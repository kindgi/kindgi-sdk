// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/compliance/evidence?kind=`: a built-in evidence kind, or one
 * the classifier names. Any other word, a renamed kind's old one among
 * them, is a 400; a kind the classifier doesn't mark exportable is an
 * empty page.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent } from '@kindgi/audit-events';
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
import type { LoadedClassifier } from '@kindgi/compliance';
import type { TenantId, Timestamp, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'compliance-evidence-kind';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN
    ? { tenantId, userId: 'u-1' as UserId, reviewerRole: 'admin', scopes: ['tenant-admin'] }
    : null;

const classifierFile = {
  version: 1,
  default: { retention: { days: 90 }, signed: false, exportable: true },
  byKind: {
    'test-run': { retention: { days: 90 }, signed: true, exportable: true },
    'acme-review': { retention: { days: 90 }, signed: false, exportable: true },
    'authz-decision': { retention: { days: 90 }, signed: false, exportable: false },
  },
};
const complianceClassifier = {
  file: classifierFile,
  resolve: (kind: string) =>
    (classifierFile.byKind as Record<string, unknown>)[kind] ?? classifierFile.default,
} as unknown as LoadedClassifier;

function event(kind: string): AuditEvent {
  return {
    id: `evt-${kind}`,
    tenantId,
    kind,
    timestamp: new Date(Date.UTC(2026, 9, 30, 12, 0, 0)).toISOString() as Timestamp,
    actor: 'user:u-1',
    outcome: 'succeeded',
    payload: { v: 1, doc: {} },
  };
}

async function list(kind: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const auditEvents = createInMemoryAuditEventBinding();
  await auditEvents.append([event('test-run'), event('acme-review'), event('authz-decision')]);
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    auditEvents,
    complianceClassifier,
    complianceGenerator: { describe: () => ({ name: 'none', version: '0' }) } as never,
  });
  const res = await app.request(`/v1/compliance/evidence?kind=${kind}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('the evidence list kind filter', () => {
  test.each(['eval-run', 'no-such-kind'])('%s is not an evidence kind: 400', async (kind) => {
    const answer = await list(kind);
    expect(answer.status).toBe(400);
    expect(answer.json.error).toMatchObject({ code: 'bad-input' });
    expect(JSON.stringify(answer.json)).toContain('`kind` must be an evidence kind');
  });

  test.each(['test-run', 'acme-review'])(
    '%s, built in or named by the classifier, lists its records',
    async (kind) => {
      const answer = await list(kind);
      expect(answer.status).toBe(200);
      expect((answer.json.data as unknown[]).length).toBe(1);
    },
  );

  test('a kind the classifier names but does not mark exportable is an empty page', async () => {
    const answer = await list('authz-decision');
    expect(answer).toEqual({ status: 200, json: { data: [], hasMore: false } });
  });
});
