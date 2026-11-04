// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { createApp, generateOpenApiDocument } from '../src/index.js';
import type { CreateAppInput, TokenResolver } from '../src/index.js';
import { LIMITED_ABOVE_PROJECT } from '../src/openapi/operations.js';
import { fullAppInput } from './support/full-app.js';

/**
 * A key or session limited to a project, on a runtime with no
 * authorization store: a write above its project (to the workspace, an
 * org or a team) is refused, `403 key-project-mismatch`, before anything
 * is written, as a store refuses it (`permission-denied`). In its own
 * project it is not refused, nor is a key limited to no project.
 */

const tenantId = randomUUID() as TenantId;
const P1 = randomUUID();
const ORG = randomUUID();
const TEAM = randomUUID();
const USER = randomUUID();
const LIMITED = 'kgi_ak_test_limited_to_p1';
const UNLIMITED = 'kgi_ak_test_not_limited';
const SESSION = 'kgi_ak_test_session_limited_to_p1';

const resolveToken: TokenResolver = async (token) => {
  if (token === LIMITED) return { tenantId, tokenProjectId: P1 };
  if (token === SESSION) return { tenantId, tokenProjectId: P1, sessionId: 'ses-acme' as never };
  return token === UNLIMITED ? { tenantId } : null;
};

/** The bindings a refused write would reach. */
const ROUTE_BINDINGS = [
  'mcpEndpointRegistry',
  'secretsBinding',
  'envBinding',
  'orgBinding',
  'teamBinding',
  'teamMembershipBinding',
  'projectBinding',
  'projectMembershipBinding',
  'agentRegistry',
  'agentPins',
  'pinnedVersions',
  'toolRegistry',
  'flowRegistry',
  'guardrailRegistry',
  'memory',
  'memoryErasures',
  'retention',
  'correctionRegistry',
  'reviewerRegistry',
  'deploymentRegistry',
] as const;

const WRITE_CALL =
  /^(add|append|create|delete|erase|move|pin|publish|put|register|reinstate|remove|replay|resume|revoke|rotate|set|sweep|unpin|unregister|update|upsert|write)/;

/** Every write-named call a request makes on a route binding. */
const writes: string[] = [];

function recorded<T extends object>(name: string, target: T): T {
  return new Proxy(target, {
    get(t, key) {
      const value: unknown = Reflect.get(t, key, t);
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          if (typeof key === 'string' && WRITE_CALL.test(key)) writes.push(`${name}.${key}`);
          return value.apply(t, args);
        };
      }
      return value !== null && typeof value === 'object'
        ? recorded(`${name}.${String(key)}`, value)
        : value;
    },
  });
}

function appWith(store: boolean) {
  const { authz, sites, ...rest } = fullAppInput();
  const input: Record<string, unknown> = { ...rest, resolveToken };
  for (const name of ROUTE_BINDINGS) input[name] = recorded(name, input[name] as object);
  return createApp((store ? { ...input, authz, sites } : input) as CreateAppInput);
}

const noStore = appWith(false);
const withStore = appWith(true);

type ErrorBody = {
  error?: { code: string; message?: string; details?: Record<string, unknown> };
};

async function send(
  app: ReturnType<typeof createApp>,
  token: string,
  { method, path, body }: Pick<Row, 'method' | 'path' | 'body'>,
) {
  writes.length = 0;
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: ErrorBody = {};
  try {
    parsed = text.length > 0 ? (JSON.parse(text) as ErrorBody) : {};
  } catch {
    // Not JSON: no error code to read.
  }
  return { status: res.status, body: parsed, writes: [...writes] };
}

type Row = {
  readonly label: string;
  /** The operation, as `METHOD /openapi/path`. */
  readonly op: string;
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
};

function row(label: string, op: string, path: string, body?: unknown): Row {
  return { label, op, method: op.slice(0, op.indexOf(' ')), path, body };
}

