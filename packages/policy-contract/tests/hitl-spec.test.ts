// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  combineHitlSpecs,
  higherRole,
  stricterToolHitlRule,
  toolHitlRule,
  validateHitlSpec,
} from '../src/hitl-spec.js';

describe('validateHitlSpec', () => {
  test('accepts every setting, and an empty spec', () => {
    const spec = {
      maxTimeoutMs: 3_600_000,
      minReviewerRole: 'senior',
      tools: {
        'acme.pay': 'always_ask',
        'acme.refund': { mode: 'always_ask', requiredRole: 'admin' },
      },
    };
    expect(validateHitlSpec(spec)).toEqual({ kind: 'ok', value: spec });
    expect(validateHitlSpec({})).toEqual({ kind: 'ok', value: {} });
  });

  test('refuses what is not an object', () => {
    for (const input of [null, 'always_ask', ['always_ask'], 3]) {
      expect(validateHitlSpec(input)).toEqual({
        kind: 'err',
        issues: [{ path: '', message: 'must be an object' }],
      });
    }
  });

  test('names each bad setting by its JSON Pointer', () => {
    const checked = validateHitlSpec({
      maxTimeoutMs: 0,
      minReviewerRole: 'owner',
      tools: {
        'acme.pay': 'sometimes',
        'acme/refund': { mode: 'ask', requiredRole: 'boss', note: 'x' },
        'acme.send': 7,
      },
      timeoutMs: 1,
    });
    expect(checked.kind).toBe('err');
    if (checked.kind !== 'err') return;
    expect(checked.issues.map((i) => i.path)).toEqual([
      '/timeoutMs',
      '/maxTimeoutMs',
      '/minReviewerRole',
      '/tools/acme.pay',
      '/tools/acme~1refund/note',
      '/tools/acme~1refund/mode',
      '/tools/acme~1refund/requiredRole',
      '/tools/acme.send',
    ]);
  });

  test('a timeout must be a positive whole number of milliseconds', () => {
    for (const maxTimeoutMs of [-1, 0, 1.5, '60000']) {
      expect(validateHitlSpec({ maxTimeoutMs }).kind).toBe('err');
    }
    expect(validateHitlSpec({ maxTimeoutMs: 1 }).kind).toBe('ok');
  });

  test('tools must be an object of tool ids, none empty', () => {
    expect(validateHitlSpec({ tools: ['acme.pay'] })).toEqual({
      kind: 'err',
      issues: [{ path: '/tools', message: 'must be an object of tool ids' }],
    });
    expect(validateHitlSpec({ tools: { '': 'always_ask' } })).toEqual({
      kind: 'err',
      issues: [{ path: '/tools/', message: 'a tool id must not be empty' }],
    });
  });
});

describe('stricterToolHitlRule', () => {
  test('the stricter mode and the higher role, whichever rule holds them', () => {
    expect(
      stricterToolHitlRule({ mode: 'always_ask' }, { mode: 'never_ask', requiredRole: 'admin' }),
    ).toEqual({ mode: 'always_ask', requiredRole: 'admin' });
    expect(stricterToolHitlRule({ mode: 'never_ask' }, { mode: 'ask_on_first_use' })).toEqual({
      mode: 'ask_on_first_use',
    });
  });

  test('a mode is a rule with no role', () => {
    expect(toolHitlRule('always_ask')).toEqual({ mode: 'always_ask' });
    expect(toolHitlRule({ mode: 'never_ask', requiredRole: 'senior' })).toEqual({
      mode: 'never_ask',
      requiredRole: 'senior',
    });
  });
});

describe('higherRole', () => {
  test('admin over senior over standard; an unset role yields', () => {
    expect(higherRole('standard', 'senior')).toBe('senior');
    expect(higherRole('admin', 'senior')).toBe('admin');
    expect(higherRole(undefined, 'standard')).toBe('standard');
    expect(higherRole('senior', undefined)).toBe('senior');
    expect(higherRole(undefined, undefined)).toBeUndefined();
  });
});

describe('combineHitlSpecs', () => {
  test('at least as strict as each: shortest timeout, highest role, stricter rule per tool', () => {
    expect(
      combineHitlSpecs([
        {
          maxTimeoutMs: 3_600_000,
          minReviewerRole: 'senior',
          tools: { 'acme.pay': 'ask_on_first_use' },
        },
        {
          maxTimeoutMs: 600_000,
          tools: { 'acme.pay': { mode: 'never_ask', requiredRole: 'admin' } },
        },
        { minReviewerRole: 'standard', tools: { 'acme.refund': 'always_ask' } },
      ]),
    ).toEqual({
      maxTimeoutMs: 600_000,
      minReviewerRole: 'senior',
      tools: {
        'acme.pay': { mode: 'ask_on_first_use', requiredRole: 'admin' },
        'acme.refund': { mode: 'always_ask' },
      },
    });
  });

  test('no specs, or empty ones, combine to an empty spec', () => {
    expect(combineHitlSpecs([])).toEqual({});
    expect(combineHitlSpecs([{}, {}])).toEqual({});
  });
});
