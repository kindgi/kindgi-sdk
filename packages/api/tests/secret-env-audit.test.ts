// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Every secret and env write through the API is recorded at the route:
 * `secret-set`, `secret-rotated` / `secret-rotation-started` /
 * `secret-rotation-failed`, `secret-revoked` / `secret-hard-revoked`,
 * `env-set`, `env-deleted`. The record names the caller (`actor`), the
 * tenant, the scope's project, the request (`correlationId`) and what the
 * backend answered; never the value, nor anything derived from one.
 */

import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
import { EVIDENCE_KINDS } from '@kindgi/compliance';
import type { ApiTokenId, ProjectId, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { WRITE_AUDIT_KINDS, createApp } from '../src/index.js';
import type { EnvBinding, RunHandlerBinding, SecretBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const projectId = randomUUID() as ProjectId;
const ALICE = 'token-alice';
const BARE = 'token-bare';
const KEY = 'token-key';
const CAPS = [
  'secrets:write',
  'secrets:rotate',
  'secrets:revoke',
  'secrets:revoke:hard',
  'env:write',
];
const resolveToken: TokenResolver = async (t) => {
  if (t === ALICE) return { tenantId, userId: 'alice' as UserId, capabilities: CAPS };
  if (t === BARE) return { tenantId, capabilities: CAPS };
  // An API key with no principal acts as its own service account.
  if (t === KEY) return { tenantId, tokenId: 'key-1' as ApiTokenId, capabilities: CAPS };
  return null;
};

const VALUE = 'sk-live-THE-VALUE-0123456789';
const RECORD = {
  name: 'stripe-key',
  envName: 'production',
  currentVersion: 1,
  createdAt: '2026-10-09T12:00:00.000Z',
  updatedAt: '2026-10-09T12:00:00.000Z',
  tags: {},
};

function harness(
  answers: {
    set?: unknown;
    rotate?: unknown;
    revoke?: unknown;
    envSet?: unknown;
    envDelete?: unknown;
  } = {},
  auditEvents: AuditEventBinding | null = createInMemoryAuditEventBinding(),
) {
  const secretsBinding = {
    set: async () => answers.set ?? { kind: 'ok', record: RECORD, versionId: 1 },
    rotate: async () =>
      answers.rotate ?? { kind: 'ok', value: { kind: 'ok', newVersionId: 3, oldVersionId: 2 } },
    revoke: async () => answers.revoke ?? { kind: 'ok', value: { revoked: true, hard: false } },
  } as unknown as SecretBinding;
  const envBinding = {
    set: async () =>
      answers.envSet ?? {
        kind: 'ok',
        record: { ...RECORD, name: 'KB_URL', revision: 4 },
      },
    delete: async () => answers.envDelete ?? { deleted: true },
  } as unknown as EnvBinding;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    secretsBinding,
    envBinding,
    ...(auditEvents !== null && { auditEvents }),
  });
  const call = async (method: string, path: string, body?: unknown, token = ALICE) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-request-id': 'req-123',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return res.status;
  };
  const recorded = async (): Promise<AuditEvent[]> => {
    if (auditEvents === null) return [];
    const page = await auditEvents.query({ tenantId, limit: 50 });
    if (page.kind === 'err') throw new Error(page.error.message);
    return [...page.value.data];
  };
  return { call, recorded };
}

const projectScope = { kind: 'project', tenantId, projectId };
const queryScope = `envName=production&scopeKind=project&scopeId=${projectId}`;
const docOf = (e: AuditEvent | undefined) =>
  (e?.payload as { doc?: Record<string, unknown> } | undefined)?.doc;

const setBody = (writeMode = 'create-new') => ({
  scope: projectScope,
  envName: 'production',
  name: 'stripe-key',
  value: VALUE,
  writeMode,
});

