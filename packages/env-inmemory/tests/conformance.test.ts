// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Conformance tests for `createInMemoryEnvBinding`. Covers the shape
 * every future `EnvBinding` adapter must honor — resolution walk,
 * cross-env refusal, grammar guards on `envName`, optimistic
 * concurrency, delete semantics.
 */

import { describe, expect, test } from 'vitest';

import type { ResolveContext } from '@kindgi/api';
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
import type { Scope } from '@kindgi/platform';
import type { OrgId, ProjectId, TenantId } from '@kindgi/types';
import { makeEnvName } from '@kindgi/types';
import type { EnvName } from '@kindgi/types';

import { createInMemoryEnvBinding } from '../src/index.js';

const t = 't-1' as TenantId;
const o = 'o-1' as OrgId;
const p = 'p-1' as ProjectId;
const staging: EnvName = makeEnvName('staging') as EnvName;
const production: EnvName = makeEnvName('production') as EnvName;

const tenantScope: Scope = { kind: 'tenant', tenantId: t };
const orgScope: Scope = { kind: 'org', tenantId: t, orgId: o };
const projectScope: Scope = { kind: 'project', tenantId: t, projectId: p };

const ctx: ResolveContext = { caller: 'dispatch' };

describe('createInMemoryEnvBinding — basic CRUD', () => {
  test('list is empty for a fresh scope', async () => {
    const b = createInMemoryEnvBinding();
    const page = await b.list({ scope: tenantScope, envName: staging, limit: 50 });
    expect(page.data).toEqual([]);
  });

  test('set + get + list round-trips at tenant scope', async () => {
    const b = createInMemoryEnvBinding();
    const outcome = await b.set({
      scope: tenantScope,
      envName: staging,
      name: 'KB_URL',
      value: 'https://kb.example.com',
      enqueueTuples: () => [],
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.record.revision).toBe(1);
    expect(outcome.record.value).toBe('https://kb.example.com');

    const got = await b.get({ scope: tenantScope, envName: staging, name: 'KB_URL' });
    expect(got?.value).toBe('https://kb.example.com');

    const page = await b.list({ scope: tenantScope, envName: staging, limit: 50 });
    expect(page.data).toHaveLength(1);
  });

  test('set overwrites and bumps revision', async () => {
    const b = createInMemoryEnvBinding();
    await b.set({
      scope: tenantScope,
      envName: staging,
      name: 'K',
      value: 'v1',
      enqueueTuples: () => [],
    });
    const second = await b.set({
      scope: tenantScope,
      envName: staging,
      name: 'K',
      value: 'v2',
      enqueueTuples: () => [],
    });
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.record.revision).toBe(2);
    expect(second.record.value).toBe('v2');
  });

  test('delete returns { deleted: true } on hit and false on miss', async () => {
    const b = createInMemoryEnvBinding();
    await b.set({
      scope: tenantScope,
      envName: staging,
      name: 'K',
      value: 'v',
      enqueueTuples: () => [],
    });
    const first = await b.delete({ scope: tenantScope, envName: staging, name: 'K' });
    expect(first.deleted).toBe(true);
    const second = await b.delete({ scope: tenantScope, envName: staging, name: 'K' });
    expect(second.deleted).toBe(false);
  });
});

