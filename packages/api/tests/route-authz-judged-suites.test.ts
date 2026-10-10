// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Building a test set from judgments, with authorization on. Under a suite
 * id never registered there's no suite to check yet: the build needs
 * `admin` on the project it names, the project the new suite belongs to.
 * Under an existing suite (a tombstoned one included), the suite is checked
 * first, as for anything else under a suite id.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { ProjectId, TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  EvalSuite,
  EvalSuiteRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import { inMemoryCaseStore } from './support/in-memory-cases.js';
import { inMemoryJudgments } from './support/in-memory-judgments.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'route-authz-judged-suites';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;
const P = randomUUID() as ProjectId;
const Q = randomUUID();
const EXISTING = 'acme.existing';
const GONE = 'acme.gone';
const NEW = 'acme.new';
const build = (suiteId: string) => `/v1/eval-suites/${suiteId}/versions/from-judgments`;
const body = { version: '2.0.0', projectId: P, agentId: 'acme.matcher' };

/** A registry with a suite in project Q and a tombstoned one, both with head rows. */
function suites(): EvalSuiteRegistryBinding & { readonly published: EvalSuite[] } {
  const heads = new Set([EXISTING, GONE]);
  const published: EvalSuite[] = [];
  return {
    published,
    async headExists({ suiteId }: { suiteId: string }) {
      return heads.has(suiteId);
    },
    async publish({ suite }: { suite: EvalSuite }) {
      published.push(suite);
      heads.add(suite.id);
      return { kind: 'ok', suiteId: suite.id, version: suite.version };
    },
  } as unknown as EvalSuiteRegistryBinding & { readonly published: EvalSuite[] };
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
  const judgments = inMemoryJudgments();
  await judgments.record({
    tenantId,
    projectId: P,
    runId: 'run-1',
    run: {
      subject: { kind: 'agent', id: 'acme.matcher', version: '2.0.0' },
      input: { query: 'acme' },
      output: { matches: [{ id: 'c1' }] },
    },
    item: { key: 'c1', rank: 0 },
    verdict: 'no',
    assertedBy: { kind: 'user', id: 'u1' },
  });
  const registry = suites();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    judgmentRegistry: judgments,
    evalSuiteRegistry: registry,
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

describe('a test set under a suite id never registered', () => {
  test('admin on the project it names builds it; the suite, not there yet, is never asked', async () => {
    const h = await harness([`admin project:${P}`]);
    const r = await h.call('POST', build(NEW), body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ suiteId: NEW, version: '2.0.0', kind: 'judged', caseCount: 1 });
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

  test('anything else under that id still checks the suite', async () => {
    const h = await harness([`admin project:${P}`]);
    expect((await h.call('POST', `/v1/eval-suites/${NEW}/versions/1.0.0/unregister`)).status).toBe(
      403,
    );
    expect((await h.call('GET', `/v1/eval-suites/${NEW}/versions/1.0.0/cases`)).status).toBe(403);
    expect(h.asked).toEqual([`admin eval_suite:${NEW}`, `read eval_suite:${NEW}`]);
  });
});

describe('a test set under an existing suite', () => {
  test('the suite is checked first: admin on the named project alone is refused', async () => {
    const h = await harness([`admin project:${P}`]);
    expect((await h.call('POST', build(EXISTING), body)).status).toBe(403);
    expect(h.asked).toEqual([`admin eval_suite:${EXISTING}`]);
    expect(h.published).toEqual([]);
  });

  test('admin on the suite and on the project: a new version', async () => {
    const h = await harness([`admin eval_suite:${EXISTING}`, `admin project:${P}`]);
    const r = await h.call('POST', build(EXISTING), body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(h.asked).toEqual([`admin eval_suite:${EXISTING}`, `admin project:${P}`]);
  });

  test('a tombstoned suite id is still checked on the suite', async () => {
    const h = await harness([`admin project:${P}`]);
    expect((await h.call('POST', build(GONE), body)).status).toBe(403);
    expect(h.asked).toEqual([`admin eval_suite:${GONE}`]);
    expect(h.published).toEqual([]);
  });
});

test('with authorization off, a new suite builds as before', async () => {
  const h = await harness([], { authzOn: false });
  expect((await h.call('POST', build(NEW), body)).status).toBe(201);
  expect(h.asked).toEqual([]);
});
