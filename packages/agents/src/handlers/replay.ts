// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Replay turns: an eval run re-running a past run (`InvokeAgentInput.replay`)
 * on an agent version, without doing anything the past run didn't already
 * do. Each tool call is decided by the deployment's `ReplayBinding`:
 *
 *   - `live`: the tool runs. Only a tool declared read-only (see
 *     `isReadOnlyTool`) with no approval to wait for can; a `live`
 *     decision for any other is refused here, whatever the binding says;
 *   - `recorded`: the past run's result for the same call is used;
 *   - `refused`: the tool doesn't run, and the model gets the given result.
 *
 * A turn marked as a replay with no binding refuses every call. Each
 * decision is journaled (`NodeContext.record`), so a resumed turn keeps
 * the decisions it made, and the turn's result lists them
 * (`AgentTurnResult.replay`).
 */

import type { NodeContext } from '@kindgi/handler';
import type { RunReplayRef } from '@kindgi/runtime';
import type { JournalEntry, ValueRecordedPayload } from '@kindgi/runtime';
import type { Tool } from '@kindgi/tools';
import type { RunId, TenantId } from '@kindgi/types';

import type { RetrievedFact } from '../types.js';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';

/** The replay turn a `ReplayBinding` is asked about. */
export interface ReplayTurnRef {
  readonly tenantId: TenantId;
  /** The replay turn's own run. */
  readonly runId: RunId;
  readonly replay: RunReplayRef;
}

export interface ReplayToolInput extends ReplayTurnRef {
  readonly tool: {
    readonly id: string;
    readonly version: string;
    /** As the tool declares it; absent means it changes things. */
    readonly mutating?: boolean;
    readonly effects?: readonly string[];
  };
  readonly arguments: unknown;
  /** The model's id for the call. */
  readonly callId: string;
  /** `true` when the tool's approval rules would ask for a review before it runs. */
  readonly gated: boolean;
}

export type ReplayToolDecision =
  | { readonly kind: 'live' }
  | { readonly kind: 'recorded'; readonly result: unknown }
  | { readonly kind: 'refused'; readonly result: unknown; readonly reason: string };

/** An approval decision the past run recorded. */
export interface ReplayApproval {
  readonly approved: boolean;
  readonly rationale?: string;
}

/**
 * How a deployment replays turns. Consulted only for a turn marked as a
 * replay (`InvokeAgentInput.replay`).
 */
export interface ReplayBinding {
  /** Decide one tool call. */
  decideTool(input: ReplayToolInput): Promise<ReplayToolDecision>;
  /**
   * What the turn's retrievals return: the past run's, or `undefined` to
   * retrieve live. Absent: retrieve live.
   */
  retrievals?(input: ReplayTurnRef): Promise<readonly RetrievedFact[] | undefined>;
  /**
   * The past run's decision at the session approval gate, when the replay
   * reaches that gate: the replay follows it. `undefined` (or absent): the
   * gate is skipped, and the result says so.
   */
  sessionApproval?(input: ReplayTurnRef): Promise<ReplayApproval | undefined>;
}

/** One tool call of a replay turn, and what happened to it. */
export interface ReplayToolTrace {
  readonly step: number;
  readonly callId: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly arguments: unknown;
  readonly source: 'live' | 'recorded' | 'refused';
  /** Why it was refused. A refused call is what the turn would have done. */
  readonly reason?: string;
}

/** What a replay turn did differently from a live one (`AgentTurnResult.replay`). */
export interface ReplayTurnReport extends RunReplayRef {
  readonly tools: readonly ReplayToolTrace[];
  /**
   * The session approval gate, when the replay reached it: `followed` the
   * past run's recorded decision, or `skipped` (none was recorded).
   */
  readonly approval?: 'followed' | 'skipped';
}

