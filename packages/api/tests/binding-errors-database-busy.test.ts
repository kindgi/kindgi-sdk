// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A binding's Result error the database was too busy for, on the wire. A
 * binding that re-codes a storage failure as its own code
 * (`persistence-error`, `journal-error`, `blob-storage-error`, ...) and
 * keeps the failure as the `cause` gets, on a GET or HEAD, the same `503
 * database-busy` with `Retry-After` a thrown one gets (thrown-errors.test.ts).
 * Any other method, or an error without the mark, answers as before: the
 * code's status and the binding's message.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuthzCheckBinding } from '@kindgi/authz';
import { type Logger, createLogger } from '@kindgi/log';
import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'binding-errors-database-busy';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId, reviewerRole: 'admin' } : null;

/** A storage failure marked busy, as the bindings' storage gives it. */
const storageBusy = {
  code: 'database-busy',
  message: 'Tenant-scoped query failed: canceling statement due to lock timeout',
  cause: Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
};

/** A binding's error re-coding `cause` as `code`, `hops` re-codes deep (1: the storage failure is its cause). */
function recoded(code: string, hops = 1, cause: unknown = storageBusy) {
  let error: { code: string; message: string; cause: unknown } = {
    code,
    message: `Failed to read: ${storageBusy.message}`,
    cause,
  };
  for (let hop = hops; hop > 1; hop--) {
    error = { code, message: `Failed to read: ${error.message}`, cause: error };
  }
  return error;
}

const runId = randomUUID();
const approvalId = randomUUID();
const conversationId = randomUUID();

/** A provenance record, so the run's call usage is read after it. */
const record = {
  id: randomUUID(),
  tenantId,
  runId,
  agentId: 'support-bot',
  createdAt: '2026-10-16T00:00:00.000Z',
};

/**
 * The app with every binding these routes read failing with `error` (or
 * the supervisor's outcome made of it), and the provenance record found
 * when `recordFound`. With `allowAll`, an authorizer that allows every
 * check: the messages route then reads the conversation first, and the
 * sign-in history needs a tenant admin.
 */
function appFailingWith(
  error: { code: string; message: string; cause?: unknown },
  opts: { recordFound?: boolean; allowAll?: boolean; logger?: Logger } = {},
) {
  const err = async () => ({ kind: 'err', error });
  const stubs = createStubAppBindings();
  const allowed = {
    allowed: true,
    reason: 'test: allowed',
    evidence: { action: 'read', relation: '', resource: '', actorSubject: '' },
  };
  return createApp({
    ...stubs,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    hitlBinding: { listApprovals: err, getApproval: err } as never,
    reviewerBinding: { resolveReviewer: async () => 'rev-1' } as never,
    conversationBinding: {
      ...stubs.conversationBinding,
      listConversationsPage: err,
      getConversation: err,
      readMessages: err,
    } as never,
    kernelBinding: {
      ...stubs.kernelBinding,
      run: { ...stubs.kernelBinding.run, readJournal: err },
    } as never,
    auditEvents: { query: err } as never,
    enableObservations: true,
    supervisor: {
      queryObservations: async () => ({ kind: 'runtime-error', ...error }),
    } as never,
    provenanceBinding: {
      ...stubs.provenanceBinding,
      listRecords: err,
      getByRunId: opts.recordFound === true ? async () => ({ kind: 'ok', value: record }) : err,
      getCallUsage: err,
    } as never,
    blobStorage: { list: err } as never,
    ...(opts.logger !== undefined && { logger: opts.logger }),
    ...(opts.allowAll === true && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async () => allowed,
          checkBatch: async (_p, _a, rs) => rs.map(() => allowed),
        } as AuthzCheckBinding,
      },
    }),
  });
}

async function call(
  app: ReturnType<typeof appFailingWith>,
  path: string,
  method = 'GET',
  body?: Record<string, unknown>,
) {
  const res = await app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'x-request-id': 'req-busy-binding',
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, retryAfter: res.headers.get('retry-after'), text };
}

