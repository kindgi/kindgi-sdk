// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The reviewer's answer at an agent turn's approval gates: the tool-call
 * gate (`dispatch-tools`) and the session gate (`setup`). A gate parks the
 * turn on a waitpoint; the approvals route resumes it with the decision
 * (`GateDecisionValue`): approve or reject, the reviewer's rationale, and
 * who decided which approval.
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

/**
 * A gate's resume value: the reviewer's decision, as the approvals route
 * (and the runtime, delivering a decision whose delivery was lost) completes
 * the gate's waitpoint with it. The run's journal keeps it as it came.
 */
export interface GateDecisionValue {
  readonly decided: 'approve' | 'reject';
  readonly rationale?: string;
  /**
   * Who decided, as an actor: `user:<userId>`, the reviewer's user. Absent
   * from values written before it was recorded.
   */
  readonly decidedBy?: string;
  /** The approval decided. Absent from values written before it was recorded. */
  readonly approvalId?: string;
}

/** Who decided a gate, and which approval, when its value says. */
interface GateDecider {
  readonly decidedBy?: string;
  readonly approvalId?: string;
}

/** What a gate's resume value decides. */
export type GateDecision = GateDecider &
  (
    | { readonly approved: true }
    | {
        readonly approved: false;
        /** `rejected`: the reviewer said no. `unreadable`: the answer wasn't a decision. */
        readonly reason: 'rejected' | 'unreadable';
        /** The reviewer's rationale, or why an unreadable answer blocks. */
        readonly rationale: string | undefined;
      }
  );

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
  const { decided, rationale, decidedBy, approvalId } = value as {
    decided?: unknown;
    rationale?: unknown;
    decidedBy?: unknown;
    approvalId?: unknown;
  };
  const decider: GateDecider = {
    ...(typeof decidedBy === 'string' && { decidedBy }),
    ...(typeof approvalId === 'string' && { approvalId }),
  };
  if (decided === 'approve') return { approved: true, ...decider };
  if (decided === 'reject') {
    return {
      approved: false,
      reason: 'rejected',
      rationale: typeof rationale === 'string' ? rationale : undefined,
      ...decider,
    };
  }
  return { approved: false, reason: 'unreadable', rationale: UNREADABLE_DECISION };
}
