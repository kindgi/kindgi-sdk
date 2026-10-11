// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/guardrails/:guardrailId/outcomes`: what a guardrail's checks
 * came to in a project. What it asks the binding for, what it refuses, and
 * who may read it (the guardrail and the project).
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type {
  GuardrailOutcomes,
  GuardrailOutcomesInput,
  GuardrailRegistryBinding,
  TokenResolver,
} from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';

const tenantId = randomUUID() as TenantId;
const projectA = randomUUID();
const projectB = randomUUID();
const TOKEN = 'guardrail-outcomes-token';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-reader' as UserId } : null;

const ANSWER: GuardrailOutcomes = {
  counts: { passed: 1204, violated: 31, blocked: 7, errored: 2 },
  byAgentVersion: [
    {
      agentId: 'acme.refunds',
      agentVersion: '2.1.0',
      passed: 1000,
      violated: 30,
      blocked: 7,
      errored: 2,
    },
  ],
  recentBlocked: [
    {
      runId: randomUUID() as never,
      at: '2026-10-07T10:00:00.000Z' as never,
      agentId: 'acme.refunds',
      agentVersion: '2.1.0',
    },
  ],
  recordedSince: '2026-09-30T08:00:00.000Z' as never,
};

function grantsAuthz(grants: readonly string[]) {
  const decision = (action: Action, resource: ResourceRef): Decision => {
    const allowed = grants.includes(`${action} ${resource.type}:${resource.id}`);
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: {
        action,
        relation: '',
        resource: `${resource.type}:${resource.id}`,
        actorSubject: '',
      },
    };
  };
  return {
    fgaApiUrl: 'http://fga.invalid',
    authzCheckBinding: {
      check: async (_p, action, resource) => decision(action, resource),
      checkBatch: async (_p, action, resources) => resources.map((r) => decision(action, r)),
    } satisfies AuthzCheckBinding,
  };
}

function harness(options: { grants?: readonly string[]; supported?: boolean } = {}) {
  const asked: GuardrailOutcomesInput[] = [];
  const unused = async () => {
    throw new Error('not used here');
  };
  const binding: GuardrailRegistryBinding = {
    list: unused,
    get: unused,
    register: unused,
    unregister: unused,
    // Absent on a registry that keeps no outcomes (the route checks for it).
    ...(options.supported !== false && {
      outcomes: async (input: GuardrailOutcomesInput) => {
        asked.push(input);
        return ANSWER;
      },
    }),
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as never,
    guardrailRegistry: binding,
    ...(options.grants !== undefined && { authz: grantsAuthz(options.grants) }),
  });
  const get = async (guardrailId: string, query: string) => {
    const res = await app.request(`/v1/guardrails/${guardrailId}/outcomes${query}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { asked, get };
}

const WEEK = '&from=2026-10-01T00:00:00Z&to=2026-10-08T00:00:00Z';

describe('GET /v1/guardrails/:guardrailId/outcomes', () => {
  test('asks the binding for the guardrail, the project and the window; answers its outcomes', async () => {
    const h = harness();
    const res = await h.get('acme.no-pii', `?projectId=${projectA}${WEEK}&recent=5`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      guardrailId: 'acme.no-pii',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-08T00:00:00.000Z',
      ...ANSWER,
    });
    expect(h.asked).toEqual([
      {
        tenantId,
        guardrailId: 'acme.no-pii',
        projectId: projectA,
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-08T00:00:00.000Z',
        recent: 5,
      },
    ]);
  });

  test('ten recent blocks by default; none when asked for 0', async () => {
    const h = harness();
    expect((await h.get('acme.no-pii', `?projectId=${projectA}${WEEK}`)).status).toBe(200);
    expect((await h.get('acme.no-pii', `?projectId=${projectA}${WEEK}&recent=0`)).status).toBe(200);
    expect(h.asked.map((a) => a.recent)).toEqual([10, 0]);
  });

  test.each([
    ['no project', '?from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z', '`projectId` is required'],
    ['no window', `?projectId=${projectA}`, '`from` and `to` are required'],
    ['a bad time', `?projectId=${projectA}&from=yesterday&to=2026-10-02T00:00:00Z`, '`from`'],
    [
      'a window backwards',
      `?projectId=${projectA}&from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z`,
      'before `to`',
    ],
    [
      'over 90 days',
      `?projectId=${projectA}&from=2026-01-01T00:00:00Z&to=2026-10-01T00:00:00Z`,
      'at most 90 days',
    ],
    ['too many recent', `?projectId=${projectA}${WEEK}&recent=51`, '`recent`'],
    ['a fraction of recent', `?projectId=${projectA}${WEEK}&recent=2.5`, '`recent`'],
  ])('%s: 400, saying why', async (_, query, says) => {
    const h = harness();
    const res = await h.get('acme.no-pii', query);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
    expect(res.body.error.message).toContain(says);
    expect(h.asked).toEqual([]);
  });

  test('exactly 90 days is allowed', async () => {
    const res = await harness().get(
      'acme.no-pii',
      `?projectId=${projectA}&from=2026-07-03T00:00:00Z&to=2026-10-01T00:00:00Z`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  test('a registry that keeps no outcomes: 501 guardrail-outcomes-not-supported', async () => {
    const res = await harness({ supported: false }).get(
      'acme.no-pii',
      `?projectId=${projectA}${WEEK}`,
    );
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('guardrail-outcomes-not-supported');
  });

  test("needs read on the guardrail and on the project; the binding isn't asked otherwise", async () => {
    const h = harness({
      grants: ['read guardrail:acme.no-pii', `read project:${projectA}`],
    });
    const allowed = await h.get('acme.no-pii', `?projectId=${projectA}${WEEK}`);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    // Another project's turns.
    const otherProject = await h.get('acme.no-pii', `?projectId=${projectB}${WEEK}`);
    expect(otherProject.status).toBe(403);
    expect(JSON.stringify(otherProject.body)).toContain(`project:${projectB}`);
    // A guardrail the caller can't read, in a project they can.
    const otherGuardrail = await h.get('acme.tone', `?projectId=${projectA}${WEEK}`);
    expect(otherGuardrail.status).toBe(403);
    expect(JSON.stringify(otherGuardrail.body)).toContain('guardrail:acme.tone');
    expect(h.asked.map((a) => [a.guardrailId, a.projectId])).toEqual([['acme.no-pii', projectA]]);
  });
});
