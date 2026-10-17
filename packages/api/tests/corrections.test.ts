// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  type CandidateCall,
  type Correction,
  describeCorrectionDifference,
  gradeCorrection,
} from '../src/corrections.js';

const call = (tool: string, args: Record<string, unknown>, step?: number): CandidateCall => ({
  tool,
  args,
  ...(step !== undefined && { step }),
});

const refused = (tool: string, args: Record<string, unknown>, step?: number): CandidateCall => ({
  ...call(tool, args, step),
  refused: true,
});

describe('gradeCorrection — scope', () => {
  test('ignores calls to tools the correction does not name', () => {
    const correction: Correction = {
      calls: [{ tool: 'refund', args: { amount: 25 } }],
      notCalled: [],
    };
    const result = gradeCorrection(correction, [
      call('refund', { amount: 25 }),
      call('lookup', { id: 'x' }),
    ]);
    expect(result).toEqual({ pass: true, differences: [] });
  });

  test('an empty correction (no calls, nothing forbidden) passes whatever happened', () => {
    expect(gradeCorrection({ calls: [], notCalled: [] }, [call('refund', { amount: 25 })])).toEqual(
      {
        pass: true,
        differences: [],
      },
    );
  });

  test('an expected call with no pinned fields asks only that the tool was called', () => {
    expect(
      gradeCorrection({ calls: [{ tool: 'refund', args: {} }], notCalled: [] }, [
        call('refund', { amount: 999 }),
      ]),
    ).toEqual({ pass: true, differences: [] });
  });
});

describe('gradeCorrection — the multiset count', () => {
  test('too many calls to a named tool fails on the count', () => {
    const correction: Correction = {
      calls: [{ tool: 'refund', args: { amount: 25 } }],
      notCalled: [],
    };
    const result = gradeCorrection(correction, [
      call('refund', { amount: 25 }),
      call('refund', { amount: 25 }),
    ]);
    expect(result.pass).toBe(false);
    expect(result.differences).toContainEqual({
      tool: 'refund',
      kind: 'count',
      expected: 1,
      actual: 2,
    });
  });

  test('too few calls fails on the count', () => {
    const correction: Correction = {
      calls: [
        { tool: 'refund', args: { amount: 25 } },
        { tool: 'refund', args: { amount: 25 } },
      ],
      notCalled: [],
    };
    const result = gradeCorrection(correction, [call('refund', { amount: 25 })]);
    expect(result.pass).toBe(false);
    expect(result.differences).toContainEqual({
      tool: 'refund',
      kind: 'count',
      expected: 2,
      actual: 1,
    });
  });

  test('the same count, each pairing, passes', () => {
    const correction: Correction = {
      calls: [
        { tool: 'refund', args: { amount: 25 } },
        { tool: 'refund', args: { amount: 50 } },
      ],
      notCalled: [],
    };
    expect(
      gradeCorrection(correction, [call('refund', { amount: 50 }), call('refund', { amount: 25 })])
        .pass,
    ).toBe(true);
  });
});

describe('gradeCorrection — partial fields', () => {
  test('an actual field the correction did not pin is not compared', () => {
    const correction: Correction = {
      calls: [{ tool: 'refund', args: { amount: 25 } }],
      notCalled: [],
    };
    expect(
      gradeCorrection(correction, [call('refund', { amount: 25, currency: 'USD', note: 'x' })]),
    ).toEqual({
      pass: true,
      differences: [],
    });
  });

  test('a pinned field with a different value fails on that field', () => {
    const correction: Correction = {
      calls: [{ tool: 'refund', args: { amount: 25 } }],
      notCalled: [],
    };
    const result = gradeCorrection(correction, [call('refund', { amount: 80 })]);
    expect(result.pass).toBe(false);
    expect(result.differences).toContainEqual({
      tool: 'refund',
      kind: 'field-value',
      field: 'amount',
      expected: 25,
      actual: 80,
    });
  });

  test('a pinned field the actual call lacks is reported as missing', () => {
    const correction: Correction = {
      calls: [{ tool: 'refund', args: { amount: 25, currency: 'USD' } }],
      notCalled: [],
    };
    const result = gradeCorrection(correction, [call('refund', { amount: 25 })]);
    expect(result.pass).toBe(false);
    expect(result.differences).toContainEqual({
      tool: 'refund',
      kind: 'missing-field',
      field: 'currency',
      expected: 'USD',
    });
  });

  test('a deep object field compares whole, by value, regardless of key order', () => {
    const correction: Correction = {
      calls: [{ tool: 'ship', args: { to: { city: 'NYC', zip: '10001' } } }],
      notCalled: [],
    };
    expect(
      gradeCorrection(correction, [call('ship', { to: { zip: '10001', city: 'NYC' } })]).pass,
    ).toBe(true);
    expect(
      gradeCorrection(correction, [call('ship', { to: { zip: '10002', city: 'NYC' } })]).pass,
    ).toBe(false);
  });
});