const PIN = (scope: unknown) => ({ version: '1.0.0', scope });
const pins = (item: string, id: string, scope: unknown, where: string): Row[] =>
  (['pin', 'unpin'] as const).map((verb) =>
    row(
      `${item} ${verb}, ${where}`,
      `POST /v1/${item}s/{${item}Id}/pinned/${verb}`,
      `/v1/${item}s/${id}/pinned/${verb}`,
      PIN(scope),
    ),
  );

/** One row per write a store refuses a limited caller above its project, by tier. */
const ABOVE: readonly Row[] = [
  // The workspace.
  row('tenant update', 'PATCH /v1/tenant', '/v1/tenant', { name: 'acme' }),
  row('tenant config', 'PATCH /v1/tenant/config', '/v1/tenant/config', {}),
  row('MCP endpoint, tenant-wide', 'POST /v1/mcp/endpoints', '/v1/mcp/endpoints', {
    scopeKind: 'tenant',
  }),
  row('secret, tenant-wide', 'POST /v1/secrets', '/v1/secrets', {
    name: 'ACME_KEY',
    value: 'x',
    scope: { kind: 'tenant' },
  }),
  row(
    'secret rotate, tenant-wide',
    'POST /v1/secrets/{name}/rotate',
    '/v1/secrets/ACME_KEY/rotate?scopeKind=tenant',
    {},
  ),
  row(
    'secret revoke, tenant-wide',
    'DELETE /v1/secrets/{name}',
    '/v1/secrets/ACME_KEY?scopeKind=tenant',
  ),
  row('env value, tenant-wide', 'PUT /v1/env/{name}', '/v1/env/ACME_FLAG?scopeKind=tenant', {
    value: 'on',
  }),
  row('env delete, tenant-wide', 'DELETE /v1/env/{name}', '/v1/env/ACME_FLAG?scopeKind=tenant'),
  row('org create', 'POST /v1/orgs', '/v1/orgs', { name: 'acme' }),
  row('team create', 'POST /v1/teams', '/v1/teams', { name: 'acme' }),
  row('project create', 'POST /v1/projects', '/v1/projects', { name: 'acme' }),
  row('project move to an org', 'PATCH /v1/projects/{projectId}', `/v1/projects/${P1}`, {
    orgId: ORG,
  }),
  row('agent publish, tenant-wide', 'POST /v1/agents', '/v1/agents', {}),
  row('tool register, tenant-wide', 'POST /v1/tools', '/v1/tools', {}),
  row('flow publish, tenant-wide', 'POST /v1/flows', '/v1/flows', {}),
  row('guardrail register, tenant-wide', 'POST /v1/guardrails', '/v1/guardrails', {}),
  row('deployment, tenant-wide', 'POST /v1/deployments', '/v1/deployments', {}),
  row('deployment check, tenant-wide', 'POST /v1/deployments/check', '/v1/deployments/check', {}),
  row('release gate publish', 'POST /v1/release-gates', '/v1/release-gates', {}),
  row(
    'release gate unregister',
    'POST /v1/release-gates/{releaseGateId}/versions/{version}/unregister',
    '/v1/release-gates/acme.gate/versions/1.0.0/unregister',
    {},
  ),
  row(
    'release gate reinstate',
    'POST /v1/release-gates/{releaseGateId}/versions/{version}/reinstate',
    '/v1/release-gates/acme.gate/versions/1.0.0/reinstate',
    {},
  ),
  row('reviewer register', 'POST /v1/approvals/reviewers', '/v1/approvals/reviewers', {}),
  row(
    'reviewer unregister',
    'POST /v1/approvals/reviewers/{reviewerId}/unregister',
    `/v1/approvals/reviewers/${randomUUID()}/unregister`,
    {},
  ),
  row('corrector group, tenant-wide', 'POST /v1/corrector-groups', '/v1/corrector-groups', {
    name: 'g',
    weight: 1,
    scope: { kind: 'tenant' },
  }),
  row('retention sweep', 'POST /v1/retention/sweep', '/v1/retention/sweep', {}),
  row(
    'retention sweep, one domain',
    'POST /v1/retention/sweep/{domain}',
    '/v1/retention/sweep/agent',
    {},
  ),
  row('memory erasure', 'POST /v1/memory/erasures', '/v1/memory/erasures', {}),
  row('memory erasure replay', 'POST /v1/memory/erasures/replay', '/v1/memory/erasures/replay', {}),
  row(
    'memory erasure resume',
    'POST /v1/memory/erasures/{erasureId}/resume',
    `/v1/memory/erasures/${randomUUID()}/resume`,
    {},
  ),
  row('memory fact, tenant-wide', 'POST /v1/memory/facts', '/v1/memory/facts', {
    type: 'note',
    content: 'x',
    scope: { tenantId },
  }),
  ...pins('agent', 'acme.agent', { kind: 'tenant' }, 'tenant-wide'),
  ...pins('tool', 'acme.tool', { kind: 'tenant' }, 'tenant-wide'),
  ...pins('flow', 'acme.flow', { kind: 'tenant' }, 'tenant-wide'),
  // An org.
  row('MCP endpoint, org-wide', 'POST /v1/mcp/endpoints', '/v1/mcp/endpoints', {
    scopeKind: 'org',
    scopeId: ORG,
  }),
  row('secret, org-wide', 'POST /v1/secrets', '/v1/secrets', {
    name: 'ACME_KEY',
    value: 'x',
    scope: { kind: 'org', orgId: ORG },
  }),
  row(
    'env value, org-wide',
    'PUT /v1/env/{name}',
    `/v1/env/ACME_FLAG?scopeKind=org&scopeId=${ORG}`,
    {
      value: 'on',
    },
  ),
  row('org update', 'PATCH /v1/orgs/{orgId}', `/v1/orgs/${ORG}`, { name: 'acme' }),
  row('org delete', 'DELETE /v1/orgs/{orgId}', `/v1/orgs/${ORG}`),
  row('memory fact, org-wide', 'POST /v1/memory/facts', '/v1/memory/facts', {
    type: 'note',
    content: 'x',
    scope: { tenantId, orgId: ORG },
  }),
  ...pins('agent', 'acme.agent', { kind: 'org', orgId: ORG }, 'org-wide'),
  ...pins('tool', 'acme.tool', { kind: 'org', orgId: ORG }, 'org-wide'),
  ...pins('flow', 'acme.flow', { kind: 'org', orgId: ORG }, 'org-wide'),
  // A team.
  row('team update', 'PATCH /v1/teams/{teamId}', `/v1/teams/${TEAM}`, { name: 'acme' }),
  row('team delete', 'DELETE /v1/teams/{teamId}', `/v1/teams/${TEAM}`),
  row('team member add', 'POST /v1/teams/{teamId}/memberships', `/v1/teams/${TEAM}/memberships`, {
    userId: USER,
    role: 'member',
  }),
  row(
    'team member remove',
    'DELETE /v1/teams/{teamId}/memberships/{userId}',
    `/v1/teams/${TEAM}/memberships/${USER}`,
  ),
  row(
    'team member role',
    'PATCH /v1/teams/{teamId}/memberships/{userId}',
    `/v1/teams/${TEAM}/memberships/${USER}`,
    { role: 'admin' },
  ),
];

