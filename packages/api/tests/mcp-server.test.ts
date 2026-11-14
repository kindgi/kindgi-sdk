// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/mcp`: its own token check (401s that say where to sign in), the chat
 * scopes, and each tool's `/v1` request in this process as the person,
 * narrowed to the token's scopes and to the routes its tool set declared.
 * Both MCP eras (2025's `initialize`, 2026-07-28 per request), with the
 * library's checks, and the revision on each request's log line.
 * Test-only tool sets; a stand-in authorization check that records who asked.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
} from '@modelcontextprotocol/server';
import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, Principal, ResourceRef } from '@kindgi/authz';
import { createLogger } from '@kindgi/log';
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
  const lines: string[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    // The API's own tokens: none of the chat ones.
    resolveToken: async (token) => (token === 'api-key' ? { tenantId } : null),
    runHandler: {} as RunHandlerBinding,
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
    logger: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
  });
  const input: McpServerInput = {
    resolveToken: async (token) => CHAT[token]?.() ?? null,
    resourceMetadataUrl: RESOURCE_METADATA,
    version: '0.0.0-test',
    ...(options.consoleUrl !== undefined && { consoleUrl: options.consoleUrl }),
  };
  mountMcpServer(app, input, [readSet, runSet]);

  const rpc = mcpRpc(app);
  /** Each `/mcp` request's access line. */
  const access = () =>
    lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.route === '/mcp');
  return { app, asked, rpc, access };
}

const toolNames = (body: Record<string, any>) =>
  (body.result.tools as { name: string }[]).map((t) => t.name).sort();

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

describe('/mcp: both eras', () => {
  // The handshake the chat apps open with, sent as they send it: no
  // MCP-Protocol-Version yet.
  test.each(['2025-11-25', '2025-06-18', '2025-03-26'])(
    'a %s initialize is answered in its revision, with no session',
    async (version) => {
      const { rpc, access } = harness();
      const { res, body } = await rpc(
        'chat-read',
        'initialize',
        {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: 'chat', version: '1.0.0' },
        },
        '2025-11-25',
        { headers: { 'mcp-protocol-version': null } },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('mcp-session-id')).toBeNull();
      expect(body.result.protocolVersion).toBe(version);
      expect(body.result.serverInfo).toMatchObject({ name: 'kindgi', version: '0.0.0-test' });
      expect(body.result.instructions).toMatch(/^Kindgi runs a workspace's agents\./);
      expect(body.result.capabilities.tools.listChanged).toBe(false);
      expect(body.result.capabilities.resources.listChanged).toBe(false);
      expect(access()).toEqual([
        expect.objectContaining({ status: 200, mcpProtocolVersion: 'none', mcpEra: 'legacy' }),
      ]);
    },
  );

  test('a 2025 tools/list without MCP-Protocol-Version is served', async () => {
    const { rpc } = harness();
    const { res, body } = await rpc('chat-read', 'tools/list', {}, '2025-11-25', {
      headers: { 'mcp-protocol-version': null },
    });
    expect(res.status).toBe(200);
    expect(toolNames(body)).toEqual(['probe_elsewhere', 'probe_tenant']);
  });

  test('a 2026-07-28 server/discover names its revisions, the server and its instructions', async () => {
    const { rpc, access } = harness();
    const { res, body } = await rpc('chat-read', 'server/discover', {}, '2026-07-28');
    expect(res.status).toBe(200);
    expect(body.result.supportedVersions).toEqual(['2026-07-28']);
    expect(body.result._meta[SERVER_INFO_META_KEY]).toMatchObject({
      name: 'kindgi',
      version: '0.0.0-test',
    });
    expect(body.result.instructions).toMatch(/^Kindgi runs a workspace's agents\./);
    expect(access()).toEqual([
      expect.objectContaining({ status: 200, mcpProtocolVersion: '2026-07-28', mcpEra: 'modern' }),
    ]);
  });

  test('a 2026-07-28 tools/call naming its tool in Mcp-Name runs it', async () => {
    const { rpc, asked } = harness();
    const { res, body } = await rpc(
      'chat-read',
      'tools/call',
      { name: 'probe_tenant', arguments: {} },
      '2026-07-28',
    );
    expect(res.status).toBe(200);
    expect(body.result.structuredContent.status).toBe(403);
    expect(asked).toHaveLength(1);
  });

  test('2026-07-28 answers are never kept by a cache, and open no session', async () => {
    const { rpc } = harness();
    for (const method of ['server/discover', 'tools/list']) {
      const { res } = await rpc('chat-read', method, {}, '2026-07-28');
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.headers.get('mcp-session-id')).toBeNull();
    }
  });

  test('the log line says a revision that is not a date as other', async () => {
    const { rpc, access } = harness();
    await rpc('chat-read', 'tools/list', {}, '2025-11-25', {
      headers: { 'mcp-protocol-version': 'latest' },
    });
    expect(access()).toEqual([expect.objectContaining({ mcpProtocolVersion: 'other' })]);
  });
});