describe('secret writes are recorded at the route', () => {
  test('a set: secret-set, by the caller, in its project, with the request; never the value', async () => {
    const { call, recorded } = harness();
    expect(await call('POST', '/v1/secrets', setBody())).toBe(201);
    const events = await recorded();
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      kind: 'secret-set',
      tenantId,
      projectId,
      actor: 'user:alice',
      correlationId: 'req-123',
      outcome: 'succeeded',
    });
    expect(docOf(event)).toMatchObject({
      name: 'stripe-key',
      envName: 'production',
      writeMode: 'create-new',
      recordVersion: 1,
    });
    expect(JSON.stringify(events)).not.toContain(VALUE);
  });

  test("a set that dropped a revoked secret's values says so (revokedValuesPurged)", async () => {
    const { call, recorded } = harness({
      set: { kind: 'ok', record: RECORD, versionId: 7, revokedValuesPurged: true },
    });
    expect(await call('POST', '/v1/secrets', setBody('add-version'))).toBe(200);
    const [event] = await recorded();
    expect(docOf(event)).toMatchObject({
      writeMode: 'add-version',
      recordVersion: 7,
      revokedValuesPurged: true,
    });
  });

  test('a refused set: secret-set, failed, with the code the client got', async () => {
    const { call, recorded } = harness({ set: { kind: 'version-conflict', currentVersion: 2 } });
    expect(await call('POST', '/v1/secrets', setBody('add-version'))).toBe(409);
    const [event] = await recorded();
    expect(event).toMatchObject({ kind: 'secret-set', outcome: 'failed' });
    expect(docOf(event)).toMatchObject({ errorCode: 'secret-write-conflict' });
  });

  test("a caller with no person, service account or key is named by its credential's hash, never the token", async () => {
    const { call, recorded } = harness();
    expect(await call('POST', '/v1/secrets', setBody(), BARE)).toBe(201);
    const events = await recorded();
    const hash = createHash('sha256').update(`Bearer ${BARE}`).digest('hex').slice(0, 16);
    expect(events[0]?.actor).toBe(`token:${hash}`);
    expect(JSON.stringify(events)).not.toContain(BARE);
  });

  test('an API key with no principal is its own service account', async () => {
    const { call, recorded } = harness();
    expect(await call('POST', '/v1/secrets', setBody(), KEY)).toBe(201);
    expect((await recorded())[0]?.actor).toBe('service_account:key-1');
  });

  test('a tenant-scoped write has no project', async () => {
    const { call, recorded } = harness();
    const body = { ...setBody(), scope: { kind: 'tenant', tenantId } };
    expect(await call('POST', '/v1/secrets', body)).toBe(201);
    const [event] = await recorded();
    expect(event?.tenantId).toBe(tenantId);
    expect(event).not.toHaveProperty('projectId');
    expect(docOf(event)).toMatchObject({ scope: { kind: 'tenant' } });
  });

  test('a rotation: secret-rotated with both versions; never the new value', async () => {
    const { call, recorded } = harness();
    const body = { scope: projectScope, envName: 'production', newValue: VALUE };
    expect(await call('POST', '/v1/secrets/stripe-key/rotate', body)).toBe(201);
    const events = await recorded();
    expect(events.map((e) => e.kind)).toEqual(['secret-rotated']);
    expect(docOf(events[0])).toMatchObject({ recordVersion: 3, previousVersion: 2 });
    expect(JSON.stringify(events)).not.toContain(VALUE);
  });

  test('an asynchronous rotation: secret-rotation-started, with its id', async () => {
    const { call, recorded } = harness({
      rotate: {
        kind: 'ok',
        value: { kind: 'rotation-pending', provider: 'acme-vault', resumeToken: 'opaque' },
      },
    });
    const body = { scope: projectScope, envName: 'production' };
    expect(await call('POST', '/v1/secrets/stripe-key/rotate', body)).toBe(202);
    const [event] = await recorded();
    expect(event?.kind).toBe('secret-rotation-started');
    expect(typeof docOf(event)?.rotationId).toBe('string');
    expect(JSON.stringify(event)).not.toContain('opaque');
  });

  test('a rotation the backend refuses: secret-rotation-failed', async () => {
    const { call, recorded } = harness({
      rotate: { kind: 'err', error: { code: 'secret-not-found', message: 'no such secret' } },
    });
    const body = { scope: projectScope, envName: 'production', newValue: VALUE };
    expect(await call('POST', '/v1/secrets/stripe-key/rotate', body)).toBe(404);
    const [event] = await recorded();
    expect(event).toMatchObject({ kind: 'secret-rotation-failed', outcome: 'failed' });
    expect(docOf(event)).toMatchObject({ errorCode: 'secret-not-found' });
  });

  test('a revoke: secret-revoked with its reason; a hard one: secret-hard-revoked', async () => {
    const { call, recorded } = harness();
    expect(await call('DELETE', `/v1/secrets/stripe-key?${queryScope}&reason=leaked`)).toBe(200);
    expect(await call('DELETE', `/v1/secrets/stripe-key?${queryScope}&hard=true`)).toBe(200);
    const events = await recorded();
    const kinds = events.map((e) => e.kind).sort();
    expect(kinds).toEqual(['secret-hard-revoked', 'secret-revoked']);
    const soft = events.find((e) => e.kind === 'secret-revoked');
    expect(docOf(soft)).toMatchObject({ name: 'stripe-key', reason: 'leaked' });
    const hard = events.find((e) => e.kind === 'secret-hard-revoked');
    expect(docOf(hard)).toMatchObject({ hard: true });
  });

  test('a revoke that changed nothing is not recorded', async () => {
    const { call, recorded } = harness({
      revoke: { kind: 'ok', value: { revoked: false, hard: false } },
    });
    expect(await call('DELETE', `/v1/secrets/stripe-key?${queryScope}`)).toBe(200);
    expect(await recorded()).toEqual([]);
  });
});

