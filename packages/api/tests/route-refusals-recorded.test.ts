// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Every operation, called with an API key that takes no admin action
 * (`role: member`) whose user the authorizer grants everything: so the
 * only refusals are the ones the API decides itself, before asking the
 * binding. Every 403 the sweep meets (a known caller refused) must have
 * its decision recorded for that request (`recordDecision`), as the
 * binding records its own, so the access audit holds the refusal,
 * whatever the route and whatever its code; a 401 (an unknown caller) is
 * a sign-in matter. It meets only what an empty body reaches: a refusal
 * deeper in a route (a body, a project, a signed artifact) isn't swept.
 * A route asking a relation the model doesn't define fails here too: a
 * check that can never pass.
 *
 * It's an invariant, not a list: a new route gated on a tenant admin is
 * swept as it lands. The floor (`MUST_REFUSE`) keeps it from passing with
 * nothing refused.
 */

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';

import { statusFor } from '../src/errors.js';
import { OPERATIONS, createApp } from '../src/index.js';
import type { TokenResolver } from '../src/index.js';
import { refusalError } from '../src/routes/denied.js';
import { fullAppInput } from './support/full-app.js';

const tenantId = '00000000-0000-4000-8000-0000000000aa' as TenantId;
const MEMBER_KEY = 'member-key-token';
/** An admin key carrying no capabilities: past the role checks, to the capability gates. */
const NO_CAPS_KEY = 'no-caps-admin-key-token';
/** An admin key limited to one project, carrying no capabilities. */
const PROJECT_KEY = 'project-key-token';
const KEY_PROJECT = '00000000-0000-4000-8000-0000000000a1';
const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000a2';
const ID = '00000000-0000-4000-8000-0000000000ff';

/**
 * Every 403 code the sweep meets: `permission-denied`, or a refusal's own
 * code where the API names one (`refused`'s `code`). A new one fails the
 * sweep until it's named here, and recorded.
 */
const REFUSAL_CODES: ReadonlySet<string> = new Set([
  'permission-denied',
  'identity-providers-operator-managed',
  'token-sign-in-not-allowed',
  'token-sign-in-off',
  'key-project-mismatch',
  'judge-class-not-allowed',
  'host-access-denied',
]);

/**
 * 403s that aren't recorded, by design: they don't refuse the caller. Two
 * more answer `permission-denied` with no principal on the request, so
 * there's no one to record them for: a public run token outside its two
 * progress routes (a run token names a run, not a principal), and judging
 * without a user or a service token (`judgments.ts`).
 */
const NOT_A_REFUSAL_OF_THE_CALLER: Readonly<Record<string, string>> = {
  'signer-not-trusted': 'it refuses an artifact, not a caller',
  'csrf-origin-mismatch': "the request may not be the principal's",
  'role-exceeds-principal':
    "a limit on the key being minted: the caller may mint, the key's principal isn't a tenant admin",
};

/** What each caller must be refused (and have recorded): the sweep's floor. */
const MUST_REFUSE: Readonly<Record<string, readonly string[]>> = {
  // A member key takes no tenant admin action.
  [MEMBER_KEY]: [
    'GET /v1/identity/users',
    'GET /v1/audit/authz',
    'POST /v1/service-accounts',
    'POST /v1/approvals/reviewers',
    // The roster names people: only tenant admins and reviewers read it.
    'GET /v1/approvals/reviewers',
    // A narrowed key opens no console session.
    'POST /v1/auth/token-sign-in token-sign-in-not-allowed',
  ],
  // An admin key without the capability a write needs; a caller who isn't a reviewer.
  [NO_CAPS_KEY]: ['PUT /v1/env/{name}', 'POST /v1/secrets', 'GET /v1/approvals'],
};

/**
 * With the operator managing sign-in, the floor also has a provider change
 * by an admin key without `kindgi:system`, under its own code.
 */
