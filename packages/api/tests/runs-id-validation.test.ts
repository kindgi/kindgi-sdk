// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A run id in a path or a filter that isn't a run id (a UUID) is a 400,
 * before it reaches a query, where Postgres's uuid cast failed it as a 500.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { RunBinding } from '@kindgi/runtime';
import { createStubAppBindings } from '@kindgi/testing';
import type { TenantId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'runs-id-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

/** An app whose run binding throws if a malformed id ever reaches it. */
function app() {
  const stubs = createStubAppBindings();
  const reached: string[] = [];
  const run = {
    ...stubs.kernelBinding.run,
    getRun: async (_t: TenantId, runId: string) => {
      reached.push(runId);
      return null;
    },
    listRuns: async (input: { parent?: { runId: string } }) => {
      reached.push(input.parent?.runId ?? 'list');
      return { data: [], hasMore: false };
    },
  } as unknown as RunBinding;
  const built = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    runHandler: {} as RunHandlerBinding,
  });
  return { built, reached };
}

async function call(path: string, method = 'GET') {
  const h = app();
  const res = await h.built.request(path, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(method === 'POST' && { 'content-type': 'application/json' }),
    },
    ...(method === 'POST' && { body: '{}' }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, ...h };
}

describe("a run id that isn't one", () => {
  test.each([
    ['GET', '/v1/runs/not-a-uuid'],
    ['GET', '/v1/runs/not-a-uuid/progress'],
    ['GET', '/v1/runs/not-a-uuid/journal'],
    ['GET', '/v1/runs/not-a-uuid/stream'],
    ['GET', '/v1/runs/not-a-uuid/progress/stream'],
    ['POST', '/v1/runs/not-a-uuid/cancel'],
  ])('%s %s: 400 bad-input, and no query', async (method, path) => {
    const answer = await call(path, method);
    expect(answer.status).toBe(400);
    expect(answer.json.error).toMatchObject({
      code: 'bad-input',
      message: '`runId` must be a run id (a UUID)',
    });
    expect(answer.reached).toEqual([]);
  });

  test('a well-formed id that names no run is still a 404', async () => {
    const answer = await call(`/v1/runs/${randomUUID()}`);
    expect(answer.status).toBe(404);
    expect(answer.json.error).toMatchObject({ code: 'run-not-found' });
  });

  test('resume still answers 422 whatever the id', async () => {
    const answer = await call('/v1/runs/not-a-uuid/resume', 'POST');
    expect(answer.status).toBe(422);
  });

  test.each([
    ['project', 'scopeId must be a project id (a UUID), got "acme-desk"'],
    ['org', 'scopeId must be an org id (a UUID), got "acme-desk"'],
  ])('a %s scopeId that is not a UUID: 400 scope-invalid, and no query', async (kind, message) => {
    const answer = await call(`/v1/runs?scopeKind=${kind}&scopeId=acme-desk`);
    expect(answer.status).toBe(400);
    expect(answer.json.error).toMatchObject({ code: 'scope-invalid' });
    expect((answer.json.error as { message: string }).message).toContain(message);
    expect(answer.reached).toEqual([]);
  });

  test('a project scope that is a UUID still reaches the run list', async () => {
    const answer = await call(`/v1/runs?scopeKind=project&scopeId=${randomUUID()}`);
    expect(answer.status).toBe(200);
    expect(answer.reached).toEqual(['list']);
  });

  test('a parentRunId filter that is not a run id: 400, and no query', async () => {
    const answer = await call('/v1/runs?parentRunId=not-a-uuid');
    expect(answer.status).toBe(400);
    expect((answer.json.error as { message: string }).message).toContain(
      '`parentRunId` must be a run id (a UUID)',
    );
    expect(answer.reached).toEqual([]);
  });
});
