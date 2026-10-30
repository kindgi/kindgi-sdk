// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  type CandidateCall,
  type ExpectedDecisions,
  describeCallDifference,
  gradeExpectedDecisions,
} from '../src/expected-decisions.js';

const call = (tool: string, args: Record<string, unknown>, step?: number): CandidateCall => ({
  tool,
  args,
  ...(step !== undefined && { step }),
});

const refused = (tool: string, args: Record<string, unknown>, step?: number): CandidateCall => ({
  ...call(tool, args, step),
  refused: true,
});

describe('gradeExpectedDecisions — scope', () => {
  test('ignores calls to tools the expected decisions do not name', () => {
    const decisions: ExpectedDecisions = {
      calls: [{ tool: 'refund', args: { amount: 25 } }],
      notCalled: [],
    };
    const result = gradeExpectedDecisions(decisions, [
      call('refund', { amount: 25 }),
      call('lookup', { id: 'x' }),
    ]);
    expect(result).toEqual({ pass: true, differences: [] });
  });

  test('empty expected decisions (no calls, nothing forbidden) pass whatever happened', () => {
    expect(
      gradeExpectedDecisions({ calls: [], notCalled: [] }, [call('refund', { amount: 25 })]),
    ).toEqual({
      pass: true,
      differences: [],
    });
  });

  test('an expected call with no pinned fields asks only that the tool was called', () => {
    expect(
      gradeExpectedDecisions({ calls: [{ tool: 'refund', args: {} }], notCalled: [] }, [
        call('refund', { amount: 999 }),
      ]),
    ).toEqual({ pass: true, differences: [] });
  });
});

