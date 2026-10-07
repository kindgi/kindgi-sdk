// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * T247: a write whose body names a project it can't use is refused before
 * any binding sees it, `400 bad-input` for a `projectId` that isn't a UUID
 * and `404 project-not-found` for one that names no project. Before, the
 * runtime's insert failed an unknown one as a 500 naming a table and a
 * foreign key. The guarded routes are held to the OpenAPI spec: every
 * operation whose body has a `projectId` is guarded, or is
 * `POST /v1/conversations`, which keeps its own documented check (T223).
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { makeInMemoryProjectBinding } from '@kindgi/platform';
import { createStubAppBindings } from '@kindgi/testing';
import type { TenantId } from '@kindgi/types';

import { OPERATIONS, createApp, generateOpenApiDocument } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';
import { PROJECT_REF_ROUTES } from '../src/middleware/project-ref.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'project-ref-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

/** The routes whose request body has a `projectId`, by their path under `/v1`, from the spec. */
function specRoutesWithProjectId(): string[] {
  const doc = generateOpenApiDocument() as unknown as {
    readonly paths: Record<
      string,
      Record<string, { readonly operationId?: string; readonly requestBody?: unknown }>
    >;
    readonly components: { readonly schemas: Record<string, unknown> };
  };
  const deref = (s: unknown): Record<string, unknown> | undefined => {
    const schema = s as { $ref?: string } | undefined;
    if (schema?.$ref !== undefined) {
      return doc.components.schemas[schema.$ref.split('/').pop() as string] as Record<
        string,
        unknown
      >;
    }
    return schema as Record<string, unknown> | undefined;
  };
  const hasProjectId = (s: unknown): boolean => {
    const schema = deref(s);
    if (schema === undefined) return false;
    if ((schema.properties as Record<string, unknown> | undefined)?.projectId !== undefined)
      return true;
    return ['oneOf', 'anyOf', 'allOf'].some((k) =>
      ((schema[k] as unknown[] | undefined) ?? []).some(hasProjectId),
    );
  };
  const honoPath = new Map(OPERATIONS.map((o) => [o.operationId, o.honoPath]));
  const routes: string[] = [];
  for (const ops of Object.values(doc.paths)) {
    for (const op of Object.values(ops)) {
      const body = (
        op.requestBody as { content?: Record<string, { schema?: unknown }> } | undefined
      )?.content?.['application/json']?.schema;
      if (body === undefined || !hasProjectId(body)) continue;
      const path = honoPath.get(op.operationId as string) as string;
      routes.push(path.replace(/^\/v1/, ''));
    }
  }
  return routes.sort();
}

describe('the routes that take a projectId (T247)', () => {
  test('every operation whose body has a projectId is guarded, or is POST /v1/conversations', () => {
    expect(specRoutesWithProjectId()).toEqual([...PROJECT_REF_ROUTES, '/conversations'].sort());
  });
});

async function harness() {
  const { projects } = makeInMemoryProjectBinding();
  const created = await projects.create(tenantId, { name: 'Acme', slug: 'acme' });
  if (created.kind !== 'ok') throw new Error('could not create the project');
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    projectBinding: projects,
  });
  const post = async (path: string, body: unknown) => {
    const res = await app.request(`/v1${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: { code: string; message: string; details?: Record<string, unknown> };
    };
    return { status: res.status, error: json.error };
  };
  return { post, projectId: created.projectId as unknown as string };
}

/** A guarded route's path, its parameters filled in. */
const concrete = (route: string): string =>
  route.replace(':agentId', 'acme.agent').replace(':suiteId', 'acme.suite');

describe('a projectId the route cannot use (T247)', () => {
  test.each(PROJECT_REF_ROUTES.map(concrete))(
    'POST %s: not a UUID → 400 bad-input; no such project → 404 project-not-found',
    async (path) => {
      const h = await harness();
      const shape = await h.post(path, { projectId: 'acme' });
      expect(shape.status).toBe(400);
      expect(shape.error).toMatchObject({
        code: 'bad-input',
        message: '`projectId` must be a project id (a UUID)',
      });

      const unknown = randomUUID();
      const missing = await h.post(path, { projectId: unknown });
      expect(missing.status).toBe(404);
      expect(missing.error).toMatchObject({
        code: 'project-not-found',
        message: `No project with id "${unknown}" in this tenant`,
        details: { projectId: unknown },
      });

      // The tenant's own project passes the guard, to whatever the route says.
      const known = await h.post(path, { projectId: h.projectId });
      expect(known.error?.code).not.toBe('project-not-found');
      expect(known.error?.message ?? '').not.toContain('`projectId` must be');
    },
  );

  test("a body without a projectId, or not JSON, is the route's to answer", async () => {
    const h = await harness();
    const none = await h.post('/runs', { agent: 'acme.agent', input: {} });
    expect(none.error?.code).not.toBe('project-not-found');
    const res = await createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler: {} as RunHandlerBinding,
    }).request('/v1/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      'valid JSON',
    );
  });

  test('POST /v1/conversations keeps its own documented 400 for an unknown project (T223)', async () => {
    const h = await harness();
    const unknown = randomUUID();
    const answer = await h.post('/conversations', {
      agentId: 'acme.agent',
      agentVersion: '1.0.0',
      projectId: unknown,
    });
    expect(answer.status).toBe(400);
    expect(answer.error?.code).toBe('bad-input');
    expect(answer.error?.message).toContain('does not resolve to a project in this tenant');
  });
});
