// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { type Cursor, type EnvName, type TenantId, makeEnvName } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { type TenantHostAccess, createApp } from '../src/index.js';
import type {
  MCPClientProbeBinding,
  MCPEndpoint,
  MCPEndpointRegistryBinding,
  MCPTransport,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

/**
 * MCP-endpoint route tests. The registry is caller-plugged;
 * these tests back it with an in-memory `Map`-based adapter. Full CRUD
 * plus the transport filter + validation error surfaces.
 */

const tenantId = randomUUID() as TenantId;
const TOKEN = 'mcp-token-abc';

const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN) return { tenantId };
  return null;
};

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
  invokeFlow: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
  resumeRun: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
};

function stdioEndpoint(overrides: Partial<MCPEndpoint> = {}): MCPEndpoint {
  return {
    endpointId: overrides.endpointId ?? 'acme.docs',
    name: overrides.name ?? 'Legal MCP',
    transport: 'stdio',
    config: overrides.config ?? {
      transport: 'stdio',
      command: '/usr/local/bin/legal-mcp',
      args: ['--stdio'],
    },
    ...(overrides.secretRef !== undefined && { secretRef: overrides.secretRef }),
    ...(overrides.instructions !== undefined && { instructions: overrides.instructions }),
    ...(overrides.metadata !== undefined && { metadata: overrides.metadata }),
  };
}

function makeInMemoryBinding(): MCPEndpointRegistryBinding {
  const store = new Map<string, MCPEndpoint>();

  function paginate(
    rows: readonly MCPEndpoint[],
    limit: number,
    cursor: Cursor | undefined,
  ): { data: readonly MCPEndpoint[]; nextCursor?: Cursor } {
    let startAt = 0;
    if (cursor !== undefined) {
      const cur = cursor as unknown as string;
      startAt = rows.findIndex((row) => row.endpointId > cur);
      if (startAt < 0) startAt = rows.length;
    }
    const slice = rows.slice(startAt, startAt + limit);
    const last = slice[slice.length - 1];
    const hasMore = startAt + slice.length < rows.length;
    return {
      data: slice,
      ...(hasMore && last !== undefined && { nextCursor: last.endpointId as unknown as Cursor }),
    };
  }

  return {
    async list({ limit, cursor, transportFilter }) {
      const sorted = [...store.values()].sort((a, b) => a.endpointId.localeCompare(b.endpointId));
      const filtered =
        transportFilter === undefined
          ? sorted
          : sorted.filter((e) => e.transport === transportFilter);
      return paginate(filtered, limit, cursor);
    },
    async get({ endpointId }) {
      return store.get(endpointId) ?? null;
    },
    async register({ endpoint }) {
      if (store.has(endpoint.endpointId)) {
        return { kind: 'already-registered', endpointId: endpoint.endpointId };
      }
      store.set(endpoint.endpointId, endpoint);
      return { kind: 'ok', endpointId: endpoint.endpointId };
    },
    async unregister({ endpointId }) {
      return { unregistered: store.delete(endpointId) };
    },
  };
}

/** `local` by default: most of this suite registers stdio endpoints to exercise the routes. */
function makeApp(tenantHostAccess: TenantHostAccess = 'local') {
  const binding = makeInMemoryBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    mcpEndpointRegistry: binding,
    tenantHostAccess,
  });
  return { app, binding };
}

describe('API — mcp endpoints list', () => {
  test('empty registry → empty list', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/mcp/endpoints', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; hasMore: boolean };
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  test('transport filter narrows results', async () => {
    const { app, binding } = makeApp();
    await binding.register({
      tenantId,
      scope: { kind: 'tenant', tenantId },
      endpoint: stdioEndpoint({ endpointId: 'acme.stdio' }),
      enqueueTuples: () => [],
    });
    await binding.register({
      tenantId,
      scope: { kind: 'tenant', tenantId },
      endpoint: {
        endpointId: 'weather.http',
        name: 'Weather',
        transport: 'streamable-http',
        config: { transport: 'streamable-http', url: 'https://mcp.example.com/weather' },
      },
      enqueueTuples: () => [],
    });

    const res = await app.request('/v1/mcp/endpoints?transport=stdio', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ endpointId: string }> };
    expect(body.data.map((e) => e.endpointId)).toEqual(['acme.stdio']);
  });

  test('invalid transport filter → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/mcp/endpoints?transport=carrier-pigeon', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });
});

