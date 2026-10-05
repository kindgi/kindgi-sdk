// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  CORS_ORIGINS_VAR,
  KINDGI_ENV_SCHEMA,
  PUBLIC_TOKEN_KEY_PATH_VAR,
  parseCorsOrigins,
  parsePackServiceToken,
} from '../src/index.js';

describe('parsePackServiceToken', () => {
  test('without its surrounding whitespace: a secret stored with a trailing newline matches', () => {
    expect(parsePackServiceToken('3f9ac0ffee')).toBe('3f9ac0ffee');
    expect(parsePackServiceToken('3f9ac0ffee\n')).toBe('3f9ac0ffee');
    expect(parsePackServiceToken('  3f9ac0ffee\r\n')).toBe('3f9ac0ffee');
    expect(parsePackServiceToken('a+b/c=')).toBe('a+b/c=');
  });

  test('unset or blank: undefined', () => {
    expect(parsePackServiceToken(undefined)).toBeUndefined();
    expect(parsePackServiceToken('')).toBeUndefined();
    expect(parsePackServiceToken(' \n')).toBeUndefined();
  });

  test.each([['two words'], ['tab\tinside'], ['line\nbreak'], ['caf\u00e9'], ['nul\u0000']])(
    "refuses %j, which a header can't carry",
    (raw) => {
      expect(() => parsePackServiceToken(raw)).toThrow(
        'KINDGI_PACK_SERVICE_TOKEN may hold only printable ASCII without spaces (it travels in an HTTP header). Use a random value such as `openssl rand -hex 32`.',
      );
    },
  );
});

describe('parseCorsOrigins', () => {
  test('exact origins, trimmed, deduplicated; unset or empty is none', () => {
    expect(
      parseCorsOrigins(' https://app.example.com, http://localhost:3000,https://app.example.com '),
    ).toEqual(['https://app.example.com', 'http://localhost:3000']);
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins(' ')).toEqual([]);
  });

  test.each([
    'https://app.example.com/',
    'https://app.example.com/path',
    'https://*.example.com',
    '*',
    'app.example.com',
    'ftp://app.example.com',
    'https://App.example.com',
  ])('refuses %s', (origin) => {
    expect(() => parseCorsOrigins(origin)).toThrow(
      /KINDGI_CORS_ORIGINS entries must be exact origins/,
    );
  });
});

describe('variable names', () => {
  test('both are in the schema', () => {
    const names = KINDGI_ENV_SCHEMA.map((v) => v.name);
    expect(names).toContain(PUBLIC_TOKEN_KEY_PATH_VAR);
    expect(names).toContain(CORS_ORIGINS_VAR);
  });
});
