// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Building a test set from corrections, with authorization on. Under a test set
 * id never registered there's no test set to check yet: the build needs
 * `admin` on the project it names, the project the new test set belongs to.
 * Under an existing test set (a tombstoned one included), the test set is checked
 * first, as for anything else under a test set id.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { ProjectId, TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  RunHandlerBinding,
  TestSet,
  TestSetRegistryBinding,
  TokenResolver,
} from '../src/index.js';
import { inMemoryCaseStore } from './support/in-memory-cases.js';
import { inMemoryCorrections } from './support/in-memory-corrections.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'route-authz-corrected-test-sets';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;
const P = randomUUID() as ProjectId;
const Q = randomUUID();
const EXISTING = 'acme.existing';
const GONE = 'acme.gone';
const NEW = 'acme.new';
const build = (testSetId: string) => `/v1/test-sets/${testSetId}/versions/from-corrections`;
const body = { version: '2.0.0', projectId: P, agentId: 'acme.matcher' };

/** A registry with a test set in project Q and a tombstoned one, both with head rows. */
function testSets(): TestSetRegistryBinding & { readonly published: TestSet[] } {
  const heads = new Set([EXISTING, GONE]);
  const published: TestSet[] = [];
  return {
    published,
    async headExists({ testSetId }: { testSetId: string }) {
      return heads.has(testSetId);
    },
    async publish({ testSet }: { testSet: TestSet }) {
      published.push(testSet);
      heads.add(testSet.id);
      return { kind: 'ok', testSetId: testSet.id, version: testSet.version };
    },
  } as unknown as TestSetRegistryBinding & { readonly published: TestSet[] };
}

async function harness(grants: readonly string[], { authzOn = true } = {}) {
  const asked: string[] = [];
  const decide = (action: Action, r: ResourceRef): Decision => {
    asked.push(`${action} ${r.type}:${r.id}`);
    const allowed = grants.includes(`${action} ${r.type}:${r.id}`);
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  const corrections = inMemoryCorrections();
  await corrections.record({
    tenantId,
    projectId: P,
    runId: 'run-1',
    run: {
      subject: { kind: 'agent', id: 'acme.matcher', version: '2.0.0' },
      input: { query: 'acme' },
      output: { matches: [{ id: 'c1' }] },
    },
    items: [{ key: 'c1', rank: 0, verdict: 'wrong' }],
    madeBy: { kind: 'user', id: 'u1' },
    status: 'open',
    sortedTo: 'improve',
    sorted: { by: { kind: 'rule' }, at: '2026-10-01T00:00:00.000Z' },
  });
  const registry = testSets();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    correctionRegistry: corrections,
    testSetRegistry: registry,
    evalCaseStore: inMemoryCaseStore(),
    ...(authzOn && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async (_p, action, r) => decide(action, r),
          checkBatch: async (_p, action, rs) => rs.map((r) => decide(action, r)),
        } satisfies AuthzCheckBinding,
      },
    }),
  });
  const call = async (method: string, path: string, payload?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(payload !== undefined && { body: JSON.stringify(payload) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call, asked, published: registry.published };
}

describe('a test set under a test set id never registered', () => {
  test('admin on the project it names builds it; the test set, not there yet, is never asked', async () => {
    const h = await harness([`admin project:${P}`]);
    const r = await h.call('POST', build(NEW), body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      testSetId: NEW,
      version: '2.0.0',
      kind: 'corrections',
      caseCount: 1,
    });
    expect(h.asked).toEqual([`admin project:${P}`]);
    expect(h.published.map((s) => s.id)).toEqual([NEW]);
  });

  test('without admin on that project: 403, and nothing built (write there, or admin elsewhere, is not enough)', async () => {
    const h = await harness([`write project:${P}`, `admin project:${Q}`]);
    const r = await h.call('POST', build(NEW), body);
    expect(r.status).toBe(403);
    expect(r.body.error?.code).toBe('permission-denied');
    expect(h.asked).toEqual([`admin project:${P}`]);
    expect(h.published).toEqual([]);
  });

  test('anything else under that id still checks the test set', async () => {
    const h = await harness([`admin project:${P}`]);
    expect((await h.call('POST', `/v1/test-sets/${NEW}/versions/1.0.0/unregister`)).status).toBe(
      403,
    );
    expect((await h.call('GET', `/v1/test-sets/${NEW}/versions/1.0.0/cases`)).status).toBe(403);
    expect(h.asked).toEqual([`admin test_set:${NEW}`, `read test_set:${NEW}`]);
  });
});

describe('a test set under an existing test set', () => {
  test('the test set is checked first: admin on the named project alone is refused', async () => {
    const h = await harness([`admin project:${P}`]);
    expect((await h.call('POST', build(EXISTING), body)).status).toBe(403);
    expect(h.asked).toEqual([`admin test_set:${EXISTING}`]);
    expect(h.published).toEqual([]);
  });

  test('admin on the test set and on the project: a new version', async () => {
    const h = await harness([`admin test_set:${EXISTING}`, `admin project:${P}`]);
    const r = await h.call('POST', build(EXISTING), body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(h.asked).toEqual([`admin test_set:${EXISTING}`, `admin project:${P}`]);
  });

  test('a tombstoned test set id is still checked on the test set', async () => {
    const h = await harness([`admin project:${P}`]);
    expect((await h.call('POST', build(GONE), body)).status).toBe(403);
    expect(h.asked).toEqual([`admin test_set:${GONE}`]);
    expect(h.published).toEqual([]);
  });
});

test('with authorization off, a new test set builds as before', async () => {
  const h = await harness([], { authzOn: false });
  expect((await h.call('POST', build(NEW), body)).status).toBe(201);
  expect(h.asked).toEqual([]);
});
