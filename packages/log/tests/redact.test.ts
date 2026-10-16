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

  test("a three-letter kind is masked too: the license renewer's private and public keys", () => {
    expect(scrubText('renewer kgi_lrk_A1b2C3d4E5f6G7h8I9j0K1l2M3n4WXYZ here')).toBe(
      'renewer kgi_lrk_…WXYZ here',
    );
    expect(scrubText('kgi_lrp_short')).toBe('kgi_lrp_…');
  });

  test('ordinary text with kgi_ in it is left alone', () => {
    for (const text of [
      'the kgi_ prefix',
      'kgi_config',
      'kgi_long_word',
      'kgi_settings',
      'KGI_TOKEN',
      'xkgi_ak_notatoken',
    ]) {
      expect(scrubText(text), text).toBe(text);
    }
  });

  test('a system key (kgi_sy_) is masked like every other kind, its kind being two letters', () => {
    expect(scrubText('minted kgi_sy_Q2hhbmdlTWUuVGhpc0lzQVN5c3RlbUtleQ9f9 for sign-up')).toBe(
      'minted kgi_sy_…Q9f9 for sign-up',
    );
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

describe('redactValue: errors and values that throw when read', () => {
  test('an error is serialized as err is, without its stack; its other fields are left out', () => {
    const unique = Object.assign(new Error('duplicate key at postgres://u:pw@h/db'), {
      code: '23505',
      detail: 'Key (email)=(owner@acme.test) already exists.',
    });
    expect(redactValue({ at: [unique] })).toEqual({
      at: [{ name: 'Error', message: 'duplicate key at postgres://u:***@h/db', code: '23505' }],
    });
  });

  test('a value, or a field of one, that throws when read is [unreadable]', () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const getter = {
      ok: 1,
      get bad(): number {
        throw new Error('not today');
      },
    };
    expect(redactValue({ revoked: revocable.proxy, getter })).toEqual({
      revoked: '[unreadable]',
      getter: { ok: 1, bad: '[unreadable]' },
    });
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
