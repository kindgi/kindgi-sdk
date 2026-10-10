// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import { ref, tuplesForCreate } from '@kindgi/authz';
import type { Scope } from '@kindgi/platform';
import type { Cursor, OrgId, ProjectId, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import {
  type MCPAuthHeader,
  type MCPAuthScheme,
  type MCPBasicAuth,
  type MCPClientProbeBinding,
  type MCPEndpoint,
  type MCPEndpointAuth,
  type MCPEndpointConfig,
  type MCPEndpointRegistryBinding,
  type MCPPromptDescriptor,
  type MCPPromptMessage,
  type MCPResourceContent,
  type MCPResourceDescriptor,
  type MCPTransport,
  MCP_AUTH_HEADERS_MAX,
  MCP_AUTH_SCHEMES,
  MCP_OAUTH_CLIENT_AUTH,
  MCP_TRANSPORTS,
  REDACTED_HEADER_VALUE,
  isCredentialHeaderName,
  mcpEndpointSecretNames,
} from '../mcp-endpoint-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import { type ProviderKeys, refuseProviderKeys } from '../provider-keys.js';
import { type TenantHostAccess, deniesHostReach, stdioRefusal } from '../tenant-host-access.js';
import type { AppEnv } from '../types.js';
import { refused } from './denied.js';
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
  options: { readonly hostAccess: TenantHostAccess; readonly providerKeys?: ProviderKeys },
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
    // Only what the caller may read (T243 A), as `GET …/:id` asks.
    const visible =
      authorizer === undefined
        ? page.data
        : await authorizer.filterByCan(c, 'read', page.data, (a) =>
            ref('mcp_endpoint', a.endpointId as unknown as string),
          );
    return c.json({
      data: visible.map(serializeEndpoint),
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

    // A model provider's key is never an MCP endpoint's.
    const refusal = await refuseProviderKeys(
      options.providerKeys,
      tenantId,
      mcpEndpointSecretNames(validation.value),
      'an MCP endpoint',
    );
    if (refusal !== undefined) {
      c.status(statusFor(refusal.code) as never);
      return c.json(toWireError(refusal, requestId));
    }

    if (validation.value.transport === 'stdio' && deniesHostReach(options.hostAccess, 'exec')) {
      // The deployment rules it out: recorded, as every refusal the API
      // decides itself is.
      return refused(c, authorizer, {
        action: 'admin',
        resource: ref('mcp_endpoint', validation.value.endpointId),
        message: stdioRefusal(validation.value.endpointId),
        failing: 'scope',
        code: 'host-access-denied',
      });
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
    config: redactedConfig(e.config),
    ...(e.secretRef !== undefined && { secretRef: e.secretRef }),
    ...(e.auth !== undefined && { auth: e.auth }),
    ...(e.instructions !== undefined && { instructions: e.instructions }),
    ...(e.metadata !== undefined && { metadata: e.metadata }),
    ...(e.sendTraceparent !== undefined && { sendTraceparent: e.sendTraceparent }),
  };
}

/**
 * The config as answered: a credential header's value reads `[redacted]`, its
 * name kept, so an operator sees what to move to `auth` and nobody reads the
 * value back. Registration refuses such a header now; an endpoint registered
 * before keeps it, and keeps working.
 */
function redactedConfig(config: MCPEndpointConfig): MCPEndpointConfig {
  if (config.transport === 'stdio' || config.headers === undefined) return config;
  const entries = Object.entries(config.headers);
  if (!entries.some(([name]) => isCredentialHeaderName(name))) return config;
  return {
    ...config,
    headers: Object.fromEntries(
      entries.map(([name, value]) => [
        name,
        isCredentialHeaderName(name) ? REDACTED_HEADER_VALUE : value,
      ]),
    ),
  };
}

/** The register body: the endpoint, plus the scope it's registered in. */
const REGISTER_BODY_FIELDS = new Set([
  'endpointId',
  'name',
  'transport',
  'config',
  'secretRef',
  'auth',
  'instructions',
  'metadata',
  'sendTraceparent',
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
  const authResult =
    b.auth === undefined
      ? undefined
      : checkedAuth(b.endpointId, b.transport as MCPTransport, b, configResult.value);
  if (authResult?.kind === 'err') return authResult;
  const auth = authResult?.value;
  const credential = credentialInHeaders(b.endpointId, configResult.value);
  if (credential !== undefined) return { kind: 'err', error: credential };
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
  if (b.sendTraceparent !== undefined && typeof b.sendTraceparent !== 'boolean') {
    return {
      kind: 'err',
      error: {
        message: `endpoint "${b.endpointId}" sendTraceparent must be true or false`,
        reason: 'invalid-send-traceparent',
      },
    };
  }
  if (b.sendTraceparent === true && b.transport === 'stdio') {
    return {
      kind: 'err',
      error: {
        message: `endpoint "${b.endpointId}" sendTraceparent needs an HTTP transport: a stdio server gets no headers`,
        reason: 'invalid-send-traceparent',
      },
    };
  }

  const value: MCPEndpoint = {
    endpointId: b.endpointId,
    name: b.name,
    transport: b.transport as MCPTransport,
    config: configResult.value,
    ...(secretRef !== undefined && { secretRef: secretRef.value }),
    ...(auth !== undefined && { auth }),
    ...(b.instructions !== undefined && { instructions: b.instructions as string }),
    ...(b.metadata !== undefined && {
      metadata: b.metadata as Readonly<Record<string, unknown>>,
    }),
    ...(b.sendTraceparent !== undefined && { sendTraceparent: b.sendTraceparent }),
  };
  return { kind: 'ok', value };
}

/** `auth`, parsed and checked against the rest of the endpoint. */
function checkedAuth(
  endpointId: string,
  transport: MCPTransport,
  b: Record<string, unknown>,
  config: MCPEndpointConfig,
): AuthParse {
  const refusal = authConflict(endpointId, transport, b.secretRef);
  if (refusal !== undefined) return { kind: 'err', error: refusal };
  const parsed = parseAuth(endpointId, b.auth);
  if (parsed.kind === 'err') return parsed;
  const twice = authHeaderInConfig(endpointId, parsed.value, config);
  if (twice !== undefined) return { kind: 'err', error: twice };
  return parsed;
}

/** What `auth` can't be set with: `secretRef` (the bearer form), a stdio transport. */
function authConflict(
  endpointId: string,
  transport: MCPTransport,
  secretRef: unknown,
): { readonly message: string; readonly reason: string } | undefined {
  if (secretRef !== undefined) {
    return {
      message: `endpoint "${endpointId}" sets both secretRef and auth: secretRef is the bearer form, auth the others. Set one.`,
      reason: 'auth-with-secret-ref',
    };
  }
  if (transport === 'stdio') {
    return {
      message: `endpoint "${endpointId}" auth needs an HTTP transport: a stdio server gets no headers`,
      reason: 'auth-on-stdio',
    };
  }
  return undefined;
}

/** A header `auth` sends that `config.headers` sets too: `auth`'s wins, so the other is refused. */
function authHeaderInConfig(
  endpointId: string,
  auth: MCPEndpointAuth,
  config: MCPEndpointConfig,
): { readonly message: string; readonly reason: string } | undefined {
  const headers = config.transport === 'stdio' ? undefined : config.headers;
  const sent = new Set(
    auth.scheme === 'header' ? auth.headers.map((h) => h.name.toLowerCase()) : ['authorization'],
  );
  const twice = Object.keys(headers ?? {}).find((name) => sent.has(name.toLowerCase()));
  if (twice === undefined) return undefined;
  return auth.scheme === 'header'
    ? {
        message: `endpoint "${endpointId}" sets the header "${twice}" in both auth.headers and config.headers: auth sends it. Drop it from config.headers.`,
        reason: 'auth-header-in-config',
      }
    : {
        message: `endpoint "${endpointId}" sets auth and an Authorization header in config.headers: auth sends that header. Drop the header.`,
        reason: 'auth-with-authorization-header',
      };
}

/**
 * A credential in `config.headers` (`isCredentialHeaderName`), refused: it'd
 * be stored as given and could follow a redirect to another host. The message
 * names each header, never its value.
 */
function credentialInHeaders(
  endpointId: string,
  config: MCPEndpointConfig,
): { readonly message: string; readonly reason: string } | undefined {
  const headers = config.transport === 'stdio' ? undefined : config.headers;
  const names = Object.keys(headers ?? {}).filter(isCredentialHeaderName);
  if (names.length === 0) return undefined;
  const listed = names.map((name) => `"${name}"`).join(', ');
  const byReference = names
    .map((name) => `{ name: "${name}", secretRef: { envName, name } }`)
    .join(', ');
  const bearer = names.some((name) => name.toLowerCase() === 'authorization')
    ? ' For `Authorization: Bearer <token>`, secretRef sends it.'
    : '';
  return {
    message: `endpoint "${endpointId}" puts a credential in config.headers (${listed}), where it's stored and shown as given. Store each value as a secret and send it by reference: auth: { scheme: "header", headers: [${byReference}] }.${bearer}`,
    reason: 'credential-in-headers',
  };
}

/** Each scheme's fields. */
const AUTH_FIELDS: Readonly<Record<MCPAuthScheme, ReadonlySet<string>>> = {
  basic: new Set(['scheme', 'username', 'secretRef']),
  'oauth2-client-credentials': new Set([
    'scheme',
    'tokenUrl',
    'clientId',
    'secretRef',
    'scope',
    'audience',
    'clientAuth',
  ]),
  header: new Set(['scheme', 'headers']),
};
const AUTH_HEADER_FIELDS = new Set(['name', 'secretRef', 'prefix']);
/** An HTTP field name: an RFC 9110 token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Headers the MCP transport or HTTP itself sets, which `auth` can't. */
const TRANSPORT_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'accept',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'upgrade',
  'trailer',
  'expect',
  'last-event-id',
  'mcp-session-id',
  'mcp-protocol-version',
  'traceparent',
  'tracestate',
]);
/** The hosts a token URL may reach over plain http: this machine's own. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether `value` is a string of 1 to `max` characters. */
function boundedString(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function parsedUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

type AuthErr = { kind: 'err'; error: { message: string; reason: string } };
type AuthParse = { kind: 'ok'; value: MCPEndpointAuth } | AuthErr;
type AuthRefusal = (message: string, reason?: string) => AuthErr;

/** `auth`, checked: a known scheme with its fields, the secret by reference. */
function parseAuth(endpointId: string, raw: unknown): AuthParse {
  const bad: AuthRefusal = (message, reason = 'invalid-auth') => ({
    kind: 'err',
    error: { message: `endpoint "${endpointId}" ${message}`, reason },
  });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return bad('auth must be an object with a `scheme`');
  }
  const a = raw as Record<string, unknown>;
  if (!(MCP_AUTH_SCHEMES as readonly unknown[]).includes(a.scheme)) {
    return bad(`auth.scheme must be one of ${MCP_AUTH_SCHEMES.join(' / ')}`);
  }
  const scheme = a.scheme as MCPAuthScheme;
  const unknown = Object.keys(a).find((key) => !AUTH_FIELDS[scheme].has(key));
  if (unknown !== undefined) {
    return bad(`auth: unknown field \`auth.${unknown}\` for scheme ${scheme}`);
  }
  if (scheme === 'header') return parseHeaderAuth(a.headers, bad);
  const secretRef = parseSecretRef(a.secretRef, 'auth.secretRef');
  if (secretRef.kind === 'err') return bad(`auth: ${secretRef.message}`, 'invalid-secret-ref');
  return a.scheme === 'basic'
    ? parseBasicAuth(a, secretRef.value, bad)
    : parseOAuth2Auth(a, secretRef.value, bad);
}

/** `auth.headers`: 1 to `MCP_AUTH_HEADERS_MAX` headers, each named once. */
function parseHeaderAuth(raw: unknown, bad: AuthRefusal): AuthParse {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MCP_AUTH_HEADERS_MAX) {
    return bad(`auth.headers must be a list of 1 to ${MCP_AUTH_HEADERS_MAX} headers`);
  }
  const headers: MCPAuthHeader[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    const header = parseAuthHeader(item, `auth.headers[${i}]`, bad);
    if (header.kind === 'err') return header;
    const key = header.value.name.toLowerCase();
    if (seen.has(key)) {
      return bad(`auth.headers names "${header.value.name}" twice: each header once`);
    }
    seen.add(key);
    headers.push(header.value);
  }
  return { kind: 'ok', value: { scheme: 'header', headers } };
}

