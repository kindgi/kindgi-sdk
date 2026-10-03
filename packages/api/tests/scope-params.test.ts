// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { OrgId, ProjectId, TenantId } from '@kindgi/types';

import { parseScopeParams } from '../src/routes/scope-params.js';

/**
 * Unit tests for the `?scopeKind + ?scopeId + ?inherit` triplet parser.
 * The parser is DRY across
 * the 10 scope-aware list-endpoints; these tests pin the wire contract
 * so route-level tests can trust the composition.
 */

const tenantId = randomUUID() as TenantId;
const orgId = randomUUID() as OrgId;
const projectId = randomUUID() as ProjectId;

function q(record: Record<string, string>): (name: string) => string | undefined {
  return (n) => record[n];
}

describe('parseScopeParams — happy paths', () => {
  test('no scope params → ok with scope=undefined, inherit=undefined', () => {
    const outcome = parseScopeParams({}, { tenantId });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error('unreachable');
    expect(outcome.scope).toBeUndefined();
    expect(outcome.inherit).toBeUndefined();
  });

  test('?scopeKind=tenant → tenant scope with session tenantId', () => {
    const outcome = parseScopeParams({ scopeKind: 'tenant' }, { tenantId });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error('unreachable');
    expect(outcome.scope).toEqual({ kind: 'tenant', tenantId });
  });

  test('?scopeKind=org&scopeId=<id> → org scope', () => {
    const outcome = parseScopeParams(
      { scopeKind: 'org', scopeId: orgId as unknown as string },
      { tenantId },
    );
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error('unreachable');
    expect(outcome.scope).toEqual({ kind: 'org', tenantId, orgId });
  });

  test('?scopeKind=project&scopeId=<id> → project scope', () => {
    const outcome = parseScopeParams(
      { scopeKind: 'project', scopeId: projectId as unknown as string },
      { tenantId },
    );
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error('unreachable');
    expect(outcome.scope).toEqual({ kind: 'project', tenantId, projectId });
  });

  test('function-style query source is accepted', () => {
    const outcome = parseScopeParams(
      q({ scopeKind: 'project', scopeId: projectId as unknown as string }),
      { tenantId },
    );
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error('unreachable');
    expect(outcome.scope).toEqual({ kind: 'project', tenantId, projectId });
  });
});

describe('parseScopeParams — inherit parsing', () => {
  test('?inherit=true → true', () => {
    const outcome = parseScopeParams({ inherit: 'true' }, { tenantId });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error('unreachable');
    expect(outcome.inherit).toBe(true);
  });

  test('?inherit=false → false', () => {
    const outcome = parseScopeParams({ inherit: 'false' }, { tenantId });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error('unreachable');
    expect(outcome.inherit).toBe(false);
  });

  test('?inherit=1 → err (only true/false accepted)', () => {
    const outcome = parseScopeParams({ inherit: '1' }, { tenantId });
    expect(outcome.kind).toBe('err');
    if (outcome.kind !== 'err') throw new Error('unreachable');
    expect(outcome.message).toMatch(/inherit must be 'true' or 'false'/);
  });

  test('?scopeKind=project&scopeId=<id>&inherit=false → scope + inherit=false', () => {
    const outcome = parseScopeParams(
      { scopeKind: 'project', scopeId: projectId as unknown as string, inherit: 'false' },
      { tenantId },
    );
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error('unreachable');
    expect(outcome.scope).toEqual({ kind: 'project', tenantId, projectId });
    expect(outcome.inherit).toBe(false);
  });
});

describe('parseScopeParams — cross-field validation errors', () => {
  test('?scopeKind=tenant&scopeId=<id> → err (tenant carries no id)', () => {
    const outcome = parseScopeParams(
      { scopeKind: 'tenant', scopeId: orgId as unknown as string },
      { tenantId },
    );
    expect(outcome.kind).toBe('err');
    if (outcome.kind !== 'err') throw new Error('unreachable');
    expect(outcome.message).toMatch(/scopeKind='tenant' takes no scopeId/);
  });

  test('?scopeKind=org (no scopeId) → err (missing id)', () => {
    const outcome = parseScopeParams({ scopeKind: 'org' }, { tenantId });
    expect(outcome.kind).toBe('err');
    if (outcome.kind !== 'err') throw new Error('unreachable');
    expect(outcome.message).toMatch(/scopeKind='org' requires scopeId/);
  });

  test('?scopeKind=project (no scopeId) → err (missing id)', () => {
    const outcome = parseScopeParams({ scopeKind: 'project' }, { tenantId });
    expect(outcome.kind).toBe('err');
    if (outcome.kind !== 'err') throw new Error('unreachable');
    expect(outcome.message).toMatch(/scopeKind='project' requires scopeId/);
  });

  test('?scopeId=<id> (no scopeKind) → err (orphan id)', () => {
    const outcome = parseScopeParams({ scopeId: projectId as unknown as string }, { tenantId });
    expect(outcome.kind).toBe('err');
    if (outcome.kind !== 'err') throw new Error('unreachable');
    expect(outcome.message).toMatch(/requires scopeKind/);
  });

  test('?scopeKind=bogus → err (unknown kind)', () => {
    const outcome = parseScopeParams({ scopeKind: 'bogus' }, { tenantId });
    expect(outcome.kind).toBe('err');
    if (outcome.kind !== 'err') throw new Error('unreachable');
    expect(outcome.message).toMatch(/scopeKind must be one of/);
  });
});
