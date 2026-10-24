// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { computeConnectWaitToken } from '../src/index.js';

describe('computeConnectWaitToken', () => {
  const call = { runId: '00000000-0000-0000-0000-0000000000a1', callId: 'toolu_01', name: 'mail' };

  it('is the first 40 hex characters of sha256 of connect:<runId>:<callId>:<name>', () => {
    const expected = createHash('sha256')
      .update('connect:00000000-0000-0000-0000-0000000000a1:toolu_01:mail')
      .digest('hex')
      .slice(0, 40);
    expect(computeConnectWaitToken(call)).toBe(expected);
    expect(computeConnectWaitToken(call)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('is the same for a replay of the call', () => {
    expect(computeConnectWaitToken({ ...call })).toBe(computeConnectWaitToken(call));
  });

  it('with a step scope: sha256 of connect:<runId>:<stepScope>:<callId>:<name>', () => {
    const expected = createHash('sha256')
      .update('connect:00000000-0000-0000-0000-0000000000a1:turn/2:toolu_01:mail')
      .digest('hex')
      .slice(0, 40);
    expect(computeConnectWaitToken({ ...call, stepScope: 'turn/2' })).toBe(expected);
  });

  it('differs by step, so a call id a later loop iteration reuses asks again', () => {
    expect(computeConnectWaitToken({ ...call, stepScope: 'turn/2' })).not.toBe(
      computeConnectWaitToken({ ...call, stepScope: 'turn/3' }),
    );
    expect(computeConnectWaitToken({ ...call, stepScope: 'turn/2' })).not.toBe(
      computeConnectWaitToken(call),
    );
  });

  it('differs by run, by call and by connection', () => {
    const token = computeConnectWaitToken(call);
    expect(
      computeConnectWaitToken({ ...call, runId: '00000000-0000-0000-0000-0000000000a2' }),
    ).not.toBe(token);
    expect(computeConnectWaitToken({ ...call, callId: 'toolu_02' })).not.toBe(token);
    expect(computeConnectWaitToken({ ...call, name: 'cal' })).not.toBe(token);
  });
});
