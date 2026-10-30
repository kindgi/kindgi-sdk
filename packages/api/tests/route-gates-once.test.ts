// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A router's gate decides a request once. Hono's trailing '/*' matches the
 * bare path too ('/:agentId/*' matches '/:agentId'), so a gate registered on
 * both a path and its '/*' form ran twice for a request to the bare path: two
 * checks, and two identical decisions in the access audit. Each gate is
 * registered once, on the '/*' form.
 *
 * For each router that had both: every method its bare path serves, and one
 * path under it, are checked once, with the action the gate decides; a caller
 * the gate refuses is still refused on the bare path, so the gate covers it.
 * The last test fails on any router that `use`s both a path and its '/*' form.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, Principal, ResourceRef } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type { TokenResolver } from '../src/index.js';
import { fullAppInput } from './support/full-app.js';

const tenantId = '00000000-0000-4000-8000-0000000000aa' as TenantId;
/** Stands for the project each harness creates: the expert queue gate answers 404 for one that isn't there. */
const PROJECT = '{project}';
const ID = '00000000-0000-4000-8000-0000000000ff';

/** Granted everything. */
const FULL = 'full-token';
/** Granted `read`, and nothing else. */
const READER = 'reader-token';
/** Granted nothing. */
const NOBODY = 'nobody-token';

const USERS: Readonly<Record<string, string>> = {
  [FULL]: 'u-full',
  [READER]: 'u-reader',
  [NOBODY]: 'u-nobody',
};

const resolveToken: TokenResolver = async (token) => {
  const user = USERS[token];
  return user === undefined ? null : { tenantId, userId: user as UserId, scopes: [] };
};

const decide = (p: Principal, action: Action, r: ResourceRef): Decision => {
  const allowed = p.actor.id === 'u-full' || (p.actor.id === 'u-reader' && action === 'read');
  return {
    allowed,
    reason: allowed ? 'test: granted' : 'test: not granted',
    evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: p.actor.id },
  };
};

