// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import {
  type CompiledTenantPattern,
  type TenantInputBounds,
  compileTenantPattern,
  tenantInputBounds,
} from '@kindgi/bounds';

import { type GuardrailConfigProblem, guardrailConfigProblems } from './config-problems.js';
import type { CheckFunction, CheckRegistry, RegisteredCheck } from './types.js';

/**
 * Built-in check library. Every entry is `kind: 'zero-llm'` — pure
 * functions over the run trace, no external calls, deterministic. See
 * `judge.ts` for LLM-judge evaluation.
 *
 * Adding a new built-in check: implement the function, add it to
 * `BUILT_IN_CHECKS` with its config's JSON Schema (which also refuses a
 * config it doesn't know: a misspelt setting is never silently ignored),
 * and document it in the JSDoc block.
 */

/**
 * `must-cite`: assistant output must include at least N matches of the
 * citation pattern. Config:
 *   `{ minCitations?: number /* default 1 *\/, sourcePattern?: string /* regex *\/ }`
 *
 * Default `sourcePattern` matches `[<name>]`-style citations; override for
 * verticals with different citation conventions.
 *
 * Counting stops once it has found `minCitations`, so a pass reports that
 * many as `citationCount` (a fail, every one it found): a long output costs
 * no more than the check needs. The bounds cap `minCitations`
 * (`mustCiteMaxCitations`): over it, registration refuses the config and
 * evaluation throws.
 */
