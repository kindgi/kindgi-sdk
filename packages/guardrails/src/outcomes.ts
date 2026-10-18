// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectId, RunId, TenantId, Timestamp } from '@kindgi/types';

import type { GuardrailSeverity, OnViolation } from './types.js';

/**
 * What one guardrail's check came to on one answer: a turn's final
 * answer, or each answer the agent loop judged, in a turn with a `retry`
 * guardrail:
 *
 * - `passed`: the check ran and found nothing;
 * - `violated`: it found something, and its action let the answer through
 *   (`log-only`, `noop`, or an action the turn hands back), or a `retry`
 *   sent it back for a new one;
 * - `blocked`: it found something, and its action failed the turn: a
 *   `halt`, or a `retry` whose attempts had run out;
 * - `errored`: the check couldn't run (no such check, a bad configuration,
 *   a judge that couldn't be routed). A `halt` guardrail's error fails the
 *   turn too, and stays `errored`.
 *
 * A guardrail whose scope didn't match the turn wasn't checked and has no
 * outcome.
 */
export type GuardrailCheckOutcomeKind = 'passed' | 'violated' | 'blocked' | 'errored';

export interface GuardrailCheckOutcome {
  readonly guardrailId: string;
  readonly outcome: GuardrailCheckOutcomeKind;
  /**
   * The guardrail's `on-violation` action, for a violation, a block or an
   * error; absent for a pass (nothing was done) and for an error whose
   * guardrail is unknown.
   */
  readonly action?: OnViolation | 'noop';
  readonly severity?: GuardrailSeverity;
  /** Why the check couldn't run (`errored`): the engine's error code, never its message. */
  readonly errorCode?: string;
}

/**
 * Every check one guardrail gate ran on an answer, as the gate decided them.
 * No content: no answer, no check's reason.
 */
export interface GuardrailOutcomeRecord {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  /** The turn's run. */
  readonly runId: RunId;
  /**
   * The step that ran the gate: a run's outcomes are kept per step. It's
   * `evaluate-guardrails` after the agent loop, or `budget-check@<iteration>`
   * for an answer the loop judged (a turn with a `retry` guardrail), so it
   * isn't always a flow node's id.
   */
  readonly nodeId: string;
  readonly agentId: string;
  readonly agentVersion: string;
  /** When the gate ran. */
  readonly at: Timestamp;
  readonly checks: readonly GuardrailCheckOutcome[];
}

/**
 * Where guardrail outcomes are recorded, so each guardrail's passes,
 * violations, blocks and errors can be counted. The gate awaits `record`
 * before it acts on the outcomes (a blocked turn is recorded before it
 * fails), and a `record` that throws fails the step: outcomes aren't left
 * unrecorded. Recording the same run's step again replaces what that step
 * recorded. Replays and dry runs aren't recorded.
 */
export interface GuardrailOutcomeSink {
  record(outcomes: GuardrailOutcomeRecord): Promise<void>;
}
