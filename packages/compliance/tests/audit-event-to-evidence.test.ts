// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { AuditEvent } from '@kindgi/audit-events';
import type { ProjectId, TenantId, Timestamp } from '@kindgi/types';

import { auditEventToEvidence } from '../src/index.js';

const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;
const PROJECT = '00000000-0000-0000-0000-0000000000aa' as ProjectId;

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'evt-1',
    tenantId: TENANT,
    kind: 'authz-decision',
    timestamp: '2026-09-29T00:00:00.000Z' as Timestamp,
    actor: 'user:alice',
    payload: { v: 1, doc: { version: 1, allowed: true } },
    ...overrides,
  };
}

describe('auditEventToEvidence', () => {
  test('carries projectId when the event is project-anchored', () => {
    expect(auditEventToEvidence(event({ projectId: PROJECT })).projectId).toBe(PROJECT);
  });

  test('omits the projectId key for tenant-level events', () => {
    const evidence = auditEventToEvidence(event());
    expect(Object.hasOwn(evidence, 'projectId')).toBe(false);
  });

  test('unwraps the versioned `doc` envelope into payload', () => {
    expect(auditEventToEvidence(event()).payload).toEqual({ version: 1, allowed: true });
  });

  test('keeps a flat payload as-is', () => {
    const flat = { version: 2, name: 'x' };
    expect(auditEventToEvidence(event({ payload: flat })).payload).toEqual(flat);
  });

  test('maps outcome and runId; omits them when absent', () => {
    const full = auditEventToEvidence(event({ outcome: 'denied', runId: 'run-1' }));
    expect(full.outcome).toBe('denied');
    expect(full.provenanceRef).toEqual({ runId: 'run-1' });
    const bare = auditEventToEvidence(event());
    expect(Object.hasOwn(bare, 'outcome')).toBe(false);
    expect(Object.hasOwn(bare, 'provenanceRef')).toBe(false);
  });

  test('passes kinds outside the built-in list through (the set is open)', () => {
    expect(auditEventToEvidence(event({ kind: 'pack.custom-audit' })).kind).toBe(
      'pack.custom-audit',
    );
  });

  test("names the event's actor, as the generator writes it (`<kind>:<id>`, or a bare kind)", () => {
    expect(auditEventToEvidence(event()).actor).toEqual({ kind: 'user', id: 'alice' });
    // The framework, by the audit convention.
    expect(auditEventToEvidence(event({ actor: 'user:system' })).actor).toEqual({
      kind: 'user',
      id: 'system',
    });
    expect(auditEventToEvidence(event({ actor: 'agent:acme.intake' })).actor).toEqual({
      kind: 'agent',
      id: 'acme.intake',
    });
    // An id may itself hold a colon.
    expect(auditEventToEvidence(event({ actor: 'external:acme:svc' })).actor).toEqual({
      kind: 'external',
      id: 'acme:svc',
    });
    expect(auditEventToEvidence(event({ actor: 'system' })).actor).toEqual({ kind: 'system' });
  });

  test('leaves out an actor of a kind evidence cannot name', () => {
    const evidence = auditEventToEvidence(event({ actor: 'pack:acme.custom' }));
    expect(Object.hasOwn(evidence, 'actor')).toBe(false);
  });
});
