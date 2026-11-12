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

describe('rule 3: the full mask, for an error a run shows', () => {
  const full = (text: string): string => scrubText(text, { fullMask: true });

  test('a Kindgi token becomes [redacted] whole; the default keeps its form', () => {
    const text = 'retry with kgi_bt_canary0123456789abcdWXYZ now';
    expect(full(text)).toBe('retry with [redacted] now');
    expect(scrubText(text)).toBe('retry with kgi_bt_…WXYZ now');
    expect(full('kgi_lk_short')).toBe('[redacted]');
  });

  test("Bearer and a URL's password read as in rule 2", () => {
    expect(full('Authorization: Bearer abc.def.ghi, next')).toBe(
      'Authorization: Bearer [redacted], next',
    );
    expect(full('Bearer kgi_bt_canary0123456789abcdWXYZ')).toBe('Bearer [redacted]');
    expect(full('connect postgres://kindgi:hunter2@db.internal:5432/kindgi failed')).toBe(
      'connect postgres://kindgi:***@db.internal:5432/kindgi failed',
    );
  });

  test("a URL's query value whose name looks secret becomes [redacted], its name kept", () => {
    for (const [text, expected] of [
      [
        'GET https://shop.acme.example/orders?token=abc123&page=2',
        'GET https://shop.acme.example/orders?token=[redacted]&page=2',
      ],
      ['?access_token=ya29.a0Af&x=1', '?access_token=[redacted]&x=1'],
      [
        '/wc/v3/orders?consumer_key=ck_1&consumer_secret=cs_2',
        '/wc/v3/orders?consumer_key=ck_1&consumer_secret=[redacted]',
      ],
      ['?api_key=k-1 rejected', '?api_key=[redacted] rejected'],
      ['?client_secret=s1', '?client_secret=[redacted]'],
      [
        'https://maps.acme.example/geo?key=AIzaSyA-0123&q=x',
        'https://maps.acme.example/geo?key=[redacted]&q=x',
      ],
      [
        'https://acme.blob.core.windows.net/c/b?sv=2022-11-02&sig=abc%2Bdef%3D',
        'https://acme.blob.core.windows.net/c/b?sv=2022-11-02&sig=[redacted]',
      ],
    ] as const) {
      expect(full(text), text).toBe(expected);
    }
  });

  test("a presigned S3 URL's signature, credential and session token are masked", () => {
    const url =
      'https://acme.s3.amazonaws.com/a.csv?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA0123%2F20261025%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261025T000000Z&X-Amz-Expires=900&X-Amz-Security-Token=IQoJ&X-Amz-SignedHeaders=host&X-Amz-Signature=0f1e2d3c';
    expect(full(url)).toBe(
      'https://acme.s3.amazonaws.com/a.csv?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=[redacted]&X-Amz-Date=20261025T000000Z&X-Amz-Expires=900&X-Amz-Security-Token=[redacted]&X-Amz-SignedHeaders=host&X-Amz-Signature=[redacted]',
    );
    expect(full('https://storage.googleapis.com/b/o?X-Goog-Signature=ab12')).toBe(
      'https://storage.googleapis.com/b/o?X-Goog-Signature=[redacted]',
    );
  });

  test("a fragment's secret value is masked too (an OAuth redirect)", () => {
    expect(full('https://app.acme.example/cb#access_token=ya29.x&token_type=bearer&state=s1')).toBe(
      'https://app.acme.example/cb#access_token=[redacted]&token_type=bearer&state=s1',
    );
  });

  test('an id named like a key stays: only the exact name key is one', () => {
    for (const text of [
      '?sort_key=a1&page=2',
      '?idempotency_key=7f3a',
      '?public_key=pk_1',
      '?cache_key=c1',
      '?page=2&q=coffee',
      '?token=',
    ]) {
      expect(full(text), text).toBe(text);
    }
  });

  test("log lines don't get it: the default leaves query values as they are", () => {
    const text = 'GET /orders?token=abc123&page=2';
    expect(scrubText(text)).toBe(text);
  });

  test('a second scrub changes nothing, in either form', () => {
    const text =
      'request to https://shop.acme.example/orders?token=abc&sig=s#access_token=t failed: Bearer b1 rejected; kgi_bt_canary0123456789abcdWXYZ; postgres://u:p@h/db';
    expect(full(full(text))).toBe(full(text));
    expect(scrubText(scrubText(text))).toBe(scrubText(text));
  });

  test("the masks keep the patterns' own matches, in time in step with the text", () => {
    // The two masks as patterns, as they were: the reference.
    const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi;
    const URL_PARAM = /([?&#])([^\s=&#"'<>]+)=([^\s&#"'<>]*)/g;
    const secretParam = (name: string): boolean =>
      name.toLowerCase().replace(/[-_]/g, '') === 'key' || isSecretKey(name, ['signature', 'sig']);
    const reference = (text: string, fullMask: boolean): string => {
      const masked = text.replace(URL_PASSWORD, '$1:***@');
      if (!fullMask) return masked;
      return masked.replace(URL_PARAM, (match, mark: string, name: string, value: string) =>
        value !== '' && secretParam(name) ? `${mark}${name}=[redacted]` : match,
      );
    };
    const nbsp = `a://u${String.fromCharCode(0xa0)}:p@h`;
    for (const text of [
      'postgres://kindgi:hunter2@db.internal:5432/kindgi',
      '1.postgres://u:p@h',
      '_a://u:p@h',
      'a://u:p@b://v:q@c',
      'a://u:p:b://v:q@c',
      'HTTPS://U:P@H',
      `x${'1'.repeat(100)}://u:p@h`,
      ':://u:p@h',
      'a://u:@h',
      'a://:p@h',
      'a://u:p q@h',
      nbsp,
      '?token=abc',
      '??key=x',
      '?a?token=x',
      'x?sort_key=1&key=s#access_token=t',
      '?=x',
      '?token=',
      '&&token=x',
      '?a b=c',
      '?debug&token=abc',
      '?token=a=b?c&x=1',
    ]) {
      expect(full(text), text).toBe(reference(text, true));
      expect(scrubText(text), text).toBe(reference(text, false));
    }
    expect(full('1.postgres://u:p@h')).toBe('1.postgres://u:***@h');
    expect(full('_a://u:p@h')).toBe('_a://u:p@h');
    expect(full(nbsp)).toBe(nbsp);
    expect(full('?token=abc')).toBe('?token=[redacted]');
    expect(full('??key=x')).toBe('??key=x');
    expect(full('?a?token=x')).toBe('?a?token=[redacted]');
    expect(full('?debug&token=abc')).toBe('?debug&token=[redacted]');

    // 64 KiB each. The patterns take seconds on these.
    const run = 'a.'.repeat(32 * 1024);
    for (const text of [run, `${run}://x`, '?a'.repeat(32 * 1024)]) {
      const started = performance.now();
      expect(full(text)).toBe(text);
      expect(performance.now() - started, text.slice(-8)).toBeLessThan(500);
    }
  });
});
