// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { NodeId } from '@kindgi/types';

import type { Expr, LiteralOperand, Mapping, Operand } from './types.js';

/**
 * The evaluation environment. Passed by the kernel at edge dispatch time —
 * one instance per edge evaluation — and when resolving a `Mapping`.
 * Consumers should treat every branch as read-only.
 *
 * Every root is optional at construction; a missing root resolves any
 * dependent path to MISSING (`MISSING_PATH`), which composes cleanly with
 * `exists` and `notExists` predicates.
 */
export interface EvalEnv {
  readonly runInput?: unknown;
  readonly state?: unknown;
  /**
   * Outputs of previously-completed nodes, keyed by NodeId. Only nodes whose
   * `step.completed` entry exists in the journal appear here — a fan-in edge
   * whose predicate references a not-yet-completed sibling resolves that
   * path to MISSING.
   */
  readonly nodeOutputs?: ReadonlyMap<NodeId, unknown>;
  /**
   * Only populated when evaluating a loop node's `exitCondition`. `undefined`
   * outside that context; predicates referencing this root then resolve to
   * MISSING (composes cleanly with `exists` / `notExists`).
   */
  readonly iterationIndex?: number;
  /**
   * Only populated when evaluating a loop node's `exitCondition`. Holds
   * the just-completed iteration's `$loop-end` output (or the previous
   * iteration's output for while+before at iteration i>0; null for
   * while+before iteration 0).
   */
  readonly iterationOutput?: unknown;
}

/** Distinguishing "resolved to `undefined`" from "path does not exist". */
const MISSING = Symbol('flow.evaluator.missing');
type Resolved = unknown | typeof MISSING;

/**
 * Evaluate a predicate expression against an environment.
 *
 * Semantics summary:
 *   - Comparisons on missing operands (path resolves to MISSING) → false.
 *   - `exists` on MISSING → false; on `undefined` value at a real path → true.
 *   - `truthy` / `falsy` use the JS truthiness rules on the resolved value;
 *     MISSING is treated as falsy.
 *   - `in` / `notIn` require `set` to be an array; a non-array `set` → false.
 *   - `and` / `or` are short-circuiting; empty children are rejected at load time.
 *
 * The evaluator is intentionally total — it never throws for a well-formed
 * expression, so kernel edge evaluation cannot fail due to predicate execution.
 */
export function evaluateExpr(expr: Expr, env: EvalEnv): boolean {
  switch (expr.op) {
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return compare(expr.op, resolveOperand(expr.left, env), resolveOperand(expr.right, env));
    case 'in':
    case 'notIn':
      return evalMembership(expr.op, expr, env);
    case 'exists':
      return resolveOperand(expr.value, env) !== MISSING;
    case 'notExists':
      return resolveOperand(expr.value, env) === MISSING;
    case 'truthy':
      return evalTruthy(resolveOperand(expr.value, env));
    case 'falsy':
      return evalFalsy(resolveOperand(expr.value, env));
    case 'and':
      return expr.children.every((c) => evaluateExpr(c, env));
    case 'or':
      return expr.children.some((c) => evaluateExpr(c, env));
    case 'not':
      return !evaluateExpr(expr.child, env);
  }
}

/**
 * Resolve a `Mapping` against an environment: literals as given, paths
 * via `resolvePath`. A path that doesn't resolve omits its key — the
 * result never carries a mapped key whose value is missing. Total, like
 * `evaluateExpr`: it never throws for a well-formed mapping.
 */
export function resolveMapping(mapping: Mapping, env: EvalEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, operand] of Object.entries(mapping)) {
    const value = resolveOperand(operand, env);
    if (value !== MISSING) out[key] = value;
  }
  return out;
}

function evalMembership(
  op: 'in' | 'notIn',
  expr: { readonly value: Operand; readonly set: Operand },
  env: EvalEnv,
): boolean {
  const value = resolveOperand(expr.value, env);
  const set = resolveOperand(expr.set, env);
  if (value === MISSING || set === MISSING) return false;
  if (!Array.isArray(set)) return false;
  const found = set.some((item) => deepEqual(item, value));
  return op === 'in' ? found : !found;
}

