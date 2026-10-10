// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Every operation, called with an API key that takes no admin action
 * (`role: member`) whose user the authorizer grants everything: so the
 * only refusals are the ones the API decides itself, before asking the
 * binding. Each such 403 must have its decision recorded for that
 * request (`recordDecision`), as the binding records its own, so the
 * access audit holds every refusal. A route asking a relation the model
 * doesn't define fails here too: a check that can never pass.
 *
 * It's an invariant, not a list: a new route gated on a tenant admin is
 * swept as it lands. The floor (`MUST_REFUSE`) keeps it from passing with
 * nothing refused.
 */

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';

import { OPERATIONS, createApp } from '../src/index.js';
import type { TokenResolver } from '../src/index.js';
import { fullAppInput } from './support/full-app.js';

const tenantId = '00000000-0000-4000-8000-0000000000aa' as TenantId;
const MEMBER_KEY = 'member-key-token';
/** An admin key carrying no capabilities: past the role checks, to the capability gates. */
const NO_CAPS_KEY = 'no-caps-admin-key-token';
const ID = '00000000-0000-4000-8000-0000000000ff';

/** What each caller must be refused (and have recorded): the sweep's floor. */
const MUST_REFUSE: Readonly<Record<string, readonly string[]>> = {
  // A member key takes no tenant admin action.
  [MEMBER_KEY]: [
    'GET /v1/identity/users',
    'GET /v1/audit/authz',
    'POST /v1/service-accounts',
    'POST /v1/approvals/reviewers',
  ],
  // An admin key without the capability a write needs; a caller who isn't a reviewer.
  [NO_CAPS_KEY]: ['PUT /v1/env/{name}', 'POST /v1/secrets', 'GET /v1/approvals'],
};

interface Recorded {
  readonly action: Action;
  readonly resource: string;
  readonly decision: Decision;
  readonly correlationId: string | undefined;
}

const resolveToken: TokenResolver = async (token) => {
  if (token === MEMBER_KEY) {
    return {
      tenantId,
      userId: 'u-admin' as UserId,
      tokenId: 'key-1' as never,
      tokenRole: 'member',
    };
  }
  if (token === NO_CAPS_KEY) {
    return {
      tenantId,
      userId: 'u-admin' as UserId,
      tokenId: 'key-2' as never,
      tokenRole: 'admin',
      capabilities: [],
    };
  }
  return null;
};

const grant = (action: Action, r: ResourceRef): Decision => ({
  allowed: true,
  reason: 'test: granted',
  evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
});

function sweepApp() {
  const recorded: Recorded[] = [];
  const authzCheckBinding: AuthzCheckBinding = {
    check: async (_p, action, r) => grant(action, r),
    checkBatch: async (_p, action, rs) => rs.map((r) => grant(action, r)),
    inProject: async () => true,
    recordDecision: (_p, action, r, decision, ctx) => {
      recorded.push({
        action,
        resource: `${r.type}:${r.id}`,
        decision,
        correlationId: ctx?.correlationId,
      });
    },
  };
  const app = createApp({
    ...fullAppInput(),
    resolveToken,
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
  });
  return { app, recorded };
}

const NO_BODY: ReadonlySet<string> = new Set(['GET', 'HEAD', 'DELETE']);

/** The operation's path with every parameter filled. */
const urlOf = (honoPath: string): string => honoPath.replace(/:[A-Za-z]+/g, ID);

describe('every refusal the API decides itself is recorded', () => {
  test('each 403 permission-denied has its decision recorded for that request; no route asks an undefined relation', async () => {
    const { app, recorded } = sweepApp();
    const unrecorded: string[] = [];
    const missed: string[] = [];
    for (const token of [MEMBER_KEY, NO_CAPS_KEY]) {
      const refused: string[] = [];
      for (const op of OPERATIONS) {
        const method = op.method.toUpperCase();
        const key = `${method} ${op.openapiPath}`;
        const res = await app.request(urlOf(op.honoPath), {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(!NO_BODY.has(method) && { 'content-type': 'application/json' }),
          },
          ...(!NO_BODY.has(method) && { body: '{}' }),
        });
        if (res.status !== 403) continue;
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string; requestId?: string };
        };
        if (body.error?.code !== 'permission-denied') continue;
        refused.push(key);
        const requestId = body.error.requestId;
        if (!recorded.some((r) => r.correlationId === requestId && !r.decision.allowed)) {
          unrecorded.push(`${token}: ${key}`);
        }
      }
      for (const key of MUST_REFUSE[token] ?? []) {
        if (!refused.includes(key)) missed.push(`${token}: ${key}`);
      }
    }
    expect(unrecorded, 'a 403 with no recorded decision for its request').toEqual([]);
    expect(
      recorded
        .filter((r) => r.decision.failing === 'invalid-action')
        .map((r) => `${r.action} ${r.resource}`),
      'a route asks a relation the authorization model does not define',
    ).toEqual([]);
    expect(missed, 'the floor: refusals the sweep must see').toEqual([]);
  });
});
