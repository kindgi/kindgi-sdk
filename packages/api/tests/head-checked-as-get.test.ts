// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A HEAD is checked as its GET. Hono answers a HEAD with the route's GET
 * handler (the GET's status and headers, without the body), and
 * `c.req.method` still says HEAD. A check that let through whatever
 * isn't a GET let a HEAD reach the handler without the right; a check
 * that asked a write's right of whatever isn't a GET refused a HEAD its
 * GET passes. Each route here asks a HEAD what it asks a GET: without
 * the right, both are refused; with it, the HEAD answers as the GET.
 */

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import type { Action, Decision, ResourceRef } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createAeadCursorSealer, createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';
import type { Authorizer } from '../src/middleware/authorize.js';
import { agentsRouter } from '../src/routes/agents.js';
import { approvalsRouter } from '../src/routes/approvals.js';
import { envRouter } from '../src/routes/env.js';
import { expertQueueRouter } from '../src/routes/expert-queue.js';
import { flowsRouter } from '../src/routes/flows.js';
import { guardrailsRouter } from '../src/routes/guardrails.js';
import { mcpRouter } from '../src/routes/mcp.js';
import { orgsRouter } from '../src/routes/orgs.js';
import { projectsRouter } from '../src/routes/projects.js';
import { provenanceRouter } from '../src/routes/provenance.js';
import { reviewersRouter } from '../src/routes/reviewers.js';
import { runsRouter } from '../src/routes/runs.js';
import { secretsRouter } from '../src/routes/secrets.js';
import { projectTeamGrantsRouter } from '../src/routes/team-grants.js';
import { teamsRouter } from '../src/routes/teams.js';
import { testSetsRouter } from '../src/routes/test-sets.js';
import { toolsRouter } from '../src/routes/tools.js';
import type { AppEnv } from '../src/types.js';

const TENANT = '00000000-0000-4000-8000-0000000000aa';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const ORG = '00000000-0000-4000-8000-0000000000c1';
const TEAM = '00000000-0000-4000-8000-0000000000d1';
const RUN = '00000000-0000-4000-8000-0000000000e1';

/** Grants exactly `grants` (`action type:id`); records each check it's asked, in order. */
function authorizerGranting(grants: readonly string[], asked: string[]): Authorizer {
  const decide = (action: Action, r: ResourceRef): boolean => {
    const key = `${action} ${r.type}:${r.id}`;
    asked.push(key);
    return grants.includes(key);
  };
  return {
    authorize: (action, getResource) => async (c, next) => {
      if (decide(action, await getResource(c))) return next();
      c.status(403);
      return c.json({ code: 'permission-denied' });
    },
    can: async (_c, action, r) => decide(action, r),
    check: async (_c, action, r): Promise<Decision> => {
      const allowed = decide(action, r);
      return {
        allowed,
        reason: 'test',
        evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
      };
    },
    canFor: async () => {
      throw new Error('not used by these routes');
    },
    filterByCan: async (_c, action, items, refFn) => items.filter((i) => decide(action, refFn(i))),
  };
}

/**
 * A binding whose methods answer `answers`' own, else an empty page (`list`,
 * `listVersions`: a refused read asks the item's project to run in) or a refusal.
 */
function binding(answers: Readonly<Record<string, unknown>> = {}): never {
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined;
        if (typeof prop === 'string' && prop in answers) return answers[prop];
        return async () =>
          prop === 'list' || prop === 'listVersions'
            ? { data: [], items: [] }
            : { kind: 'err', error: { code: 'bad-input', message: 'stub' } };
      },
    },
  ) as never;
}

/** The run every run route here reads: in PROJECT. */
const runBinding = () =>
  binding({ getRun: async () => ({ runId: RUN, tenantId: TENANT, projectId: PROJECT }) });

/** Whom the reviewer roster names the caller as: `reviewer`, or no one. */
const reviewers = (reviewer: boolean) =>
  binding({ resolveReviewerRole: async () => (reviewer ? 'standard' : null) });

function mount(router: Hono<AppEnv>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('tenantId' as never, TENANT as never);
    c.set('userId' as never, 'user-1' as never);
    c.set('requestId' as never, 'req-head-checked-as-get' as never);
    c.set('capabilities' as never, [] as never);
    return next();
  });
  app.route('/', router);
  return app;
}

