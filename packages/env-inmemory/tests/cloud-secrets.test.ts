// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `createInMemoryEnvCloudSecretBinding`: env names set to a cloud secret,
 * keyed as env values are, with optimistic concurrency, name-ordered pages
 * and a delete that says whether it removed one.
 */

import { describe, expect, test } from 'vitest';

import type { Scope } from '@kindgi/platform';
import type { Cursor, EnvName, ProjectId, TenantId } from '@kindgi/types';
import { makeEnvName } from '@kindgi/types';

import { createInMemoryEnvCloudSecretBinding } from '../src/index.js';

const t = 't-1' as TenantId;
const p = 'p-1' as ProjectId;
const staging = makeEnvName('staging') as EnvName;
const production = makeEnvName('production') as EnvName;
const tenantScope: Scope = { kind: 'tenant', tenantId: t };
const projectScope: Scope = { kind: 'project', tenantId: t, projectId: p };
const PATH = 'projects/acme-prod/secrets/stripe-key/versions/3';

describe('createInMemoryEnvCloudSecretBinding', () => {
  test('set answers the record at revision 1, and get finds it at its scope and env only', async () => {
    const b = createInMemoryEnvCloudSecretBinding({ now: () => 0 });
    const out = await b.set({
      scope: projectScope,
      envName: staging,
      name: 'STRIPE_KEY',
      cloudSecret: PATH,
    });
    expect(out).toMatchObject({
      kind: 'ok',
      record: {
        name: 'STRIPE_KEY',
        cloudSecret: PATH,
        revision: 1,
        scope: projectScope,
        envName: staging,
      },
    });
    const key = { envName: staging, name: 'STRIPE_KEY' };
    expect(await b.get({ ...key, scope: projectScope })).toMatchObject({ cloudSecret: PATH });
    expect(await b.get({ ...key, scope: tenantScope })).toBeNull();
    expect(await b.get({ ...key, scope: projectScope, envName: production })).toBeNull();
  });

  test('a change moves the revision and keeps the row; a stale ifRevision is a conflict', async () => {
    const b = createInMemoryEnvCloudSecretBinding();
    const key = { scope: projectScope, envName: staging, name: 'STRIPE_KEY' };
    const first = await b.set({ ...key, cloudSecret: PATH });
    const next = PATH.replace(/3$/, '4');
    const second = await b.set({ ...key, cloudSecret: next, ifRevision: 1 });
    if (first.kind !== 'ok' || second.kind !== 'ok') throw new Error('expected ok');
    expect(second.record).toMatchObject({ cloudSecret: next, revision: 2 });
    expect(second.record.recordId).toBe(first.record.recordId);
    expect(second.record.createdAt).toBe(first.record.createdAt);
    expect(await b.set({ ...key, cloudSecret: PATH, ifRevision: 1 })).toEqual({
      kind: 'revision-conflict',
      currentRevision: 2,
    });
    // ifRevision 0 means "only if none is set".
    expect(await b.set({ ...key, name: 'OTHER', cloudSecret: PATH, ifRevision: 0 })).toMatchObject({
      kind: 'ok',
    });
    expect(await b.set({ ...key, name: 'OTHER', cloudSecret: PATH, ifRevision: 0 })).toEqual({
      kind: 'revision-conflict',
      currentRevision: 1,
    });
  });

  test('list pages in name order, the cursor being the last name', async () => {
    const b = createInMemoryEnvCloudSecretBinding();
    for (const name of ['C_KEY', 'A_KEY', 'B_KEY']) {
      await b.set({ scope: projectScope, envName: staging, name, cloudSecret: PATH });
    }
    const at = { scope: projectScope, envName: staging };
    const one = await b.list({ ...at, limit: 2 });
    expect(one.data.map((r) => r.name)).toEqual(['A_KEY', 'B_KEY']);
    expect(one.nextCursor).toBe('B_KEY' as unknown as Cursor);
    const two = await b.list({
      ...at,
      limit: 2,
      ...(one.nextCursor !== undefined && { cursor: one.nextCursor }),
    });
    expect(two.data.map((r) => r.name)).toEqual(['C_KEY']);
    expect(two.nextCursor).toBeUndefined();
    expect((await b.list({ scope: tenantScope, envName: staging, limit: 50 })).data).toEqual([]);
  });

  test('delete says whether it removed one; a second is a no-op', async () => {
    const b = createInMemoryEnvCloudSecretBinding();
    const key = { scope: projectScope, envName: staging, name: 'STRIPE_KEY' };
    await b.set({ ...key, cloudSecret: PATH });
    expect(await b.delete(key)).toEqual({ deleted: true });
    expect(await b.delete(key)).toEqual({ deleted: false });
    expect(await b.get(key)).toBeNull();
  });

  test('refuses to boot in production unless told it is safe', () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => createInMemoryEnvCloudSecretBinding()).toThrow(/refuses to boot/);
      expect(() => createInMemoryEnvCloudSecretBinding({ productionSafe: true })).not.toThrow();
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});