describe('createInMemoryEnvBinding — resolution walk', () => {
  test('project scope wins over tenant scope when both exist', async () => {
    const b = createInMemoryEnvBinding();
    await b.set({
      scope: tenantScope,
      envName: staging,
      name: 'K',
      value: 'from-tenant',
      enqueueTuples: () => [],
    });
    await b.set({
      scope: projectScope,
      envName: staging,
      name: 'K',
      value: 'from-project',
      enqueueTuples: () => [],
    });
    const res = await b.resolve({
      scope: projectScope,
      envName: staging,
      name: 'K',
      resolveContext: ctx,
    });
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.value.value).toBe('from-project');
  });

  test('project scope falls back to tenant when project has no value', async () => {
    const b = createInMemoryEnvBinding();
    await b.set({
      scope: tenantScope,
      envName: staging,
      name: 'K',
      value: 'from-tenant',
      enqueueTuples: () => [],
    });
    const res = await b.resolve({
      scope: projectScope,
      envName: staging,
      name: 'K',
      resolveContext: ctx,
    });
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.value.value).toBe('from-tenant');
  });

  test('org scope falls back to tenant when org has no value', async () => {
    const b = createInMemoryEnvBinding();
    await b.set({
      scope: tenantScope,
      envName: staging,
      name: 'K',
      value: 'from-tenant',
      enqueueTuples: () => [],
    });
    const res = await b.resolve({
      scope: orgScope,
      envName: staging,
      name: 'K',
      resolveContext: ctx,
    });
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.value.value).toBe('from-tenant');
  });

  test('delete at project scope surfaces tenant value on next resolve', async () => {
    const b = createInMemoryEnvBinding();
    await b.set({
      scope: tenantScope,
      envName: staging,
      name: 'K',
      value: 'from-tenant',
      enqueueTuples: () => [],
    });
    await b.set({
      scope: projectScope,
      envName: staging,
      name: 'K',
      value: 'from-project',
      enqueueTuples: () => [],
    });
    await b.delete({ scope: projectScope, envName: staging, name: 'K' });
    const res = await b.resolve({
      scope: projectScope,
      envName: staging,
      name: 'K',
      resolveContext: ctx,
    });
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.value.value).toBe('from-tenant');
  });

  test('resolve of unknown name returns err env-not-found', async () => {
    const b = createInMemoryEnvBinding();
    const res = await b.resolve({
      scope: tenantScope,
      envName: staging,
      name: 'MISSING',
      resolveContext: ctx,
    });
    expect(res.kind).toBe('err');
    if (res.kind !== 'err') return;
    expect(res.error.code).toBe('env-not-found');
  });
});

describe('createInMemoryEnvBinding — cross-env safety', () => {
  test('write in staging is invisible to production reads', async () => {
    const b = createInMemoryEnvBinding();
    await b.set({
      scope: tenantScope,
      envName: staging,
      name: 'K',
      value: 'staging-value',
      enqueueTuples: () => [],
    });
    const got = await b.get({ scope: tenantScope, envName: production, name: 'K' });
    expect(got).toBeNull();
    const res = await b.resolve({
      scope: tenantScope,
      envName: production,
      name: 'K',
      resolveContext: ctx,
    });
    expect(res.kind).toBe('err');
  });

  test('list at staging never returns production entries', async () => {
    const b = createInMemoryEnvBinding();
    await b.set({
      scope: tenantScope,
      envName: staging,
      name: 'A',
      value: '1',
      enqueueTuples: () => [],
    });
    await b.set({
      scope: tenantScope,
      envName: production,
      name: 'B',
      value: '2',
      enqueueTuples: () => [],
    });
    const page = await b.list({ scope: tenantScope, envName: staging, limit: 50 });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.name).toBe('A');
  });
});

describe('createInMemoryEnvBinding — optimistic concurrency', () => {
  test('ifRevision match applies write', async () => {
    const b = createInMemoryEnvBinding();
    await b.set({
      scope: tenantScope,
      envName: staging,
      name: 'K',
      value: 'v1',
      enqueueTuples: () => [],
    });
    const outcome = await b.set({
      scope: tenantScope,
      envName: staging,
      name: 'K',
      value: 'v2',
      ifRevision: 1,
      enqueueTuples: () => [],
    });
    expect(outcome.kind).toBe('ok');
  });

  test('ifRevision mismatch returns revision-conflict', async () => {
    const b = createInMemoryEnvBinding();
    await b.set({
      scope: tenantScope,
      envName: staging,
      name: 'K',
      value: 'v1',
      enqueueTuples: () => [],
    });
    const outcome = await b.set({
      scope: tenantScope,
      envName: staging,
      name: 'K',
      value: 'v2',
      ifRevision: 99,
      enqueueTuples: () => [],
    });
    expect(outcome.kind).toBe('revision-conflict');
    if (outcome.kind !== 'revision-conflict') return;
    expect(outcome.currentRevision).toBe(1);
  });
});