describe('gradeCorrection — must not call', () => {
  test('a forbidden tool that was called fails, with the count', () => {
    const correction: Correction = { calls: [], notCalled: ['refund'] };
    const result = gradeCorrection(correction, [
      call('refund', { amount: 25 }),
      call('refund', { amount: 1 }),
    ]);
    expect(result.pass).toBe(false);
    expect(result.differences).toContainEqual({ tool: 'refund', kind: 'must-not-call', actual: 2 });
  });

  test('a forbidden tool called exactly once fails, with a count of one', () => {
    const result = gradeCorrection({ calls: [], notCalled: ['refund'] }, [
      call('refund', { amount: 25 }),
    ]);
    expect(result.pass).toBe(false);
    expect(result.differences).toContainEqual({ tool: 'refund', kind: 'must-not-call', actual: 1 });
  });

  test('a forbidden tool that was not called passes', () => {
    expect(
      gradeCorrection({ calls: [], notCalled: ['refund'] }, [call('lookup', { id: 'x' })]),
    ).toEqual({
      pass: true,
      differences: [],
    });
  });
});

describe('gradeCorrection — maximum matching, not greedy', () => {
  // The broad expected call is listed first. A greedy, order-dependent
  // pairing would take the call the narrow expected needs and then fail;
  // a maximum matching pairs them both.
  const correction: Correction = {
    calls: [
      { tool: 'refund', args: { currency: 'USD' } },
      { tool: 'refund', args: { amount: 25 } },
    ],
    notCalled: [],
  };

  test('pairs both when a maximum matching exists', () => {
    const result = gradeCorrection(correction, [
      call('refund', { amount: 25, currency: 'USD' }, 0),
      call('refund', { amount: 80, currency: 'USD' }, 1),
    ]);
    expect(result).toEqual({ pass: true, differences: [] });
  });

  test('the result does not depend on the order the actual calls are given', () => {
    const forwards = gradeCorrection(correction, [
      call('refund', { amount: 25, currency: 'USD' }, 0),
      call('refund', { amount: 80, currency: 'USD' }, 1),
    ]);
    const backwards = gradeCorrection(correction, [
      call('refund', { amount: 80, currency: 'USD' }, 1),
      call('refund', { amount: 25, currency: 'USD' }, 0),
    ]);
    expect(backwards).toEqual(forwards);
  });
});

describe('gradeCorrection — refused calls are named', () => {
  test('a refused call then a real retry counts both, and the count names the refused one', () => {
    const result = gradeCorrection(
      { calls: [{ tool: 'refund', args: { amount: 25 } }], notCalled: [] },
      [refused('refund', { amount: 25 }, 0), call('refund', { amount: 25 }, 1)],
    );
    expect(result.pass).toBe(false);
    expect(result.differences).toContainEqual({
      tool: 'refund',
      kind: 'count',
      expected: 1,
      actual: 2,
      refused: 1,
    });
  });

  test('a forbidden tool whose only call was refused names it', () => {
    const result = gradeCorrection({ calls: [], notCalled: ['refund'] }, [
      refused('refund', { amount: 25 }),
    ]);
    expect(result.pass).toBe(false);
    expect(result.differences).toContainEqual({
      tool: 'refund',
      kind: 'must-not-call',
      actual: 1,
      refused: 1,
    });
  });

  test('a field difference against a refused call is marked refused', () => {
    const result = gradeCorrection(
      { calls: [{ tool: 'refund', args: { amount: 25 } }], notCalled: [] },
      [refused('refund', { amount: 80 })],
    );
    expect(result.pass).toBe(false);
    expect(result.differences).toContainEqual({
      tool: 'refund',
      kind: 'field-value',
      field: 'amount',
      expected: 25,
      actual: 80,
      refused: true,
    });
  });
});

