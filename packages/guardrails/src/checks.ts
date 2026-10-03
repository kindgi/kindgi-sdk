// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { CheckFunction, CheckRegistry, RegisteredCheck } from './types.js';

/**
 * Built-in check library. Every entry is `kind: 'zero-llm'` — pure
 * functions over the run trace, no external calls, deterministic. See
 * `judge.ts` for LLM-judge evaluation.
 *
 * Adding a new built-in check: implement the function, add it to
 * `BUILT_IN_CHECKS`, document its `config` schema in the JSDoc block.
 */

/**
 * `must-cite`: assistant output must include at least N matches of the
 * citation pattern. Config:
 *   `{ minCitations?: number /* default 1 *\/, sourcePattern?: string /* regex *\/ }`
 *
 * Default `sourcePattern` matches `[<name>]`-style citations; override for
 * verticals with different citation conventions.
 */
const mustCite: CheckFunction = async (config, trace) => {
  const minCitations = typeof config.minCitations === 'number' ? config.minCitations : 1;
  const sourcePattern =
    typeof config.sourcePattern === 'string' ? config.sourcePattern : '\\[[^\\]]+\\]';
  if (trace.output === undefined || trace.output.length === 0) {
    return { passed: false, reason: 'output empty; nothing to cite' };
  }
  const re = new RegExp(sourcePattern, 'g');
  const matches = trace.output.match(re) ?? [];
  if (matches.length >= minCitations) {
    return { passed: true, attributes: { citationCount: matches.length } };
  }
  return {
    passed: false,
    reason: `expected >= ${minCitations} citations, found ${matches.length}`,
    attributes: { citationCount: matches.length },
  };
};

/**
 * `never-call-tool`: fail if any of the listed tools were invoked.
 * Config: `{ tools: string[] }` — tool ids or names to forbid.
 */
const neverCallTool: CheckFunction = async (config, trace) => {
  // Accept both tool id / name strings and ToolRef objects
  // ({ id, version }) — pack config authors may use either.
  const rawTools = Array.isArray(config.tools) ? (config.tools as unknown[]) : [];
  const forbidden = new Set<string>();
  for (const entry of rawTools) {
    if (typeof entry === 'string') {
      forbidden.add(entry);
    } else if (
      entry !== null &&
      typeof entry === 'object' &&
      'id' in entry &&
      typeof (entry as { id: unknown }).id === 'string'
    ) {
      forbidden.add((entry as { id: string }).id);
    }
  }
  const violations: string[] = [];
  for (const call of trace.toolCalls) {
    if (forbidden.has(call.toolId) || forbidden.has(call.toolName)) {
      violations.push(call.toolName);
    }
  }
  if (violations.length === 0) return { passed: true };
  return {
    passed: false,
    reason: `forbidden tool(s) invoked: ${[...new Set(violations)].join(', ')}`,
    attributes: { violatingTools: [...new Set(violations)] },
  };
};

/**
 * `max-tool-calls`: cap total tool invocations. Config: `{ max?: number }` (default 10).
 * Guards against runaway agents.
 */
const maxToolCalls: CheckFunction = async (config, trace) => {
  const max = typeof config.max === 'number' ? config.max : 10;
  if (trace.toolCalls.length <= max) {
    return { passed: true, attributes: { toolCallCount: trace.toolCalls.length } };
  }
  return {
    passed: false,
    reason: `expected <= ${max} tool calls, saw ${trace.toolCalls.length}`,
    attributes: { toolCallCount: trace.toolCalls.length },
  };
};

/**
 * `output-matches`: final assistant output must match a regex (or fail
 * if `negate: true`). Config: `{ pattern: string, flags?: string, negate?: boolean }`.
 */
const outputMatches: CheckFunction = async (config, trace) => {
  const pattern = typeof config.pattern === 'string' ? config.pattern : '';
  const flags = typeof config.flags === 'string' ? config.flags : '';
  const negate = config.negate === true;
  if (pattern.length === 0) {
    return { passed: false, reason: 'pattern config is required' };
  }
  const re = new RegExp(pattern, flags);
  const output = trace.output ?? '';
  const matched = re.test(output);
  const passed = negate ? !matched : matched;
  return passed
    ? { passed: true }
    : {
        passed: false,
        reason: negate
          ? `output matched forbidden pattern /${pattern}/`
          : `output did not match /${pattern}/`,
      };
};

/**
 * `tool-order`: tool calls must appear in a specified order. Config:
 *   `{ sequence: string[] }` — tool names in expected order (subsequence).
 * Non-listed tools are allowed to appear anywhere; the sequence must exist
 * as a subsequence of the actual call order.
 */
