// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { createLogger, isSecretKey, redactValue, scrubText } from '../src/index.js';

describe('rule 1: secret keys', () => {
  test.each([
    'authorization',
    'Authorization',
    'cookie',
    'set-cookie',
    'token',
    'accessToken',
    'refresh_token',
    'password',
    'dbPassword',
    'passwd',
    'secret',
    'clientSecret',
    'secrets',
    'apiKey',
    'x-api-key',
    'API_KEY',
    'privateKey',
    'private_key',
    'passphrase',
    'credentials',
    'gcpCredential',
  ])('%s is redacted', (key) => {
    expect(isSecretKey(key)).toBe(true);
  });

  test.each(['tokenCount', 'promptTokens', 'secretRef', 'keyId', 'passed', 'runId', 'requestId'])(
    '%s is not',
    (key) => {
      expect(isSecretKey(key)).toBe(false);
    },
  );

  test('at any depth, and in arrays; a caller adds its own', () => {
    expect(
      redactValue({ a: { b: [{ apiKey: 'sk-1', ok: 1 }] }, sessionId: 's', mine: 'x' }, [
        'sessionId',
      ]),
    ).toEqual({ a: { b: [{ apiKey: '[redacted]', ok: 1 }] }, sessionId: '[redacted]', mine: 'x' });
  });

  test('a secrets map is redacted whole, whatever its keys', () => {
    expect(redactValue({ secrets: { API_KEY: 's3cret' } })).toEqual({ secrets: '[redacted]' });
  });
});

describe('rule 2: known shapes in strings', () => {
  test('a Kindgi token keeps its prefix and last four; a short one keeps only the prefix', () => {
    expect(scrubText('token kgi_bt_abcdefghijklmnopqrstuvwxyz1234 here')).toBe(
      'token kgi_bt_…1234 here',
    );
    expect(scrubText('kgi_pt_eyJ2IjoxLCJraWQiOiJwd.abc_def-XYZ9')).toBe('kgi_pt_…XYZ9');
    expect(scrubText('kgi_lk_short')).toBe('kgi_lk_…');
  });

  test('Bearer <anything> becomes Bearer [redacted]', () => {
    expect(scrubText('Authorization: Bearer abc.def.ghi, next')).toBe(
      'Authorization: Bearer [redacted], next',
    );
    expect(scrubText('bearer sk-or-v1-123')).toBe('bearer [redacted]');
  });

  test("a URL's password becomes ***, the user and host stay", () => {
    expect(scrubText('connect postgres://kindgi:hunter2@db.internal:5432/kindgi failed')).toBe(
      'connect postgres://kindgi:***@db.internal:5432/kindgi failed',
    );
    expect(scrubText('https://user:p%40ss@pack.example.com/v1')).toBe(
      'https://user:***@pack.example.com/v1',
    );
  });

  test('ids are left alone (no entropy guessing)', () => {
    const id = 'run 1a2b3c4d-5e6f-7a8b-9c0d-ef1234567890 trace 4bf92f3577b34da6a3ce929d0e0e4736';
    expect(scrubText(id)).toBe(id);
  });
});

describe('the logger applies both rules everywhere, at every level', () => {
  test("the message, fields, err.message and err.stack; the seeded token's tail stays", () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'trace', write: (l) => lines.push(l) });
    const err = new Error(
      'auth failed for Bearer kgi_bt_0123456789abcdefWXYZ at postgres://u:pw@h/db',
    );
    log.trace('calling with Bearer abc123', {
      headers: { authorization: 'Bearer abc123', accept: 'json' },
      url: 'postgres://u:pw@h/db',
      err,
    });
    const out = lines.join('\n');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain(':pw@');
    expect(out).not.toContain('0123456789abcdefWXYZ');
    expect(out).toContain('"authorization":"[redacted]"');
    expect(out).toContain('postgres://u:***@h/db');
  });

  test('in the pretty format too', () => {
    const lines: string[] = [];
    const log = createLogger({ format: 'pretty', write: (l) => lines.push(l) });
    log.info('x', { password: 'pw', note: 'Bearer zzz' });
    expect(lines[0]).toContain('password=[redacted]');
    expect(lines[0]).not.toContain('zzz');
  });
});