/** Each GET that answers a binding's Result error, and the code its binding re-codes to. */
const READS: readonly {
  readonly path: string;
  readonly code: string;
  readonly opts?: { readonly recordFound?: boolean; readonly allowAll?: boolean };
}[] = [
  { path: '/v1/approvals', code: 'persistence-error' },
  { path: `/v1/approvals/${approvalId}`, code: 'persistence-error' },
  { path: '/v1/conversations', code: 'persistence-error' },
  { path: `/v1/conversations/${conversationId}`, code: 'persistence-error' },
  { path: `/v1/conversations/${conversationId}/messages`, code: 'persistence-error' },
  // With an authorizer, the messages route reads the conversation first.
  {
    path: `/v1/conversations/${conversationId}/messages`,
    code: 'persistence-error',
    opts: { allowAll: true },
  },
  { path: `/v1/runs/${runId}/journal`, code: 'journal-error' },
  { path: '/v1/audit/authz', code: 'persistence-error' },
  // A tenant admin's read: the authorizer says so.
  { path: '/v1/audit/sign-ins', code: 'persistence-error', opts: { allowAll: true } },
  { path: '/v1/observations', code: 'persistence-error' },
  { path: '/v1/provenance', code: 'persistence-error' },
  { path: `/v1/provenance/${runId}`, code: 'persistence-error' },
  // The record found, then the run's call usage read.
  { path: `/v1/provenance/${runId}`, code: 'internal-server-error', opts: { recordFound: true } },
  { path: '/v1/artifacts', code: 'blob-storage-error' },
];

describe("a binding's Result error the database was too busy for", () => {
  test.each(READS)(
    'GET $path ($code, the storage failure its cause): 503 database-busy with Retry-After',
    async ({ path, code, opts }) => {
      const answer = await call(appFailingWith(recoded(code), opts), path);
      expect(answer.status, answer.text).toBe(503);
      expect(answer.retryAfter).toBe('5');
      expect(JSON.parse(answer.text)).toEqual({
        error: {
          code: 'database-busy',
          message: 'The database was too busy to answer in time. Try again after Retry-After.',
          requestId: 'req-busy-binding',
        },
      });
      // Neither the binding's message nor the storage failure's reaches the client.
      expect(answer.text).not.toContain('lock timeout');
    },
  );

  test.each(READS)('HEAD $path answers the same 503', async ({ path, code, opts }) => {
    const answer = await call(appFailingWith(recoded(code), opts), path, 'HEAD');
    expect(answer.status).toBe(503);
    expect(answer.retryAfter).toBe('5');
  });

  test.each(READS)(
    'GET $path without the busy mark answers as before: the code, its status, the message',
    async ({ path, code, opts }) => {
      const plain = { code, message: 'Failed to read: the table is gone' };
      const answer = await call(appFailingWith(plain, opts), path);
      expect(answer.status, answer.text).toBe(500);
      expect(answer.retryAfter).toBeNull();
      expect(JSON.parse(answer.text).error.code).toBe(code);
    },
  );

  test('the mark two re-codes down (a log read re-coded by the conversation binding) still counts', async () => {
    const twice = recoded('persistence-error', 2);
    const answer = await call(
      appFailingWith(twice),
      `/v1/conversations/${conversationId}/messages`,
    );
    expect(answer.status).toBe(503);
  });

  test('a write the database was too busy for still answers 500: part of it may have committed', async () => {
    const app = appFailingWith(recoded('persistence-error'));
    const complete = await call(app, `/v1/approvals/${approvalId}/complete`, 'POST', {
      decision: 'approve',
    });
    expect(complete.status, complete.text).toBe(500);
    expect(complete.retryAfter).toBeNull();
    expect(JSON.parse(complete.text).error.code).toBe('persistence-error');
    const closed = await call(app, `/v1/conversations/${conversationId}/close`, 'POST');
    expect(closed.status, closed.text).toBe(500);
    expect(closed.retryAfter).toBeNull();
    expect(JSON.parse(closed.text).error.code).toBe('persistence-error');
  });

  test("the warn line names the binding's error by its code and message, and nothing under it", async () => {
    // The storage failure and the driver error under it each carry text of
    // their own: a query's values can be a person's (`params: …`).
    const driver = Object.assign(
      new Error('canceling statement due to lock timeout; params: owner@example.test'),
      { code: '55P03' },
    );
    const error = recoded('persistence-error', 1, {
      code: 'database-busy',
      message: 'Tenant-scoped query failed: the storage failure itself',
      cause: driver,
    });
    const lines: string[] = [];
    const app = appFailingWith(error, {
      logger: createLogger({ write: (line) => lines.push(line) }),
    });
    expect((await call(app, '/v1/approvals')).status).toBe(503);
    const busy = lines
      .map((line) => JSON.parse(line) as { level?: string; message?: string; err?: unknown })
      .filter((record) => record.message === 'database busy');
    expect(busy).toHaveLength(1);
    expect(busy[0]?.level).toBe('warn');
    expect(busy[0]?.err).toEqual({
      name: 'Object',
      code: 'persistence-error',
      message: error.message,
    });
    const logged = lines.join('\n');
    expect(logged).not.toContain('the storage failure itself');
    expect(logged).not.toContain('owner@example.test');
  });
});
