// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { readEnv, readEnvLayers } from '../src/index.js';

describe('readEnvLayers', () => {
  test('later layers override earlier ones; origin names the winner', () => {
    const r = readEnvLayers([
      { source: '.env', contents: 'A=base\nB=base\n' },
      { source: '.env.local', contents: 'B=local\nC=local\n' },
    ]);
    expect(r.values).toEqual({ A: 'base', B: 'local', C: 'local' });
    expect(r.origin).toEqual({ A: '.env', B: '.env.local', C: '.env.local' });
  });

  test('missing layers (null) are skipped and not listed as present', () => {
    const r = readEnvLayers([
      { source: '.env', contents: null },
      { source: '.env.local', contents: 'A=1\n' },
    ]);
    expect(r.values).toEqual({ A: '1' });
    expect(r.present).toEqual(['.env.local']);
  });

  test('expansion runs over the merged view (a ref in .env sees .env.local)', () => {
    const r = readEnvLayers([
      { source: '.env', contents: 'HOST=prod-db\nURL=postgres://${HOST}/app\n' },
      { source: '.env.local', contents: 'HOST=localhost\n' },
    ]);
    expect(r.values.URL).toBe('postgres://localhost/app');
    expect(r.raw.URL).toBe('postgres://${HOST}/app');
  });

  test('malformed lines are ignored (as dotenv does) and reported with their source', () => {
    const r = readEnvLayers([{ source: '.env', contents: 'A="multi\nline"\n# c\njunk line\n' }]);
    expect(r.values).toEqual({ A: 'multi\nline' });
    expect(r.diagnostics).toEqual([
      {
        kind: 'malformed',
        source: '.env',
        line: 4,
        raw: 'junk line',
        reason: 'not a `KEY=value` line',
      },
    ]);
  });

  test('expansion diagnostics carry the source of the key that holds the reference', () => {
    const r = readEnvLayers([
      { source: '.env', contents: 'A=1\n' },
      { source: '.env.local', contents: 'B=$MISSING\n' },
    ]);
    expect(r.diagnostics).toEqual([
      { kind: 'unresolved', key: 'B', ref: 'MISSING', source: '.env.local' },
    ]);
  });

  test('options.env fills names no layer defines', () => {
    const r = readEnvLayers([{ source: '.env', contents: 'P=${HOME}/x\n' }], {
      env: { HOME: '/h' },
    });
    expect(r.values.P).toBe('/h/x');
  });
});

describe('readEnv', () => {
  test('parses and expands one file', () => {
    expect(readEnv('A=1\nB=${A}2\n')).toEqual({ A: '1', B: '12' });
  });
});
