// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An audit append that fails or throws never fails the caller's op: it's
 * logged at `warn` through the input's `log`, naming the record's tenant
 * and kind, and why. Without a `log` it isn't logged anywhere, the console included.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { AuditEventBinding } from '@kindgi/audit-events';
import { type Logger, createLogger } from '@kindgi/log';
import type { EnvName, ProjectId, TenantId } from '@kindgi/types';

import { emitLifecycleEvent, emitResolveEvent } from '../src/index.js';

const tenantId = 'tenant-1' as TenantId;
const projectId = 'project-1' as ProjectId;

function capturing(): { log: Logger; records: () => Record<string, unknown>[] } {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', write: (line) => lines.push(line) });
  return { log, records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

const answering = (error: { code: string; message: string }) =>
  ({ append: async () => ({ kind: 'err', error }) }) as unknown as AuditEventBinding;
const throwing = (cause: unknown) =>
  ({
    append: async () => {
      throw cause;
    },
  }) as unknown as AuditEventBinding;
const ok = {
  append: async () => ({ kind: 'ok', value: undefined }),
} as unknown as AuditEventBinding;

const resolveInput = (auditEvents: AuditEventBinding, log?: Logger) => ({
  kind: 'secret' as const,
  scope: { kind: 'project' as const, tenantId, projectId },
  envName: 'production' as EnvName,
  name: 'stripe-key',
  outcome: 'succeeded' as const,
  resolveContext: { caller: 'dispatch' as const, runId: 'run-1' },
  auditEvents,
  tenantId,
  projectId,
  ...(log !== undefined && { log }),
});

const lifecycleInput = (auditEvents: AuditEventBinding, log?: Logger) => ({
  evidenceKind: 'env-set',
  bindingKind: 'env' as const,
  scope: { kind: 'tenant' as const, tenantId },
  envName: 'production' as EnvName,
  name: 'KB_URL',
  outcome: 'succeeded' as const,
  auditEvents,
  tenantId,
  ...(log !== undefined && { log }),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an audit append that fails is logged through the given log', () => {
  test('an append that answers an error: one warn, with its kind and code', async () => {
    const { log, records } = capturing();
    await emitResolveEvent(
      resolveInput(
        answering({ code: 'persistence-error', message: 'the audit store is down' }),
        log,
      ),
    );
    expect(records()).toEqual([
      expect.objectContaining({
        level: 'warn',
        message: 'secret-resolved audit event failed: the audit store is down',
        tenantId,
        kind: 'secret-resolved',
        code: 'persistence-error',
        inMessage: ['kind'],
      }),
    ]);
  });

  test('an append that throws: one warn, with the error', async () => {
    const { log, records } = capturing();
    await emitLifecycleEvent(lifecycleInput(throwing(new Error('connection reset')), log));
    expect(records()).toEqual([
      expect.objectContaining({
        level: 'warn',
        message: 'env-set audit event failed',
        tenantId,
        kind: 'env-set',
        err: expect.objectContaining({ name: 'Error', message: 'connection reset' }),
        inMessage: ['kind'],
      }),
    ]);
  });

  test('an append that throws something not an Error: the warn carries it as text', async () => {
    const { log, records } = capturing();
    await emitResolveEvent(resolveInput(throwing('boom'), log));
    expect(records()).toEqual([
      expect.objectContaining({
        level: 'warn',
        message: 'secret-resolved audit event failed',
        kind: 'secret-resolved',
        err: 'boom',
      }),
    ]);
  });

  test("the logger's own fields stay on the record (a child's subsystem and ids)", async () => {
    const { log, records } = capturing();
    await emitLifecycleEvent(
      lifecycleInput(
        answering({ code: 'persistence-error', message: 'down' }),
        log.child({ subsystem: 'audit', requestId: 'req-1' }),
      ),
    );
    expect(records()[0]).toMatchObject({ subsystem: 'audit', requestId: 'req-1' });
  });

  test('an append that succeeds logs nothing', async () => {
    const { log, records } = capturing();
    await emitResolveEvent(resolveInput(ok, log));
    await emitLifecycleEvent(lifecycleInput(ok, log));
    expect(records()).toEqual([]);
  });
});

describe('without a log', () => {
  test('a failed or thrown append is swallowed, and nothing reaches the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      emitResolveEvent(resolveInput(answering({ code: 'persistence-error', message: 'down' }))),
    ).resolves.toBeUndefined();
    await expect(
      emitLifecycleEvent(lifecycleInput(throwing(new Error('connection reset')))),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