const MUST_REFUSE_OPERATOR_MANAGED: Readonly<Record<string, readonly string[]>> = {
  ...MUST_REFUSE,
  [NO_CAPS_KEY]: [
    ...(MUST_REFUSE[NO_CAPS_KEY] ?? []),
    'POST /v1/auth/providers identity-providers-operator-managed',
    'PATCH /v1/auth/providers/{providerId} identity-providers-operator-managed',
  ],
};

/** With console token sign-in off, no key opens a session, under its own code. */
const MUST_REFUSE_TOKEN_SIGN_IN_OFF: Readonly<Record<string, readonly string[]>> = {
  [MEMBER_KEY]: [
    ...(MUST_REFUSE[MEMBER_KEY] ?? []).filter((k) => !k.startsWith('POST /v1/auth/token-sign-in')),
    'POST /v1/auth/token-sign-in token-sign-in-off',
  ],
  [NO_CAPS_KEY]: [
    ...(MUST_REFUSE[NO_CAPS_KEY] ?? []),
    'POST /v1/auth/token-sign-in token-sign-in-off',
  ],
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
  if (token === PROJECT_KEY) {
    return {
      tenantId,
      userId: 'u-admin' as UserId,
      tokenId: 'key-3' as never,
      tokenRole: 'admin',
      capabilities: [],
      tokenProjectId: KEY_PROJECT,
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

function sweepApp(
  options: {
    readonly identityProviderChanges?: 'operator';
    readonly tokenSignIn?: false;
  } = {},
) {
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
  const input = fullAppInput();
  const app = createApp({
    ...input,
    resolveToken,
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
    ...(options.identityProviderChanges !== undefined && {
      identityProviderChanges: options.identityProviderChanges,
    }),
    ...(options.tokenSignIn === false &&
      input.session !== undefined && { session: { ...input.session, tokenSignIn: false } }),
  });
  return { app, recorded };
}

const NO_BODY: ReadonlySet<string> = new Set(['GET', 'HEAD', 'DELETE']);

/** The operation's path with every parameter filled. */
const urlOf = (honoPath: string): string => honoPath.replace(/:[A-Za-z]+/g, ID);

describe('every refusal the API decides itself is recorded', () => {
  test.each([
    ['tenant', {}, MUST_REFUSE],
    [
      'the operator',
      { identityProviderChanges: 'operator' as const },
      MUST_REFUSE_OPERATOR_MANAGED,
    ],
    [
      'the tenant, with token sign-in off',
      { tokenSignIn: false as const },
      MUST_REFUSE_TOKEN_SIGN_IN_OFF,
    ],
  ])(
    'identity providers managed by %s: every 403 has its decision recorded for that request; no route asks an undefined relation',
    async (_name, options, floor) => {
      const { app, recorded } = sweepApp(options);
      const unrecorded: string[] = [];
      const unnamed: string[] = [];
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
          const code = body.error?.code ?? '(no code)';
          if (NOT_A_REFUSAL_OF_THE_CALLER[code] !== undefined) continue;
          if (!REFUSAL_CODES.has(code)) unnamed.push(`${token}: ${key} ${code}`);
          refused.push(key, `${key} ${code}`);
          const requestId = body.error?.requestId;
          if (!recorded.some((r) => r.correlationId === requestId && !r.decision.allowed)) {
            unrecorded.push(`${token}: ${key} ${code}`);
          }
        }
        for (const key of floor[token] ?? []) {
          if (!refused.includes(key)) missed.push(`${token}: ${key}`);
        }
      }
      expect(unrecorded, 'a 403 with no recorded decision for its request').toEqual([]);
      expect(unnamed, 'a 403 code the sweep does not name (REFUSAL_CODES)').toEqual([]);
      expect(
        recorded
          .filter((r) => r.decision.failing === 'invalid-action')
          .map((r) => `${r.action} ${r.resource}`),
        'a route asks a relation the authorization model does not define',
      ).toEqual([]);
      expect(missed, 'the floor: refusals the sweep must see').toEqual([]);
    },
  );
});

test('every refusal code the sweep names is a 403', () => {
  // `refused` answers 403 whatever code it's given: its codes must be 403s.
  expect([...REFUSAL_CODES].filter((code) => statusFor(code) !== 403)).toEqual([]);
});

describe('refusals deeper in a route, which an empty body never reaches, are recorded too', () => {
  /** One request, its answer and whether its refusal was recorded for it. */
  async function refusal(token: string, method: string, path: string, body?: unknown) {
    const { app, recorded } = sweepApp();
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const error = ((await res.json()) as { error: Record<string, any> }).error;
    const ours = recorded.filter((r) => r.correlationId === error.requestId && !r.decision.allowed);
    return { status: res.status, error, recorded: ours };
  }

  test('a key limited to a project naming another one (key-project-mismatch)', async () => {
    const r = await refusal(PROJECT_KEY, 'GET', `/v1/flows?projectId=${OTHER_PROJECT}`);
    expect([r.status, r.error.code]).toEqual([403, 'key-project-mismatch']);
    expect(r.error.details).toMatchObject({ keyProjectId: KEY_PROJECT, projectId: OTHER_PROJECT });
    expect(r.recorded.map((x) => [x.action, x.resource, x.decision.failing])).toEqual([
      ['read', `project:${OTHER_PROJECT}`, 'scope'],
    ]);
  });

  test("minting a key with capabilities the minter doesn't hold", async () => {
    const r = await refusal(NO_CAPS_KEY, 'POST', '/v1/tokens', {
      role: 'member',
      capabilities: ['secrets:write'],
    });
    expect([r.status, r.error.code]).toEqual([403, 'permission-denied']);
    expect(r.recorded.map((x) => [x.action, x.resource, x.decision.failing])).toEqual([
      ['admin', `tenant:${tenantId}`, 'scope'],
    ]);
  });

  test('a key limited to a project minting one that is not (key-project-mismatch)', async () => {
    const r = await refusal(PROJECT_KEY, 'POST', '/v1/tokens', {
      role: 'member',
      capabilities: [],
    });
    expect([r.status, r.error.code]).toEqual([403, 'key-project-mismatch']);
    expect(r.recorded.map((x) => [x.action, x.resource, x.decision.failing])).toEqual([
      ['admin', `tenant:${tenantId}`, 'scope'],
    ]);
  });

  test('a stdio MCP endpoint where the deployment runs no commands (host-access-denied)', async () => {
    const r = await refusal(NO_CAPS_KEY, 'POST', '/v1/mcp/endpoints', {
      scopeKind: 'tenant',
      endpointId: 'acme.docs',
      name: 'Docs',
      transport: 'stdio',
      config: { transport: 'stdio', command: '/usr/local/bin/docs-mcp', args: ['--stdio'] },
    });
    expect([r.status, r.error.code]).toEqual([403, 'host-access-denied']);
    expect(r.recorded.map((x) => [x.action, x.resource, x.decision.failing])).toEqual([
      ['admin', 'mcp_endpoint:acme.docs', 'scope'],
    ]);
  });

  // `judge-class-not-allowed` needs a run and a restricted judge class: its
  // recording is pinned in judgments-routes.test.ts.
});

test("a route's details never override the refusal's code, message or what was refused", () => {
  const error = refusalError({
    action: 'read',
    resource: { type: 'project', id: 'p1' },
    message: 'the route said so',
    failing: 'scope',
    code: 'key-project-mismatch',
    details: {
      code: 'other',
      message: 'other',
      action: 'admin',
      resource: 'tenant:t',
      keyProjectId: 'p0',
    },
  });
  expect(error).toMatchObject({
    code: 'key-project-mismatch',
    message: 'the route said so',
    action: 'read',
    resource: 'project:p1',
    keyProjectId: 'p0',
  });
});