/** One of `auth.headers`: a header name the transport doesn't own, its secret, a prefix. */
function parseAuthHeader(
  raw: unknown,
  at: string,
  bad: AuthRefusal,
): { kind: 'ok'; value: MCPAuthHeader } | AuthErr {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return bad(`${at} must be an object \`{ name, secretRef, prefix? }\``);
  }
  const h = raw as Record<string, unknown>;
  const unknown = Object.keys(h).find((key) => !AUTH_HEADER_FIELDS.has(key));
  if (unknown !== undefined) return bad(`auth: unknown field \`${at}.${unknown}\``);
  if (!boundedString(h.name, 256) || !HEADER_NAME.test(h.name as string)) {
    return bad(`${at}.name must be an HTTP header name of 1 to 256 characters`);
  }
  const name = h.name as string;
  if (TRANSPORT_HEADERS.has(name.toLowerCase())) {
    return bad(`${at}.name "${name}" is a header the MCP transport sets itself`);
  }
  if (h.prefix !== undefined && !(boundedString(h.prefix, 64) && printable(h.prefix as string))) {
    return bad(`${at}.prefix must be 1 to 64 characters, without control characters`);
  }
  const secretRef = parseSecretRef(h.secretRef, `${at}.secretRef`);
  if (secretRef.kind === 'err') return bad(`auth: ${secretRef.message}`, 'invalid-secret-ref');
  return {
    kind: 'ok',
    value: {
      name,
      secretRef: secretRef.value,
      ...(h.prefix !== undefined && { prefix: h.prefix as string }),
    },
  };
}

