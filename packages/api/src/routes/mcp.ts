// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import { ref, tuplesForCreate } from '@kindgi/authz';
import type { Scope } from '@kindgi/platform';
import type { Cursor, OrgId, ProjectId, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import {
  type MCPClientProbeBinding,
  type MCPEndpoint,
  type MCPEndpointConfig,
  type MCPEndpointRegistryBinding,
  type MCPPromptDescriptor,
  type MCPPromptMessage,
  type MCPResourceContent,
  type MCPResourceDescriptor,
  type MCPTransport,
  MCP_TRANSPORTS,
} from '../mcp-endpoint-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import { type TenantHostAccess, deniesHostReach, stdioRefusal } from '../tenant-host-access.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { parseScopeParams, scopeResourceRef } from './scope-params.js';
import { parseSecretRef } from './secret-ref.js';

/**
 * MCP-endpoint routes (mounted at `/v1/mcp`). Tenants declare the
 * remote MCP servers they want the runtime to consume; at boot the
 * runtime discovers each endpoint's tools and registers them into
 * `ToolRegistryBinding` under the same tenant.
 *
 * Secrets do NOT cross the wire — `MCPEndpoint.secretRef` names a
 * secret in the deployment's store, never a plaintext credential. The
 * API surface accepts, stores, and returns only the reference.
 *
 * `hostAccess` (`KINDGI_TENANT_HOST_ACCESS`): under `deployed`, a stdio
 * endpoint — a command the server would run on its own host — is
 * refused with `403 host-access-denied`.
 */
export function mcpRouter(
  binding: MCPEndpointRegistryBinding,
  clientProbe: MCPClientProbeBinding | undefined,
  authorizer: Authorizer | undefined,
  options: { readonly hostAccess: TenantHostAccess },
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // Authorization PEP — config-shaped resource. `mcp_endpoint` has
  // `admin from scope`, so cascade fires when scope tuple exists.
  // Register gates at admin on the body's `scopeKind` + `scopeId`, parsed
  // as the handler parses them (parseBodyScope); reads on :id gate at read
  // on `mcp_endpoint:<id>`.
  if (authorizer !== undefined) {
    r.use('/endpoints', async (c, next) => {
      if (c.req.method !== 'POST') return next();
      const tenantId = c.get('tenantId') as TenantId;
      const mw = authorizer.authorize('admin', async () => {
        let body: unknown = {};
        try {
          body = await c.req.json();
        } catch {
          // POST handler validates + returns 400
        }
        const s =
          body !== null && typeof body === 'object'
            ? parseBodyScope(body, tenantId)
            : { kind: 'err' as const };
        return scopeResourceRef(s.kind === 'ok' ? s.scope : undefined, tenantId);
      });
      return mw(c, next);
    });
    r.use('/endpoints/:endpointId/*', async (c, next) => {
      const action = c.req.method === 'GET' ? 'read' : 'admin';
      const endpointId = c.req.param('endpointId') ?? '';
      const mw = authorizer.authorize(action, () => ref('mcp_endpoint', endpointId));
      return mw(c, next);
    });
    r.use('/endpoints/:endpointId', async (c, next) => {
      const action = c.req.method === 'GET' ? 'read' : 'admin';
      const endpointId = c.req.param('endpointId') ?? '';
      const mw = authorizer.authorize(action, () => ref('mcp_endpoint', endpointId));
      return mw(c, next);
    });
  }

  // ---------- GET /endpoints (list, cursor-paginated, optional ?transport=) ----------
  r.get('/endpoints', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');
    const transportRaw = c.req.query('transport');

    let transportFilter: MCPTransport | undefined;
    if (transportRaw !== undefined && transportRaw.length > 0) {
      if (!(MCP_TRANSPORTS as readonly string[]).includes(transportRaw)) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            {
              code: 'bad-input',
              message: `Unknown transport "${transportRaw}" — must be one of ${MCP_TRANSPORTS.join(' / ')}`,
            },
            requestId,
          ),
        );
      }
      transportFilter = transportRaw as MCPTransport;
    }

    // `inherit` IS LOAD-BEARING for this
    // policy/config-scoped binding: the mcp-endpoint list does an
    // upward hierarchy walk (project → org → tenant) when inherit=true
    // (default). Pass the parsed values through faithfully;
    // do NOT default them in the route.
    const scopeParsed = parseScopeParams(c.req.query(), { tenantId });
    if (scopeParsed.kind === 'err') {
      c.status(statusFor('scope-invalid') as never);
      return c.json(
        toWireError({ code: 'scope-invalid', message: scopeParsed.message }, requestId),
      );
    }

    const page = await binding.list({
      tenantId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(transportFilter !== undefined && { transportFilter }),
      ...(scopeParsed.scope !== undefined && { scope: scopeParsed.scope }),
      ...(scopeParsed.inherit !== undefined && { inherit: scopeParsed.inherit }),
    });
    return c.json({
      data: page.data.map(serializeEndpoint),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /endpoints/:endpointId ----------
  r.get('/endpoints/:endpointId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const endpointId = c.req.param('endpointId');

    const endpoint = await binding.get({ tenantId, endpointId });
    if (endpoint === null) {
      c.status(statusFor('mcp-endpoint-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'mcp-endpoint-not-found',
            message: `No MCP endpoint registered with id "${endpointId}"`,
            endpointId,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeEndpoint(endpoint));
  });

  // ---------- POST /endpoints (register) ----------
  r.post('/endpoints', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    if (body === null || typeof body !== 'object') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be an object' }, requestId),
      );
    }

    const validation = validateMCPEndpoint(body);
    if (validation.kind === 'err') {
      c.status(statusFor('invalid-mcp-endpoint') as never);
      return c.json(
        toWireError(
          {
            code: 'invalid-mcp-endpoint',
            message: validation.error.message,
            reason: validation.error.reason,
          },
          requestId,
        ),
      );
    }

    if (validation.value.transport === 'stdio' && deniesHostReach(options.hostAccess, 'exec')) {
      c.status(statusFor('host-access-denied') as never);
      return c.json(
        toWireError(
          { code: 'host-access-denied', message: stdioRefusal(validation.value.endpointId) },
          requestId,
        ),
      );
    }

    // Policy/config: register requires an explicit scope. Wire
    // shape mirrors the query-param triplet used by list routes —
    // `scopeKind + scopeId` in the body — for uniformity.
    const scopeParsed = parseBodyScope(body, tenantId);
    if (scopeParsed.kind === 'err') {
      c.status(statusFor('scope-invalid') as never);
      return c.json(
        toWireError({ code: 'scope-invalid', message: scopeParsed.message }, requestId),
      );
    }

    const registerScope = scopeParsed.scope;
    const outcome = await binding.register({
      tenantId,
      endpoint: validation.value,
      scope: registerScope,
      enqueueTuples: (endpointId) =>
        tuplesForCreate({
          kind: 'mcp_endpoint',
          id: endpointId,
          tenantId,
          scope: registerScope,
        }),
    });
    if (outcome.kind === 'already-registered') {
      c.status(statusFor('mcp-endpoint-already-registered') as never);
      return c.json(
        toWireError(
          {
            code: 'mcp-endpoint-already-registered',
            message: `MCP endpoint "${outcome.endpointId}" is already registered`,
            endpointId: outcome.endpointId,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'project-not-found') {
      c.status(statusFor('scope-invalid') as never);
      return c.json(
        toWireError(
          {
            code: 'scope-invalid',
            message: `Project "${outcome.projectId as unknown as string}" not found for tenant`,
            projectId: outcome.projectId as unknown as string,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'org-not-found') {
      c.status(statusFor('scope-invalid') as never);
      return c.json(
        toWireError(
          {
            code: 'scope-invalid',
            message: `Org "${outcome.orgId as unknown as string}" not found for tenant`,
            orgId: outcome.orgId as unknown as string,
          },
          requestId,
        ),
      );
    }
    c.status(201);
    return c.json({ endpointId: outcome.endpointId });
  });

  // ---------- GET /endpoints/:endpointId/resources (list) ----------
  r.get('/endpoints/:endpointId/resources', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const endpointId = c.req.param('endpointId');

    if (clientProbe === undefined) {
      c.status(statusFor('mcp-endpoint-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'mcp-endpoint-not-found',
            message: 'MCP client probe not configured on this deployment',
            endpointId,
          },
          requestId,
        ),
      );
    }

    const outcome = await clientProbe.listResources({ tenantId, endpointId });
    if (outcome.kind === 'endpoint-not-found') {
      c.status(statusFor('mcp-endpoint-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'mcp-endpoint-not-found',
            message: `No MCP endpoint registered with id "${endpointId}"`,
            endpointId,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'protocol-error') {
      c.status(statusFor('mcp-resource-read-failed') as never);
      return c.json(
        toWireError(
          {
            code: 'mcp-resource-read-failed',
            message: outcome.message,
            endpointId,
          },
          requestId,
        ),
      );
    }
    return c.json({ data: outcome.resources.map(serializeResource) });
  });

  // ---------- GET /endpoints/:endpointId/resources/:uri (read; uri URL-encoded) ----------
  r.get('/endpoints/:endpointId/resources/:uri', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const endpointId = c.req.param('endpointId');
    const uri = decodeURIComponent(c.req.param('uri'));

    if (clientProbe === undefined) {
      c.status(statusFor('mcp-endpoint-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'mcp-endpoint-not-found',
            message: 'MCP client probe not configured on this deployment',
            endpointId,
          },
          requestId,
        ),
      );
    }

    const outcome = await clientProbe.readResource({ tenantId, endpointId, uri });
    if (outcome.kind === 'endpoint-not-found') {
      c.status(statusFor('mcp-endpoint-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'mcp-endpoint-not-found',
            message: `No MCP endpoint registered with id "${endpointId}"`,
            endpointId,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'resource-not-found') {
      c.status(statusFor('mcp-resource-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'mcp-resource-not-found',
            message: `No MCP resource "${outcome.uri}" at endpoint "${endpointId}"`,
            endpointId,
            uri: outcome.uri,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'read-failed') {
      c.status(statusFor('mcp-resource-read-failed') as never);
      return c.json(
        toWireError(
          {
            code: 'mcp-resource-read-failed',
            message: outcome.message,
            endpointId,
            uri,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeResourceContent(outcome.content));
  });

  // ---------- GET /endpoints/:endpointId/prompts (list) ----------
  r.get('/endpoints/:endpointId/prompts', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const endpointId = c.req.param('endpointId');

    if (clientProbe === undefined) {
      c.status(statusFor('mcp-endpoint-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'mcp-endpoint-not-found',
            message: 'MCP client probe not configured on this deployment',
            endpointId,
          },
          requestId,
        ),
      );
    }

    const outcome = await clientProbe.listPrompts({ tenantId, endpointId });
    if (outcome.kind === 'endpoint-not-found') {
      c.status(statusFor('mcp-endpoint-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'mcp-endpoint-not-found',
            message: `No MCP endpoint registered with id "${endpointId}"`,
            endpointId,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'protocol-error') {
      c.status(statusFor('mcp-prompt-get-failed') as never);
      return c.json(
        toWireError(
          {
            code: 'mcp-prompt-get-failed',
            message: outcome.message,
            endpointId,
          },
          requestId,
        ),
      );
    }
    return c.json({ data: outcome.prompts.map(serializePrompt) });
  });

  // ---------- POST /endpoints/:endpointId/prompts/:name (get, args in body) ----------
  r.post('/endpoints/:endpointId/prompts/:name', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const endpointId = c.req.param('endpointId');
    const name = c.req.param('name');

    if (clientProbe === undefined) {
      c.status(statusFor('mcp-endpoint-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'mcp-endpoint-not-found',
            message: 'MCP client probe not configured on this deployment',
            endpointId,
          },
          requestId,
        ),
      );
    }

    let body: unknown = {};
    const raw = await c.req.text();
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
        );
      }
    }
    if (body === null || typeof body !== 'object') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be an object' }, requestId),
      );
    }
    const argsRaw = (body as { arguments?: unknown }).arguments;
    let args: Readonly<Record<string, string>> | undefined;
    if (argsRaw !== undefined) {
      if (
        typeof argsRaw !== 'object' ||
        argsRaw === null ||
        Object.values(argsRaw as Record<string, unknown>).some((v) => typeof v !== 'string')
      ) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            {
              code: 'bad-input',
              message: 'arguments must be a Record<string, string>',
            },
            requestId,
          ),
        );
      }
      args = argsRaw as Readonly<Record<string, string>>;
    }

    const outcome = await clientProbe.getPrompt({
      tenantId,
      endpointId,
      name,
      ...(args !== undefined && { args }),
    });
    if (outcome.kind === 'endpoint-not-found') {
      c.status(statusFor('mcp-endpoint-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'mcp-endpoint-not-found',
            message: `No MCP endpoint registered with id "${endpointId}"`,
            endpointId,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'prompt-not-found') {
      c.status(statusFor('mcp-prompt-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'mcp-prompt-not-found',
            message: `No MCP prompt "${outcome.name}" at endpoint "${endpointId}"`,
            endpointId,
            promptName: outcome.name,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'get-failed') {
      c.status(statusFor('mcp-prompt-get-failed') as never);
      return c.json(
        toWireError(
          {
            code: 'mcp-prompt-get-failed',
            message: outcome.message,
            endpointId,
            promptName: name,
          },
          requestId,
        ),
      );
    }
    return c.json({ messages: outcome.messages.map(serializePromptMessage) });
  });

  // ---------- POST /endpoints/:endpointId/unregister ----------
  r.post('/endpoints/:endpointId/unregister', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const endpointId = c.req.param('endpointId');

    const outcome = await binding.unregister({ tenantId, endpointId });
    if (!outcome.unregistered) {
      c.status(statusFor('mcp-endpoint-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'mcp-endpoint-not-found',
            message: `No MCP endpoint "${endpointId}" to unregister`,
            endpointId,
          },
          requestId,
        ),
      );
    }
    return c.json({ endpointId, unregistered: true });
  });

  return r;
}

function serializeResource(r: MCPResourceDescriptor): Record<string, unknown> {
  return {
    uri: r.uri,
    name: r.name,
    ...(r.description !== undefined && { description: r.description }),
    ...(r.mimeType !== undefined && { mimeType: r.mimeType }),
  };
}

function serializeResourceContent(c: MCPResourceContent): Record<string, unknown> {
  return {
    uri: c.uri,
    ...(c.mimeType !== undefined && { mimeType: c.mimeType }),
    ...(c.text !== undefined && { text: c.text }),
    ...(c.blob !== undefined && { blob: c.blob }),
  };
}

function serializePrompt(p: MCPPromptDescriptor): Record<string, unknown> {
  return {
    name: p.name,
    ...(p.description !== undefined && { description: p.description }),
    ...(p.arguments !== undefined && {
      arguments: p.arguments.map((a) => ({
        name: a.name,
        ...(a.description !== undefined && { description: a.description }),
        ...(a.required !== undefined && { required: a.required }),
      })),
    }),
  };
}

function serializePromptMessage(m: MCPPromptMessage): Record<string, unknown> {
  return { role: m.role, content: m.content };
}

function serializeEndpoint(e: MCPEndpoint): Record<string, unknown> {
  return {
    endpointId: e.endpointId,
    name: e.name,
    transport: e.transport,
    config: e.config,
    ...(e.secretRef !== undefined && { secretRef: e.secretRef }),
    ...(e.instructions !== undefined && { instructions: e.instructions }),
    ...(e.metadata !== undefined && { metadata: e.metadata }),
  };
}

/** The register body: the endpoint, plus the scope it's registered in. */
const REGISTER_BODY_FIELDS = new Set([
  'endpointId',
  'name',
  'transport',
  'config',
  'secretRef',
  'instructions',
  'metadata',
  'scopeKind',
  'scopeId',
]);

/**
 * Wire-shape validator. Enforces the closed transport enum + the
 * config-transport-matches-top-level guardrail + required fields per
 * variant. Returns a `Result`-ish shape.
 */
function validateMCPEndpoint(
  body: unknown,
):
  | { kind: 'ok'; value: MCPEndpoint }
  | { kind: 'err'; error: { message: string; reason: string } } {
  const b = body as Partial<MCPEndpoint> & Record<string, unknown>;
  const unknown = Object.keys(b).find((key) => !REGISTER_BODY_FIELDS.has(key));
  if (unknown !== undefined) {
    return {
      kind: 'err',
      error: { message: `Unknown field \`${unknown}\``, reason: 'unknown-field' },
    };
  }
  if (typeof b.endpointId !== 'string' || b.endpointId.length === 0) {
    return {
      kind: 'err',
      error: { message: 'endpointId required (non-empty string)', reason: 'empty-endpoint-id' },
    };
  }
  if (typeof b.name !== 'string' || b.name.length === 0) {
    return {
      kind: 'err',
      error: {
        message: `endpoint "${b.endpointId}" missing name`,
        reason: 'empty-name',
      },
    };
  }
  if (
    typeof b.transport !== 'string' ||
    !(MCP_TRANSPORTS as readonly string[]).includes(b.transport)
  ) {
    return {
      kind: 'err',
      error: {
        message: `endpoint "${b.endpointId}" transport must be one of ${MCP_TRANSPORTS.join(' / ')} — got "${String(b.transport)}"`,
        reason: 'unknown-transport',
      },
    };
  }
  const cfg = b.config;
  if (cfg === undefined || cfg === null || typeof cfg !== 'object') {
    return {
      kind: 'err',
      error: {
        message: `endpoint "${b.endpointId}" config required (object)`,
        reason: 'missing-config',
      },
    };
  }
  const cfgAny = cfg as Partial<MCPEndpointConfig> & Record<string, unknown>;
  if (cfgAny.transport !== b.transport) {
    return {
      kind: 'err',
      error: {
        message: `endpoint "${b.endpointId}" config.transport must match top-level transport (got "${String(cfgAny.transport)}" vs "${b.transport}")`,
        reason: 'config-transport-mismatch',
      },
    };
  }
  const configResult = validateConfig(b.endpointId, cfgAny);
  if (configResult.kind === 'err') return configResult;

  const secretRef = b.secretRef === undefined ? undefined : parseSecretRef(b.secretRef);
  if (secretRef?.kind === 'err') {
    return {
      kind: 'err',
      error: {
        message: `endpoint "${b.endpointId}": ${secretRef.message}`,
        reason: 'invalid-secret-ref',
      },
    };
  }
  if (b.instructions !== undefined && typeof b.instructions !== 'string') {
    return {
      kind: 'err',
      error: {
        message: `endpoint "${b.endpointId}" instructions must be a string`,
        reason: 'invalid-instructions',
      },
    };
  }
  if (b.metadata !== undefined && (typeof b.metadata !== 'object' || b.metadata === null)) {
    return {
      kind: 'err',
      error: {
        message: `endpoint "${b.endpointId}" metadata must be an object`,
        reason: 'invalid-metadata',
      },
    };
  }

  const value: MCPEndpoint = {
    endpointId: b.endpointId,
    name: b.name,
    transport: b.transport as MCPTransport,
    config: configResult.value,
    ...(secretRef !== undefined && { secretRef: secretRef.value }),
    ...(b.instructions !== undefined && { instructions: b.instructions as string }),
    ...(b.metadata !== undefined && {
      metadata: b.metadata as Readonly<Record<string, unknown>>,
    }),
  };
  return { kind: 'ok', value };
}

function validateConfig(
  endpointId: string,
  cfg: Partial<MCPEndpointConfig> & Record<string, unknown>,
):
  | { kind: 'ok'; value: MCPEndpointConfig }
  | { kind: 'err'; error: { message: string; reason: string } } {
  if (cfg.transport === 'stdio') {
    if (typeof cfg.command !== 'string' || cfg.command.length === 0) {
      return {
        kind: 'err',
        error: {
          message: `endpoint "${endpointId}" stdio config.command required (non-empty string)`,
          reason: 'invalid-stdio-command',
        },
      };
    }
    if (cfg.args !== undefined) {
      if (!Array.isArray(cfg.args) || cfg.args.some((a) => typeof a !== 'string')) {
        return {
          kind: 'err',
          error: {
            message: `endpoint "${endpointId}" stdio config.args must be an array of strings`,
            reason: 'invalid-stdio-args',
          },
        };
      }
    }
    if (cfg.env !== undefined) {
      if (
        typeof cfg.env !== 'object' ||
        cfg.env === null ||
        Object.values(cfg.env as Record<string, unknown>).some((v) => typeof v !== 'string')
      ) {
        return {
          kind: 'err',
          error: {
            message: `endpoint "${endpointId}" stdio config.env must be a Record<string, string>`,
            reason: 'invalid-stdio-env',
          },
        };
      }
    }
    return {
      kind: 'ok',
      value: {
        transport: 'stdio',
        command: cfg.command as string,
        ...(cfg.args !== undefined && { args: cfg.args as readonly string[] }),
        ...(cfg.env !== undefined && { env: cfg.env as Readonly<Record<string, string>> }),
      },
    };
  }
  if (cfg.transport === 'http-sse') {
    if (typeof cfg.url !== 'string' || cfg.url.length === 0) {
      return {
        kind: 'err',
        error: {
          message: `endpoint "${endpointId}" http-sse config.url required (non-empty string)`,
          reason: 'invalid-http-sse-url',
        },
      };
    }
    if (cfg.sseUrl !== undefined && typeof cfg.sseUrl !== 'string') {
      return {
        kind: 'err',
        error: {
          message: `endpoint "${endpointId}" http-sse config.sseUrl must be a string`,
          reason: 'invalid-http-sse-sse-url',
        },
      };
    }
    if (
      cfg.headers !== undefined &&
      (typeof cfg.headers !== 'object' ||
        cfg.headers === null ||
        Object.values(cfg.headers as Record<string, unknown>).some((v) => typeof v !== 'string'))
    ) {
      return {
        kind: 'err',
        error: {
          message: `endpoint "${endpointId}" http-sse config.headers must be a Record<string, string>`,
          reason: 'invalid-http-sse-headers',
        },
      };
    }
    return {
      kind: 'ok',
      value: {
        transport: 'http-sse',
        url: cfg.url as string,
        ...(cfg.sseUrl !== undefined && { sseUrl: cfg.sseUrl as string }),
        ...(cfg.headers !== undefined && {
          headers: cfg.headers as Readonly<Record<string, string>>,
        }),
      },
    };
  }
  // streamable-http
  if (typeof cfg.url !== 'string' || cfg.url.length === 0) {
    return {
      kind: 'err',
      error: {
        message: `endpoint "${endpointId}" streamable-http config.url required (non-empty string)`,
        reason: 'invalid-streamable-http-url',
      },
    };
  }
  if (
    cfg.headers !== undefined &&
    (typeof cfg.headers !== 'object' ||
      cfg.headers === null ||
      Object.values(cfg.headers as Record<string, unknown>).some((v) => typeof v !== 'string'))
  ) {
    return {
      kind: 'err',
      error: {
        message: `endpoint "${endpointId}" streamable-http config.headers must be a Record<string, string>`,
        reason: 'invalid-streamable-http-headers',
      },
    };
  }
  return {
    kind: 'ok',
    value: {
      transport: 'streamable-http',
      url: cfg.url as string,
      ...(cfg.headers !== undefined && {
        headers: cfg.headers as Readonly<Record<string, string>>,
      }),
    },
  };
}

/**
 * Parse the register-body's `scopeKind + scopeId` triplet into a
 * discriminated `Scope`. Mirrors the query-param triplet shape from
 * `parseScopeParams` so write bodies and read query params
 * stay uniform. Cross-field validation:
 *
 * - `scopeKind` required, one of `'tenant' | 'org' | 'project'`.
 * - `scopeKind = 'tenant'` → `scopeId` MUST be absent (tenant is
 *   implicit from the session).
 * - `scopeKind ∈ {'org','project'}` → `scopeId` required, non-empty.
 */
function parseBodyScope(
  body: unknown,
  tenantId: TenantId,
):
  | { readonly kind: 'ok'; readonly scope: Scope }
  | { readonly kind: 'err'; readonly message: string } {
  const b = body as { readonly scopeKind?: unknown; readonly scopeId?: unknown };
  const kindRaw = b.scopeKind;
  const idRaw = b.scopeId;

  if (typeof kindRaw !== 'string' || kindRaw.length === 0) {
    return {
      kind: 'err',
      message: 'scopeKind required in register body: one of "tenant" | "org" | "project"',
    };
  }
  if (kindRaw !== 'tenant' && kindRaw !== 'org' && kindRaw !== 'project') {
    return {
      kind: 'err',
      message: `scopeKind must be one of "tenant" | "org" | "project", got "${kindRaw}"`,
    };
  }
  if (kindRaw === 'tenant') {
    if (idRaw !== undefined && idRaw !== null && String(idRaw).length > 0) {
      return {
        kind: 'err',
        message: `scopeKind="tenant" takes no scopeId (tenant is implicit from the session)`,
      };
    }
    return { kind: 'ok', scope: { kind: 'tenant', tenantId } };
  }
  if (typeof idRaw !== 'string' || idRaw.length === 0) {
    return {
      kind: 'err',
      message: `scopeKind="${kindRaw}" requires a non-empty scopeId in the body`,
    };
  }
  const scope: Scope =
    kindRaw === 'org'
      ? { kind: 'org', tenantId, orgId: idRaw as OrgId }
      : { kind: 'project', tenantId, projectId: idRaw as ProjectId };
  return { kind: 'ok', scope };
}