interface Route {
  /** The route, as the test names it. */
  readonly name: string;
  /** Its path under the router. */
  readonly path: string;
  /** What the caller holds that its GET needs: grants, and a reviewer role where that's the right. */
  readonly right: { readonly grants: readonly string[]; readonly reviewer?: boolean };
  readonly router: (a: Authorizer, reviewer: boolean) => Hono<AppEnv>;
}

const inProject = `?scopeKind=project&scopeId=${PROJECT}`;

const ROUTES: readonly Route[] = [
  {
    name: 'GET /v1/env (a scope admin lists)',
    path: `/${inProject}&envName=staging`,
    right: { grants: [`admin project:${PROJECT}`] },
    router: (a) => envRouter(binding(), a),
  },
  {
    name: 'GET /v1/secrets (a scope admin lists)',
    path: `/${inProject}&envName=staging`,
    right: { grants: [`admin project:${PROJECT}`] },
    router: (a) =>
      secretsRouter({ secretsBinding: binding(), rotationStatusStore: binding(), authorizer: a }),
  },
  ...(
    [
      ['agents', agentsRouter, 'agent'],
      ['flows', flowsRouter, 'flow'],
      ['tools', toolsRouter, 'tool'],
      ['guardrails', guardrailsRouter, 'guardrail'],
      ['test-sets', testSetsRouter, 'test_set'],
    ] as const
  ).flatMap(([list, make, kind]): Route[] => [
    {
      name: `GET /v1/${list} in a project (read on the project)`,
      path: `/${inProject}`,
      right: { grants: [`read project:${PROJECT}`] },
      router: (a) => make(binding(), a),
    },
    {
      name: `GET /v1/${list}/:id (read on the item)`,
      path: '/acme.one',
      right: { grants: [`read ${kind}:acme.one`] },
      router: (a) => make(binding(), a),
    },
  ]),
  {
    name: 'GET /v1/mcp/endpoints/:endpointId (read on the endpoint)',
    path: '/endpoints/acme.one',
    right: { grants: ['read mcp_endpoint:acme.one'] },
    router: (a) => mcpRouter(binding(), undefined, a, { hostAccess: 'local' }),
  },
  {
    name: 'GET /v1/projects/default (read on it)',
    path: '/default',
    right: { grants: [`read project:${PROJECT}`] },
    router: (a) =>
      projectsRouter(
        binding({ getDefault: async () => ({ id: PROJECT }) }),
        binding(),
        binding(),
        a,
      ),
  },
  {
    name: 'GET /v1/projects/:projectId (read on it)',
    path: `/${PROJECT}`,
    right: { grants: [`read project:${PROJECT}`] },
    router: (a) => projectsRouter(binding(), binding(), binding(), a),
  },
  {
    name: "GET /v1/projects/:projectId/memberships (write on it: who's in it)",
    path: `/${PROJECT}/memberships`,
    right: { grants: [`write project:${PROJECT}`] },
    router: (a) => projectsRouter(binding(), binding(), binding(), a),
  },
  {
    name: 'GET /v1/projects/:projectId/team-grants (write on the project)',
    path: `/${PROJECT}/team-grants`,
    right: { grants: [`write project:${PROJECT}`] },
    router: (a) =>
      projectTeamGrantsRouter({
        grants: binding(),
        projects: binding(),
        teams: binding(),
        tenantHierarchy: binding(),
        authorizer: a,
      }),
  },
  {
    name: 'GET /v1/projects/:projectId/queue-rules (read on the project)',
    path: `/${PROJECT}/queue-rules`,
    right: { grants: [`read project:${PROJECT}`] },
    router: (a) => expertQueueRouter(binding(), { authorizer: a }),
  },
  {
    name: 'GET /v1/orgs/:orgId (read on it)',
    path: `/${ORG}`,
    right: { grants: [`read org:${ORG}`] },
    router: (a) => orgsRouter(binding(), binding(), a),
  },
  {
    name: 'GET /v1/teams/:teamId (read on it)',
    path: `/${TEAM}`,
    right: { grants: [`read team:${TEAM}`] },
    router: (a) => teamsRouter(binding(), binding(), binding(), a),
  },
  {
    name: "GET /v1/runs/:runId (read on the run's project)",
    path: `/${RUN}`,
    right: { grants: [`read project:${PROJECT}`] },
    router: (a) =>
      runsRouter(
        binding(),
        runBinding(),
        { conversationOf: async () => null, targetProject: async () => undefined },
        a,
      ),
  },
  {
    name: "GET /v1/provenance/:runId (read on the run's project)",
    path: `/${RUN}`,
    right: { grants: [`read project:${PROJECT}`] },
    router: (a) => provenanceRouter(binding(), { runBinding: runBinding() }, a),
  },
  {
    name: "GET /v1/approvals (the tenant's admin reads, not on the roster)",
    path: '/',
    right: { grants: [`admin tenant:${TENANT}`] },
    router: (a, reviewer) =>
      approvalsRouter(binding(), reviewers(reviewer), binding(), binding(), {}, a),
  },
  {
    name: 'GET /v1/reviewers (a reviewer reads the roster)',
    path: '/',
    right: { grants: [], reviewer: true },
    router: (a, reviewer) => reviewersRouter(binding(), a, reviewers(reviewer)),
  },
];