/** Whether `text` has no control characters, which a header value can't carry. */
function printable(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function parseBasicAuth(
  a: Record<string, unknown>,
  secretRef: MCPBasicAuth['secretRef'],
  bad: AuthRefusal,
): AuthParse {
  if (!boundedString(a.username, 256) || (a.username as string).includes(':')) {
    return bad('auth.username must be 1 to 256 characters, without `:`');
  }
  return { kind: 'ok', value: { scheme: 'basic', username: a.username as string, secretRef } };
}

/** Whether a token URL may carry a client secret: https, or http to this machine; no credentials or fragment. */
function tokenUrlAllowed(raw: unknown): boolean {
  const url = boundedString(raw, 2048) ? parsedUrl(raw as string) : null;
  if (url === null || url.username !== '' || url.password !== '' || url.hash !== '') return false;
  return (
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  );
}

function parseOAuth2Auth(
  a: Record<string, unknown>,
  secretRef: MCPBasicAuth['secretRef'],
  bad: AuthRefusal,
): AuthParse {
  if (!tokenUrlAllowed(a.tokenUrl)) {
    return bad(
      'auth.tokenUrl must be an https URL (or http to localhost, 127.0.0.1 or [::1]), without credentials or a fragment',
      'invalid-token-url',
    );
  }
  if (!boundedString(a.clientId, 512)) return bad('auth.clientId must be 1 to 512 characters');
  for (const field of ['scope', 'audience'] as const) {
    if (a[field] !== undefined && !boundedString(a[field], 1024)) {
      return bad(`auth.${field} must be 1 to 1024 characters`);
    }
  }
  if (
    a.clientAuth !== undefined &&
    !(MCP_OAUTH_CLIENT_AUTH as readonly unknown[]).includes(a.clientAuth)
  ) {
    return bad(`auth.clientAuth must be one of ${MCP_OAUTH_CLIENT_AUTH.join(' / ')}`);
  }
  return {
    kind: 'ok',
    value: {
      scheme: 'oauth2-client-credentials',
      tokenUrl: a.tokenUrl as string,
      clientId: a.clientId as string,
      secretRef,
      ...(a.scope !== undefined && { scope: a.scope as string }),
      ...(a.audience !== undefined && { audience: a.audience as string }),
      ...(a.clientAuth !== undefined && {
        clientAuth: a.clientAuth as (typeof MCP_OAUTH_CLIENT_AUTH)[number],
      }),
    },
  };
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
