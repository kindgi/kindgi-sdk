// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuthzCheckBinding, Decision } from '@kindgi/authz';
import { makeInMemoryProjectBinding } from '@kindgi/platform';
import type { TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';
import { PROJECT_LITERAL_READS } from '../src/middleware/key-project.js';
import { createStubAppBindings } from '../src/testing/index.js';
import { fullAppInput } from './support/full-app.js';

/**
 * A route with a fixed word where a project id goes (`GET
 * /v1/projects/default`) names no project in its path. A key or session
 * limited to a project reads it only when the project it answers for is
 * the caller's own; otherwise it gets the refusal the path gave it before,
 * naming the word, never the project behind it. Every other request that
 * names a project, the word in an id's place included, is checked as
 * before.
 */

const LIMITED = 'kgi_ak_test_limited_to_own';
const SESSION = 'kgi_ak_test_session_limited_to_own';
const UNLIMITED = 'kgi_ak_test_not_limited';

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
};

type DefaultIs = 'own' | 'other' | 'none';

/**
 * A workspace with two projects, `own` (the limited callers') and
 * `other`, and `defaultIs` naming its default. With `store`, the
 * authorization check allows everything, so what's refused is the
 * caller's limit alone, and `records` holds each refusal it records.
 */
async function workspace(defaultIs: DefaultIs, store: boolean) {
  const tenantId = randomUUID() as TenantId;
  const trio = makeInMemoryProjectBinding();
  const make = async (slug: string, isDefault: boolean) => {
    const made = await trio.projects.create(tenantId, { name: slug, slug, isDefault });
    if (made.kind !== 'ok') throw new Error(made.kind);
    return made.projectId as unknown as string;
  };
  const own = await make('acme-own', defaultIs === 'own');
  const other = await make('acme-other', defaultIs === 'other');
  const resolveToken: TokenResolver = async (token) => {
    const person = { tenantId, userId: 'jane' as UserId };
    const limited = { ...person, tokenProjectId: own };
    if (token === LIMITED) return limited;
    if (token === SESSION) return { ...limited, sessionId: 'ses-acme' as never };
    return token === UNLIMITED ? person : null;
  };
  const records: string[] = [];
  const authzCheckBinding: AuthzCheckBinding = {
    check: async (_principal, action, resource) =>
      ({
        allowed: true,
        reason: 'test: granted',
        evidence: { action, relation: '', resource: resource.id, actorSubject: '' },
      }) satisfies Decision,
    checkBatch: async (_principal, action, resources) =>
      resources.map(
        (resource) =>
          ({
            allowed: true,
            reason: 'test: granted',
            evidence: { action, relation: '', resource: resource.id, actorSubject: '' },
          }) satisfies Decision,
      ),
    recordDecision: (_principal, action, resource, decision) => {
      records.push(`${action} ${resource.type}:${resource.id}: ${decision.reason}`);
    },
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    projectBinding: trio.projects,
    projectMembershipBinding: trio.memberships,
    teamProjectGrantBinding: trio.grants,
    ...(store && { authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding } }),
  });
  const as = async (token: string, path: string, method = 'GET') => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(method === 'PATCH' && { body: JSON.stringify({ name: 'acme-renamed' }) }),
    });
    return { status: res.status, text: await res.text() };
  };
  return { own, other, as, records };
}

type WireError = {
  error: { code: string; message: string; details?: Record<string, unknown> };
};

const errorOf = (text: string) => (JSON.parse(text) as WireError).error;

type Named = { own: string; named: string; who: string; action?: string };

/** The refusal a limited caller gets on a request that names project `named`. */
function namesProject(text: string, { own, named, who, action = 'read' }: Named) {
  expect(errorOf(text)).toMatchObject({
    code: 'key-project-mismatch',
    message: `${who} is limited to project ${own}; the request names project ${named}`,
    details: { keyProjectId: own, projectId: named, action, resource: `project:${named}` },
  });
}