describe("/mcp: the library's checks, before any tool", () => {
  test("an Mcp-Name that isn't the body's tool: 400 -32020, and nothing runs", async () => {
    const { rpc, asked } = harness();
    const { res, body } = await rpc(
      'chat-run',
      'tools/call',
      { name: 'probe_tenant', arguments: {} },
      '2026-07-28',
      { headers: { 'mcp-name': 'probe_run' } },
    );
    expect(res.status).toBe(400);
    expect(body.error.code).toBe(-32020);
    expect(asked).toEqual([]);
  });

  test.each([
    ['Mcp-Method', { 'mcp-method': null }],
    ['MCP-Protocol-Version', { 'mcp-protocol-version': null }],
  ])('a 2026-07-28 request without %s: 400 -32020', async (_, headers) => {
    const { rpc } = harness();
    const { res, body } = await rpc('chat-read', 'tools/list', {}, '2026-07-28', { headers });
    expect(res.status).toBe(400);
    expect(body.error.code).toBe(-32020);
  });

  test('a revision it does not serve: 400 -32022, naming 2026-07-28', async () => {
    const { rpc } = harness();
    const { res, body } = await rpc('chat-read', 'tools/list', {}, '2026-07-28', {
      headers: { 'mcp-protocol-version': '2099-01-01' },
      metaVersion: '2099-01-01',
    });
    expect(res.status).toBe(400);
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.supported).toContain('2026-07-28');
  });

  test('a batch holding a 2026-07-28 request: 400', async () => {
    const { app, asked } = harness();
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        authorization: 'Bearer chat-read',
      },
      body: JSON.stringify([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'probe_tenant',
            arguments: {},
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        },
      ]),
    });
    expect(res.status).toBe(400);
    expect(asked).toEqual([]);
  });
});

describe('/mcp: sign-in first, and no sessions', () => {
  test.each(['GET', 'DELETE'])('%s with a token: 405', async (method) => {
    const { app } = harness();
    const res = await app.request('/mcp', {
      method,
      headers: { accept: 'text/event-stream', authorization: 'Bearer chat-read' },
    });
    expect(res.status).toBe(405);
  });

  test.each(['GET', 'DELETE'])('%s without one: 401 pointing to the metadata', async (method) => {
    const { app } = harness();
    const res = await app.request('/mcp', { method, headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${RESOURCE_METADATA}"`,
    );
  });

  test('a 2026-07-28 server/discover without a token: the same 401, its revision logged', async () => {
    const { rpc, access } = harness();
    const { res, body } = await rpc(undefined, 'server/discover', {}, '2026-07-28');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${RESOURCE_METADATA}"`,
    );
    expect(body.jsonrpc).toBeUndefined();
    const [line] = access();
    expect(line).toMatchObject({ status: 401, mcpProtocolVersion: '2026-07-28' });
    // No body is read before sign-in.
    expect(line).not.toHaveProperty('mcpEra');
  });
});