/** The `record` key of a replay's tool decision, per call. */
export const REPLAY_TOOL_RECORD_PREFIX = 'replay-tool:';
/** The `record` key of a replay's session approval. */
export const REPLAY_APPROVAL_RECORD = 'replay-session-approval';

/** Effects a read-only tool can't declare. */
const CHANGING_EFFECTS: ReadonlySet<string> = new Set([
  'writes',
  'deletes',
  'spawns-run',
  'emits-event',
  'external-side-effect',
]);

/** A tool that declares it changes nothing: `mutating: false`, and no changing effect. */
export function isReadOnlyTool(tool: {
  readonly mutating?: boolean;
  readonly effects?: readonly { readonly kind: string }[] | readonly string[];
}): boolean {
  if (tool.mutating !== false) return false;
  return !(tool.effects ?? []).some((e) =>
    CHANGING_EFFECTS.has(typeof e === 'string' ? e : e.kind),
  );
}

/** What the model gets for a call a replay refuses because nothing decided it. */
const NO_BINDING_REASON = 'replay: no replay binding is wired, so no tool runs';
const CHANGES_REASON = 'replay: this call changes things and has no recorded result';
const GATED_REASON = 'replay: this call needs an approval and has no recorded result';

function refusedResult(reason: string): Readonly<Record<string, unknown>> {
  return { status: 'not-executed', reason };
}

/** The journaled decision of one call: its trace entry, and the result the model got. */
interface RecordedDecision extends ReplayToolTrace {
  readonly result?: unknown;
}

/**
 * Decide one tool call of a replay turn, once: the binding's decision,
 * held to `isReadOnlyTool`, journaled, and added to the turn's trace.
 */
export async function decideReplayTool(
  ctx: TurnContext,
  kctx: NodeContext,
  call: {
    readonly step: number;
    readonly callId: string;
    readonly tool: Tool;
    readonly version: string;
    readonly arguments: unknown;
    readonly gated: boolean;
  },
): Promise<ReplayToolDecision> {
  const replay = ctx.input.replay;
  if (replay === undefined) return { kind: 'live' };
  const base = {
    step: call.step,
    callId: call.callId,
    toolId: call.tool.id as unknown as string,
    toolVersion: call.version,
    arguments: call.arguments,
  };
  const refuse = (reason: string): RecordedDecision => ({
    ...base,
    source: 'refused',
    reason,
    result: refusedResult(reason),
  });
  const decided = await kctx.record(
    `${REPLAY_TOOL_RECORD_PREFIX}${call.callId}`,
    async (): Promise<RecordedDecision> => {
      const binding = ctx.bindings.replay;
      if (binding === undefined) return refuse(NO_BINDING_REASON);
      const decision = await binding.decideTool({
        tenantId: ctx.input.tenantId,
        runId: kctx.runId,
        replay,
        tool: {
          id: base.toolId,
          version: call.version,
          ...(call.tool.mutating !== undefined && { mutating: call.tool.mutating }),
          ...(call.tool.effects !== undefined && {
            effects: call.tool.effects.map((e) => e.kind),
          }),
        },
        arguments: call.arguments,
        callId: call.callId,
        gated: call.gated,
      });
      if (decision.kind === 'recorded') {
        return { ...base, source: 'recorded', result: decision.result };
      }
      if (decision.kind === 'refused') {
        return { ...base, source: 'refused', reason: decision.reason, result: decision.result };
      }
      // `live` runs only a read-only tool, and never waits for an approval.
      if (!isReadOnlyTool(call.tool)) return refuse(CHANGES_REASON);
      if (call.gated) return refuse(GATED_REASON);
      return { ...base, source: 'live' };
    },
  );
  addReplayTrace(ctx, traceOf(decided));
  if (decided.source === 'live') return { kind: 'live' };
  if (decided.source === 'recorded') return { kind: 'recorded', result: decided.result };
  return { kind: 'refused', result: decided.result, reason: decided.reason ?? CHANGES_REASON };
}