describe('API — mcp endpoints register + get', () => {
  test('register + get roundtrip preserves secretRef and metadata', async () => {
    const { app } = makeApp();
    const spec = {
      ...stdioEndpoint({
        endpointId: 'acme.stdio',
        secretRef: { envName: makeEnvName('production') as EnvName, name: 'legal-mcp-token' },
        instructions: 'Legal document MCP server',
        metadata: { owner: 'legal-team' },
      }),
      scopeKind: 'tenant',
    };
    const register = await app.request('/v1/mcp/endpoints', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(spec),
    });
    expect(register.status).toBe(201);
    const registered = (await register.json()) as { endpointId: string };
    expect(registered.endpointId).toBe('acme.stdio');

    const get = await app.request('/v1/mcp/endpoints/acme.stdio', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(200);
    const body = (await get.json()) as MCPEndpoint;
    expect(body.endpointId).toBe('acme.stdio');
    expect(body.transport).toBe('stdio');
    expect(body.secretRef).toEqual({ envName: 'production', name: 'legal-mcp-token' });
    expect(body.instructions).toBe('Legal document MCP server');
    expect(body.metadata).toEqual({ owner: 'legal-team' });
    if (body.config.transport === 'stdio') {
      expect(body.config.command).toBe('/usr/local/bin/legal-mcp');
    }
  });

  test('register twice same id → 409 mcp-endpoint-already-registered', async () => {
    const { app } = makeApp();
    const spec = { ...stdioEndpoint(), scopeKind: 'tenant' };
    const first = await app.request('/v1/mcp/endpoints', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(spec),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v1/mcp/endpoints', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(spec),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('mcp-endpoint-already-registered');
  });

  test('idempotency-key retry replays 201', async () => {
    const { app } = makeApp();
    const key = randomUUID();
    const first = await app.request('/v1/mcp/endpoints', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify({ ...stdioEndpoint(), scopeKind: 'tenant' }),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v1/mcp/endpoints', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify({ ...stdioEndpoint(), scopeKind: 'tenant' }),
    });
    expect(second.status).toBe(201);
    expect(second.headers.get('X-Idempotent-Replay')).toBe('true');
  });

  test('unknown transport → 400 invalid-mcp-endpoint', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/mcp/endpoints', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...stdioEndpoint(),
        transport: 'nope' as MCPTransport,
        config: { transport: 'nope', command: '/nope' },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe('invalid-mcp-endpoint');
    expect(body.error.details?.reason).toBe('unknown-transport');
  });

  test('config-transport ↔ top-level mismatch → 400 invalid-mcp-endpoint', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/mcp/endpoints', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        endpointId: 'mismatch',
        name: 'Mismatch',
        transport: 'stdio',
        config: { transport: 'streamable-http', url: 'https://x' },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe('invalid-mcp-endpoint');
    expect(body.error.details?.reason).toBe('config-transport-mismatch');
  });

  test('missing stdio command → 400 invalid-mcp-endpoint', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/mcp/endpoints', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        endpointId: 'nocmd',
        name: 'No command',
        transport: 'stdio',
        config: { transport: 'stdio' },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe('invalid-mcp-endpoint');
    expect(body.error.details?.reason).toBe('invalid-stdio-command');
  });

  test('missing http url → 400 invalid-mcp-endpoint', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/mcp/endpoints', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        endpointId: 'nourl',
        name: 'No URL',
        transport: 'streamable-http',
        config: { transport: 'streamable-http' },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe('invalid-mcp-endpoint');
    expect(body.error.details?.reason).toBe('invalid-streamable-http-url');
  });

  describe('sendTraceparent (logging phase 2)', () => {
    const http = {
      endpointId: 'acme.tickets',
      name: 'Tickets',
      transport: 'streamable-http',
      config: { transport: 'streamable-http', url: 'https://mcp.acme.test/mcp' },
      scopeKind: 'tenant',
    };
    const post = (app: ReturnType<typeof makeApp>['app'], body: Record<string, unknown>) =>
      app.request('/v1/mcp/endpoints', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    test('on an HTTP endpoint it is stored and read back; absent, it is not there', async () => {
      const { app } = makeApp();
      expect((await post(app, { ...http, sendTraceparent: true })).status).toBe(201);
      const get = await app.request('/v1/mcp/endpoints/acme.tickets', {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(((await get.json()) as MCPEndpoint).sendTraceparent).toBe(true);
      expect((await post(app, { ...http, endpointId: 'acme.plain' })).status).toBe(201);
      const plain = await app.request('/v1/mcp/endpoints/acme.plain', {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(((await plain.json()) as MCPEndpoint).sendTraceparent).toBeUndefined();
    });

    test('not a boolean, or true on a stdio endpoint → 400 invalid-mcp-endpoint', async () => {
      const { app } = makeApp();
      for (const body of [
        { ...http, sendTraceparent: 'yes' },
        { ...stdioEndpoint(), scopeKind: 'tenant', sendTraceparent: true },
      ]) {
        const res = await post(app, body);
        expect(res.status).toBe(400);
        const error = (
          (await res.json()) as { error: { code: string; details?: { reason?: string } } }
        ).error;
        expect([error.code, error.details?.reason]).toEqual([
          'invalid-mcp-endpoint',
          'invalid-send-traceparent',
        ]);
      }
    });
  });

  test('non-JSON body → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/mcp/endpoints', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });

  test('unknown id → 404 mcp-endpoint-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/mcp/endpoints/nope', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('mcp-endpoint-not-found');
  });
});

describe('API — tenant host access (KINDGI_TENANT_HOST_ACCESS)', () => {
  const register = (app: ReturnType<typeof makeApp>['app'], body: Record<string, unknown>) =>
    app.request('/v1/mcp/endpoints', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scopeKind: 'tenant', ...body }),
    });
  const http = {
    endpointId: 'acme.http',
    name: 'Docs over HTTP',
    transport: 'streamable-http',
    config: { transport: 'streamable-http', url: 'https://mcp.example.com/docs' },
  };

  test('deployed (the default): a stdio endpoint is 403 host-access-denied, and nothing is stored', async () => {
    const binding = makeInMemoryBinding();
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      mcpEndpointRegistry: binding,
    });
    const res = await register(app, { ...stdioEndpoint() });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('host-access-denied');
    expect(body.error.message).toContain('KINDGI_TENANT_HOST_ACCESS=deployed');
    expect(body.error.message).toContain('streamable-http');
    const listed = await binding.list({ tenantId, limit: 10 });
    expect(listed.data).toEqual([]);
  });

  test('deployed: an HTTP endpoint with a secretRef registers', async () => {
    const { app } = makeApp('deployed');
    const res = await register(app, {
      ...http,
      secretRef: { envName: 'production', name: 'docs-mcp-token' },
    });
    expect(res.status).toBe(201);
  });

  test('local: a stdio endpoint registers', async () => {
    const { app } = makeApp('local');
    expect((await register(app, { ...stdioEndpoint() })).status).toBe(201);
  });

  test('authRef is gone: an unknown field, refused, not ignored', async () => {
    const { app } = makeApp('deployed');
    const res = await register(app, { ...http, authRef: 'env:DOCS_TOKEN' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: { reason?: string } };
    };
    expect(body.error.code).toBe('invalid-mcp-endpoint');
    expect(body.error.details?.reason).toBe('unknown-field');
    expect(body.error.message).toBe('Unknown field `authRef`');
  });

  test('a malformed secretRef is refused, naming the field', async () => {
    const { app } = makeApp('deployed');
    for (const [secretRef, expected] of [
      ['env:DOCS_TOKEN', '`secretRef` must be an object'],
      [{ envName: 'Production', name: 'x' }, '`secretRef.envName` must be a lowercase name'],
      [{ envName: 'production', name: '' }, '`secretRef.name` must be a non-empty string'],
      [{ envName: 'production', name: 'x', value: 'plaintext' }, 'Unknown field `secretRef.value`'],
    ] as const) {
      const res = await register(app, { ...http, secretRef });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { message: string; details?: { reason?: string } };
      };
      expect(body.error.details?.reason).toBe('invalid-secret-ref');
      expect(body.error.message).toContain(expected);
    }
  });
});

