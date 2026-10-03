// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Kindgi's expansion choices where host frameworks disagree (see
 * `README.md` § Expanding). `conformance.test.ts` covers the cases where
 * they agree.
 */

import { describe, expect, test } from 'vitest';

import { expandEnv } from '../src/index.js';

describe('expandEnv — where dotenv-expand versions disagree', () => {
  test('forward references resolve (Next.js behavior; Vite yields "")', () => {
    expect(expandEnv({ A: '${B}', B: 'later' }).values.A).toBe('later');
  });

  test('`${A:-d}` with A set keeps A (bash + Vite; Next.js returns d)', () => {
    expect(expandEnv({ A: 'set', B: '${A:-d}' }).values.B).toBe('set');
  });

  test('`$1` is literal (a name must start with a letter or _)', () => {
    expect(expandEnv({ A: 'cost $1' }).values.A).toBe('cost $1');
  });
});

describe('expandEnv — operators', () => {
  const v = { SET: 'x', EMPTY: '' };
  test.each([
    ['${SET:-d}', 'x'],
    ['${EMPTY:-d}', 'd'],
    ['${UNSET:-d}', 'd'],
    ['${SET-d}', 'x'],
    ['${EMPTY-d}', ''],
    ['${UNSET-d}', 'd'],
    ['${SET:+alt}', 'alt'],
    ['${EMPTY:+alt}', ''],
    ['${UNSET:+alt}', ''],
    ['${SET+alt}', 'alt'],
    ['${EMPTY+alt}', 'alt'],
    ['${UNSET+alt}', ''],
  ])('%s → %j', (expr, expected) => {
    expect(expandEnv({ ...v, R: expr }).values.R).toBe(expected);
  });

  test('defaults are themselves expanded', () => {
    expect(expandEnv({ HOST: 'h', R: '${UNSET:-${HOST}:5432}' }).values.R).toBe('h:5432');
  });

  test('malformed braces stay literal', () => {
    const r = expandEnv({ A: '${', B: '${}', C: '${a{b}', D: 'x}' }).values;
    expect(r).toEqual({ A: '${', B: '${}', C: '${a{b}', D: 'x}' });
  });
});

describe('expandEnv — lookup: files are the source, env only fills gaps', () => {
  test('a name no file defines falls back to options.env', () => {
    expect(expandEnv({ P: '${HOME}/x' }, { env: { HOME: '/home/k' } }).values.P).toBe('/home/k/x');
  });

  test("options.env never overrides a file's own value", () => {
    const r = expandEnv({ A: 'file', B: '$A' }, { env: { A: 'shell' } }).values;
    expect(r).toEqual({ A: 'file', B: 'file' });
  });

  test('env values are inserted verbatim (not re-expanded)', () => {
    expect(expandEnv({ R: '$E' }, { env: { E: '$NOT_A_REF' } }).values.R).toBe('$NOT_A_REF');
  });

  test('never reads process.env implicitly', () => {
    const name = `KINDGI_DOTENV_TEST_${Date.now()}`;
    process.env[name] = 'leaked';
    try {
      expect(expandEnv({ R: `\${${name}}` }).values.R).toBe('');
    } finally {
      Reflect.deleteProperty(process.env, name);
    }
  });
});

describe('expandEnv — escapes, cycles, diagnostics', () => {
  test('\\$ is a literal $ and blocks expansion', () => {
    expect(expandEnv({ A: 'x', R: '\\$A and \\${A}' }).values.R).toBe('$A and ${A}');
  });

  test('resolved values are not re-expanded (a literal $ inside stays)', () => {
    expect(expandEnv({ A: '\\$B', B: 'no', R: '$A' }).values.R).toBe('$B');
  });

  test('unresolved references expand to "" and are reported once per key', () => {
    const r = expandEnv({ R: '$MISSING-$MISSING' });
    expect(r.values.R).toBe('-');
    expect(r.diagnostics).toEqual([{ kind: 'unresolved', key: 'R', ref: 'MISSING' }]);
  });

  test('cycles are cut and reported, never overflow the stack', () => {
    const r = expandEnv({ A: 'a$B', B: 'b$A', SELF: 'x$SELF' });
    expect(r.values.SELF).toBe('x');
    expect(r.values.A).toBe('ab');
    expect(r.diagnostics.filter((d) => d.kind === 'cycle').map((d) => d.ref)).toEqual(
      expect.arrayContaining(['A', 'SELF']),
    );
  });

  test('every input key is present in the output', () => {
    expect(Object.keys(expandEnv({ A: '1', B: '$A', C: '' }).values)).toEqual(['A', 'B', 'C']);
  });
});