const mustCite: CheckFunction = async (config, trace) => {
  const minCitations = typeof config.minCitations === 'number' ? config.minCitations : 1;
  const tooMany = tooManyCitations(minCitations);
  if (tooMany !== undefined) throw new Error(tooMany);
  const sourcePattern =
    typeof config.sourcePattern === 'string' ? config.sourcePattern : '\\[[^\\]]+\\]';
  if (trace.output === undefined || trace.output.length === 0) {
    return { passed: false, reason: 'output empty; nothing to cite' };
  }
  const found = patternOf(config, 'sourcePattern', sourcePattern, '').count(
    trace.output,
    minCitations,
  );
  if (found >= minCitations) {
    return { passed: true, attributes: { citationCount: found } };
  }
  return {
    passed: false,
    reason: `expected >= ${minCitations} citations, found ${found}`,
    attributes: { citationCount: found },
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
  const output = trace.output ?? '';
  const matched = patternOf(config, 'pattern', pattern, flags).test(output);
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

const nonEmptyStrings = {
  type: 'array',
  minItems: 1,
  items: { type: 'string', minLength: 1 },
} as const;
const object = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Readonly<Record<string, unknown>> => ({
  type: 'object',
  properties,
  ...(required.length > 0 && { required }),
  additionalProperties: false,
});

/**
 * A config's pattern, compiled once (by `@kindgi/bounds`, under the
 * process's bounds) for registration and every evaluation after it; again
 * only if the setting or the bounds change. Held by the config object, so
 * it goes when the config does.
 */
const compiledPatterns = new WeakMap<
  object,
  {
    readonly bounds: TenantInputBounds;
    readonly source: string;
    readonly flags: string;
    readonly compiled: CompiledTenantPattern;
  }
>();

function compiledPattern(config: object, source: string, flags: string): CompiledTenantPattern {
  const bounds = tenantInputBounds();
  const kept = compiledPatterns.get(config);
  if (
    kept !== undefined &&
    kept.bounds === bounds &&
    kept.source === source &&
    kept.flags === flags
  ) {
    return kept.compiled;
  }
  const compiled = compileTenantPattern(source, flags);
  compiledPatterns.set(config, { bounds, source, flags, compiled });
  return compiled;
}

const notAPattern = (key: string, reason: string) =>
  `config.${key} isn't a regular expression that compiles: ${reason}.`;

/** A pattern evaluation runs: refused, it throws (a config the check refuses is never a pass). */
function patternOf(config: object, key: string, source: string, flags: string) {
  const compiled = compiledPattern(config, source, flags);
  if (compiled.kind === 'refused') throw new Error(notAPattern(key, compiled.reason));
  return compiled.pattern;
}

/** Why `must-cite`'s `minCitations` is over the bounds' cap, if it is. */
function tooManyCitations(minCitations: unknown): string | undefined {
  const max = tenantInputBounds().mustCiteMaxCitations;
  return typeof minCitations === 'number' && minCitations > max
    ? `config.minCitations is ${minCitations}, over the limit of ${max}.`
    : undefined;
}

/** Each built-in's config, as JSON Schema: what registration and evaluation check it against. */
const CONFIG_SCHEMAS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'must-cite': object({
    minCitations: { type: 'integer', minimum: 1 },
    sourcePattern: { type: 'string', minLength: 1 },
  }),
  'never-call-tool': object(
    {
      tools: {
        type: 'array',
        minItems: 1,
        items: {
          anyOf: [
            { type: 'string', minLength: 1 },
            {
              type: 'object',
              properties: { id: { type: 'string', minLength: 1 }, version: { type: 'string' } },
              required: ['id'],
            },
          ],
        },
      },
    },
    ['tools'],
  ),
  'max-tool-calls': object({ max: { type: 'integer', minimum: 0 } }),
  'output-matches': object(
    {
      pattern: { type: 'string', minLength: 1 },
      flags: { type: 'string', pattern: '^[dgimsuyv]*$' },
      negate: { type: 'boolean' },
    },
    ['pattern'],
  ),
  'tool-order': object({ sequence: nonEmptyStrings }, ['sequence']),
  'required-substring': object({ patterns: nonEmptyStrings, caseSensitive: { type: 'boolean' } }, [
    'patterns',
  ]),
  'forbidden-substring': object({ patterns: nonEmptyStrings, caseSensitive: { type: 'boolean' } }, [
    'patterns',
  ]),
};

/** The settings that are regular expressions, by check: each must compile. */
const REGEX_SETTINGS: Readonly<Record<string, readonly [pattern: string, flags?: string]>> = {
  'must-cite': ['sourcePattern'],
  'output-matches': ['pattern', 'flags'],
};

/**
 * Every way `config` doesn't fit built-in `id`: its schema's problems; or,
 * once it fits, a setting over the bounds' cap and a regex that won't compile.
 */
function builtInConfigProblems(id: string, config: unknown): readonly GuardrailConfigProblem[] {
  const schema = CONFIG_SCHEMAS[id] as Readonly<Record<string, unknown>>;
  const problems = guardrailConfigProblems({ configSchema: schema, config });
  if (problems.length > 0) return problems;
  const settings = (config ?? {}) as Record<string, unknown>;
  const tooMany = id === 'must-cite' ? tooManyCitations(settings.minCitations) : undefined;
  return [
    ...(tooMany !== undefined ? [{ path: '/config/minCitations', message: tooMany }] : []),
    ...regexProblems(id, settings),
  ];
}

/** A regex setting of built-in `id`'s that won't compile, if there is one. */
function regexProblems(
  id: string,
  settings: Readonly<Record<string, unknown>>,
): readonly GuardrailConfigProblem[] {
  const regex = REGEX_SETTINGS[id];
  if (regex === undefined) return [];
  const [patternKey, flagsKey] = regex;
  const pattern = settings[patternKey];
  if (typeof pattern !== 'string') return [];
  const flags = flagsKey !== undefined ? settings[flagsKey] : undefined;
  const compiled = compiledPattern(settings, pattern, typeof flags === 'string' ? flags : '');
  return compiled.kind === 'ok'
    ? []
    : [{ path: `/config/${patternKey}`, message: notAPattern(patternKey, compiled.reason) }];
}

function builtIn(id: string, evaluate: CheckFunction): RegisteredCheck {
  const configProblems = (config: unknown) => builtInConfigProblems(id, config);
  return {
    id,
    kind: 'zero-llm',
    evaluate,
    configSchema: CONFIG_SCHEMAS[id] as Readonly<Record<string, unknown>>,
    configProblems,
    validateConfig: (config) => configProblems(config)[0]?.message,
  };
}

const BUILT_IN_CHECKS: readonly RegisteredCheck[] = [
  builtIn('must-cite', mustCite),
  builtIn('never-call-tool', neverCallTool),
  builtIn('max-tool-calls', maxToolCalls),
  builtIn('output-matches', outputMatches),
  builtIn('tool-order', toolOrder),
  builtIn('required-substring', requiredSubstring),
  builtIn('forbidden-substring', forbiddenSubstring),
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