/** The same writes in the key's own project. */
const OWN: readonly Row[] = [
  row('MCP endpoint', 'POST /v1/mcp/endpoints', '/v1/mcp/endpoints', {
    scopeKind: 'project',
    scopeId: P1,
  }),
  row('secret', 'POST /v1/secrets', '/v1/secrets', {
    name: 'ACME_KEY',
    value: 'x',
    scope: { kind: 'project', projectId: P1 },
  }),
  row('env value', 'PUT /v1/env/{name}', `/v1/env/ACME_FLAG?scopeKind=project&scopeId=${P1}`, {
    value: 'on',
  }),
  row('agent publish', 'POST /v1/agents', '/v1/agents', { projectId: P1 }),
  row('tool register', 'POST /v1/tools', '/v1/tools', { projectId: P1 }),
  row('flow publish', 'POST /v1/flows', '/v1/flows', { projectId: P1 }),
  row('guardrail register', 'POST /v1/guardrails', '/v1/guardrails', { projectId: P1 }),
  row('deployment', 'POST /v1/deployments', '/v1/deployments', { projectId: P1 }),
  row('corrector group', 'POST /v1/corrector-groups', '/v1/corrector-groups', {
    name: 'g',
    weight: 1,
    scope: { kind: 'project', projectId: P1 },
  }),
  row('memory fact', 'POST /v1/memory/facts', '/v1/memory/facts', {
    type: 'note',
    content: 'x',
    scope: { tenantId, projectId: P1 },
  }),
  ...pins('agent', 'acme.agent', { kind: 'project', projectId: P1 }, 'its project'),
  ...pins('tool', 'acme.tool', { kind: 'project', projectId: P1 }, 'its project'),
  ...pins('flow', 'acme.flow', { kind: 'project', projectId: P1 }, 'its project'),
];

