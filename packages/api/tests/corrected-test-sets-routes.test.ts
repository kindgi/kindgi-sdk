// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The cases of test sets built from corrections:
 * `GET /v1/test-sets/:id/versions/:version/cases`. Nothing builds them any
 * more, since an agent's corrections are its test set; the ones built
 * before are still read, on `read` of the test set.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type {
  CorrectedTestCase,
  RunHandlerBinding,
  TestSetRegistryBinding,
  TokenResolver,
} from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';
import { inMemoryCaseStore } from './support/in-memory-cases.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'corrected-test-sets-token';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;
const CASES = '/v1/test-sets/acme.matches/versions/1.0.0/cases';

function aCase(caseId: string): CorrectedTestCase {
  return {
    caseId,
    subject: { kind: 'agent', id: 'acme.matcher', version: '1.0.0' },
    input: { query: caseId },
    output: { matches: [] },
    items: [],
  };
}

async function harness({ grants }: { readonly grants?: readonly string[] } = {}) {
  const asked: string[] = [];
  const decide = (action: Action, r: ResourceRef): Decision => {
    asked.push(`${action} ${r.type}:${r.id}`);
    const allowed = grants?.includes(`${action} ${r.type}:${r.id}`) ?? false;
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  const cases = inMemoryCaseStore();
  await cases.putCases({
    tenantId,
    testSetId: 'acme.matches',
    version: '1.0.0',
    cases: [aCase('run-3'), aCase('run-2'), aCase('run-1')],
  });
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    testSetRegistry: {
      headExists: async () => true,
    } as unknown as TestSetRegistryBinding,
    evalCaseStore: cases,
    ...(grants !== undefined && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async (_p, action, r) => decide(action, r),
          checkBatch: async (_p, action, rs) => rs.map((r) => decide(action, r)),
        } satisfies AuthzCheckBinding,
      },
    }),
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call, asked };
}

describe('GET /v1/test-sets/:id/versions/:version/cases', () => {
  test('pages with limit and cursor, in the order the cases were stored', async () => {
    const h = await harness();
    const first = await h.call('GET', `${CASES}?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.data.map((c: { caseId: string }) => c.caseId)).toEqual(['run-3', 'run-2']);
    expect(first.body.hasMore).toBe(true);
    const second = await h.call('GET', `${CASES}?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.data.map((c: { caseId: string }) => c.caseId)).toEqual(['run-1']);
    expect(second.body.hasMore).toBe(false);
    expect(second.body.nextCursor).toBeUndefined();
  });

  test('a version with no cases is an empty page', async () => {
    const h = await harness();
    const res = await h.call('GET', '/v1/test-sets/acme.matches/versions/9.9.9/cases');
    expect(res.body).toEqual({ data: [], hasMore: false });
  });

  test('needs read on the test set', async () => {
    const refused = await harness({ grants: [] });
    expect((await refused.call('GET', CASES)).status).toBe(403);
    expect(refused.asked).toEqual(['read test_set:acme.matches']);

    const allowed = await harness({ grants: ['read test_set:acme.matches'] });
    expect((await allowed.call('GET', CASES)).status).toBe(200);
  });
});

test('nothing builds a test set from corrections any more', async () => {
  const h = await harness();
  const res = await h.call('POST', '/v1/test-sets/acme.matches/versions/from-corrections', {
    version: '2.0.0',
    agentId: 'acme.matcher',
  });
  expect(res.status).toBe(404);
});
