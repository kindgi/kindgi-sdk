// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { timingSafeEqual } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';

import { hmacSha256Sign, hmacSha256Verify } from '../src/index.js';

// Spy on the constant-time primitive (still the real implementation).
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

describe('hmacSha256Sign', () => {
  test('produces a 64-char lowercase hex digest', () => {
    const sig = hmacSha256Sign('secret', 'hello');
    expect(sig).toMatch(/^[0-9a-f]{64}$/u);
  });

  test('is deterministic for the same input', () => {
    const a = hmacSha256Sign('shared', 'payload');
    const b = hmacSha256Sign('shared', 'payload');
    expect(a).toBe(b);
  });

  test('accepts Uint8Array for both secret and message', () => {
    const s = new TextEncoder().encode('shared');
    const m = new TextEncoder().encode('payload');
    const asBytes = hmacSha256Sign(s, m);
    const asString = hmacSha256Sign('shared', 'payload');
    expect(asBytes).toBe(asString);
  });

  test('matches a known Stripe-style test vector', () => {
    // A standard HMAC-SHA256 test vector: NIST FIPS 198-1 test.
    // key = 'key', msg = 'The quick brown fox jumps over the lazy dog'
    // expected sha256 hmac = f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8
    const sig = hmacSha256Sign('key', 'The quick brown fox jumps over the lazy dog');
    expect(sig).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });
});

describe('hmacSha256Verify', () => {
  test('sign → verify round-trip', () => {
    const secret = 'webhook-signing-secret';
    const message = '{"event":"payment.succeeded","amount":1000}';
    const sig = hmacSha256Sign(secret, message);
    expect(hmacSha256Verify(secret, message, sig)).toBe(true);
  });

  test('tampered message fails', () => {
    const secret = 'webhook-signing-secret';
    const sig = hmacSha256Sign(secret, 'original');
    expect(hmacSha256Verify(secret, 'tampered', sig)).toBe(false);
  });

  test('wrong secret fails', () => {
    const sig = hmacSha256Sign('secret-a', 'message');
    expect(hmacSha256Verify('secret-b', 'message', sig)).toBe(false);
  });

  test('shorter signature fails immediately', () => {
    expect(hmacSha256Verify('s', 'm', 'abc')).toBe(false);
  });

  test('non-hex signature fails', () => {
    // 64 chars, but with non-hex characters — Buffer.from with 'hex' is
    // lenient (silently truncates on invalid chars), so the guard is that
    // decoded lengths mismatch. Verify returns false in either case.
    const sig = 'z'.repeat(64);
    expect(hmacSha256Verify('s', 'm', sig)).toBe(false);
  });

  test('non-string signature returns false (defensive)', () => {
    // TypeScript would reject this, but runtime callers (e.g., untyped
    // JSON bodies) may pass through anything.
    expect(hmacSha256Verify('s', 'm', undefined as unknown as string)).toBe(false);
  });
});

describe('hmacSha256Verify — constant-time comparison', () => {
  // A short-circuiting comparison would leak the position of the first
  // differing byte. Verification must compare with crypto.timingSafeEqual
  // on equal-length buffers wherever the mismatch is. (Timing the call
  // can't detect a leak: computing the HMAC dominates its running time.)
  const secret = 'timing-test-secret';
  const message = 'timing-test-message';

  test.each([
    ['first', 0],
    ['last', 63],
  ])('a mismatch at the %s hex digit is compared with timingSafeEqual', (_, index) => {
    const signature = flipHexChar(hmacSha256Sign(secret, message), index);
    vi.mocked(timingSafeEqual).mockClear();
    expect(hmacSha256Verify(secret, message, signature)).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    const [expected, provided] = vi.mocked(timingSafeEqual).mock.calls[0] ?? [];
    expect(expected?.byteLength).toBe(32);
    expect(provided?.byteLength).toBe(32);
  });

  test('a matching signature is compared with timingSafeEqual too', () => {
    vi.mocked(timingSafeEqual).mockClear();
    expect(hmacSha256Verify(secret, message, hmacSha256Sign(secret, message))).toBe(true);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });
});

function flipHexChar(hex: string, index: number): string {
  const original = hex[index];
  if (original === undefined) throw new Error('index out of range');
  const flipped = original === '0' ? '1' : '0';
  return hex.slice(0, index) + flipped + hex.slice(index + 1);
}