describe('gradeExpectedDecisions — the multiset count', () => {
  test('too many calls to a named tool fails on the count', () => {
    const decisions: ExpectedDecisions = {
      calls: [{ tool: 'refund', args: { amount: 25 } }],
      notCalled: [],
    };
    const result = gradeExpectedDecisions(decisions, [
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
    const decisions: ExpectedDecisions = {
      calls: [
        { tool: 'refund', args: { amount: 25 } },
        { tool: 'refund', args: { amount: 25 } },
      ],
      notCalled: [],
    };
    const result = gradeExpectedDecisions(decisions, [call('refund', { amount: 25 })]);
    expect(result.pass).toBe(false);
    expect(result.differences).toContainEqual({
      tool: 'refund',
      kind: 'count',
      expected: 2,
      actual: 1,
    });
  });

  test('the same count, each pairing, passes', () => {
    const decisions: ExpectedDecisions = {
      calls: [
        { tool: 'refund', args: { amount: 25 } },
        { tool: 'refund', args: { amount: 50 } },
      ],
      notCalled: [],
    };
    expect(
      gradeExpectedDecisions(decisions, [
        call('refund', { amount: 50 }),
        call('refund', { amount: 25 }),
      ]).pass,
    ).toBe(true);
  });
});

describe('gradeExpectedDecisions — partial fields', () => {
  test('an actual field the expected decisions did not pin is not compared', () => {
    const decisions: ExpectedDecisions = {
      calls: [{ tool: 'refund', args: { amount: 25 } }],
      notCalled: [],
    };
    expect(
      gradeExpectedDecisions(decisions, [
        call('refund', { amount: 25, currency: 'USD', note: 'x' }),
      ]),
    ).toEqual({
      pass: true,
      differences: [],
    });
  });

  test('a pinned field with a different value fails on that field', () => {
    const decisions: ExpectedDecisions = {
      calls: [{ tool: 'refund', args: { amount: 25 } }],
      notCalled: [],
    };
    const result = gradeExpectedDecisions(decisions, [call('refund', { amount: 80 })]);
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
    const decisions: ExpectedDecisions = {
      calls: [{ tool: 'refund', args: { amount: 25, currency: 'USD' } }],
      notCalled: [],
    };
    const result = gradeExpectedDecisions(decisions, [call('refund', { amount: 25 })]);
    expect(result.pass).toBe(false);
    expect(result.differences).toContainEqual({
      tool: 'refund',
      kind: 'missing-field',
      field: 'currency',
      expected: 'USD',
    });
  });

  test('a deep object field compares whole, by value, regardless of key order', () => {
    const decisions: ExpectedDecisions = {
      calls: [{ tool: 'ship', args: { to: { city: 'NYC', zip: '10001' } } }],
      notCalled: [],
    };
    expect(
      gradeExpectedDecisions(decisions, [call('ship', { to: { zip: '10001', city: 'NYC' } })]).pass,
    ).toBe(true);
    expect(
      gradeExpectedDecisions(decisions, [call('ship', { to: { zip: '10002', city: 'NYC' } })]).pass,
    ).toBe(false);
  });
});

describe('gradeExpectedDecisions — must not call', () => {
  test('a forbidden tool that was called fails, with the count', () => {
    const decisions: ExpectedDecisions = { calls: [], notCalled: ['refund'] };
    const result = gradeExpectedDecisions(decisions, [
      call('refund', { amount: 25 }),
      call('refund', { amount: 1 }),
    ]);
    expect(result.pass).toBe(false);
    expect(result.differences).toContainEqual({ tool: 'refund', kind: 'must-not-call', actual: 2 });
  });

  test('a forbidden tool called exactly once fails, with a count of one', () => {
    const result = gradeExpectedDecisions({ calls: [], notCalled: ['refund'] }, [
      call('refund', { amount: 25 }),
    ]);
    expect(result.pass).toBe(false);
    expect(result.differences).toContainEqual({ tool: 'refund', kind: 'must-not-call', actual: 1 });
  });

  test('a forbidden tool that was not called passes', () => {
    expect(
      gradeExpectedDecisions({ calls: [], notCalled: ['refund'] }, [call('lookup', { id: 'x' })]),
    ).toEqual({
      pass: true,
      differences: [],
    });
  });
});

describe('gradeExpectedDecisions — maximum matching, not greedy', () => {
  // The broad expected call is listed first. A greedy, order-dependent
  // pairing would take the call the narrow expected needs and then fail;
  // a maximum matching pairs them both.
  const decisions: ExpectedDecisions = {
    calls: [
      { tool: 'refund', args: { currency: 'USD' } },
      { tool: 'refund', args: { amount: 25 } },
    ],
    notCalled: [],
  };

  test('pairs both when a maximum matching exists', () => {
    const result = gradeExpectedDecisions(decisions, [
      call('refund', { amount: 25, currency: 'USD' }, 0),
      call('refund', { amount: 80, currency: 'USD' }, 1),
    ]);
    expect(result).toEqual({ pass: true, differences: [] });
  });

  test('the result does not depend on the order the actual calls are given', () => {
    const forwards = gradeExpectedDecisions(decisions, [
      call('refund', { amount: 25, currency: 'USD' }, 0),
      call('refund', { amount: 80, currency: 'USD' }, 1),
    ]);
    const backwards = gradeExpectedDecisions(decisions, [
      call('refund', { amount: 80, currency: 'USD' }, 1),
      call('refund', { amount: 25, currency: 'USD' }, 0),
    ]);
    expect(backwards).toEqual(forwards);
  });
});

describe('gradeExpectedDecisions — refused calls are named', () => {
  test('a refused call then a real retry counts both, and the count names the refused one', () => {
    const result = gradeExpectedDecisions(
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
    const result = gradeExpectedDecisions({ calls: [], notCalled: ['refund'] }, [
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
    const result = gradeExpectedDecisions(
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

describe('gradeExpectedDecisions — order is not compared', () => {
  test('two different tools in any order pass', () => {
    const decisions: ExpectedDecisions = {
      calls: [
        { tool: 'lookup', args: { id: 'x' } },
        { tool: 'refund', args: { amount: 25 } },
      ],
      notCalled: [],
    };
    expect(
      gradeExpectedDecisions(decisions, [
        call('refund', { amount: 25 }),
        call('lookup', { id: 'x' }),
      ]).pass,
    ).toBe(true);
  });
});

describe('gradeExpectedDecisions — reporting the nearest miss', () => {
  test('an unmatched expected call is blamed on the free actual with the fewest differing fields', () => {
    const decisions: ExpectedDecisions = {
      calls: [{ tool: 'refund', args: { amount: 25, currency: 'USD' } }],
      notCalled: [],
    };
    const result = gradeExpectedDecisions(decisions, [
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

describe('describeCallDifference', () => {
  test('the default words for each kind', () => {
    expect(describeCallDifference({ tool: 'refund', kind: 'count', expected: 1, actual: 2 })).toBe(
      'refund: expected 1 call, got 2',
    );
    expect(describeCallDifference({ tool: 'refund', kind: 'count', expected: 2, actual: 0 })).toBe(
      'refund: expected 2 calls, got 0',
    );
    expect(describeCallDifference({ tool: 'refund', kind: 'must-not-call', actual: 1 })).toBe(
      'refund: expected no calls, got 1',
    );
    expect(
      describeCallDifference({
        tool: 'refund',
        kind: 'missing-field',
        field: 'amount',
        expected: 25,
      }),
    ).toBe('refund amount: expected 25, got nothing');
    expect(
      describeCallDifference({
        tool: 'refund',
        kind: 'field-value',
        field: 'amount',
        expected: 25,
        actual: 80,
      }),
    ).toBe('refund amount: expected 25, got 80');
    expect(
      describeCallDifference({
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
      describeCallDifference({
        tool: 'refund',
        kind: 'field-value',
        field: 'amount',
        expected: 25,
        actual: '25',
      }),
    ).toBe('refund amount: expected 25, got "25"');
    expect(
      describeCallDifference({
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
      describeCallDifference({
        tool: 'refund',
        kind: 'count',
        expected: 1,
        actual: 2,
        refused: 1,
      }),
    ).toBe('refund: expected 1 call, got 2 (1 refused)');
    expect(
      describeCallDifference({
        tool: 'refund',
        kind: 'must-not-call',
        actual: 1,
        refused: 1,
      }),
    ).toBe('refund: expected no calls, got 1 (1 refused)');
    expect(
      describeCallDifference({
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