describe('a key limited to a project, with no authorization store', () => {
  test('every operation whose 403 names this refusal has a row, and no other', () => {
    const doc = generateOpenApiDocument() as {
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    };
    const documented = new Set<string>();
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (JSON.stringify(op.responses?.['403'] ?? '').includes(LIMITED_ABOVE_PROJECT)) {
          documented.add(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect([...new Set(ABOVE.map((r) => r.op))].sort()).toEqual([...documented].sort());
  });

  test.each(ABOVE)('$label: 403 key-project-mismatch, nothing written', async (r) => {
    const res = await send(noStore, LIMITED, r);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'key-project-mismatch',
      details: { keyProjectId: P1 },
    });
    expect(res.body.error?.details).not.toHaveProperty('projectId');
    expect(res.body.error?.message).toMatch(
      new RegExp(`^This API key is limited to project ${P1}, and this request changes `),
    );
    expect(res.writes).toEqual([]);
  });

  test.each(OWN)('$label, in its own project: not refused', async (r) => {
    const res = await send(noStore, LIMITED, r);
    expect(res.body.error?.code).not.toBe('key-project-mismatch');
  });

  test.each(ABOVE)('$label, by a key limited to no project: not refused', async (r) => {
    const res = await send(noStore, UNLIMITED, r);
    expect(res.body.error?.code).not.toBe('key-project-mismatch');
  });

  test('a write that is not refused reaches its binding, so the rows above see one', async () => {
    const res = await send(
      noStore,
      UNLIMITED,
      row('', 'POST /v1/orgs', '/v1/orgs', { name: 'acme' }),
    );
    expect(res.writes).not.toEqual([]);
  });

  test('a session limited to a project is held the same way', async () => {
    const res = await send(noStore, SESSION, row('', 'PATCH /v1/tenant', '/v1/tenant', {}));
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('key-project-mismatch');
    expect(res.body.error?.message).toMatch(/^This session is limited to project /);
  });

  test('a read above its project is not refused', async () => {
    for (const path of ['/v1/orgs', '/v1/env?scopeKind=tenant', '/v1/secrets?scopeKind=tenant']) {
      const res = await send(noStore, LIMITED, { method: 'GET', path });
      expect(res.body.error?.code, path).not.toBe('key-project-mismatch');
    }
  });

  test('a write to an item by its id is not refused', async () => {
    const res = await send(noStore, LIMITED, {
      method: 'POST',
      path: `/v1/mcp/endpoints/${randomUUID()}/unregister`,
      body: {},
    });
    expect(res.body.error?.code).not.toBe('key-project-mismatch');
  });
});

describe('a key limited to a project, with an authorization store', () => {
  test.each(ABOVE)('$label: 403 permission-denied, as before', async (r) => {
    const res = await send(withStore, LIMITED, r);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('permission-denied');
    expect(res.writes).toEqual([]);
  });
});
