// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/mcp`: its own token check (401s that say where to sign in), the chat
 * scopes, and each tool's `/v1` request in this process as the person,
 * narrowed to the token's scopes and to the routes its tool set declared;
 * and how a chat app's requests count toward the tenant's API requests a
 * minute. Test-only tool sets; a stand-in authorization check that records
 * who asked.
 */

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, Principal, ResourceRef } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';

import { createApp, createInMemoryRateLimitStore } from '../src/index.js';
import type {
  CreateAppInput,
  RateLimitStore,
  RunHandlerBinding,
  TokenResolution,
} from '../src/index.js';
import {
  MCP_CALLS_PER_MESSAGE,
  type McpServerInput,
  type McpToolSet,
  mountMcpServer,
} from '../src/mcp-server/endpoint.js';
import { createTenantLimiter } from '../src/middleware/tenant-limits.js';
import { createStubAppBindings } from '../src/testing/index.js';
import { mcpRpc } from './support/mcp-rpc.js';

const tenantId = '00000000-0000-4000-8000-0000000000a1' as TenantId;
const RESOURCE_METADATA = 'https://kindgi.test/.well-known/oauth-protected-resource/mcp';
const inAnHour = () => new Date(Date.now() + 3_600_000);

const reading = (): TokenResolution => ({
  tenantId,
  userId: 'alice' as UserId,
  expiresAt: inAnHour(),
  scopes: ['kindgi:read'],
});

/** Chat tokens, as the deployment's chat sign-in would resolve them. */
const CHAT: Record<string, () => TokenResolution> = {
  'chat-read': reading,
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
  // A person, and something the tools' `/v1` calls can't carry.
  'chat-for-a-machine': () => ({ ...reading(), serviceAccountId: 'ci' }),
  'chat-keys-operator': () => ({ ...reading(), systemKeysOperator: { keyId: 'boot' } }),
  'chat-one-project': () => ({ ...reading(), tokenProjectId: 'project-1' }),
  'chat-reviewer': () => ({ ...reading(), reviewerRole: 'admin' }),
  'chat-idle-limit': () => ({ ...reading(), lastActiveAt: new Date() }),
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

/** Reads the tenant 5 times past what one message's cover holds, and answers each status. */
const oftenSet: McpToolSet = {
  scopes: ['kindgi:read'],
  routes: ['GET /v1/tenant'],
  register(server, context) {
    server.registerTool('probe_often', { description: 'Reads past the cover.' }, async () => {
      const statuses: number[] = [];
      for (let i = 0; i < MCP_CALLS_PER_MESSAGE + 5; i++) {
        statuses.push((await context.call('GET', '/v1/tenant')).status);
      }
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: { statuses } };
    });
  },
};

