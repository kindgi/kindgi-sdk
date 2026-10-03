// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { GuardrailId } from '@kindgi/types';

/**
 * Errors emitted by @kindgi/guardrails. Every variant carries a `code`
 * for pattern matching; messages are human-readable, not API contract.
 */
export type GuardrailError =
  | InvalidGuardrailError
  | InvalidCheckDefinitionError
  | UnknownCheckError
  | InvalidCheckConfigError
  | JudgeMissingError
  | JudgeRoutingError
  | ScopeMismatchError
  | UnknownActionError;

/**
 * The judge model couldn't be routed via `@kindgi/capabilities`. Wraps
 * the underlying capability error (usually `capability-unsatisfiable` —
 * no registered provider matches the judge's declared capability).
 */
export interface JudgeRoutingError {
  readonly code: 'judge-routing-failed';
  readonly message: string;
  readonly guardrailId: GuardrailId;
  readonly cause: unknown;
}

/**
 * The declaration is invalid. From `defineGuardrail` /
 * `validateGuardrailSpec`: it fails the schema, or (`defineGuardrail`)
 * its registered check has another kind. From the engine: its kind has
 * no registered strategy, it is `llm-judge` without `judgeCapabilities`,
 * or it is `external` and only the built-in `external` strategy is
 * registered.
 */
export interface InvalidGuardrailError {
  readonly code: 'invalid-guardrail';
  readonly message: string;
  readonly issues: readonly { readonly path: string; readonly message: string }[];
}

/** The guardrail references a check id that isn't registered. */
export interface UnknownCheckError {
  readonly code: 'unknown-check';
  readonly message: string;
  readonly guardrailId: GuardrailId;
  readonly checkId: string;
}

/**
 * The guardrail fired an action that no handler in
 * `EvaluationBindings.actions` handles. `on-violation` is an open
 * string, so an unknown name is accepted at define time and surfaces
 * here, when the guardrail fires. The violation itself was already
 * recorded (and compliance evidence emitted) before the lookup.
 */
export interface UnknownActionError {
  readonly code: 'unknown-action';
  readonly message: string;
  readonly guardrailId: GuardrailId;
  readonly action: string;
}

/** The guardrail's `config` failed the check's own validator. */
export interface InvalidCheckConfigError {
  readonly code: 'invalid-check-config';
  readonly message: string;
  readonly guardrailId: GuardrailId;
  readonly reason: string;
}

/**
 * `defineCheck` couldn't build the check — either the supplied Zod
 * schema failed to convert via `z.toJSONSchema()`, or the resulting
 * JSON Schema failed to compile as Draft 2020-12.
 */
export interface InvalidCheckDefinitionError {
  readonly code: 'invalid-check-definition';
  readonly message: string;
  readonly checkId: string;
  readonly cause: unknown;
}

/**
 * An `llm-judge` guardrail was evaluated without the required bindings
 * (providerRegistry or judgeProvider). Runtime-only error.
 */
export interface JudgeMissingError {
  readonly code: 'judge-missing';
  readonly message: string;
  readonly guardrailId: GuardrailId;
}

/**
 * Not really an error — surfaced so callers can distinguish "guardrail
 * didn't apply to this trace" from "guardrail applied and passed."
 */
export interface ScopeMismatchError {
  readonly code: 'scope-mismatch';
  readonly message: string;
  readonly guardrailId: GuardrailId;
  readonly reason: 'wrong-mode' | 'wrong-agent' | 'wrong-flow' | 'wrong-tenant';
}
