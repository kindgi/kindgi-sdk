// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `emitLifecycleEvent`: a secret or env write's audit record. An API route
 * names its caller (`actor`) and request (`correlationId`); a tenant- or
 * org-scoped value has no project; the record carries the write's answer
 * (`writeMode`, `rotationId`, `revokedValuesPurged`) and never a value.
 */

import { describe, expect, test } from 'vitest';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import type { EnvName, ProjectId, TenantId } from '@kindgi/types';

import { emitLifecycleEvent } from '../src/index.js';

const tenantId = 'tenant-1' as TenantId;
const projectId = 'project-1' as ProjectId;

function capture(): { binding: AuditEventBinding; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  const binding = {
    append: async (batch: readonly AuditEvent[]) => {
      events.push(...batch);
      return { kind: 'ok', value: undefined };
    },
  } as unknown as AuditEventBinding;
  return { binding, events };
}

describe('emitLifecycleEvent', () => {
  test("an API route's record: its caller, request and project, and the write's answer", async () => {
    const { binding, events } = capture();
    await emitLifecycleEvent({
      evidenceKind: 'secret-set',
      bindingKind: 'secret',
      scope: { kind: 'project', tenantId, projectId },
      envName: 'production' as EnvName,
      name: 'stripe-key',
      outcome: 'succeeded',
      version: 7,
      writeMode: 'add-version',
      revokedValuesPurged: true,
      actor: 'user:alice',
      correlationId: 'req-123',
      auditEvents: binding,
      tenantId,
      projectId,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'secret-set',
      tenantId,
      projectId,
      actor: 'user:alice',
      correlationId: 'req-123',
      outcome: 'succeeded',
    });
    expect((events[0]?.payload as { doc: Record<string, unknown> }).doc).toEqual({
      scope: { kind: 'project', tenantId, projectId },
      envName: 'production',
      name: 'stripe-key',
      recordVersion: 7,
      writeMode: 'add-version',
      revokedValuesPurged: true,
    });
  });

  test('a tenant-scoped value has no project; without an actor, the binding default stays', async () => {
    const { binding, events } = capture();
    await emitLifecycleEvent({
      evidenceKind: 'secret-rotation-started',
      bindingKind: 'secret',
      scope: { kind: 'tenant', tenantId },
      envName: 'production' as EnvName,
      name: 'stripe-key',
      outcome: 'succeeded',
      rotationId: 'rot-1',
      auditEvents: binding,
      tenantId,
    });
    expect(events[0]).not.toHaveProperty('projectId');
    expect(events[0]).not.toHaveProperty('correlationId');
    expect(events[0]?.actor).toBe('user:system');
    expect((events[0]?.payload as { doc: Record<string, unknown> }).doc.rotationId).toBe('rot-1');
  });
});