describe('API — mcp endpoints unregister', () => {
  test('unregister known → 200, then get 404', async () => {
    const { app, binding } = makeApp();
    await binding.register({
      tenantId,
      scope: { kind: 'tenant', tenantId },
      endpoint: stdioEndpoint(),
      enqueueTuples: () => [],
    });
    const res = await app.request('/v1/mcp/endpoints/acme.docs/unregister', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { endpointId: string; unregistered: boolean };
    expect(body.endpointId).toBe('acme.docs');
    expect(body.unregistered).toBe(true);

    const get = await app.request('/v1/mcp/endpoints/acme.docs', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(404);
  });

  test('unregister unknown → 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/mcp/endpoints/nope/unregister', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('API — mcp surface unmounted when no binding supplied', () => {
  test('no mcpEndpointRegistry binding → routes 404', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/mcp/endpoints', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

// ---------- resources + prompts routes ----------

function makeClientProbe(): MCPClientProbeBinding {
  return {
    async listResources({ endpointId }) {
      if (endpointId === 'missing') return { kind: 'endpoint-not-found' };
      if (endpointId === 'broken') return { kind: 'protocol-error', message: 'unreachable' };
      return {
        kind: 'ok',
        resources: [
          {
            uri: 'file:///readme.md',
            name: 'README',
            description: 'the readme',
            mimeType: 'text/markdown',
          },
        ],
      };
    },
    async readResource({ endpointId, uri }) {
      if (endpointId === 'missing') return { kind: 'endpoint-not-found' };
      if (uri === 'file:///nope.md') return { kind: 'resource-not-found', uri };
      if (uri === 'file:///boom.md') return { kind: 'read-failed', message: 'io' };
      return {
        kind: 'ok',
        content: { uri, mimeType: 'text/markdown', text: `contents of ${uri}` },
      };
    },
    async listPrompts({ endpointId }) {
      if (endpointId === 'missing') return { kind: 'endpoint-not-found' };
      return {
        kind: 'ok',
        prompts: [
          {
            name: 'summarize',
            description: 'summarize text',
            arguments: [
              { name: 'text', required: true },
              { name: 'style', required: false },
            ],
          },
        ],
      };
    },
    async getPrompt({ endpointId, name, args }) {
      if (endpointId === 'missing') return { kind: 'endpoint-not-found' };
      if (name === 'nope') return { kind: 'prompt-not-found', name };
      if (name === 'boom') return { kind: 'get-failed', message: 'downstream' };
      const text = args?.text ?? '<none>';
      return {
        kind: 'ok',
        messages: [{ role: 'user', content: { type: 'text', text: `summarize: ${text}` } }],
      };
    },
  };
}

function makeAppWithProbe(): {
  app: ReturnType<typeof createApp>;
  binding: MCPEndpointRegistryBinding;
} {
  const binding = makeInMemoryBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    mcpEndpointRegistry: binding,
    mcpClientProbe: makeClientProbe(),
  });
  return { app, binding };
}

describe('API — mcp resources routes', () => {
  test('GET /v1/mcp/endpoints/:id/resources → 200 with descriptors', async () => {
    const { app } = makeAppWithProbe();
    const res = await app.request('/v1/mcp/endpoints/acme.docs/resources', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ uri: string; name: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.uri).toBe('file:///readme.md');
  });

  test('GET /v1/mcp/endpoints/:id/resources → 404 when endpoint missing', async () => {
    const { app } = makeAppWithProbe();
    const res = await app.request('/v1/mcp/endpoints/missing/resources', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('mcp-endpoint-not-found');
  });

  test('GET /v1/mcp/endpoints/:id/resources → 502 on upstream failure', async () => {
    const { app } = makeAppWithProbe();
    const res = await app.request('/v1/mcp/endpoints/broken/resources', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('mcp-resource-read-failed');
  });

  test('GET /v1/mcp/endpoints/:id/resources/:uri → 200 with content (URL-encoded uri)', async () => {
    const { app } = makeAppWithProbe();
    const uri = encodeURIComponent('file:///readme.md');
    const res = await app.request(`/v1/mcp/endpoints/acme.docs/resources/${uri}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uri: string; text: string };
    expect(body.uri).toBe('file:///readme.md');
    expect(body.text).toContain('contents of file:///readme.md');
  });

  test('GET /v1/mcp/endpoints/:id/resources/:uri → 404 for unknown uri', async () => {
    const { app } = makeAppWithProbe();
    const uri = encodeURIComponent('file:///nope.md');
    const res = await app.request(`/v1/mcp/endpoints/acme.docs/resources/${uri}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('mcp-resource-not-found');
  });

  test('resources routes 404 with mcp-endpoint-not-found when probe unbound', async () => {
    const binding = makeInMemoryBinding();
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      mcpEndpointRegistry: binding,
    });
    const res = await app.request('/v1/mcp/endpoints/x/resources', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('mcp-endpoint-not-found');
  });
});

describe('API — mcp prompts routes', () => {
  test('GET /v1/mcp/endpoints/:id/prompts → 200 with descriptors', async () => {
    const { app } = makeAppWithProbe();
    const res = await app.request('/v1/mcp/endpoints/acme.docs/prompts', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ name: string; arguments?: Array<{ required?: boolean }> }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.name).toBe('summarize');
    expect(body.data[0]?.arguments?.[0]?.required).toBe(true);
  });

  test('POST /v1/mcp/endpoints/:id/prompts/:name → 200 with messages (with args)', async () => {
    const { app } = makeAppWithProbe();
    const res = await app.request('/v1/mcp/endpoints/acme.docs/prompts/summarize', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ arguments: { text: 'hello' } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ role: string; content: { type: string; text: string } }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.content.text).toBe('summarize: hello');
  });

  test('POST /v1/mcp/endpoints/:id/prompts/:name → 200 with no body', async () => {
    const { app } = makeAppWithProbe();
    const res = await app.request('/v1/mcp/endpoints/acme.docs/prompts/summarize', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  test('POST /v1/mcp/endpoints/:id/prompts/:name → 404 for unknown prompt name', async () => {
    const { app } = makeAppWithProbe();
    const res = await app.request('/v1/mcp/endpoints/acme.docs/prompts/nope', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('mcp-prompt-not-found');
  });

  test('POST /v1/mcp/endpoints/:id/prompts/:name → 502 on upstream failure', async () => {
    const { app } = makeAppWithProbe();
    const res = await app.request('/v1/mcp/endpoints/acme.docs/prompts/boom', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('mcp-prompt-get-failed');
  });

  test('POST /v1/mcp/endpoints/:id/prompts/:name → 400 for non-string argument values', async () => {
    const { app } = makeAppWithProbe();
    const res = await app.request('/v1/mcp/endpoints/acme.docs/prompts/summarize', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ arguments: { text: 42 } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });
});

// -------------------- scope filter --------------------

describe('API — mcp endpoints scope filter', () => {
  function makeSpy() {
    const inner = makeInMemoryBinding();
    let lastListInput: Parameters<MCPEndpointRegistryBinding['list']>[0] | null = null;
    const spy: MCPEndpointRegistryBinding = {
      ...inner,
      async list(input) {
        lastListInput = input;
        return inner.list(input);
      },
    };
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      mcpEndpointRegistry: spy,
    });
    return { app, getLastInput: (): typeof lastListInput => lastListInput };
  }

  test('?scopeKind=project&scopeId=<uuid> → binding receives project scope', async () => {
    const { app, getLastInput } = makeSpy();
    const projectId = randomUUID();
    const res = await app.request(`/v1/mcp/endpoints?scopeKind=project&scopeId=${projectId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toEqual({ kind: 'project', tenantId, projectId });
  });

  test('?scopeKind=org&scopeId=<uuid> → binding receives org scope', async () => {
    const { app, getLastInput } = makeSpy();
    const orgId = randomUUID();
    const res = await app.request(`/v1/mcp/endpoints?scopeKind=org&scopeId=${orgId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toEqual({ kind: 'org', tenantId, orgId });
  });

  test('no scope params → binding receives scope=undefined and inherit=undefined', async () => {
    const { app, getLastInput } = makeSpy();
    const res = await app.request('/v1/mcp/endpoints', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toBeUndefined();
    expect(getLastInput()?.inherit).toBeUndefined();
  });

  test('?scopeKind=tenant&scopeId=<uuid> → 400 scope-invalid', async () => {
    const { app } = makeSpy();
    const res = await app.request(`/v1/mcp/endpoints?scopeKind=tenant&scopeId=${randomUUID()}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('scope-invalid');
  });

  // mcp-only extra: inherit is LOAD-BEARING here (policy/config-scoped).
  test('?inherit=false → binding receives inherit=false (load-bearing for policy/config-scoped)', async () => {
    const { app, getLastInput } = makeSpy();
    const projectId = randomUUID();
    const res = await app.request(
      `/v1/mcp/endpoints?scopeKind=project&scopeId=${projectId}&inherit=false`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toEqual({ kind: 'project', tenantId, projectId });
    expect(getLastInput()?.inherit).toBe(false);
  });

  test('?inherit=true (explicit) → binding receives inherit=true', async () => {
    const { app, getLastInput } = makeSpy();
    const res = await app.request('/v1/mcp/endpoints?inherit=true', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.inherit).toBe(true);
  });
});
