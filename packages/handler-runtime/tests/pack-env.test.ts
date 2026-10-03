// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { missingPackEnv, parsePackEnvCheck, resolvePackEnv } from '../src/pack-env.js';

describe('resolvePackEnv', () => {
  test('nothing declared, or both lists empty: no declaration', () => {
    expect(resolvePackEnv(undefined)).toEqual({ kind: 'ok', value: undefined });
    expect(resolvePackEnv({})).toEqual({ kind: 'ok', value: undefined });
    expect(resolvePackEnv({ required: [], optional: [] })).toEqual({
      kind: 'ok',
      value: undefined,
    });
  });

  test('both lists, sorted by code unit, the missing one empty', () => {
    expect(resolvePackEnv({ required: ['b', 'A_URL', 'B_URL', '_x'] })).toEqual({
      kind: 'ok',
      value: { optional: [], required: ['A_URL', 'B_URL', '_x', 'b'] },
    });
    expect(resolvePackEnv({ optional: ['LOG_LEVEL'] })).toEqual({
      kind: 'ok',
      value: { optional: ['LOG_LEVEL'], required: [] },
    });
  });

  test.each([
    [null, '`env` must be an object'],
    [['A'], '`env` must be an object'],
    [{ needed: ['A'] }, '`env` takes only `required` and `optional`, not `needed`'],
    [{ required: 'A' }, '`env.required` must be a list of names'],
    [{ optional: [1] }, '`env.optional` must be a list of names'],
    [{ required: ['1ABC'] }, '"1ABC" in `env.required` isn\'t an environment variable name'],
    [{ required: ['A-B'] }, '"A-B" in `env.required` isn\'t an environment variable name'],
    [
      { optional: ['KINDGI_ENV'] },
      '"KINDGI_ENV" in `env.optional`: `KINDGI_*` names configure Kindgi',
    ],
    [{ required: ['A', 'A'] }, '"A" is listed twice in `env.required`'],
    [{ required: ['A'], optional: ['A'] }, '"A" is in both `env.required` and `env.optional`'],
  ])('refuses %j', (env, message) => {
    const outcome = resolvePackEnv(env);
    expect(outcome.kind).toBe('err');
    expect(outcome.kind === 'err' && outcome.message).toContain(message);
  });
});

describe('missingPackEnv', () => {
  const declared = { required: ['A', 'B', 'C'], optional: ['D'] };

  test('unset and empty are missing; any other value, whitespace included, is there', () => {
    expect(missingPackEnv(declared, { A: 'x', B: '', C: ' ' })).toEqual(['B']);
    expect(missingPackEnv(declared, {})).toEqual(['A', 'B', 'C']);
  });

  test('optional names are never missing, and no declaration needs nothing', () => {
    expect(missingPackEnv(declared, { A: '1', B: '1', C: '1' })).toEqual([]);
    expect(missingPackEnv(undefined, {})).toEqual([]);
  });
});

describe('parsePackEnvCheck', () => {
  test('unset or empty is strict; strict and warn as given; anything else refused', () => {
    expect(parsePackEnvCheck(undefined)).toEqual({ kind: 'ok', value: 'strict' });
    expect(parsePackEnvCheck('')).toEqual({ kind: 'ok', value: 'strict' });
    expect(parsePackEnvCheck('strict')).toEqual({ kind: 'ok', value: 'strict' });
    expect(parsePackEnvCheck('warn')).toEqual({ kind: 'ok', value: 'warn' });
    expect(parsePackEnvCheck('WARN')).toEqual({
      kind: 'err',
      message: 'KINDGI_PACK_ENV_CHECK must be `strict` or `warn`, not "WARN"',
    });
  });
});
