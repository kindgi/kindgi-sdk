// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { validatePolicySpec } from '../src/validate-policy-spec.js';

describe('validatePolicySpec', () => {
  test('checks a hitl spec', () => {
    expect(validatePolicySpec('hitl', { minReviewerRole: 'senior' })).toEqual([]);
    expect(validatePolicySpec('hitl', { minReviewerRole: 'owner' })).toEqual([
      { path: '/minReviewerRole', message: 'must be one of standard, senior, admin' },
    ]);
  });

  test('checks a tool-errors spec', () => {
    expect(validatePolicySpec('tool-errors', { maxRetries: 2 })).toEqual([]);
    expect(validatePolicySpec('tool-errors', { maxRetries: 11 })).toEqual([
      { path: '/maxRetries', message: 'must be an integer from 0 to 10' },
    ]);
  });

  test("passes the kinds whose specs are their consumer's to check", () => {
    expect(validatePolicySpec('model-routing', 'anything')).toEqual([]);
  });
});
