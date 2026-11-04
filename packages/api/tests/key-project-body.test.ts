// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

/**
 * A key limited to a project, on a runtime with no authorization store:
 * its own limit is all that holds it. A write body that names another
 * project, in each shape a route reads one from, is refused before the
 * route runs (`key-project-mismatch`); one that names its own isn't.
 */

const tenantId = randomUUID() as TenantId;
const P1 = randomUUID();
const P2 = randomUUID();
const LIMITED = 'kgi_ak_test_limited_to_p1';

const resolveToken: TokenResolver = async (token) =>
  token === LIMITED ? { tenantId, tokenProjectId: P1 } : null;

const app = createApp({
  ...createStubAppBindings(),
  resolveToken,
  runHandler: {} as RunHandlerBinding,
});

type ErrorBody = { error?: { code: string; details?: unknown } };

async function post(path: string, body: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${LIMITED}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text.length > 0 ? JSON.parse(text) : {}) as ErrorBody };
}

const BODIES: [string, string, (project: string) => unknown][] = [
  [
    "an MCP endpoint's register body, scopeKind project with scopeId",
    '/v1/mcp/endpoints',
    (project) => ({ scopeKind: 'project', scopeId: project }),
  ],
  [
    "an Improve schedule's target, improve.projectId",
    '/v1/schedules',
    (project) => ({ improve: { agentId: 'acme.agent', projectId: project } }),
  ],
];

describe('a key limited to a project, with no authorization store', () => {
  test.each(BODIES)(
    '%s, naming another project: 403 key-project-mismatch',
    async (_, path, body) => {
      const res = await post(path, body(P2));
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({
        code: 'key-project-mismatch',
        details: { keyProjectId: P1, projectId: P2 },
      });
    },
  );

  test.each(BODIES)(
    '%s, naming its own project: not refused for the project',
    async (_, path, body) => {
      const res = await post(path, body(P1));
      expect(res.body.error?.code).not.toBe('key-project-mismatch');
    },
  );

  test("scopeKind org: its scopeId isn't read as a project", async () => {
    const res = await post('/v1/mcp/endpoints', { scopeKind: 'org', scopeId: P2 });
    expect(res.body.error?.code).not.toBe('key-project-mismatch');
  });
});