/** The app with one project, and every decision made on a request: the binding's checks, and the API's own refusals. */
async function harness(options: { readonly identityProviderChanges?: 'operator' } = {}) {
  const input = fullAppInput();
  const created = await input.projectBinding?.create(tenantId, { name: 'Acme', slug: 'acme' });
  if (created?.kind !== 'ok') throw new Error('the project was not created');
  const projectId = created.projectId as unknown as string;
  const decided: string[] = [];
  const authzCheckBinding: AuthzCheckBinding = {
    check: async (p, action, r) => {
      decided.push(`${action} ${r.type}:${r.id}`);
      return decide(p, action, r);
    },
    checkBatch: async (p, action, rs) => {
      for (const r of rs) decided.push(`${action} ${r.type}:${r.id}`);
      return rs.map((r) => decide(p, action, r));
    },
    inProject: async () => true,
    recordDecision: (_p, action, r) => {
      decided.push(`refused ${action} ${r.type}:${r.id}`);
    },
  };
  const app = createApp({
    ...input,
    resolveToken,
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
    ...options,
  });
  const call = async (token: string, method: string, path: string) => {
    decided.length = 0;
    const res = await app.request(`/v1${path.replaceAll(PROJECT, projectId)}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method !== 'GET' && { 'content-type': 'application/json' }),
      },
      ...(method !== 'GET' && { body: '{}' }),
    });
    return { status: res.status, decided: [...decided] };
  };
  /** What the gate is expected to decide, on this harness's project. */
  const on = (expected: string) => expected.replaceAll(PROJECT, projectId);
  return { call, on };
}

const project = `project:${PROJECT}`;
const tenant = `tenant:${tenantId}`;

/**
 * Each router's bare path, for every method it serves, then one path under
 * it: what the gate decides there, once, and what the route itself asks
 * after it, if anything.
 */
const ONCE: readonly {
  readonly router: string;
  readonly method: string;
  readonly path: string;
  readonly decided: string;
  readonly thenAsks?: string;
}[] = [
  // A project's queue rules and queue: `read` on the project, a change `write`.
  {
    router: 'expert-queue',
    method: 'GET',
    path: `/projects/${PROJECT}/queue-rules`,
    decided: `read ${project}`,
  },
  {
    router: 'expert-queue',
    method: 'POST',
    path: `/projects/${PROJECT}/queue-rules`,
    decided: `write ${project}`,
  },
  {
    router: 'expert-queue',
    method: 'GET',
    path: `/projects/${PROJECT}/queue-rules/${ID}`,
    decided: `read ${project}`,
  },
  // The list asks `write` itself, for its items' `can` (whether you may dismiss or reopen).
  {
    router: 'expert-queue',
    method: 'GET',
    path: `/projects/${PROJECT}/expert-queue`,
    decided: `read ${project}`,
    thenAsks: `write ${project}`,
  },
  {
    router: 'expert-queue',
    method: 'POST',
    path: `/projects/${PROJECT}/expert-queue/${ID}/dismiss`,
    decided: `write ${project}`,
  },
  // A project's sites: a tenant admin's.
  {
    router: 'sites',
    method: 'GET',
    path: `/projects/${PROJECT}/sites`,
    decided: `admin ${tenant}`,
  },
  {
    router: 'sites',
    method: 'POST',
    path: `/projects/${PROJECT}/sites`,
    decided: `admin ${tenant}`,
  },
  {
    router: 'sites',
    method: 'GET',
    path: `/projects/${PROJECT}/sites/${ID}`,
    decided: `admin ${tenant}`,
  },
  // The tenant's sign-in providers: `read` on the tenant, a change `admin`.
  { router: 'providers', method: 'GET', path: '/auth/providers', decided: `read ${tenant}` },
  { router: 'providers', method: 'POST', path: '/auth/providers', decided: `admin ${tenant}` },
  { router: 'providers', method: 'GET', path: `/auth/providers/${ID}`, decided: `read ${tenant}` },
  // One registered thing: `read` on it.
  { router: 'agents', method: 'GET', path: `/agents/${ID}`, decided: `read agent:${ID}` },
  { router: 'agents', method: 'GET', path: `/agents/${ID}/versions`, decided: `read agent:${ID}` },
  { router: 'flows', method: 'GET', path: `/flows/${ID}`, decided: `read flow:${ID}` },
  { router: 'flows', method: 'GET', path: `/flows/${ID}/versions`, decided: `read flow:${ID}` },
  { router: 'tools', method: 'GET', path: `/tools/${ID}`, decided: `read tool:${ID}` },
  { router: 'tools', method: 'GET', path: `/tools/${ID}/versions`, decided: `read tool:${ID}` },
  {
    router: 'guardrails',
    method: 'GET',
    path: `/guardrails/${ID}`,
    decided: `read guardrail:${ID}`,
  },
  {
    router: 'guardrails',
    method: 'GET',
    path: `/guardrails/${ID}/outcomes`,
    decided: `read guardrail:${ID}`,
  },
  {
    router: 'eval-suites',
    method: 'GET',
    path: `/eval-suites/${ID}`,
    decided: `read eval_suite:${ID}`,
  },
  {
    router: 'eval-suites',
    method: 'GET',
    path: `/eval-suites/${ID}/versions`,
    decided: `read eval_suite:${ID}`,
  },
  {
    router: 'mcp',
    method: 'GET',
    path: `/mcp/endpoints/${ID}`,
    decided: `read mcp_endpoint:${ID}`,
  },
  {
    router: 'mcp',
    method: 'GET',
    path: `/mcp/endpoints/${ID}/prompts`,
    decided: `read mcp_endpoint:${ID}`,
  },
];

describe('each request is decided once', () => {
  test.each(ONCE)('$router: $method $path', async ({ method, path, decided, thenAsks }) => {
    const h = await harness();
    const r = await h.call(FULL, method, path);
    expect(r.status).not.toBe(403);
    expect(r.decided).toEqual([decided, ...(thenAsks === undefined ? [] : [thenAsks])].map(h.on));
  });
});

/**
 * The gate still covers the bare path: a caller it refuses there is refused,
 * once. A change for a caller with only `read`, or a read for one with
 * nothing, where the bare path serves only reads.
 */
const REFUSED: readonly {
  readonly router: string;
  readonly token: string;
  readonly method: string;
  readonly path: string;
  readonly decided: string;
}[] = [
  {
    router: 'expert-queue',
    token: READER,
    method: 'POST',
    path: `/projects/${PROJECT}/queue-rules`,
    decided: `write ${project}`,
  },
  {
    router: 'expert-queue',
    token: NOBODY,
    method: 'GET',
    path: `/projects/${PROJECT}/expert-queue`,
    decided: `read ${project}`,
  },
  {
    router: 'sites',
    token: READER,
    method: 'POST',
    path: `/projects/${PROJECT}/sites`,
    decided: `admin ${tenant}`,
  },
  {
    router: 'providers',
    token: READER,
    method: 'POST',
    path: '/auth/providers',
    decided: `admin ${tenant}`,
  },
  {
    router: 'agents',
    token: NOBODY,
    method: 'GET',
    path: `/agents/${ID}`,
    decided: `read agent:${ID}`,
  },
  {
    router: 'flows',
    token: NOBODY,
    method: 'GET',
    path: `/flows/${ID}`,
    decided: `read flow:${ID}`,
  },
  {
    router: 'tools',
    token: NOBODY,
    method: 'GET',
    path: `/tools/${ID}`,
    decided: `read tool:${ID}`,
  },
  {
    router: 'guardrails',
    token: NOBODY,
    method: 'GET',
    path: `/guardrails/${ID}`,
    decided: `read guardrail:${ID}`,
  },
  {
    router: 'eval-suites',
    token: NOBODY,
    method: 'GET',
    path: `/eval-suites/${ID}`,
    decided: `read eval_suite:${ID}`,
  },
  {
    router: 'mcp',
    token: NOBODY,
    method: 'GET',
    path: `/mcp/endpoints/${ID}`,
    decided: `read mcp_endpoint:${ID}`,
  },
];

describe('the gate still refuses on the bare path', () => {
  test.each(REFUSED)('$router: $method $path', async ({ token, method, path, decided }) => {
    const h = await harness();
    const r = await h.call(token, method, path);
    expect(r.status).toBe(403);
    expect(r.decided).toEqual([h.on(decided)]);
  });

  test('when the operator manages sign-in, a change to the providers is refused once, after the tenant check', async () => {
    const h = await harness({ identityProviderChanges: 'operator' });
    const r = await h.call(FULL, 'POST', '/auth/providers');
    expect(r.status).toBe(403);
    expect(r.decided).toEqual([`admin ${tenant}`, `refused admin ${tenant}`]);
    const read = await h.call(FULL, 'GET', '/auth/providers');
    expect(read.decided).toEqual([`read ${tenant}`]);
  });
});

/** Every path a source file registers a gate on (`.use('…'`), as `<file>: <path>`. */
function gatedPaths(src: string): string[] {
  const uses = /\.use\(\s*(['`])([^'`$]+)\1/g;
  return (readdirSync(src, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.ts'))
    .flatMap((file) =>
      [...readFileSync(join(src, file), 'utf8').matchAll(uses)].map((m) => `${file}: ${m[2]}`),
    );
}

/** The paths that are gated both bare and on their '/*' form, which matches them too. */
function gatedTwice(gated: readonly string[]): string[] {
  const all = new Set(gated);
  return gated.filter(
    (entry) => !entry.endsWith('*') && all.has(entry.endsWith('/') ? `${entry}*` : `${entry}/*`),
  );
}

describe('no gate is registered on a path and its /* form', () => {
  test('the check finds one', () => {
    expect(
      gatedTwice([
        'routes/a.ts: /:id',
        'routes/a.ts: /:id/*',
        'routes/b.ts: /x',
        'routes/a.ts: /x/*',
      ]),
    ).toEqual(['routes/a.ts: /:id']);
    expect(gatedTwice(['app.ts: /', 'app.ts: /*'])).toEqual(['app.ts: /']);
  });

  test('none in packages/api/src', () => {
    const gated = gatedPaths(join(dirname(fileURLToPath(import.meta.url)), '..', 'src'));
    // It reads the routers it should: each one's '/*' gate is found.
    expect(gated).toEqual(
      expect.arrayContaining([
        'routes/expert-queue.ts: /:projectId/queue-rules/*',
        'routes/expert-queue.ts: /:projectId/expert-queue/*',
        'routes/sites.ts: /:projectId/sites/*',
        'routes/auth.ts: /providers/*',
        'routes/agents.ts: /:agentId/*',
        'routes/mcp.ts: /endpoints/:endpointId/*',
      ]),
    );
    expect(gatedTwice(gated)).toEqual([]);
  });
});
