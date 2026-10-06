// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `policyScope` (T236): a retention policy holds its domain, `*`
 * included; other kinds hold none.
 */

import { describe, expect, test } from 'vitest';

import { policyScope, retentionSpecDoc } from '../src/index.js';

const doc = { domain: 'provider', graceSeconds: 0, mode: 'purge' };

describe('policyScope', () => {
  test('a retention policy holds its domain, wrapped or bare', () => {
    expect(policyScope({ kind: 'retention', spec: { v: 1, doc } })).toBe('provider');
    expect(policyScope({ kind: 'retention', spec: doc })).toBe('provider');
  });

  test('the * default is a scope of its own', () => {
    expect(policyScope({ kind: 'retention', spec: { v: 1, doc: { ...doc, domain: '*' } } })).toBe(
      '*',
    );
  });

  test('a retention spec that fails validation holds nothing', () => {
    expect(
      policyScope({ kind: 'retention', spec: { v: 1, doc: { ...doc, mode: 'archive' } } }),
    ).toBeUndefined();
    expect(policyScope({ kind: 'retention', spec: {} })).toBeUndefined();
  });

  test('other kinds hold no scope', () => {
    expect(policyScope({ kind: 'hitl', spec: { minReviewerRole: 'senior' } })).toBeUndefined();
    expect(policyScope({ kind: 'model-routing', spec: { domain: 'provider' } })).toBeUndefined();
  });
});

describe('retentionSpecDoc', () => {
  test('unwraps the envelope, passes a bare spec through', () => {
    expect(retentionSpecDoc({ v: 1, doc })).toBe(doc);
    expect(retentionSpecDoc(doc)).toBe(doc);
    expect(retentionSpecDoc(null)).toBeNull();
  });
});
