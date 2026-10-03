// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

const WIRE_TOOL = {
  id: 'acme.verify-citation',
  description: 'Verify a legal citation',
  version: '1.0.0',
  input: { type: 'object' },
  output: { type: 'object' },
};

describe('tools.list', () => {
  it('GETs /v1/tools with name/limit filters and returns Page', async () => {
    const stub = jsonFetch({ data: [WIRE_TOOL], hasMore: true, nextCursor: 'cur-1' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.tools.list({ name: 'acme.', limit: 10 });
    expect(page.items[0]?.id).toBe('acme.verify-citation');
    expect(page.nextCursor).toBe('cur-1');
    const url = new URL(stub.calls[0]?.url);
    expect(url.searchParams.get('name')).toBe('acme.');
    expect(url.searchParams.get('limit')).toBe('10');
  });
});

describe('tools.get', () => {
  it('GETs /v1/tools/{toolId}', async () => {
    const stub = jsonFetch(WIRE_TOOL);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const tool = await client.tools.get('acme.verify-citation' as never);
    expect(tool.id).toBe('acme.verify-citation');
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/tools/acme.verify-citation');
  });

  it('maps 404 tool-not-found to NotFoundError', async () => {
    const stub = errorFetch(404, {
      code: 'tool-not-found',
      message: 'not found',
      details: { toolId: 'x.y' },
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.tools.get('x.y' as never)).rejects.toMatchObject({
      error: { code: 'not-found', resource: { kind: 'tool', id: 'x.y' } },
    });
  });
});

describe('tools.listVersions', () => {
  it('GETs /v1/tools/{toolId}/versions with pagination params', async () => {
    const stub = jsonFetch({
      data: [
        { ...WIRE_TOOL, version: '2.0.0' },
        { ...WIRE_TOOL, version: '1.0.0' },
      ],
      hasMore: false,
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.tools.listVersions('acme.verify-citation' as never, { limit: 5 });
    expect(page.items.map((t) => (t as { version: string }).version)).toEqual(['2.0.0', '1.0.0']);
    const url = new URL(stub.calls[0]?.url);
    expect(url.pathname).toBe('/v1/tools/acme.verify-citation/versions');
    expect(url.searchParams.get('limit')).toBe('5');
  });
});

describe('tools.getVersion', () => {
  it('GETs /v1/tools/{toolId}/versions/{version}', async () => {
    const stub = jsonFetch({ ...WIRE_TOOL, version: '1.0.0' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const tool = await client.tools.getVersion('acme.verify-citation' as never, '1.0.0');
    expect((tool as { version: string }).version).toBe('1.0.0');
    expect(stub.calls[0]?.url).toBe(
      'https://api.example.com/v1/tools/acme.verify-citation/versions/1.0.0',
    );
  });
});

describe('tools.reinstateVersion', () => {
  it('POSTs to /v1/tools/{toolId}/versions/{version}/reinstate and returns wasTombstoned', async () => {
    const stub = jsonFetch({
      toolId: 'acme.verify-citation',
      version: '1.0.0',
      wasTombstoned: true,
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const result = await client.tools.reinstateVersion('acme.verify-citation' as never, '1.0.0');
    expect(result.wasTombstoned).toBe(true);
    expect(result.version).toBe('1.0.0');
    const call = stub.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(
      'https://api.example.com/v1/tools/acme.verify-citation/versions/1.0.0/reinstate',
    );
  });

  it('honors Idempotency-Key on reinstate', async () => {
    const stub = jsonFetch({
      toolId: 'acme.verify-citation',
      version: '1.0.0',
      wasTombstoned: false,
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.tools.reinstateVersion('acme.verify-citation' as never, '1.0.0', {
      idempotencyKey: 'reinstate-once',
    });
    expect(stub.calls[0]?.headers['idempotency-key']).toBe('reinstate-once');
  });
});

describe('tools.invoke / tools.manifests (not yet wired)', () => {
  it('invoke throws not-yet-wired without hitting the network', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.tools.invoke('x' as never, {})).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'tools.invoke' },
    });
    expect(stub.calls.length).toBe(0);
  });

  it('manifests throws not-yet-wired', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.tools.manifests()).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'tools.manifests' },
    });
  });
});
