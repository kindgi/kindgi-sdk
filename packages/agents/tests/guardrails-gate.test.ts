// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { EvaluationResult } from '@kindgi/guardrails';
import type { GuardrailId, Timestamp } from '@kindgi/types';

import { describeBlockingViolations } from '../src/guardrails-gate.js';

function violation(guardrailId: string, reason?: string): EvaluationResult {
  return {
    guardrailId: guardrailId as GuardrailId,
    result: { passed: false, ...(reason !== undefined && { reason }) },
    action: 'halt',
    severity: 'error',
    at: '2026-09-30T00:00:00.000Z' as Timestamp,
  };
}

describe('describeBlockingViolations', () => {
  test('one guardrail — named, with its reason', () => {
    expect(describeBlockingViolations([violation('no-pii', 'Response contains an email')])).toBe(
      "Turn blocked by guardrail 'no-pii': Response contains an email",
    );
  });

  test('one guardrail without a reason — named only', () => {
    expect(describeBlockingViolations([violation('no-pii')])).toBe(
      "Turn blocked by guardrail 'no-pii'",
    );
  });

  test('a blank reason counts as no reason', () => {
    expect(describeBlockingViolations([violation('no-pii', '  ')])).toBe(
      "Turn blocked by guardrail 'no-pii'",
    );
  });

  test('several guardrails — each named, in evaluation order, reasons where given', () => {
    expect(
      describeBlockingViolations([
        violation('no-pii', 'Response contains an email'),
        violation('max-length'),
      ]),
    ).toBe("Turn blocked by 2 guardrails: 'no-pii' (Response contains an email); 'max-length'");
  });
});
