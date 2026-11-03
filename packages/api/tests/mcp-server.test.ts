// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/mcp`: its own token check (401s that say where to sign in), the chat
 * scopes, and each tool's `/v1` request in this process as the person,
 * narrowed to the token's scopes and to the routes its tool set declared.
 * Test-only tool sets; a stand-in authorization check that records who asked.
 */

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, Principal, ResourceRef } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type { CreateAppInput, RunHandlerBinding, TokenResolution } from '../src/index.js';
import {
  type McpServerInput,
  type McpToolSet,
  mountMcpServer,
} from '../src/mcp-server/endpoint.js';
import { createStubAppBindings } from '../src/testing/index.js';
import { mcpRpc } from './support/mcp-rpc.js';

const tenantId = '00000000-0000-4000-8000-0000000000a1' as TenantId;
const RESOURCE_METADATA = 'https://kindgi.test/.well-known/oauth-protected-resource/mcp';
const inAnHour = () => new Date(Date.now() + 3_600_000);

/** Chat tokens, as the deployment's chat sign-in would resolve them. */
const CHAT: Record<string, () => TokenResolution> = {
  'chat-read': () => ({
    tenantId,
    userId: 'alice' as UserId,
    expiresAt: inAnHour(),
    scopes: ['kindgi:read'],
  }),
  'chat-run': () => ({
    tenantId,
    userId: 'alice' as UserId,
    expiresAt: inAnHour(),
    scopes: ['kindgi:read', 'kindgi:run', 'openid'],
  }),
  'chat-expired': () => ({
    tenantId,
    userId: 'alice' as UserId,
    expiresAt: new Date(Date.now() - 1_000),
    scopes: ['kindgi:read'],
  }),
  'chat-no-expiry': () => ({ tenantId, userId: 'alice' as UserId, scopes: ['kindgi:read'] }),
  'chat-machine': () => ({
    tenantId,
    serviceAccountId: 'ci',
    expiresAt: inAnHour(),
    scopes: ['kindgi:read'],
  }),
  'chat-no-scope': () => ({
    tenantId,
    userId: 'alice' as UserId,
    expiresAt: inAnHour(),
    scopes: ['openid'],
  }),
  'chat-revoked': () => ({
    tenantId,
    userId: 'alice' as UserId,
    expiresAt: inAnHour(),
    scopes: ['kindgi:read'],
    revoked: true,
  }),
};

const readSet: McpToolSet = {
  scopes: ['kindgi:read'],
  routes: ['GET /v1/tenant'],
  register(server, context) {
    server.registerTool('probe_tenant', { description: 'Reads the tenant.' }, async () => {
      const res = await context.call('GET', '/v1/tenant');
      return {
        content: [{ type: 'text', text: String(res.status) }],
        structuredContent: { status: res.status, link: context.link('runs', 'run/1') ?? null },
      };
    });
    server.registerTool(
      'probe_elsewhere',
      { description: 'Reads an undeclared route.' },
      async () => {
        const res = await context.call('GET', '/v1/tenant/../agents');
        return { content: [{ type: 'text', text: String(res.status) }] };
      },
    );
  },
};