const toolOrder: CheckFunction = async (config, trace) => {
  const sequence = Array.isArray(config.sequence) ? (config.sequence as string[]) : [];
  if (sequence.length === 0) return { passed: true };
  let seqIndex = 0;
  for (const call of trace.toolCalls) {
    if (call.toolName === sequence[seqIndex]) seqIndex += 1;
    if (seqIndex === sequence.length) return { passed: true };
  }
  return {
    passed: false,
    reason: `expected tool-call subsequence [${sequence.join(', ')}] not observed`,
    attributes: { matchedPrefix: sequence.slice(0, seqIndex) },
  };
};

/**
 * `required-substring`: `trace.output` must contain EVERY listed pattern.
 * Config: `{ patterns: string[], caseSensitive?: boolean }`.
 *
 * Mirror of `forbidden-substring` — enables "output must include the
 * standard legal disclaimer / required attribution / policy footer"
 * without needing an llm-judge.
 *
 * Empty `patterns` array passes vacuously. Missing `output` on the
 * trace fails (nothing can contain the required text).
 */
const requiredSubstring: CheckFunction = async (config, trace) => {
  const patternsRaw = Array.isArray(config.patterns) ? (config.patterns as unknown[]) : [];
  const patterns = patternsRaw.filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (patterns.length === 0) return { passed: true };
  if (trace.output === undefined || trace.output.length === 0) {
    return {
      passed: false,
      reason: `output empty; ${patterns.length} required pattern(s) not satisfied`,
      attributes: { missing: patterns },
    };
  }
  const caseSensitive = config.caseSensitive === true;
  const haystack = caseSensitive ? trace.output : trace.output.toLowerCase();
  const missing: string[] = [];
  for (const p of patterns) {
    const needle = caseSensitive ? p : p.toLowerCase();
    if (!haystack.includes(needle)) missing.push(p);
  }
  if (missing.length === 0) return { passed: true };
  return {
    passed: false,
    reason: `output missing required pattern(s): ${missing.join(', ')}`,
    attributes: { missing },
  };
};

/**
 * `forbidden-substring`: `trace.output` must NOT contain any listed pattern.
 * Config: `{ patterns: string[], caseSensitive?: boolean }`.
 *
 * Symmetric to `required-substring`. Enables "output must not contain
 * PII markers / off-limits phrases / policy trigger words" without an
 * llm-judge.
 */
const forbiddenSubstring: CheckFunction = async (config, trace) => {
  const patternsRaw = Array.isArray(config.patterns) ? (config.patterns as unknown[]) : [];
  const patterns = patternsRaw.filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (patterns.length === 0) return { passed: true };
  if (trace.output === undefined || trace.output.length === 0) return { passed: true };
  const caseSensitive = config.caseSensitive === true;
  const haystack = caseSensitive ? trace.output : trace.output.toLowerCase();
  const violated: string[] = [];
  for (const p of patterns) {
    const needle = caseSensitive ? p : p.toLowerCase();
    if (haystack.includes(needle)) violated.push(p);
  }
  if (violated.length === 0) return { passed: true };
  return {
    passed: false,
    reason: `output contains forbidden pattern(s): ${violated.join(', ')}`,
    attributes: { violated },
  };
};

const BUILT_IN_CHECKS: readonly RegisteredCheck[] = [
  { id: 'must-cite', kind: 'zero-llm', evaluate: mustCite },
  { id: 'never-call-tool', kind: 'zero-llm', evaluate: neverCallTool },
  { id: 'max-tool-calls', kind: 'zero-llm', evaluate: maxToolCalls },
  { id: 'output-matches', kind: 'zero-llm', evaluate: outputMatches },
  { id: 'tool-order', kind: 'zero-llm', evaluate: toolOrder },
  { id: 'required-substring', kind: 'zero-llm', evaluate: requiredSubstring },
  { id: 'forbidden-substring', kind: 'zero-llm', evaluate: forbiddenSubstring },
];

/**
 * Create a fresh CheckRegistry pre-populated with built-in checks.
 * Consumers register custom checks at pack init.
 */
export function createCheckRegistry(seed: readonly RegisteredCheck[] = []): CheckRegistry {
  const checks = new Map<string, RegisteredCheck>();
  for (const c of BUILT_IN_CHECKS) checks.set(c.id, c);
  for (const c of seed) checks.set(c.id, c);
  return {
    register(check): void {
      checks.set(check.id, check);
    },
    get(id): RegisteredCheck | undefined {
      return checks.get(id);
    },
    list(): readonly RegisteredCheck[] {
      return [...checks.values()];
    },
  };
}

/** Exported for tests + downstream introspection. */
export const BUILT_IN_CHECK_IDS = BUILT_IN_CHECKS.map((c) => c.id);