describe('createInMemoryEnvBinding — envName grammar', () => {
  const bad = ['Prod', 'us_prod', 'prod.us', 'prod/us', '', 'a'.repeat(64), '1prod'];
  for (const raw of bad) {
    test(`rejects malformed envName ${JSON.stringify(raw)} at factory`, () => {
      expect(makeEnvName(raw)).toBeNull();
    });
  }
  test('accepts well-formed envNames', () => {
    expect(makeEnvName('staging')).not.toBeNull();
    expect(makeEnvName('prod-us')).not.toBeNull();
    expect(makeEnvName('a')).not.toBeNull();
    expect(makeEnvName('preview-pr-1234')).not.toBeNull();
  });
});

describe('createInMemoryEnvBinding — compliance evidence emission', () => {
  test('set + resolve + delete emit env-set / env-resolved / env-deleted', async () => {
    const auditEvents = createInMemoryAuditEventBinding();
    const b = createInMemoryEnvBinding({
      auditEvents,
      tenantId: t,
      projectId: p,
    });
    await b.set({
      scope: tenantScope,
      envName: staging,
      name: 'K',
      value: 'v1',
      enqueueTuples: () => [],
    });
    await b.resolve({ scope: tenantScope, envName: staging, name: 'K', resolveContext: ctx });
    await b.delete({ scope: tenantScope, envName: staging, name: 'K' });

    const list = await auditEvents.query({ tenantId: t });
    if (list.kind !== 'ok') throw new Error('query failed');
    const kinds = new Set(list.value.data.map((r) => r.kind));
    expect(kinds.has('env-set')).toBe(true);
    expect(kinds.has('env-resolved')).toBe(true);
    expect(kinds.has('env-deleted')).toBe(true);
    expect(list.value.data).toHaveLength(3);
    for (const rec of list.value.data) {
      expect(rec.outcome).toBe('succeeded');
      const doc = (rec.payload.doc ?? {}) as Record<string, unknown>;
      expect(doc.value).toBeUndefined();
    }
  });

  test('failed resolve emits env-resolved with outcome=failed', async () => {
    const auditEvents = createInMemoryAuditEventBinding();
    const b = createInMemoryEnvBinding({
      auditEvents,
      tenantId: t,
      projectId: p,
    });
    await b.resolve({
      scope: tenantScope,
      envName: staging,
      name: 'MISSING',
      resolveContext: ctx,
    });
    const list = await auditEvents.query({ tenantId: t });
    if (list.kind !== 'ok') throw new Error('query failed');
    expect(list.value.data).toHaveLength(1);
    expect(list.value.data[0]?.kind).toBe('env-resolved');
    expect(list.value.data[0]?.outcome).toBe('failed');
    const doc0 = (list.value.data[0]?.payload.doc ?? {}) as Record<string, unknown>;
    expect(doc0.errorCode).toBe('env-not-found');
  });

  test('emitted audit events never contain value', async () => {
    const auditEvents = createInMemoryAuditEventBinding();
    const b = createInMemoryEnvBinding({
      auditEvents,
      tenantId: t,
      projectId: p,
    });
    const sentinel = 'super-secret-plaintext-abc123';
    await b.set({
      scope: tenantScope,
      envName: staging,
      name: 'K',
      value: sentinel,
      enqueueTuples: () => [],
    });
    await b.resolve({ scope: tenantScope, envName: staging, name: 'K', resolveContext: ctx });
    const list = await auditEvents.query({ tenantId: t });
    if (list.kind !== 'ok') throw new Error('query failed');
    const serialized = JSON.stringify(list.value.data);
    expect(serialized).not.toContain(sentinel);
  });
});

describe('createInMemoryEnvBinding — production gate', () => {
  test('refuses to boot when NODE_ENV=production and productionSafe is unset', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => createInMemoryEnvBinding()).toThrow(/refuses to boot/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  test('allows boot in production when productionSafe: true', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => createInMemoryEnvBinding({ productionSafe: true })).not.toThrow();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