function harness(options: { consoleUrl?: string; perMinute?: number } = {}) {
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
  // With a limit: the tenant's API requests a minute, each take recorded.
  const takes: string[] = [];
  const memory = createInMemoryRateLimitStore();
  const store: RateLimitStore = {
    take(input) {
      takes.push(input.key);
      return memory.take(input);
    },
  };
  const stubs = createStubAppBindings();
  const tenantHierarchyBinding = {
    ...stubs.tenantHierarchyBinding,
    getTenant: async (id: TenantId) => ({
      id,
      name: 'Acme',
      slug: 'acme',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      ...(options.perMinute !== undefined && {
        limits: { apiRequestsPerMinute: options.perMinute },
      }),
    }),
  };
  const limited = options.perMinute !== undefined;
  const app = createApp({
    ...stubs,
    // The API's own tokens: none of the chat ones.
    resolveToken: async (token) => (token === 'api-key' ? { tenantId } : null),
    runHandler: {} as RunHandlerBinding,
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
    ...(limited && { tenantHierarchyBinding, tenantLimits: { store } }),
  });
  const input: McpServerInput = {
    resolveToken: async (token) => CHAT[token]?.() ?? null,
    resourceMetadataUrl: RESOURCE_METADATA,
    version: '0.0.0-test',
    ...(options.consoleUrl !== undefined && { consoleUrl: options.consoleUrl }),
  };
  if (limited) {
    // `/v1`'s count lives in the same store, so both see one minute.
    const limiter = createTenantLimiter(tenantHierarchyBinding, { store });
    mountMcpServer(app, input, [readSet, runSet, oftenSet], limiter);
  } else {
    mountMcpServer(app, input, [readSet, runSet]);
  }

  const rpc = mcpRpc(app);
  return { app, asked, rpc, takes };
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

  test.each(['chat-machine', 'chat-for-a-machine', 'chat-keys-operator'])(
    '%s, a token for someone other than a person: 403',
    async (token) => {
      const { rpc, asked } = harness();
      const { res, body } = await rpc(token, 'tools/list');
      expect(res.status).toBe(403);
      expect(body.error).toBe('access_denied');
      expect(body.error_description).toBe('Only a person can use Kindgi from a chat app.');
      expect(asked).toEqual([]);
    },
  );

  // Served without its limit, the token would reach more than it was given.
  test.each(['chat-one-project', 'chat-reviewer', 'chat-idle-limit'])(
    '%s, a person with a limit the tools can not keep: 403',
    async (token) => {
      const { rpc, asked } = harness();
      const { res, body } = await rpc(token, 'tools/call', { name: 'probe_tenant', arguments: {} });
      expect(res.status).toBe(403);
      expect(body.error).toBe('access_denied');
      expect(body.error_description).toContain("can't keep this token's limits");
      expect(asked).toEqual([]);
    },
  );

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

describe("/mcp: the tenant's API requests a minute", () => {
  const BUSY =
    /^Kindgi is busy: this workspace has reached its limit on requests a minute, so nothing was done\. Try again in \d+ seconds?\.$/;
  const probe = { name: 'probe_tenant', arguments: {} };

  test("each message counts once, and its tools' /v1 requests count on it", async () => {
    const { rpc, asked, takes } = harness({ perMinute: 600 });
    await rpc('chat-read', 'ping');
    await rpc('chat-read', 'tools/list');
    const { body } = await rpc('chat-read', 'tools/call', probe);
    // The tool's /v1 request went through the route: the stand-in refused it.
    expect(body.result.structuredContent.status).toBe(403);
    expect(asked).toHaveLength(1);
    expect(takes).toEqual(Array.from({ length: 3 }, () => `tenant-limit:api-requests:${tenantId}`));
  });

  test("past a message's cover, each of its /v1 requests counts as any request does", async () => {
    const { rpc } = harness({ perMinute: 4 });
    const { body } = await rpc('chat-read', 'tools/call', { name: 'probe_often', arguments: {} });
    const statuses = body.result.structuredContent.statuses as number[];
    // One for the message, and the minute's other 3 for the calls past the cover.
    expect(statuses.slice(0, MCP_CALLS_PER_MESSAGE + 3)).not.toContain(429);
    expect(statuses.slice(MCP_CALLS_PER_MESSAGE + 3)).toEqual([429, 429]);
  });

  test('a request from the network never rides a cover, whatever it sends, and none carries over from /mcp', async () => {
    const { app, rpc } = harness({ perMinute: 3 });
    // One count, and most of its cover left when the request ends.
    await rpc('chat-read', 'tools/call', probe);
    const forged = () =>
      app.request('/v1/tenant', {
        headers: {
          authorization: 'Bearer api-key',
          'x-request-id': 'req-test',
          'kindgi.in-process-caller': 'alice',
          'x-kindgi-in-process': '1',
          'x-kindgi-cover': '40',
        },
      });
    expect((await forged()).status).not.toBe(429);
    expect((await forged()).status).not.toBe(429);
    const refused = await forged();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });

  test.each(['2025-11-25', '2026-07-28'] as const)(
    'past the limit, a tool call answers that Kindgi is busy and when to try again, and reads nothing (%s)',
    async (version) => {
      const { rpc, asked } = harness({ perMinute: 1 });
      await rpc('chat-read', 'ping', {}, version);
      const { res, body } = await rpc('chat-read', 'tools/call', probe, version);
      expect(res.status).toBe(200);
      expect(body.result.isError).toBe(true);
      expect(body.result.content).toHaveLength(1);
      const text = body.result.content[0].text as string;
      expect(text).toMatch(BUSY);
      const seconds = Number(/in (\d+) second/.exec(text)?.[1]);
      expect(seconds).toBeGreaterThanOrEqual(1);
      expect(seconds).toBeLessThanOrEqual(60);
      expect(asked).toEqual([]);
    },
  );

  test("past the limit, any other message gets the API's 429 with Retry-After", async () => {
    const { rpc } = harness({ perMinute: 1 });
    await rpc('chat-read', 'ping');
    for (const method of ['tools/list', 'ping']) {
      const { res, body } = await rpc('chat-read', method);
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(body.error).toMatchObject({
        code: 'rate-limit-exceeded',
        details: { limit: 'api-requests' },
      });
    }
  });

  test('a batch counts each of its messages', async () => {
    const { app, takes } = harness({ perMinute: 600 });
    await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-03-26',
        authorization: 'Bearer chat-read',
      },
      body: JSON.stringify([1, 2, 3].map((id) => ({ jsonrpc: '2.0', id, method: 'ping' }))),
    });
    expect(takes).toHaveLength(3);
  });

  test("createApp's tenantLimits count /mcp too", async () => {
    const stubs = createStubAppBindings();
    const app = createApp({
      ...stubs,
      resolveToken: async () => null,
      runHandler: {} as RunHandlerBinding,
      tenantHierarchyBinding: {
        ...stubs.tenantHierarchyBinding,
        getTenant: async (id: TenantId) => ({
          id,
          name: 'Acme',
          slug: 'acme',
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
          limits: { apiRequestsPerMinute: 1 },
        }),
      },
      tenantLimits: {},
      mcpServer: {
        resolveToken: async (token) => CHAT[token]?.() ?? null,
        resourceMetadataUrl: RESOURCE_METADATA,
        version: '0.0.0-test',
      },
    });
    const rpc = mcpRpc(app);
    expect((await rpc('chat-read', 'ping')).res.status).toBe(200);
    expect((await rpc('chat-read', 'tools/list')).res.status).toBe(429);
  });
});
