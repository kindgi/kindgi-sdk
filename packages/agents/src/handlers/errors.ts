// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { EvaluationResult } from '@kindgi/guardrails';
import type { PolicyKind } from '@kindgi/policy-contract';

import type { AgentError } from '../errors.js';
import type {
  GuardrailViolationError,
  HitlRequiredError,
  UnresolvedGuardrailError,
} from '../guardrails-gate.js';

/** Structured error returned to the caller when an agent turn fails. */
export type InvokeAgentError =
  | AgentError
  | UnresolvedToolError
  | ToolVersionUnresolvableError
  | CapabilityRoutingError
  | ModelInvocationError
  | ToolInvocationError
  | BudgetExceededError
  | AgentTurnAbortedError
  | HitlRequiredError
  | GuardrailViolationError
  | UnresolvedGuardrailError
  | OutputSchemaViolationError
  | TenantPolicyUnavailableError
  | RunSnapshotError;

/**
 * A turn being resumed can't be rebuilt from its snapshot:
 * `run-snapshot-missing`, there is none (its write failed), so it can't
 * be resumed; `run-snapshot-unreadable`, reading it failed (a passing
 * storage error), so resuming again may work.
 */
export interface RunSnapshotError {
  readonly code: 'run-snapshot-missing' | 'run-snapshot-unreadable';
  readonly message: string;
}

/**
 * A tenant policy the turn must apply couldn't be: its spec doesn't
 * validate, or the policy registry failed. The turn doesn't run without
 * it — skipping a tenant's `hitl` policy would skip its approvals.
 */
export interface TenantPolicyUnavailableError {
  readonly code: 'tenant-policy-unavailable';
  readonly message: string;
  readonly policyKind: PolicyKind;
}

export interface UnresolvedToolError {
  readonly code: 'unresolved-tool';
  readonly message: string;
  readonly toolId: string;
  /**
   * Failed tool calls sent back to the model this turn before this one
   * ended it (see `Agent.toolErrors`). Present when the failure is a
   * kind the turn retries and its retries ran out.
   */
  readonly toolRetries?: number;
}

/**
 * The agent references a tool that is registered but whose semver range
 * does not match any registered version, or whose range is grammatically
 * broken. Distinct from `unresolved-tool` (no id registered).
 */
export interface ToolVersionUnresolvableError {
  readonly code: 'tool-version-unresolvable';
  readonly message: string;
  readonly toolId: string;
  readonly requestedRange: string;
  readonly availableVersions?: readonly string[];
}

export interface CapabilityRoutingError {
  readonly code: 'capability-routing-failed';
  readonly message: string;
  readonly cause: unknown;
}

export interface ModelInvocationError {
  readonly code: 'model-invocation-failed';
  readonly message: string;
  readonly cause: unknown;
}

export interface ToolInvocationError {
  readonly code: 'tool-invocation-failed';
  readonly message: string;
  readonly toolId: string;
  readonly cause: unknown;
  /**
   * When the inner failure was an AJV input-schema validation, the
   * validator's `errors[]` array. Hoisted from `cause` to the top
   * level so it survives `toWireError` (which filters `cause` to
   * avoid Error-instance / cycle serialization hazards). Consumers
   * inspecting *which* field failed *how* read this; `fromWire` in
   * `@kindgi/client` projects it back onto the client-side error.
   */
  readonly validationIssues?: readonly Readonly<Record<string, unknown>>[];
  /**
   * The exact payload the model produced that failed validation.
   * Included so authors debugging LLM-tool-arg drift can see whether
   * the model sent `{}`, `{ location: "" }`, `{ city: "…" }`
   * (wrong field name), etc. without instrumenting their handler.
   * Size-capped at ~4KiB stringified — larger payloads truncate
   * with a trailing `…`; sensitive tools should sanitize inputs
   * upstream.
   */
  readonly receivedInput?: unknown;
  /**
   * Failed tool calls sent back to the model this turn before this one
   * ended it (see `Agent.toolErrors`). Present when the failure is a
   * kind the turn retries and its retries ran out.
   */
  readonly toolRetries?: number;
}

export interface BudgetExceededError {
  readonly code: 'budget-exceeded';
  readonly message: string;
  readonly kind: 'steps' | 'cost' | 'wall-time';
  readonly limit: number;
  readonly observed: number;
}

