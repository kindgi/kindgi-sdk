// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** Sealed page cursors: they show nothing, and open only where they were handed out, for a day. */

import { randomBytes } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { CURSOR_TTL_MS, type CursorContext, createAeadCursorSealer } from '../src/index.js';

const key = (kid: string) => ({ kid, key: new Uint8Array(randomBytes(32)) });
const CONTEXT: CursorContext = {
  tenantId: 't-1',
  principal: 'user:u-1',
  list: '/v1/agents',
  filters: 'name=acme',
};
const POSITION = Buffer.from(JSON.stringify({ a: 'acme.hidden-agent' })).toString('base64url');

describe('a sealed cursor', () => {
  test('opens to the position it sealed, and shows nothing of it', () => {
    const sealer = createAeadCursorSealer({ keys: [key('k1')] });
    const sealed = sealer.seal(POSITION, CONTEXT);
    expect(sealed.startsWith('k1.k1.')).toBe(true);
    expect(sealed).not.toContain(POSITION);
    expect(Buffer.from(sealed.split('.')[3] ?? '', 'base64url').toString('latin1')).not.toContain(
      'acme',
    );
    expect(sealer.open(sealed, CONTEXT)).toEqual({ kind: 'sealed', cursor: POSITION });
    // Two seals of the same position differ (a fresh nonce each).
    expect(sealer.seal(POSITION, CONTEXT)).not.toBe(sealed);
  });

  test.each([
    ['another tenant', { tenantId: 't-2' }],
    ['another caller', { principal: 'user:u-2' }],
    ['another list', { list: '/v1/flows' }],
    ['other filters', { filters: 'name=other' }],
  ])('opens for nobody else: %s is refused', (_what, other) => {
    const sealer = createAeadCursorSealer({ keys: [key('k1')] });
    const sealed = sealer.seal(POSITION, CONTEXT);
    expect(sealer.open(sealed, { ...CONTEXT, ...other })).toEqual({
      kind: 'refused',
      reason: 'foreign',
    });
  });

  test('tampered with, or sealed with a key this runtime lacks: refused', () => {
    const sealer = createAeadCursorSealer({ keys: [key('k1')] });
    const sealed = sealer.seal(POSITION, CONTEXT);
    const [p, kid, nonce, body] = sealed.split('.') as [string, string, string, string];
    const flipped = Buffer.from(body, 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    for (const bad of [
      [p, kid, nonce, flipped.toString('base64url')].join('.'),
      [p, kid, nonce].join('.'),
      `${sealed}.extra`,
      'k1.k1.!!.!!',
    ]) {
      expect(sealer.open(bad, CONTEXT)).toEqual({ kind: 'refused', reason: 'foreign' });
    }
    const elsewhere = createAeadCursorSealer({ keys: [key('k9')] });
    expect(elsewhere.open(sealed, CONTEXT)).toEqual({ kind: 'refused', reason: 'foreign' });
  });

  test('expires after a day (and one from the future is stale too)', () => {
    let now = 1_000_000_000_000;
    const sealer = createAeadCursorSealer({ keys: [key('k1')], now: () => now });
    const sealed = sealer.seal(POSITION, CONTEXT);
    now += CURSOR_TTL_MS;
    expect(sealer.open(sealed, CONTEXT).kind).toBe('sealed');
    now += 1;
    expect(sealer.open(sealed, CONTEXT)).toEqual({ kind: 'refused', reason: 'expired' });
    now -= CURSOR_TTL_MS + 120_001;
    expect(sealer.open(sealed, CONTEXT)).toEqual({ kind: 'refused', reason: 'expired' });
  });

  test('a key rotates: the first key seals, an earlier one still opens what it sealed', () => {
    const old = key('2026-09');
    const before = createAeadCursorSealer({ keys: [old] }).seal(POSITION, CONTEXT);
    const rotated = createAeadCursorSealer({ keys: [key('2026-10'), old] });
    expect(rotated.open(before, CONTEXT)).toEqual({ kind: 'sealed', cursor: POSITION });
    expect(rotated.seal(POSITION, CONTEXT).startsWith('k1.2026-10.')).toBe(true);
  });

  test('a cursor that was never sealed is plain: a list takes it as it is', () => {
    const sealer = createAeadCursorSealer({ keys: [key('k1')] });
    expect(sealer.open(POSITION, CONTEXT)).toEqual({ kind: 'plain' });
    expect(sealer.open('2026-10-09T01:02:03.004Z', CONTEXT)).toEqual({ kind: 'plain' });
  });

  test('its keys are checked when it is made', () => {
    expect(() => createAeadCursorSealer({ keys: [] })).toThrow('at least one key');
    expect(() =>
      createAeadCursorSealer({ keys: [{ kid: 'k1', key: new Uint8Array(16) }] }),
    ).toThrow('must be 32 bytes');
    expect(() => createAeadCursorSealer({ keys: [key('has.dot')] })).toThrow('[A-Za-z0-9_-]');
    expect(() => createAeadCursorSealer({ keys: [key('k1'), key('k1')] })).toThrow('twice');
  });
});
