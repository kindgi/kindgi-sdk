// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

const WIRE_ENDPOINT = {
  endpointId: 'mcp-1',
  name: 'Local scratch server',
  transport: 'stdio' as const,
  config: { transport: 'stdio', command: 'node', args: ['./server.js'] },
};

describe('mcp.endpoints.list', () => {
  it('GETs /v1/mcp/endpoints with transport filter', async () => {
    const stub = jsonFetch({ data: [WIRE_ENDPOINT], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.mcp.endpoints.list({ transport: 'stdio' });
    expect(page.items[0]?.endpointId).toBe('mcp-1');
    const url = new URL(stub.calls[0]?.url);
    expect(url.pathname).toBe('/v1/mcp/endpoints');
    expect(url.searchParams.get('transport')).toBe('stdio');
  });
});

describe('mcp.endpoints.register', () => {
  it('POSTs /v1/mcp/endpoints with body + Idempotency-Key', async () => {
    const stub = jsonFetch({ endpointId: 'mcp-1' }, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const result = await client.mcp.endpoints.register(
      {
        endpointId: 'mcp-1',
        name: 'Local scratch server',
        transport: 'stdio',
        config: { transport: 'stdio', command: 'node', args: ['./server.js'] },
        scope: { kind: 'project', tenantId: 'tenant-1' as never, projectId: 'proj-42' as never },
      },
      { idempotencyKey: 'idem-mcp' },
    );

    expect(result.endpointId).toBe('mcp-1');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/mcp/endpoints');
    expect(req.headers['idempotency-key']).toBe('idem-mcp');
    expect(JSON.parse(req.body!)).toEqual({
      endpointId: 'mcp-1',
      name: 'Local scratch server',
      transport: 'stdio',
      config: { transport: 'stdio', command: 'node', args: ['./server.js'] },
      scopeKind: 'project',
      scopeId: 'proj-42',
    });
  });

  it('sends a tenant scope as scopeKind alone', async () => {
    const stub = jsonFetch({ endpointId: 'mcp-1' }, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.mcp.endpoints.register({
      endpointId: 'mcp-1',
      name: 'Local scratch server',
      transport: 'stdio',
      config: { transport: 'stdio', command: 'node' },
      scope: { kind: 'tenant', tenantId: 'tenant-1' as never },
    });

    const body = JSON.parse(stub.calls[0]!.body!);
    expect(body.scopeKind).toBe('tenant');
    expect(body).not.toHaveProperty('scopeId');
    expect(body).not.toHaveProperty('scope');
  });
});

describe('mcp.endpoints.get', () => {
  it('GETs /v1/mcp/endpoints/{endpointId}', async () => {
    const stub = jsonFetch(WIRE_ENDPOINT);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const e = await client.mcp.endpoints.get('mcp-1');
    expect(e.transport).toBe('stdio');
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/mcp/endpoints/mcp-1');
  });

  it('maps 404 to NotFoundError', async () => {
    const stub = errorFetch(404, { code: 'not-found', message: 'no such endpoint' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.mcp.endpoints.get('mcp-x')).rejects.toMatchObject({
      error: { code: 'not-found' },
    });
  });
});

describe('mcp.endpoints.unregister', () => {
  it('POSTs /v1/mcp/endpoints/{endpointId}/unregister and resolves void', async () => {
    const stub = jsonFetch({ endpointId: 'mcp-1', unregistered: true });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.mcp.endpoints.unregister('mcp-1', { idempotencyKey: 'idem-u' });
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/mcp/endpoints/mcp-1/unregister');
    expect(req.headers['idempotency-key']).toBe('idem-u');
  });
});

describe('mcp not-yet-wired surface', () => {
  it('serverInfo / tools / agents / invokeTool / invokeAgent throw not-yet-wired', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.mcp.serverInfo()).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'mcp.serverInfo' },
    });
    await expect(client.mcp.tools()).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'mcp.tools' },
    });
    await expect(client.mcp.agents()).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'mcp.agents' },
    });
    await expect(client.mcp.invokeTool('x', {})).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'mcp.invokeTool' },
    });
    await expect(client.mcp.invokeAgent('a' as never, {})).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'mcp.invokeAgent' },
    });
    expect(stub.calls.length).toBe(0);
  });
});
