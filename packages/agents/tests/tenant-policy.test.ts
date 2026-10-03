// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { TenantPolicy } from '@kindgi/capabilities';
import type { TenantId } from '@kindgi/types';

import { mergeTenantPolicies } from '../src/tenant-policy.js';

const tenantId = 'acme' as TenantId;
const policy = (fields: Omit<TenantPolicy, 'tenantId'>): TenantPolicy => ({ tenantId, ...fields });

describe('mergeTenantPolicies — the result is at least as strict as each side', () => {
  test('either side undefined → the other side as-is', () => {
    const p = policy({ regionAllow: ['eu-west-1'] });
    expect(mergeTenantPolicies(p, undefined)).toBe(p);
    expect(mergeTenantPolicies(undefined, p)).toBe(p);
    expect(mergeTenantPolicies(undefined, undefined)).toBeUndefined();
  });

  test('allow lists set on both sides intersect', () => {
    const merged = mergeTenantPolicies(
      policy({
        providers: { allow: ['anthropic', 'openai'] },
        models: { allow: ['sonnet', 'gpt-large'] },
        regionAllow: ['eu-west-1', 'us-east-1'],
      }),
      policy({
        providers: { allow: ['openai', 'mistral'] },
        models: { allow: ['gpt-large'] },
        regionAllow: ['eu-west-1'],
      }),
    );
    expect(merged?.providers?.allow).toEqual(['openai']);
    expect(merged?.models?.allow).toEqual(['gpt-large']);
    expect(merged?.regionAllow).toEqual(['eu-west-1']);
  });

  test('disjoint allow lists intersect to empty — nothing is allowed', () => {
    const merged = mergeTenantPolicies(
      policy({ regionAllow: ['eu-west-1'] }),
      policy({ regionAllow: ['us-east-1'] }),
    );
    expect(merged?.regionAllow).toEqual([]);
  });

  test('an allow list set on one side only applies as-is', () => {
    const merged = mergeTenantPolicies(
      policy({ providers: { allow: ['anthropic'] } }),
      policy({ providers: { deny: ['openai'] } }),
    );
    expect(merged?.providers).toEqual({ allow: ['anthropic'], deny: ['openai'] });
  });

  test('deny lists union; caps take the smaller value', () => {
    const merged = mergeTenantPolicies(
      policy({ models: { deny: ['opus'] }, maxCostPerCallUsd: 0.05, maxTokensPerCall: 100_000 }),
      policy({ models: { deny: ['gpt-large'] }, maxCostPerCallUsd: 0.02 }),
    );
    expect(merged?.models?.deny).toEqual(['opus', 'gpt-large']);
    expect(merged?.maxCostPerCallUsd).toBe(0.02);
    expect(merged?.maxTokensPerCall).toBe(100_000);
  });
});
