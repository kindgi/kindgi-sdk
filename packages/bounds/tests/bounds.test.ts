// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The process's bounds: self-hosted until boot sets them, set once, never
 * changed while the process runs.
 */

import { describe, expect, test } from 'vitest';

import {
  HOSTED_BOUNDS,
  SELF_HOSTED_BOUNDS,
  configureTenantInputBounds,
  tenantInputBounds,
} from '../src/index.js';
import { overrideTenantInputBounds } from '../src/testing.js';

describe('the process’s bounds', () => {
  test('self-hosted until boot sets them; then set once, and a second call throws', () => {
    expect(tenantInputBounds()).toBe(SELF_HOSTED_BOUNDS);
    configureTenantInputBounds(HOSTED_BOUNDS);
    expect(tenantInputBounds()).toEqual(HOSTED_BOUNDS);
    expect(() => configureTenantInputBounds(SELF_HOSTED_BOUNDS)).toThrow(
      'Tenant input bounds are already set: they are set once, at boot.',
    );
    expect(tenantInputBounds().regex).toBe('re2');
  });

  test('what is set is a frozen copy: changing the object it was given changes nothing', () => {
    const given = { ...SELF_HOSTED_BOUNDS, patternMaxLength: 10 };
    const restore = overrideTenantInputBounds(given);
    try {
      given.patternMaxLength = 20_000;
      expect(tenantInputBounds().patternMaxLength).toBe(10);
      expect(Object.isFrozen(tenantInputBounds())).toBe(true);
      expect(Object.isFrozen(tenantInputBounds().liquid)).toBe(true);
      expect(Object.isFrozen(HOSTED_BOUNDS.liquid)).toBe(true);
    } finally {
      restore();
    }
  });

  test('the hosted profile is RE2 with every limit finite; self-hosted is V8', () => {
    expect(HOSTED_BOUNDS.regex).toBe('re2');
    expect(SELF_HOSTED_BOUNDS.regex).toBe('v8');
    for (const [name, value] of Object.entries({ ...HOSTED_BOUNDS, ...HOSTED_BOUNDS.liquid })) {
      if (typeof value === 'number') expect(Number.isFinite(value), name).toBe(true);
    }
    // Bounded in both: an unbounded compile cache hurts a self-hoster too.
    expect(SELF_HOSTED_BOUNDS.schemaCacheEntries).toBeGreaterThan(0);
    expect(Number.isFinite(SELF_HOSTED_BOUNDS.schemaCacheEntries)).toBe(true);
  });
});
