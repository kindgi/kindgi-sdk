// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The API's limits on a request body, from the tenant input bounds: its
 * size (`requestMaxBytes`, `413 request-too-large`), checked before the
 * caller is known, and how deep its JSON nests (`requestJsonMaxDepth`,
 * `400 bad-input`), checked before anything walks it.
 */

import { HOSTED_BOUNDS, SELF_HOSTED_BOUNDS } from '@kindgi/bounds';
import { overrideTenantInputBounds } from '@kindgi/bounds/testing';
import type { TenantId, UserId } from '@kindgi/types';
import { afterEach, describe, expect, test } from 'vitest';

import { createApp } from '../src/app.js';
import type { RunHandlerBinding } from '../src/index.js';
import { createStubAppBindings } from '../src/testing/app-bindings.js';

const TENANT = '00000000-0000-4000-8000-0000000000a1' as TenantId;
const MiB = 1024 * 1024;

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

function app() {
  const created = createApp({
    ...createStubAppBindings(),
    resolveToken: async (token) =>
      token === 'token-a' ? { tenantId: TENANT, userId: 'user-a' as UserId } : null,
    runHandler: {} as RunHandlerBinding,
  });
  // A write that succeeds, behind the same middleware as every /v1 route.
  created.post('/v1/echo-for-test', async (c) =>
    c.json({ length: (await c.req.text()).length }, 201),
  );
  return created;
}

/** A body streamed in `chunk`-byte pieces up to `total`, counting what was pulled. */
function counted(total: number, chunk = 64 * 1024) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= total) return controller.close();
      pulled += chunk;
      controller.enqueue(new Uint8Array(chunk).fill(0x20));
    },
  });
  return { stream, pulled: () => pulled };
}

async function send(
  path: string,
  body: string | Uint8Array | ReadableStream<Uint8Array>,
  options: { method?: string; token?: string; headers?: Record<string, string> } = {},
) {
  const res = await app().request(path, {
    method: options.method ?? 'POST',
    headers: {
      authorization: `Bearer ${options.token ?? 'token-a'}`,
      'content-type': 'application/json',
      ...options.headers,
    },
    body,
    ...(body instanceof ReadableStream && { duplex: 'half' }),
  } as RequestInit);
  const json = (await res.json()) as { readonly error?: Record<string, unknown> };
  return { status: res.status, error: json.error };
}

describe("a request body's size", () => {
  test('on hosted, a body over 2 MiB is refused, by its declared length or as it streams', async () => {
    restore = overrideTenantInputBounds(HOSTED_BOUNDS);
    const over = ' '.repeat(2 * MiB + 1);
    const refused = {
      status: 413,
      error: expect.objectContaining({ code: 'request-too-large', details: { maxBytes: 2 * MiB } }),
    };
    expect(
      await send('/v1/echo-for-test', over, { headers: { 'content-length': String(over.length) } }),
    ).toEqual(refused);
    const streamed = counted(10 * MiB);
    expect(await send('/v1/echo-for-test', streamed.stream)).toEqual(refused);
    // Read no further than the limit and the piece that passed it.
    expect(streamed.pulled()).toBeLessThanOrEqual(2 * MiB + 2 * 64 * 1024);
    expect((await send('/v1/echo-for-test', '{}')).status).toBe(201);
  });

  test("an upload's own limit covers that route alone: its neighbours answer the API's", async () => {
    restore = overrideTenantInputBounds(HOSTED_BOUNDS);
    const over = ' '.repeat(3 * MiB);
    for (const [method, path] of [
      ['PATCH', '/v1/artifacts'],
      ['POST', '/v1/artifacts/a-blob'],
      ['POST', '/v1/artifacts-for-test'],
    ] as const) {
      const r = await send(path, over, { method });
      expect(r.status).toBe(413);
      expect(r.error).toMatchObject({ code: 'request-too-large' });
    }
  });

  test('an upload from a caller who is not known is refused before its body is read', async () => {
    const upload = counted(200 * MiB);
    const r = await send('/v1/artifacts', upload.stream, {
      token: 'not-a-token',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
    });
    expect(r.status).toBe(401);
    // A stream pulls its first piece when it starts; nothing after that was read.
    expect(upload.pulled()).toBeLessThanOrEqual(64 * 1024);
  });

  test.each([
    ['PUT', '/v1/hooks/a/b'],
    ['POST', '/v1/hooks/a/b/x'],
    ['POST', '/v1/hooks/a/b/'],
    // The webhook receiver isn't mounted here.
    ['POST', '/v1/hooks/a/b'],
  ])(
    "%s %s, which no webhook receiver takes, is read under the API's limit",
    async (method, path) => {
      restore = overrideTenantInputBounds(HOSTED_BOUNDS);
      const streamed = counted(20 * MiB);
      expect(await send(path, streamed.stream, { method })).toEqual({
        status: 413,
        error: expect.objectContaining({
          code: 'request-too-large',
          details: { maxBytes: 2 * MiB },
        }),
      });
      expect(streamed.pulled()).toBeLessThanOrEqual(2 * MiB + 2 * 64 * 1024);
    },
  );

  test('on a self-hosted server, the limit is 10 MiB', async () => {
    restore = overrideTenantInputBounds(SELF_HOSTED_BOUNDS);
    expect((await send('/v1/echo-for-test', ' '.repeat(3 * MiB))).status).toBe(201);
    expect((await send('/v1/echo-for-test', ' '.repeat(10 * MiB + 1))).status).toBe(413);
  });
});

describe('how deep a JSON body nests', () => {
  const nested = (levels: number, open = '[', close = ']') =>
    `${open.repeat(levels)}${close.repeat(levels)}`;

  test.each([
    ['the hosted bounds', HOSTED_BOUNDS],
    ['the self-hosted bounds', SELF_HOSTED_BOUNDS],
  ])('past 128 levels it is refused, under %s', async (_, bounds) => {
    restore = overrideTenantInputBounds(bounds);
    expect((await send('/v1/echo-for-test', nested(128))).status).toBe(201);
    expect(await send('/v1/echo-for-test', nested(129))).toEqual({
      status: 400,
      error: expect.objectContaining({ code: 'bad-input', details: { maxDepth: 128 } }),
    });
  });

  test('objects count as arrays do, and whitespace or a byte-order mark first changes nothing', async () => {
    const objects = `${'{"a":'.repeat(129)}1${'}'.repeat(129)}`;
    expect((await send('/v1/echo-for-test', objects)).status).toBe(400);
    expect((await send('/v1/echo-for-test', ` \n\t\r${nested(129)}`)).status).toBe(400);
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(nested(129))]);
    expect((await send('/v1/echo-for-test', bom)).status).toBe(400);
  });

  test('a body that is not JSON is left to the route', async () => {
    expect((await send('/v1/echo-for-test', nested(200, '[', ''))).status).toBe(201);
    expect((await send('/v1/echo-for-test', 'name=a&b=c')).status).toBe(201);
  });
});