/**
 * The agent declares an `output` schema and its final answer still
 * didn't fit after the allowed repairs. `errors` lists the last
 * attempt's problems; `attempts` counts the answers checked.
 */
export interface OutputSchemaViolationError {
  readonly code: 'output-schema-violation';
  readonly message: string;
  readonly errors: readonly string[];
  readonly attempts: number;
}

export interface AgentTurnAbortedError {
  readonly code: 'agent-turn-aborted';
  readonly message: string;
  readonly reason: 'external' | 'timeout';
}

/**
 * Thrown by a node handler when a precondition fails or a runtime step
 * short-circuits with a structured error. The kernel captures
 * `Error.message` into `step.failed.payload.message`; we serialize the
 * full structured error as JSON so `projectRunResult` can recover the
 * discriminated union shape on the way out.
 *
 * Deliberately narrowed to `Error` subclass so `cause` becomes a plain
 * property (JSON-round-trippable) instead of the native ErrorOptions
 * behavior.
 */
export class AgentTurnFailure extends Error {
  readonly payload: InvokeAgentError;
  constructor(payload: InvokeAgentError) {
    super(serializeError(payload));
    this.name = 'AgentTurnFailure';
    this.payload = payload;
  }
}

const FAILURE_SENTINEL = '__agent_turn_failure__' as const;

interface SerializedFailure {
  readonly [FAILURE_SENTINEL]: true;
  readonly error: InvokeAgentError;
}

/**
 * Encode an `InvokeAgentError` as a JSON string carried in an Error's
 * message. The sentinel field lets `parseFailureMessage` distinguish
 * our structured failures from other error messages that happen to be
 * JSON-shaped.
 *
 * `cause` fields on inner errors are downgraded to their message form
 * so the payload is JSON-safe.
 */
function serializeError(error: InvokeAgentError): string {
  return JSON.stringify(
    {
      [FAILURE_SENTINEL]: true as const,
      error: stripCauseFunctions(error),
    } satisfies SerializedFailure,
    (_key, value) => {
      if (value instanceof Error) {
        return { code: (value as { code?: string }).code, message: value.message };
      }
      return value;
    },
  );
}

function stripCauseFunctions(error: InvokeAgentError): InvokeAgentError {
  // JSON.stringify replacer above handles Error instances; nothing more
  // to do here. A pass-through hook for error variants that embed
  // callbacks.
  return error;
}

/**
 * Attempt to reconstruct a structured `InvokeAgentError` from a run's
 * `failureMessage`. Returns `undefined` when the message is not one of
 * ours (e.g. a raw kernel-level exception message).
 */
export function parseFailureMessage(raw: string | undefined): InvokeAgentError | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  // Fast path: the raw message IS the single serialized failure (one
  // step.failed for the whole turn, which is the common case).
  const whole = tryParseChunk(raw);
  if (whole !== undefined) return whole;
  // Fallback: the kernel joins multiple step.failed messages with '; '.
  // Recover by extracting balanced-brace substrings and trying each.
  for (const chunk of extractJsonCandidates(raw)) {
    const parsed = tryParseChunk(chunk);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * Extract substrings that look like well-formed JSON objects by
 * scanning for balanced braces. Only single-level scan — inner strings
 * are respected. Cheap parser used for the rare multi-failure case.
 */
function extractJsonCandidates(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

function tryParseChunk(chunk: string): InvokeAgentError | undefined {
  const trimmed = chunk.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const doc = JSON.parse(trimmed) as SerializedFailure | Record<string, unknown>;
    if (
      typeof doc === 'object' &&
      doc !== null &&
      (doc as SerializedFailure)[FAILURE_SENTINEL] === true
    ) {
      return (doc as SerializedFailure).error;
    }
  } catch {
    // Not our JSON — probably a raw JS Error.message. Fall through.
  }
  return undefined;
}

/** Helper for handlers to short-circuit with a structured error. */
export function throwAgentTurnFailure(error: InvokeAgentError): never {
  throw new AgentTurnFailure(error);
}

/**
 * Placeholder to satisfy TS-strict "declared but unused" on
 * `EvaluationResult` in ambient imports elsewhere; the type is used
 * transitively via `GuardrailViolationError`.
 */
export type _EvaluationResultAlias = EvaluationResult;