describe('env writes are recorded at the route', () => {
  test('a set: env-set with its revision; never the value', async () => {
    const { call, recorded } = harness();
    const body = { scope: projectScope, value: VALUE };
    expect(await call('PUT', `/v1/env/KB_URL?${queryScope}`, body)).toBe(200);
    const events = await recorded();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'env-set',
      projectId,
      actor: 'user:alice',
      correlationId: 'req-123',
      outcome: 'succeeded',
    });
    expect(docOf(events[0])).toMatchObject({ name: 'KB_URL', recordVersion: 4 });
    expect(JSON.stringify(events)).not.toContain(VALUE);
  });

  test('a delete: env-deleted; one that removed nothing is not recorded', async () => {
    const { call, recorded } = harness();
    expect(await call('DELETE', `/v1/env/KB_URL?${queryScope}`)).toBe(200);
    expect((await recorded()).map((e) => e.kind)).toEqual(['env-deleted']);

    const none = harness({ envDelete: { deleted: false } });
    expect(await none.call('DELETE', `/v1/env/KB_URL?${queryScope}`)).toBe(200);
    expect(await none.recorded()).toEqual([]);
  });
});

describe('best effort', () => {
  test('without an audit binding the writes answer as before', async () => {
    const { call } = harness({}, null);
    expect(await call('POST', '/v1/secrets', setBody())).toBe(201);
  });

  test('an audit log that fails never fails the write', async () => {
    const failing = {
      ...createInMemoryAuditEventBinding(),
      append: async () => {
        throw new Error('audit store down');
      },
    } as AuditEventBinding;
    const { call } = harness({}, failing);
    expect(await call('POST', '/v1/secrets', setBody())).toBe(201);
  });
});

describe('WRITE_AUDIT_KINDS', () => {
  test('lists every kind the routes write, each one a compliance evidence kind', () => {
    expect([...WRITE_AUDIT_KINDS].sort()).toEqual(
      [
        'env-deleted',
        'env-set',
        'secret-hard-revoked',
        'secret-revoked',
        'secret-rotated',
        'secret-rotation-failed',
        'secret-rotation-started',
        'secret-set',
      ].sort(),
    );
    for (const kind of WRITE_AUDIT_KINDS) {
      expect(EVIDENCE_KINDS as readonly string[]).toContain(kind);
    }
  });
});