describe('gradeCorrection — order is not compared', () => {
  test('two different tools in any order pass', () => {
    const correction: Correction = {
      calls: [
        { tool: 'lookup', args: { id: 'x' } },
        { tool: 'refund', args: { amount: 25 } },
      ],
      notCalled: [],
    };
    expect(
      gradeCorrection(correction, [call('refund', { amount: 25 }), call('lookup', { id: 'x' })])
        .pass,
    ).toBe(true);
  });
});

describe('gradeCorrection — reporting the nearest miss', () => {
  test('an unmatched expected call is blamed on the free actual with the fewest differing fields', () => {
    const correction: Correction = {
      calls: [{ tool: 'refund', args: { amount: 25, currency: 'USD' } }],
      notCalled: [],
    };
    const result = gradeCorrection(correction, [
      call('refund', { amount: 25, currency: 'EUR' }, 0), // one field off
      call('refund', { amount: 99, currency: 'JPY' }, 1), // two fields off
    ]);
    expect(result.pass).toBe(false);
    // Count is wrong (1 vs 2), and the nearest miss (EUR, not JPY) is named.
    expect(result.differences).toContainEqual({
      tool: 'refund',
      kind: 'count',
      expected: 1,
      actual: 2,
    });
    expect(result.differences).toContainEqual({
      tool: 'refund',
      kind: 'field-value',
      field: 'currency',
      expected: 'USD',
      actual: 'EUR',
    });
    expect(result.differences).not.toContainEqual(
      expect.objectContaining({ kind: 'field-value', field: 'currency', actual: 'JPY' }),
    );
  });
});

describe('describeCorrectionDifference', () => {
  test('the default words for each kind', () => {
    expect(
      describeCorrectionDifference({ tool: 'refund', kind: 'count', expected: 1, actual: 2 }),
    ).toBe('refund: expected 1 call, got 2');
    expect(
      describeCorrectionDifference({ tool: 'refund', kind: 'count', expected: 2, actual: 0 }),
    ).toBe('refund: expected 2 calls, got 0');
    expect(describeCorrectionDifference({ tool: 'refund', kind: 'must-not-call', actual: 1 })).toBe(
      'refund: expected no calls, got 1',
    );
    expect(
      describeCorrectionDifference({
        tool: 'refund',
        kind: 'missing-field',
        field: 'amount',
        expected: 25,
      }),
    ).toBe('refund amount: expected 25, got nothing');
    expect(
      describeCorrectionDifference({
        tool: 'refund',
        kind: 'field-value',
        field: 'amount',
        expected: 25,
        actual: 80,
      }),
    ).toBe('refund amount: expected 25, got 80');
    expect(
      describeCorrectionDifference({
        tool: 'refund',
        kind: 'field-value',
        field: 'currency',
        expected: 'USD',
        actual: 'EUR',
      }),
    ).toBe('refund currency: expected "USD", got "EUR"');
  });

  test('a string value reads quoted, so it is not mistaken for the number it looks like', () => {
    expect(
      describeCorrectionDifference({
        tool: 'refund',
        kind: 'field-value',
        field: 'amount',
        expected: 25,
        actual: '25',
      }),
    ).toBe('refund amount: expected 25, got "25"');
    expect(
      describeCorrectionDifference({
        tool: 'refund',
        kind: 'field-value',
        field: 'note',
        expected: null,
        actual: 'null',
      }),
    ).toBe('refund note: expected null, got "null"');
  });

  test('the default words name a refused call', () => {
    expect(
      describeCorrectionDifference({
        tool: 'refund',
        kind: 'count',
        expected: 1,
        actual: 2,
        refused: 1,
      }),
    ).toBe('refund: expected 1 call, got 2 (1 refused)');
    expect(
      describeCorrectionDifference({
        tool: 'refund',
        kind: 'must-not-call',
        actual: 1,
        refused: 1,
      }),
    ).toBe('refund: expected no calls, got 1 (1 refused)');
    expect(
      describeCorrectionDifference({
        tool: 'refund',
        kind: 'field-value',
        field: 'amount',
        expected: 25,
        actual: 80,
        refused: true,
      }),
    ).toBe('refund amount: expected 25, got 80 (refused)');
  });
});
