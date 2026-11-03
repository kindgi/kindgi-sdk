// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { computeToolCallWaitToken } from '../src/handlers/tool-hitl.js';

describe('computeToolCallWaitToken', () => {
  const call = {
    runId: '00000000-0000-0000-0000-0000000000a1',
    callId: 'toolu_01',
    argsHash: 'a'.repeat(64),
  };
  const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 40);

  it('is the first 40 hex characters of sha256 of tool-call:<runId>:<callId>:<argsHash>', () => {
    expect(computeToolCallWaitToken(call)).toBe(
      sha(`tool-call:00000000-0000-0000-0000-0000000000a1:toolu_01:${'a'.repeat(64)}`),
    );
    expect(computeToolCallWaitToken(call)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('with a step scope: sha256 of tool-call:<runId>:<stepScope>:<callId>:<argsHash>', () => {
    expect(computeToolCallWaitToken({ ...call, stepScope: 'turn/2' })).toBe(
      sha(`tool-call:00000000-0000-0000-0000-0000000000a1:turn/2:toolu_01:${'a'.repeat(64)}`),
    );
  });

  it('is the same for a replay of the call', () => {
    expect(computeToolCallWaitToken({ ...call, stepScope: 'turn/2' })).toBe(
      computeToolCallWaitToken({ ...call, stepScope: 'turn/2' }),
    );
  });

  it('differs by step, so a call a later loop iteration makes again waits for its own answer', () => {
    expect(computeToolCallWaitToken({ ...call, stepScope: 'turn/2' })).not.toBe(
      computeToolCallWaitToken({ ...call, stepScope: 'turn/3' }),
    );
    expect(computeToolCallWaitToken({ ...call, stepScope: 'turn/2' })).not.toBe(
      computeToolCallWaitToken(call),
    );
  });

  it('differs by run, by call and by arguments', () => {
    const token = computeToolCallWaitToken(call);
    expect(
      computeToolCallWaitToken({ ...call, runId: '00000000-0000-0000-0000-0000000000a2' }),
    ).not.toBe(token);
    expect(computeToolCallWaitToken({ ...call, callId: 'toolu_02' })).not.toBe(token);
    expect(computeToolCallWaitToken({ ...call, argsHash: 'b'.repeat(64) })).not.toBe(token);
  });
});
