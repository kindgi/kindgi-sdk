// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { PACK_PROTOCOL_VERSION, parsePackRequest, parsePackResponse } from '../src/protocol.js';

const ctx = { tenantId: 't', runId: 'r', requestId: 'call-1' };

describe('parsePackRequest', () => {
  test('a tool invoke and a check invoke parse as themselves', () => {
    const invoke = { v: 2, kind: 'invoke', tool: { id: 'p.t', version: '1.0.0' }, input: {}, ctx };
    expect(parsePackRequest(invoke)).toEqual({ kind: 'ok', value: invoke });
    const check = { v: 2, kind: 'check-invoke', check: { id: 'p.c' }, config: {}, trace: {} };
    expect(parsePackRequest(check)).toEqual({ kind: 'ok', value: check });
  });

  test.each([
    ['not an object', [1], 'malformed-message'],
    ['protocol v1', { v: 1, kind: 'invoke' }, 'unknown-protocol-version'],
    ['an unknown kind', { v: 2, kind: 'run' }, 'unexpected-message-kind'],
    ['no tool id', { v: 2, kind: 'invoke', tool: {}, input: {}, ctx }, 'malformed-message'],
    [
      'no run id',
      { v: 2, kind: 'invoke', tool: { id: 'x' }, input: {}, ctx: { tenantId: 't' } },
      'malformed-message',
    ],
    [
      'a non-object config',
      { v: 2, kind: 'check-invoke', check: { id: 'c' }, config: 1 },
      'malformed-message',
    ],
  ])('%s → %s', (_label, value, code) => {
    const r = parsePackRequest(value);
    expect(r.kind === 'err' && r.error).toMatchObject({
      v: PACK_PROTOCOL_VERSION,
      kind: 'error',
      code,
    });
  });
});

describe('parsePackResponse', () => {
  test('results and errors parse; anything else is rejected', () => {
    expect(parsePackResponse({ v: 2, kind: 'result', output: 1 }).kind).toBe('ok');
    expect(parsePackResponse({ v: 2, kind: 'check-result', result: {} }).kind).toBe('ok');
    expect(
      parsePackResponse({ v: 2, kind: 'error', code: 'handler-throw', message: 'x' }).kind,
    ).toBe('ok');
    expect(parsePackResponse({ v: 2, kind: 'error' }).kind).toBe('err');
    expect(parsePackResponse({ v: 1, kind: 'result' }).kind).toBe('err');
  });
});