describe('the routes with a fixed word where a project id goes', () => {
  test('are the reads PROJECT_LITERAL_READS names, and no other route the app mounts', () => {
    const literal = createApp(fullAppInput())
      .routes.filter((r) => r.method !== 'ALL' && /\/projects\/[^/:]/.test(r.path))
      .map((r) => `${r.method} ${r.path}`);
    expect([...new Set(literal)].sort()).toEqual(
      PROJECT_LITERAL_READS.map((path) => `GET ${path}`).sort(),
    );
  });
});

const CALLERS = [
  { label: 'a key', token: LIMITED, who: 'This API key' },
  { label: 'a session', token: SESSION, who: 'This session' },
] as const;

describe.each([
  { store: false, where: 'without a store' },
  { store: true, where: 'with a store' },
])('GET /v1/projects/default, $where', ({ store }) => {
  describe.each(CALLERS)('$label limited to a project', ({ token, who }) => {
    test('reads the default project when it is its own, its HEAD too', async () => {
      const { own, as } = await workspace('own', store);
      const res = await as(token, '/v1/projects/default');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.text)).toMatchObject({ id: own, isDefault: true });
      expect((await as(token, '/v1/projects/default', 'HEAD')).status).toBe(200);
    });

    test("is refused another project's default, naming `default`: none of its settings come back", async () => {
      const { own, other, as, records } = await workspace('other', store);
      const res = await as(token, '/v1/projects/default');
      expect(res.status).toBe(403);
      namesProject(res.text, { own, named: 'default', who });
      expect(res.text).not.toContain(other);
      expect(res.text).not.toContain('acme-other');
      expect((await as(token, '/v1/projects/default', 'HEAD')).status).toBe(403);
      if (store) {
        expect(records).toContain(
          `read project:default: ${who} is limited to project ${own}; the request names project default`,
        );
        expect(records.join('\n')).not.toContain(other);
      }
    });

    test('is refused the same way when the workspace has no default project', async () => {
      const { own, as } = await workspace('none', store);
      const res = await as(token, '/v1/projects/default');
      expect(res.status).toBe(403);
      namesProject(res.text, { own, named: 'default', who });
      expect((await as(token, '/v1/projects/default', 'HEAD')).status).toBe(403);
    });

    test('is refused when the query names another project, though the default is its own', async () => {
      const { own, other, as } = await workspace('own', store);
      const res = await as(token, `/v1/projects/default?projectId=${other}`);
      expect(res.status).toBe(403);
      namesProject(res.text, { own, named: other, who });
    });
  });

  test('a caller limited to no project reads any default, and gets 404 when there is none', async () => {
    const { other, as } = await workspace('other', store);
    const res = await as(UNLIMITED, '/v1/projects/default');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ id: other });
    const none = await (await workspace('none', store)).as(UNLIMITED, '/v1/projects/default');
    expect(none.status).toBe(404);
    expect(errorOf(none.text)).toMatchObject({
      code: 'project-not-found',
      message: 'Workspace has no default project',
    });
  });
});

describe.each([
  { store: false, where: 'without a store' },
  { store: true, where: 'with a store' },
])('every other request that names a project, $where, is checked as before', ({ store }) => {
  test("another project's routes are refused a limited key, naming that project", async () => {
    const { own, other, as } = await workspace('own', store);
    for (const path of [`/v1/projects/${other}`, `/v1/projects/${other}/memberships`]) {
      const res = await as(LIMITED, path);
      expect(res.status, path).toBe(403);
      namesProject(res.text, { own, named: other, who: 'This API key' });
    }
  });

  test("the word in an id's place names the project `default`: a nested path, a change, a delete", async () => {
    const { own, as } = await workspace('own', store);
    const reads = ['/v1/projects/default/memberships', '/v1/projects/default/'];
    for (const path of reads) {
      const res = await as(LIMITED, path);
      expect(res.status, path).toBe(403);
      namesProject(res.text, { own, named: 'default', who: 'This API key' });
    }
    for (const method of ['PATCH', 'DELETE']) {
      const res = await as(LIMITED, '/v1/projects/default', method);
      expect(res.status, method).toBe(403);
      namesProject(res.text, { own, named: 'default', who: 'This API key', action: 'write' });
    }
  });

  test('its own project is not refused', async () => {
    const { own, as } = await workspace('other', store);
    const res = await as(LIMITED, `/v1/projects/${own}`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ id: own });
  });
});
