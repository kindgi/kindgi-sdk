// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** An agent gate's reading of the reviewer's answer: only an explicit approve approves. */

import { describe, expect, test } from 'vitest';

import { UNREADABLE_DECISION, readGateDecision } from '../src/handlers/gate-decision.js';

describe('readGateDecision — fails closed', () => {
  test('an explicit approve approves', () => {
    expect(readGateDecision({ decided: 'approve' })).toEqual({ approved: true });
    expect(readGateDecision({ decided: 'approve', rationale: 'fine' })).toEqual({ approved: true });
  });

  test("a reject blocks, keeping the reviewer's rationale", () => {
    expect(readGateDecision({ decided: 'reject', rationale: 'not this one' })).toEqual({
      approved: false,
      reason: 'rejected',
      rationale: 'not this one',
    });
    expect(readGateDecision({ decided: 'reject' })).toEqual({
      approved: false,
      reason: 'rejected',
      rationale: undefined,
    });
  });

  test.each([
    ['a value that replaced the decision', { maxCostUsd: 1.5 }],
    ['an empty object', {}],
    ['another spelling', { decided: 'APPROVE' }],
    ['a bare string', 'approve'],
    ['null', null],
    ['nothing', undefined],
  ])('%s blocks, saying why', (_name, value) => {
    expect(readGateDecision(value)).toEqual({
      approved: false,
      reason: 'unreadable',
      rationale: UNREADABLE_DECISION,
    });
  });
});

describe('readGateDecision — who decided', () => {
  test('a decision names who decided which approval', () => {
    expect(
      readGateDecision({
        decided: 'approve',
        decidedBy: 'user:u-1',
        approvalId: 'appr-1',
      }),
    ).toEqual({ approved: true, decidedBy: 'user:u-1', approvalId: 'appr-1' });
    expect(readGateDecision({ decided: 'reject', rationale: 'no', decidedBy: 'user:u-1' })).toEqual(
      { approved: false, reason: 'rejected', rationale: 'no', decidedBy: 'user:u-1' },
    );
  });

  test("a decision recorded before it named the decider still decides; a malformed decider isn't read", () => {
    expect(readGateDecision({ decided: 'approve' })).toEqual({ approved: true });
    expect(readGateDecision({ decided: 'approve', decidedBy: 42, approvalId: {} })).toEqual({
      approved: true,
    });
  });

  test("an answer that isn't a decision names no decider", () => {
    expect(readGateDecision({ decidedBy: 'user:u-1', approvalId: 'appr-1' })).toEqual({
      approved: false,
      reason: 'unreadable',
      rationale: UNREADABLE_DECISION,
    });
  });
});
