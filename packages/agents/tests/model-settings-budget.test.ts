// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Checking model settings is Kindgi's own work, whoever's request starts
 * it: the first check compiles `MODEL_SETTINGS_SCHEMA` outside the
 * tenant's scope, so it never counts against the tenant's compile budget.
 * Its own file, so the first check in the process is this test's.
 */

import { HOSTED_BOUNDS, runAsTenant } from '@kindgi/bounds';
import { overrideTenantInputBounds } from '@kindgi/bounds/testing';
import { afterEach, expect, test } from 'vitest';

import { modelSettingsIssues } from '../src/index.js';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

test('the first check, in a publish with no budget left, compiles and isn’t refused', () => {
  restore = overrideTenantInputBounds({ ...HOSTED_BOUNDS, schemaCompileBudgetMs: 0 });
  const issues = runAsTenant('tenant-a', () => modelSettingsIssues({ temperature: 'hot' }), {
    compiles: 'all',
  });
  expect(issues).toEqual([{ path: '/content/values/temperature', message: 'must be number' }]);
  expect(runAsTenant('tenant-a', () => modelSettingsIssues({}), { compiles: 'all' })).toEqual([]);
});