function evalTruthy(v: Resolved): boolean {
  if (v === MISSING) return false;
  return Boolean(v);
}

function evalFalsy(v: Resolved): boolean {
  if (v === MISSING) return true;
  return !v;
}

function compare(
  op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte',
  left: Resolved,
  right: Resolved,
): boolean {
  if (op === 'eq' || op === 'ne') return compareEquality(op, left, right);
  return compareOrdering(op, left, right);
}

function compareEquality(op: 'eq' | 'ne', left: Resolved, right: Resolved): boolean {
  if (left === MISSING || right === MISSING) return op === 'ne' ? left !== right : false;
  const equal = deepEqual(left, right);
  return op === 'eq' ? equal : !equal;
}

function compareOrdering(
  op: 'lt' | 'lte' | 'gt' | 'gte',
  left: Resolved,
  right: Resolved,
): boolean {
  if (left === MISSING || right === MISSING) return false;
  if (typeof left !== typeof right) return false;
  if (typeof left !== 'number' && typeof left !== 'string') return false;
  const l = left as number | string;
  const r = right as number | string;
  switch (op) {
    case 'lt':
      return l < r;
    case 'lte':
      return l <= r;
    case 'gt':
      return l > r;
    case 'gte':
      return l >= r;
  }
}

function resolveOperand(operand: Operand, env: EvalEnv): Resolved {
  if (isLiteral(operand)) return operand.literal;
  return resolvePath(operand.path, env);
}

function isLiteral(operand: Operand): operand is LiteralOperand {
  return 'literal' in operand;
}

// Exported for tests and diagnostics; keep small and predictable.
export function resolvePath(path: string, env: EvalEnv): Resolved {
  const segments = path.split('.');
  const [root, ...rest] = segments;
  if (root === undefined) return MISSING;

  if (root === 'runInput') {
    return walk(env.runInput, rest);
  }
  if (root === 'state') {
    return walk(env.state, rest);
  }
  if (root === 'nodeOutputs') {
    const [nodeId, ...tail] = rest;
    if (nodeId === undefined || nodeId === '') return MISSING;
    if (env.nodeOutputs === undefined) return MISSING;
    if (!env.nodeOutputs.has(nodeId as NodeId)) return MISSING;
    return walk(env.nodeOutputs.get(nodeId as NodeId), tail);
  }
  if (root === 'iterationIndex') {
    if (env.iterationIndex === undefined) return MISSING;
    if (rest.length > 0) return MISSING;
    return env.iterationIndex;
  }
  if (root === 'iterationOutput') {
    if (env.iterationOutput === undefined) return MISSING;
    return walk(env.iterationOutput, rest);
  }
  return MISSING;
}

function walk(base: unknown, segments: readonly string[]): Resolved {
  let current: unknown = base;
  if (segments.length === 0) return current === undefined ? MISSING : current;
  for (const seg of segments) {
    if (current === null || current === undefined) return MISSING;
    if (typeof current !== 'object') return MISSING;
    const asRecord = current as Readonly<Record<string, unknown>>;
    if (!(seg in asRecord)) return MISSING;
    current = asRecord[seg];
  }
  return current === undefined ? MISSING : current;
}

/** Structural JSON equality. Handles primitives, arrays, and plain objects. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) return arrayEqual(a, b);
  return objectEqual(a as object, b as object);
}

function arrayEqual(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!deepEqual(a[i], b[i])) return false;
  }
  return true;
}

function objectEqual(a: object, b: object): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return false;
  const aRec = a as Readonly<Record<string, unknown>>;
  const bRec = b as Readonly<Record<string, unknown>>;
  for (const k of ka) {
    if (!deepEqual(aRec[k as string], bRec[k as string])) return false;
  }
  return true;
}

/**
 * Distinguishes "path resolved but value was undefined" from "path did not
 * exist at all". Exported so tests and downstream diagnostics can identify
 * the missing marker without depending on a private symbol.
 */
export const MISSING_PATH: typeof MISSING = MISSING;
