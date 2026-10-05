// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { fromWire } from '../src/errors.js';

describe('fromWire — guardrail-violation', () => {
  it('hydrates the violations the server sends under details', () => {
    const err = fromWire({
      code: 'guardrail-violation',
      message: "Turn blocked by guardrail 'no-pii': Response contains an email",
      details: {
        violations: [
          {
            guardrailId: 'no-pii',
            result: { passed: false, reason: 'Response contains an email' },
            action: 'halt',
            severity: 'error',
            at: '2026-09-30T00:00:00.000Z',
          },
        ],
        evaluationErrors: [{ guardrailId: 'tone', message: 'check tone-v2 not registered' }],
      },
      requestId: 'req_1',
    });
    expect(err).toEqual({
      code: 'guardrail-violation',
      message: "Turn blocked by guardrail 'no-pii': Response contains an email",
      violations: [
        {
          guardrailId: 'no-pii',
          severity: 'error',
          action: 'halt',
          reason: 'Response contains an email',
        },
      ],
      evaluationErrors: [{ guardrailId: 'tone', message: 'check tone-v2 not registered' }],
    });
  });

  it('is still a guardrail-violation when the server sends no details', () => {
    expect(
      fromWire({ code: 'guardrail-violation', message: "Turn blocked by guardrail 'no-pii'" }),
    ).toEqual({
      code: 'guardrail-violation',
      message: "Turn blocked by guardrail 'no-pii'",
      violations: [],
      evaluationErrors: [],
    });
  });

  it('drops malformed entries and omits an absent reason', () => {
    const err = fromWire({
      code: 'guardrail-violation',
      message: 'blocked',
      details: {
        violations: [null, 'no-pii', { result: {} }, { guardrailId: 'max-length', result: {} }],
        evaluationErrors: [{ message: 'no id' }],
      },
    });
    expect(err).toEqual({
      code: 'guardrail-violation',
      message: 'blocked',
      violations: [{ guardrailId: 'max-length', severity: 'unknown', action: 'unknown' }],
      evaluationErrors: [],
    });
  });
});

describe('fromWire — conflicts', () => {
  it.each(['slug-conflict', 'project-default-already-exists'])(
    'a %s is a conflict, its code the reason',
    (code) => {
      expect(fromWire({ code, message: 'taken' })).toEqual({
        code: 'conflict',
        message: 'taken',
        reason: code,
      });
    },
  );
});
