// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Idempotency fingerprints a request by its body's bytes as received, the
 * same way for every caller: a key limited to a project, whose check reads
 * the body before idempotency does, included.
 */

import { createHash } from 'node:crypto';

import type { TenantId, UserId } from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import { createApp } from '../src/app.js';
import type { RunHandlerBinding } from '../src/index.js';
import {
  type IdempotencyStore,
  createInMemoryIdempotencyStore,
} from '../src/middleware/idempotency.js';
import { createStubAppBindings } from '../src/testing/app-bindings.js';

const TENANT = '00000000-0000-4000-8000-0000000000a1' as TenantId;
const PROJECT = '00000000-0000-4000-8000-0000000000b1';

/** The app, its caller's key limited to `project` when given; the fingerprints the store keeps. */
function harness(project?: string) {
  const memory = createInMemoryIdempotencyStore();
  const kept: string[] = [];
  const store: IdempotencyStore = {
    ...memory,
    set: async (key, entry) => {
      kept.push(entry.bodyHash);
      await memory.set(key, entry);
    },
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken: async () => ({
      tenantId: TENANT,
      userId: 'user-a' as UserId,
      ...(project !== undefined && { tokenProjectId: project }),
    }),
    runHandler: {} as RunHandlerBinding,
    idempotencyStore: store,
  });
  // A write that succeeds, behind the same middleware as every /v1 route.
  app.post('/v1/echo-for-test', async (c) => c.json({ received: await c.req.text() }, 201));
  async function post(body: Uint8Array | string, key = 'key-1') {
    const res = await app.request('/v1/echo-for-test', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token-a',
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body,
    });
    const json = (await res.json()) as { readonly error?: { readonly code?: string } };
    return { status: res.status, code: json.error?.code };
  }
  return { post, kept };
}

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

describe("idempotency's fingerprint is the body's bytes", () => {
  test('a key limited to a project: the same Idempotency-Key with another body is refused', async () => {
    const h = harness(PROJECT);
    expect((await h.post('{"name":"a"}')).status).toBe(201);
    const second = await h.post('{"name":"b"}');
    expect(second).toEqual({ status: 409, code: 'idempotency-key-body-mismatch' });
    expect(h.kept).toEqual([sha256('{"name":"a"}')]);
  });

  test("an ordinary key's fingerprint is sha256 of the body, as before", async () => {
    const h = harness();
    await h.post('{"name":"a"}');
    expect(h.kept).toEqual([sha256('{"name":"a"}')]);
  });

  test('bodies that differ only in bytes text decoding drops are different bodies', async () => {
    const plain = new TextEncoder().encode('{"name":"a"}');
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...plain]);
    for (const project of [undefined, PROJECT]) {
      const h = harness(project);
      await h.post(withBom);
      expect(h.kept).toEqual([sha256(withBom)]);
      expect(await h.post(plain)).toEqual({ status: 409, code: 'idempotency-key-body-mismatch' });
    }
  });
});