const runSet: McpToolSet = {
  scopes: ['kindgi:run'],
  routes: [],
  register(server) {
    server.registerTool('probe_run', { description: 'Only with kindgi:run.' }, async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
  },
};

function harness(options: { consoleUrl?: string } = {}) {
  /** Each check the routes asked: who, and what. */
  const asked: { principal: Principal; action: string }[] = [];
  const refused = (principal: Principal, action: Action, resource: ResourceRef): Decision => ({
    allowed: false,
    reason: 'stand-in: refuses everything',
    evidence: { action, relation: '', resource: resource.id, actorSubject: principal.actor.id },
  });
  const authzCheckBinding: AuthzCheckBinding = {
    async check(principal, action, resource) {
      asked.push({ principal, action });
      return refused(principal, action, resource);
    },
    async checkBatch(principal, action, resources) {
      asked.push({ principal, action });
      return resources.map((resource) => refused(principal, action, resource));
    },
  };
  const app = createApp({
    ...createStubAppBindings(),
    // The API's own tokens: none of the chat ones.
    resolveToken: async (token) => (token === 'api-key' ? { tenantId } : null),
    runHandler: {} as RunHandlerBinding,
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
  });
  const input: McpServerInput = {
    resolveToken: async (token) => CHAT[token]?.() ?? null,
    resourceMetadataUrl: RESOURCE_METADATA,
    version: '0.0.0-test',
    ...(options.consoleUrl !== undefined && { consoleUrl: options.consoleUrl }),
  };
  mountMcpServer(app, input, [readSet, runSet]);

  const rpc = mcpRpc(app);
  return { app, asked, rpc };
}

describe('/mcp: signing in', () => {
  test('is not mounted without mcpServer', async () => {
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken: async () => null,
      runHandler: {} as RunHandlerBinding,
    } satisfies CreateAppInput);
    expect((await app.request('/mcp', { method: 'POST' })).status).toBe(404);
  });

  test('mcpServer mounts it', async () => {
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken: async () => null,
      runHandler: {} as RunHandlerBinding,
      mcpServer: {
        resolveToken: async () => null,
        resourceMetadataUrl: RESOURCE_METADATA,
        version: '0.0.0-test',
      },
    });
    expect((await app.request('/mcp', { method: 'POST' })).status).toBe(401);
  });

  test('no token: 401 pointing to the metadata, before any JSON-RPC', async () => {
    const { rpc } = harness();
    const { res, body } = await rpc(undefined, 'tools/list');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${RESOURCE_METADATA}"`,
    );
    expect(body.jsonrpc).toBeUndefined();
  });

  test.each(['nobody', 'chat-revoked', 'chat-expired', 'chat-no-expiry', 'api-key'])(
    '%s: 401 invalid_token',
    async (token) => {
      const { rpc } = harness();
      const { res } = await rpc(token, 'tools/list');
      expect(res.status).toBe(401);
      const challenge = res.headers.get('www-authenticate') ?? '';
      expect(challenge).toContain('error="invalid_token"');
      expect(challenge).toContain(`resource_metadata="${RESOURCE_METADATA}"`);
    },
  );

  test('a token that names no person: 403', async () => {
    const { rpc } = harness();
    const { res, body } = await rpc('chat-machine', 'tools/list');
    expect(res.status).toBe(403);
    expect(body.error).toBe('access_denied');
  });

  test('a token with no Kindgi scope: 403 insufficient_scope, asking for kindgi:read', async () => {
    const { rpc } = harness();
    const { res } = await rpc('chat-no-scope', 'tools/list');
    expect(res.status).toBe(403);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('kindgi:read');
  });

  test('a chat token opens no /v1 route', async () => {
    const { app } = harness();
    const res = await app.request('/v1/tenant', { headers: { authorization: 'Bearer chat-run' } });
    expect(res.status).toBe(401);
  });

  test('answers are never kept by a cache', async () => {
    const { rpc } = harness();
    for (const token of [undefined, 'chat-read']) {
      const { res } = await rpc(token, 'tools/list');
      expect(res.headers.get('cache-control')).toContain('no-store');
    }
  });
});

describe('/mcp: tools by scope', () => {
  const names = (body: Record<string, any>) =>
    (body.result.tools as { name: string }[]).map((t) => t.name).sort();

  test('kindgi:read lists only the read set', async () => {
    const { rpc } = harness();
    const { res, body } = await rpc('chat-read', 'tools/list');
    expect(res.status).toBe(200);
    expect(names(body)).toEqual(['probe_elsewhere', 'probe_tenant']);
  });

  test('kindgi:run adds its set; an unknown scope is ignored', async () => {
    const { rpc } = harness();
    const { body } = await rpc('chat-run', 'tools/list');
    expect(names(body)).toEqual(['probe_elsewhere', 'probe_run', 'probe_tenant']);
  });

  test('2026-07-28 requests are served too', async () => {
    const { rpc } = harness();
    const { res, body } = await rpc('chat-read', 'tools/list', {}, '2026-07-28');
    expect(res.status).toBe(200);
    expect(names(body)).toEqual(['probe_elsewhere', 'probe_tenant']);
  });
});

describe("/mcp: a tool's /v1 request", () => {
  test('goes through the route as the person, narrowed to the scopes', async () => {
    const { rpc, asked } = harness();
    const { body } = await rpc('chat-read', 'tools/call', { name: 'probe_tenant', arguments: {} });
    // The stand-in refused, so the route answered 403 and touched nothing.
    expect(body.result.structuredContent.status).toBe(403);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.action).toBe('read');
    expect(asked[0]?.principal.actor).toEqual({ kind: 'user', id: 'alice', tenantId });
    expect(asked[0]?.principal.scope?.allowedActions).toEqual(['read']);
  });

  test("kindgi:run's actions are the union", async () => {
    const { rpc, asked } = harness();
    await rpc('chat-run', 'tools/call', { name: 'probe_tenant', arguments: {} });
    expect(asked[0]?.principal.scope?.allowedActions).toEqual([
      'read',
      'execute',
      'call',
      'invoke',
      'run',
    ]);
  });

  test('a route the tool set did not declare is never called, dot segments included', async () => {
    const { rpc, asked } = harness();
    const { body } = await rpc('chat-read', 'tools/call', {
      name: 'probe_elsewhere',
      arguments: {},
    });
    expect(body.result.isError).toBe(true);
    expect(JSON.stringify(body.result.content)).toContain("isn't a route the tools declared");
    expect(asked).toHaveLength(0);
  });

  test('console links: <consoleUrl>/<kind>/<id>, or none without a console URL', async () => {
    const withConsole = harness({ consoleUrl: 'https://kindgi.test/console/' });
    const linked = await withConsole.rpc('chat-read', 'tools/call', {
      name: 'probe_tenant',
      arguments: {},
    });
    expect(linked.body.result.structuredContent.link).toBe(
      'https://kindgi.test/console/runs/run%2F1',
    );
    const unlinked = await harness().rpc('chat-read', 'tools/call', {
      name: 'probe_tenant',
      arguments: {},
    });
    expect(unlinked.body.result.structuredContent.link).toBeNull();
  });
});
