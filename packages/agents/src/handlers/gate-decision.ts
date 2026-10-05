// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The reviewer's answer at an agent turn's approval gates: the tool-call
 * gate (`dispatch-tools`) and the session gate (`setup`). A gate parks the
 * turn on a waitpoint; the approvals route resumes it with the decision,
 * `{ decided: 'approve' | 'reject', rationale? }`.
 *
 * A gate fails closed. Only an explicit approve lets the tool run (or the
 * session go on). Anything else blocks: a reject, and also a resume value
 * that isn't a decision at all (a `value` that replaced it, a malformed
 * payload), so no answer can be read as consent by omission.
 */

/** The approval subject an agent's tool-call gate parks on. */
export const TOOL_CALL_GATE_SUBJECT = 'tool-call:pending';

/** The approval subject an agent's session gate (`afterTurns`) parks on. */
export const SESSION_GATE_SUBJECT = 'agent-turn:session-hitl-gate';

/**
 * The approval subjects an agent turn parks on. Their resume value is the
 * reviewer's decision and nothing else, so the approvals route takes no
 * `value` for them.
 */
export const AGENT_GATE_SUBJECTS: ReadonlySet<string> = new Set([
  TOOL_CALL_GATE_SUBJECT,
  SESSION_GATE_SUBJECT,
]);

/** What a gate's resume value decides. */
export type GateDecision =
  | { readonly approved: true }
  | {
      readonly approved: false;
      /** `rejected`: the reviewer said no. `unreadable`: the answer wasn't a decision. */
      readonly reason: 'rejected' | 'unreadable';
      /** The reviewer's rationale, or why an unreadable answer blocks. */
      readonly rationale: string | undefined;
    };

/** Why a gate blocks on an answer that isn't a decision. */
export const UNREADABLE_DECISION =
  "the approval's answer wasn't a decision (approve or reject), so it counts as a rejection";

/**
 * The decision in a gate's resume value. Fails closed: only
 * `{ decided: 'approve' }` approves.
 */
export function readGateDecision(value: unknown): GateDecision {
  if (typeof value !== 'object' || value === null) {
    return { approved: false, reason: 'unreadable', rationale: UNREADABLE_DECISION };
  }
  const { decided, rationale } = value as { decided?: unknown; rationale?: unknown };
  if (decided === 'approve') return { approved: true };
  if (decided === 'reject') {
    return {
      approved: false,
      reason: 'rejected',
      rationale: typeof rationale === 'string' ? rationale : undefined,
    };
  }
  return { approved: false, reason: 'unreadable', rationale: UNREADABLE_DECISION };
}
