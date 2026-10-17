// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Grading a correction: an expert's "these are the tool calls the agent
 * should have made, and these tools it should not have called" checked
 * against the calls a candidate version actually made on the replay. Pure,
 * with no dependencies, so the console and the CLI grade and preview a
 * correction the same way the gate does.
 *
 * How two sets of calls compare (all of it deterministic, no model):
 *   - Scope: only tools the correction names are compared; a candidate's
 *     calls to any other tool are ignored, so an extra lookup by a new
 *     version doesn't fail it.
 *   - Named calls, as a multiset: for each named tool the candidate's calls
 *     must match the expected calls one for one — the same number, and each
 *     expected call pairs with exactly one actual call that holds every
 *     expected argument field with an equal value. Pairing is a maximum
 *     bipartite matching, not greedy: greedy depends on the order the calls
 *     are given and so isn't deterministic.
 *   - A field is a top-level argument property; its value is compared whole,
 *     with the same canonical-JSON equality a judged item uses (`canonical`
 *     from `./judged-items.js`). Fields the correction leaves out are not
 *     compared. Order of the calls is not compared.
 *   - Must not call: a `notCalled` tool has zero calls.
 *
 * A {@link CorrectionDifference} can quote argument values (a person's
 * words), so the differences erase with the run; the pass/fail does not.
 * {@link describeCorrectionDifference} renders the default words — the only
 * place the wording lives, so a surface or the docs can change it in one
 * spot.
 */

import { canonical } from './judged-items.js';

/** One call an expert says the agent should have made. */
export interface ExpectedCall {
  readonly tool: string;
  /**
   * The partial set of top-level argument fields to compare, by value.
   * Fields the expert left out are not compared; an empty set asks only
   * that a call to the tool was made.
   */
  readonly args: Readonly<Record<string, unknown>>;
}

/** What an expert corrected about a run's decisions. */
export interface Correction {
  /** The calls that should have been made. */
  readonly calls: readonly ExpectedCall[];
  /** The tools that should not have been called at all. */
  readonly notCalled: readonly string[];
}

/**
 * A tool call a candidate version made on the replay. A refused decision
 * keeps its arguments in the trace, so it is a call here like any other.
 */
export interface CandidateCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** Its place in the replay trace; only ever used to break a tie. */
  readonly step?: number;
  readonly callId?: string;
  /**
   * The call was refused on the replay (a guardrail or a denied approval), so
   * it never ran. It still counts — the agent decided to make it — but the
   * differences name it, so a refused-then-retried call doesn't read as two
   * plain calls.
   */
  readonly refused?: boolean;
}

/**
 * One way a candidate's calls differ from a correction. It can quote
 * argument values, so it is part of what erases with the run.
 */
export type CorrectionDifference =
  | {
      readonly tool: string;
      readonly kind: 'count';
      readonly expected: number;
      readonly actual: number;
      /** How many of the actual calls were refused, when any were. */
      readonly refused?: number;
    }
  | {
      readonly tool: string;
      readonly kind: 'must-not-call';
      readonly actual: number;
      /** How many of the forbidden calls were refused, when any were. */
      readonly refused?: number;
    }
  | {
      readonly tool: string;
      readonly kind: 'missing-field';
      readonly field: string;
      readonly expected: unknown;
      /** Set when the call blamed for the miss was refused. */
      readonly refused?: true;
    }
  | {
      readonly tool: string;
      readonly kind: 'field-value';
      readonly field: string;
      readonly expected: unknown;
      readonly actual: unknown;
      /** Set when the call blamed for the miss was refused. */
      readonly refused?: true;
    };

export interface CorrectionResult {
  readonly pass: boolean;
  /** Every way the calls differed; empty when it passed. */
  readonly differences: readonly CorrectionDifference[];
}

/** Grade a candidate's calls against one correction. */
export function gradeCorrection(
  correction: Correction,
  calls: readonly CandidateCall[],
): CorrectionResult {
  const differences: CorrectionDifference[] = [];

  // Must-not-call: a named tool has zero calls.
  for (const tool of distinct(correction.notCalled)) {
    const made = calls.filter((c) => c.tool === tool);
    if (made.length > 0) {
      const refused = made.filter((c) => c.refused === true).length;
      differences.push({
        tool,
        kind: 'must-not-call',
        actual: made.length,
        ...(refused > 0 && { refused }),
      });
    }
  }

  // Expected calls, per named tool, as a multiset.
  for (const tool of distinct(correction.calls.map((c) => c.tool))) {
    const expected = correction.calls.filter((c) => c.tool === tool);
    const actual = ordered(calls.filter((c) => c.tool === tool));
    if (expected.length !== actual.length) {
      const refused = actual.filter((c) => c.refused === true).length;
      differences.push({
        tool,
        kind: 'count',
        expected: expected.length,
        actual: actual.length,
        ...(refused > 0 && { refused }),
      });
    }
    differences.push(...diffNamedTool(tool, expected, actual));
  }

  return { pass: differences.length === 0, differences };
}

/** The default wording for a difference — the one place it lives. */
export function describeCorrectionDifference(d: CorrectionDifference): string {
  switch (d.kind) {
    case 'count':
      return `${d.tool}: expected ${d.expected} call${d.expected === 1 ? '' : 's'}, got ${d.actual}${refusedCount(d.refused)}`;
    case 'must-not-call':
      return `${d.tool}: expected no calls, got ${d.actual}${refusedCount(d.refused)}`;
    case 'missing-field':
      return `${d.tool} ${d.field}: expected ${show(d.expected)}, got nothing${refusedMark(d.refused)}`;
    case 'field-value':
      return `${d.tool} ${d.field}: expected ${show(d.expected)}, got ${show(d.actual)}${refusedMark(d.refused)}`;
  }
}