/** The route's GET and HEAD, each on its own app and record of checks. */
async function getAndHead(route: Route, grants: readonly string[], reviewer: boolean) {
  const ask = async (method: 'GET' | 'HEAD') => {
    const asked: string[] = [];
    const app = mount(route.router(authorizerGranting(grants, asked), reviewer));
    const res = await app.request(route.path, { method });
    return { status: res.status, asked };
  };
  return { get: await ask('GET'), head: await ask('HEAD') };
}

describe('a HEAD is checked as its GET', () => {
  test.each(ROUTES)('$name: without the right, its HEAD is refused as its GET', async (route) => {
    const { get, head } = await getAndHead(route, [], false);
    expect(get.status).toBe(403);
    expect(head.status).toBe(403);
    expect(head.asked).toEqual(get.asked);
  });

  test.each(ROUTES)('$name: with the right, its HEAD answers as its GET', async (route) => {
    const { get, head } = await getAndHead(
      route,
      route.right.grants,
      route.right.reviewer ?? false,
    );
    expect(get.status).not.toBe(403);
    expect(head.status).toBe(get.status);
    expect(head.asked).toEqual(get.asked);
  });
});

describe("a HEAD's page cursor is opened as its GET's", () => {
  const tenantId = randomUUID() as TenantId;
  const users: Readonly<Record<string, string>> = { 'token-1': 'user-1', 'token-2': 'user-2' };
  const resolveToken: TokenResolver = async (token) =>
    users[token] !== undefined ? { tenantId, userId: users[token] as UserId } : null;
  const POSITION = Buffer.from(JSON.stringify({ a: 'acme.last' })).toString('base64url');

  function harness() {
    const cursors: (string | undefined)[] = [];
    const agentRegistry = new Proxy(
      {},
      {
        get: (_t, name) => {
          if (name !== 'list') return undefined;
          return async (input: { cursor?: string }) => {
            cursors.push(input.cursor);
            return { data: [], nextCursor: POSITION };
          };
        },
      },
    ) as never;
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler: {} as RunHandlerBinding,
      agentRegistry,
      cursorSealer: createAeadCursorSealer({
        keys: [{ kid: 'k', key: new Uint8Array(32).fill(3) }],
      }),
    });
    const call = (method: 'GET' | 'HEAD', path: string, token: string) =>
      app.request(path, { method, headers: { authorization: `Bearer ${token}` } });
    return { call, cursors };
  }

  test("another caller's sealed cursor: its HEAD is 400 as its GET, and never reaches the list", async () => {
    const { call, cursors } = harness();
    const first = await call('GET', '/v1/agents', 'token-1');
    const { nextCursor } = (await first.json()) as { nextCursor: string };
    expect(nextCursor).not.toBe(POSITION);
    cursors.length = 0;

    const path = `/v1/agents?cursor=${encodeURIComponent(nextCursor)}`;
    expect((await call('GET', path, 'token-2')).status).toBe(400);
    expect((await call('HEAD', path, 'token-2')).status).toBe(400);
    expect(cursors).toEqual([]);
  });

  test('its own sealed cursor: its HEAD opens it to the position, as its GET', async () => {
    const { call, cursors } = harness();
    const first = await call('GET', '/v1/agents', 'token-1');
    const { nextCursor } = (await first.json()) as { nextCursor: string };
    cursors.length = 0;

    const path = `/v1/agents?cursor=${encodeURIComponent(nextCursor)}`;
    expect((await call('GET', path, 'token-1')).status).toBe(200);
    expect((await call('HEAD', path, 'token-1')).status).toBe(200);
    expect(cursors).toEqual([POSITION, POSITION]);
  });
});
