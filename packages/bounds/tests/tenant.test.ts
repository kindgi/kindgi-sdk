// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** Whose work this is: `runAsTenant`'s scope, through awaits, never across requests. */

import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, test } from 'vitest';

import { currentTenant, runAsTenant, runOutsideTenant } from '../src/index.js';

describe('runAsTenant', () => {
  test('outside a scope, no tenant', () => {
    expect(currentTenant()).toBeUndefined();
  });

  test('recompiles count unless the scope says all', () => {
    expect(runAsTenant('tenant-a', () => currentTenant())).toEqual({
      tenantId: 'tenant-a',
      compiles: 'recompiles',
    });
    expect(runAsTenant('tenant-a', () => currentTenant(), { compiles: 'all' })).toEqual({
      tenantId: 'tenant-a',
      compiles: 'all',
    });
  });

  test('returns what fn returns, a promise included', async () => {
    expect(runAsTenant('tenant-a', () => 7)).toBe(7);
    await expect(runAsTenant('tenant-a', async () => 8)).resolves.toBe(8);
  });

  test('follows fn’s awaits, and two scopes interleaving keep their own', async () => {
    const seen = async (tenantId: string, ms: number) =>
      runAsTenant(tenantId, async () => {
        await sleep(ms);
        const first = currentTenant()?.tenantId;
        await sleep(ms);
        return [first, currentTenant()?.tenantId];
      });
    const [a, b] = await Promise.all([seen('tenant-a', 5), seen('tenant-b', 3)]);
    expect(a).toEqual(['tenant-a', 'tenant-a']);
    expect(b).toEqual(['tenant-b', 'tenant-b']);
    expect(currentTenant()).toBeUndefined();
  });

  test('an inner scope is its own, and the outer one is back after it', () => {
    runAsTenant('tenant-a', () => {
      runAsTenant('tenant-a', () => expect(currentTenant()?.compiles).toBe('all'), {
        compiles: 'all',
      });
      expect(currentTenant()?.compiles).toBe('recompiles');
    });
  });

  test('runOutsideTenant: no scope inside it, through its awaits; the scope is back after it', async () => {
    await runAsTenant('tenant-a', async () => {
      const inside = await runOutsideTenant(async () => {
        await sleep(1);
        return currentTenant();
      });
      expect(inside).toBeUndefined();
      expect(currentTenant()?.tenantId).toBe('tenant-a');
    });
  });
});