/** " (N refused)" when some of the counted calls were refused, else "". */
function refusedCount(refused: number | undefined): string {
  return refused !== undefined && refused > 0 ? ` (${refused} refused)` : '';
}

/** " (refused)" when the blamed call was refused, else "". */
function refusedMark(refused: true | undefined): string {
  return refused === true ? ' (refused)' : '';
}

// -------------------- the matching, per named tool --------------------

function diffNamedTool(
  tool: string,
  expected: readonly ExpectedCall[],
  actual: readonly CandidateCall[],
): CorrectionDifference[] {
  const matchedActual = maximumMatching(expected, actual);
  // Which expected calls found a partner, and which actual calls are free.
  const expectedMatched = new Set(matchedActual.filter((j) => j !== undefined));
  const free: number[] = actual.map((_, j) => j).filter((j) => !expectedMatched.has(j));

  const differences: CorrectionDifference[] = [];
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i];
    if (e === undefined || matchedActual[i] !== undefined) continue;
    // Blame the free actual call that differs in the fewest fields, so the
    // expert reads the nearest miss; consume it so two unmatched expected
    // calls don't both blame the same actual.
    const pick = pickClosest(e, free, actual);
    if (pick !== undefined) free.splice(free.indexOf(pick), 1);
    differences.push(...fieldDifferences(tool, e, pick === undefined ? undefined : actual[pick]));
  }
  return differences;
}

/**
 * A maximum bipartite matching of expected calls to actual calls (an
 * expected call may pair with an actual call that holds all its fields),
 * by augmenting paths. `result[i]` is the actual index expected `i` took,
 * or `undefined`. Deterministic: expected in their given order, actual in
 * {@link ordered}'s order.
 */
function maximumMatching(
  expected: readonly ExpectedCall[],
  actual: readonly CandidateCall[],
): (number | undefined)[] {
  const eligible = expected.map((e) => actual.map((a) => matches(e, a)));
  const actualToExpected: (number | undefined)[] = actual.map(() => undefined);
  const expectedToActual: (number | undefined)[] = expected.map(() => undefined);
  for (let i = 0; i < expected.length; i++) {
    augment(
      i,
      eligible,
      actual.map(() => false),
      actualToExpected,
      expectedToActual,
    );
  }
  return expectedToActual;
}

function augment(
  i: number,
  eligible: readonly (readonly boolean[])[],
  seen: boolean[],
  actualToExpected: (number | undefined)[],
  expectedToActual: (number | undefined)[],
): boolean {
  const row = eligible[i] ?? [];
  for (let j = 0; j < seen.length; j++) {
    if (!row[j] || seen[j]) continue;
    seen[j] = true;
    const holder = actualToExpected[j];
    if (
      holder === undefined ||
      augment(holder, eligible, seen, actualToExpected, expectedToActual)
    ) {
      actualToExpected[j] = i;
      expectedToActual[i] = j;
      return true;
    }
  }
  return false;
}

/** Whether every field the expected call pins is present and equal in the actual call. */
function matches(e: ExpectedCall, a: CandidateCall): boolean {
  for (const [field, value] of Object.entries(e.args)) {
    if (!present(a.args, field) || canonical(a.args[field]) !== canonical(value)) return false;
  }
  return true;
}

/** The free actual call that differs from `e` in the fewest fields (tie → the earliest). */
function pickClosest(
  e: ExpectedCall,
  free: readonly number[],
  actual: readonly CandidateCall[],
): number | undefined {
  let best: number | undefined;
  let bestCount = Number.POSITIVE_INFINITY;
  for (const j of free) {
    const count = fieldDifferences('', e, actual[j]).length;
    if (count < bestCount) {
      best = j;
      bestCount = count;
    }
  }
  return best;
}

function fieldDifferences(
  tool: string,
  e: ExpectedCall,
  a: CandidateCall | undefined,
): CorrectionDifference[] {
  const refused = a?.refused === true ? { refused: true as const } : {};
  const differences: CorrectionDifference[] = [];
  for (const [field, value] of Object.entries(e.args)) {
    if (a === undefined || !present(a.args, field)) {
      differences.push({ tool, kind: 'missing-field', field, expected: value, ...refused });
    } else if (canonical(a.args[field]) !== canonical(value)) {
      differences.push({
        tool,
        kind: 'field-value',
        field,
        expected: value,
        actual: a.args[field],
        ...refused,
      });
    }
  }
  return differences;
}

function present(args: Readonly<Record<string, unknown>>, field: string): boolean {
  // `Object.hasOwn`, not `in`: a field named for a prototype member (say
  // `constructor`) isn't present just because the chain has one.
  return Object.hasOwn(args, field) && args[field] !== undefined;
}

/** Actual calls in a fixed order: by step, then callId, then their given order. */
function ordered(calls: readonly CandidateCall[]): CandidateCall[] {
  return calls
    .map((call, index) => ({ call, index }))
    .sort(
      (a, b) =>
        (a.call.step ?? Number.POSITIVE_INFINITY) - (b.call.step ?? Number.POSITIVE_INFINITY) ||
        // A plain codepoint compare, not `localeCompare`: the order mustn't
        // depend on the host's locale.
        compareStrings(a.call.callId ?? '', b.call.callId ?? '') ||
        a.index - b.index,
    )
    .map((x) => x.call);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function show(value: unknown): string {
  // Render every value as JSON, so a string reads quoted and can't be
  // mistaken for the number, boolean or null it stringifies to (`'25'` vs
  // `25`, `'null'` vs `null`).
  return JSON.stringify(value) ?? 'null';
}