/** A journaled decision's trace entry (without the result). */
function traceOf(decided: RecordedDecision): ReplayToolTrace {
  const { result: _result, ...trace } = decided;
  return trace;
}

function addReplayTrace(ctx: TurnContext, entry: ReplayToolTrace): void {
  const trace = ctx.replayTrace ?? [];
  ctx.replayTrace = trace;
  // A step run again after a resume decides its calls again (from the journal).
  if (trace.some((t) => t.callId === entry.callId)) return;
  trace.push(entry);
}

/** The session approval a replay follows, decided once: the past run's, or none. */
export async function replaySessionApproval(
  ctx: TurnContext,
  kctx: NodeContext,
): Promise<ReplayApproval | undefined> {
  const replay = ctx.input.replay;
  if (replay === undefined) return undefined;
  const recorded = await kctx.record(
    REPLAY_APPROVAL_RECORD,
    async (): Promise<{ readonly approval: ReplayApproval | null }> => {
      const approval = await ctx.bindings.replay?.sessionApproval?.({
        tenantId: ctx.input.tenantId,
        runId: kctx.runId,
        replay,
      });
      return { approval: approval ?? null };
    },
  );
  ctx.replayApproval = recorded.approval === null ? 'skipped' : 'followed';
  return recorded.approval ?? undefined;
}

/**
 * A replay at the session approval gate: it goes on when the past run's
 * reviewer approved (or none was recorded), and fails as the past run did
 * (`hitl-rejected`) when they rejected.
 */
export async function followReplaySessionGate(ctx: TurnContext, kctx: NodeContext): Promise<void> {
  const approval = await replaySessionApproval(ctx, kctx);
  if (approval === undefined || approval.approved) return;
  throwAgentTurnFailure({
    code: 'hitl-rejected',
    message: `The replayed run's reviewer rejected the session-HITL gate${
      approval.rationale !== undefined ? `: ${approval.rationale}` : ''
    }`,
    ...(approval.rationale !== undefined && { rationale: approval.rationale }),
  } as never);
}

/**
 * A resumed replay turn's trace and approval, from the journal: every call
 * decided before the park, and the session approval if `setup` reached it.
 * The step the turn parked in decides its calls again, from the journal.
 */
export function rehydrateReplay(ctx: TurnContext, journal: readonly JournalEntry[]): void {
  if (ctx.input.replay === undefined) return;
  for (const e of journal) {
    if (e.kind !== 'value.recorded') continue;
    const p = (e.payload ?? {}) as Partial<ValueRecordedPayload>;
    if (p.key === REPLAY_APPROVAL_RECORD) {
      const approval = (p.value as { readonly approval?: unknown } | undefined)?.approval;
      ctx.replayApproval = approval == null ? 'skipped' : 'followed';
    } else if (p.key?.startsWith(REPLAY_TOOL_RECORD_PREFIX) === true) {
      restoreDecision(ctx, p.value);
    }
  }
}

function restoreDecision(ctx: TurnContext, value: unknown): void {
  const decided = value as RecordedDecision | undefined;
  if (decided?.source !== undefined && decided.callId !== undefined) {
    addReplayTrace(ctx, traceOf(decided));
  }
}

/** The turn's replay report, for its result. */
export function replayReport(ctx: TurnContext): ReplayTurnReport | undefined {
  const replay = ctx.input.replay;
  if (replay === undefined) return undefined;
  return {
    of: replay.of,
    evalRunId: replay.evalRunId,
    tools: [...(ctx.replayTrace ?? [])].sort((a, b) => a.step - b.step),
    ...(ctx.replayApproval !== undefined && { approval: ctx.replayApproval }),
  };
}

/** A replay's tag on its usage records (`ModelUsageRecord.replay`). */
export function replayTag(replay: RunReplayRef): {
  readonly of: string;
  readonly evalRunId: string;
} {
  return { of: replay.of as unknown as string, evalRunId: replay.evalRunId };
}
