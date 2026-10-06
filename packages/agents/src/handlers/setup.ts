// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import type { NodeHandler } from '@kindgi/handler';
import { WaitpointCancelledError } from '@kindgi/handler';

import { evaluateSessionGate } from '../guardrails-gate.js';
import { emitTurnEvent } from '../streaming.js';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';
import { SESSION_GATE_SUBJECT, readGateDecision } from './gate-decision.js';
import { followReplaySessionGate } from './replay.js';
import { writeRunSnapshot } from './run-snapshot.js';
import {
  loadTurnConversation,
  resolveTurnEnvironment,
  resolveTurnHitlPolicy,
} from './turn-environment.js';
import { decisionOf } from './turn-provenance.js';

/**
 * Deterministic waitpoint token — must produce the same value on every
 * flow replay so the kernel's `waitForToken(tokenId)` resolves against
 * the correct suspended state. Not sensitive to time or approval id;
 * driven only by (runId, gate scope, turnCount).
 */
function computeSessionGateWaitToken(input: {
  readonly runId: string;
  readonly turnCount: number;
}): string {
  return createHash('sha256')
    .update(`agent-turn:session-hitl-gate:${input.runId}:${input.turnCount}`)
    .digest('hex')
    .slice(0, 40);
}

/** The `record` key of the session gate's decision. */
export const SESSION_GATE_RECORD = 'session-hitl-gate';

/**
 * The session gate's decision, as `setup` records it the first time
 * the gate asks for a review: the wait it parks on, and the review it asks
 * for. A turn resumed after the park reads it back instead of deciding again.
 */
interface SessionGateRecord {
  readonly waitTokenId: string;
  readonly turnCount: number;
  readonly threshold: number;
  readonly reason: string;
  readonly requiredRole: 'standard' | 'senior' | 'admin';
  readonly timeoutMs: number;
}

/**
 * The first node in the flow. Runs every precondition check in one
 * gate so the run either commits to a full turn or fails fast before
 * the user message is stored in the conversation (only the run
 * snapshot is written first):
 *
 *   1. Load + validate conversation (open, not closed, matches agent version).
 *   2. Session-level HITL gate (`conversationPolicy.hitl.afterTurns` /
 *      `hitlAfterTurns`).
 *   3. Resolve declared guardrails against the guardrails bound for the run.
 *   4. Resolve declared tools against the tenant's tool registry
 *      (`ToolRegistry.forTenant`).
 *   5. Merge the tenant policy (bound policy + policy registry), then
 *      route the agent's first capability through the provider registry.
 *
 * Populates `ctx.conversation`, `ctx.guardrails`, `ctx.tools`,
 * `ctx.tenantPolicy`, `ctx.provider` and `ctx.model` for downstream
 * handlers. Emits `turn.started` on success. Any failure surfaces as an `AgentTurnFailure` — the run
 * fails and `projectRunResult` translates it back into the caller's
 * `InvokeAgentError`.
 */
export function buildSetupHandler(ctx: TurnContext): NodeHandler {
  return async (_input, kctx) => {
    // Write the run's reconstruction snapshot on FIRST
    // execution (idempotent via PK on runId). resumeAgentTurn(runId)
    // reads this to rebuild the same InvokeAgentInput when a parked
    // waitpoint resolves — kernel replay lands in an identical context.
    // The binding write is tenant-scoped and idempotent on runId, so it
    // is safe under handler replay.
    await writeRunSnapshot(ctx, kctx);

    // Create the provenance builder BEFORE the session-HITL
    // gate so we can emit wait/resume nodes around the park boundary.
    // The builder is fresh on every replay (kernel replays the flow
    // from scratch); nodes emitted before the first suspend are
    // discarded (persist-provenance runs only on run.completed). On the
    // final replay, both wait AND resume nodes get emitted and
    // persisted — the DAG shows the whole cycle.
    if (ctx.bindings.provenance?.newBuilder !== undefined) {
      ctx.provenance = ctx.bindings.provenance.newBuilder({
        runId: kctx.runId as unknown as string,
        tenantId: ctx.input.tenantId,
      });
      ctx.provenanceBindings = ctx.bindings.provenance;
    }

    const conversation = await loadTurnConversation(ctx);

    // Session HITL gate — checked BEFORE tool/guardrail resolution so
    // callers with a HITL block don't waste routing work.
    //
    // Park-and-resume: instead of failing the turn with
    // `hitl-required`, we PARK the run on a kernel waitpoint. A reviewer's
    // decision (via POST /v1/approvals/:id/complete) resolves the
    // waitpoint; the kernel replays this handler; `waitForToken` returns
    // the reviewer's decision object; the handler branches on it and
    // continues (approve) or fails cleanly (reject / cancelled / timeout).
    //
    // Same run, same conversationId, same provenance record — the audit
    // trail stays coherent across the human-in-the-loop cycle.
    //
    // Enqueue is idempotent on `waitTokenId` (see
    // `HitlEnqueueInput.waitTokenId`) — safe under handler replay.
    // The turn's approval rules — the agent's, held to the tenant's
    // `hitl` policy — before the gate that may park on them.
    const effectiveHitl = await resolveTurnHitlPolicy(ctx);
    ctx.hitlPolicy = effectiveHitl;
    // Decided once: a turn that parked here resumes on the gate it parked
    // on, whatever the policy or the conversation's turn count say by then.
    const gate = await kctx.record(SESSION_GATE_RECORD, (): SessionGateRecord | undefined => {
      const evaluated = evaluateSessionGate(
        { ...(effectiveHitl.turn !== undefined && { afterTurns: effectiveHitl.turn.afterTurns }) },
        conversation.turnCount,
      );
      if (evaluated.kind !== 'hitl-required') return undefined;
      return {
        waitTokenId: computeSessionGateWaitToken({
          runId: kctx.runId as unknown as string,
          turnCount: conversation.turnCount,
        }),
        turnCount: conversation.turnCount,
        threshold: evaluated.threshold,
        reason: evaluated.reason,
        requiredRole: effectiveHitl.defaultReviewerRole,
        timeoutMs: effectiveHitl.timeoutMs,
      };
    });
    if (gate !== undefined && ctx.input.replay !== undefined) {
      // A replay follows the past run's decision at this gate, or skips it
      // when none was recorded; it never waits for a reviewer.
      await followReplaySessionGate(ctx, kctx);
    } else if (gate !== undefined) {
      const { waitTokenId, timeoutMs } = gate;
      const expiresAt = new Date(Date.now() + timeoutMs).toISOString();

      if (ctx.bindings.hitl?.enqueue !== undefined) {
        try {
          await ctx.bindings.hitl.enqueue({
            tenantId: ctx.input.tenantId,
            projectId: ctx.input.projectId,
            subjectKind: SESSION_GATE_SUBJECT,
            subjectRef: {
              conversationId: ctx.input.conversationId,
              agentId: ctx.input.agent.id,
              agentVersion: ctx.input.agent.version,
              turnCount: gate.turnCount,
              threshold: gate.threshold,
            },
            requiredRole: gate.requiredRole,
            title: `HITL review required for ${ctx.input.agent.name}`,
            description: gate.reason,
            waitTokenId,
            provenanceRef: { runId: kctx.runId },
            expiresAt: expiresAt as never,
          });
        } catch {
          // Failing sink must not affect turn outcome — swallow. The
          // waitForToken below will still park; if no reviewer sees the
          // approval row, the kernel timeout cancels the wait per policy.
        }
      }

      // Provenance: emit `wait` node right before the park. On first
      // execution (park), persist-provenance never runs so this node is
      // lost — that's fine. On the FINAL replay after resume, this node
      // AND the `resume` node below both emit and get persisted.
      const waitNodeId = `session-hitl-gate-wait:${gate.turnCount}`;
      const resumeNodeId = `session-hitl-gate-resume:${gate.turnCount}`;
      if (ctx.provenance !== undefined) {
        ctx.provenance.addNode({
          id: waitNodeId,
          kind: 'wait',
          timestamp: new Date().toISOString() as never,
          actor: `agent:${ctx.input.agent.id as unknown as string}`,
          attributes: {
            gate: 'session-hitl',
            turnCount: gate.turnCount,
            threshold: gate.threshold,
            waitTokenId,
          },
        });
      }

      try {
        // Fails closed: only an explicit approve lets the turn go on
        // (`readGateDecision`).
        const decision = readGateDecision(
          await kctx.waitForToken<unknown>(waitTokenId, { timeoutMs }),
        );
        // Post-resume: emit the resume node + resumed-from edge. Only
        // runs on the REPLAY path — the first execution throws
        // SuspensionSignal inside waitForToken and never gets here.
        if (ctx.provenance !== undefined) {
          ctx.provenance.addNode({
            id: resumeNodeId,
            kind: 'resume',
            timestamp: new Date().toISOString() as never,
            // Whoever decided; a decision recorded before it named them, the agent.
            actor: decision.decidedBy ?? `agent:${ctx.input.agent.id as unknown as string}`,
            attributes: {
              gate: 'session-hitl',
              decision: decisionOf(decision),
              ...(!decision.approved &&
                decision.rationale !== undefined && { rationale: decision.rationale }),
              ...(decision.approvalId !== undefined && { approvalId: decision.approvalId }),
            },
          });
          ctx.provenance.addEdge({
            from: waitNodeId,
            to: resumeNodeId,
            kind: 'resumed-from',
          });
        }

        if (!decision.approved) {
          throwAgentTurnFailure({
            code: 'hitl-rejected',
            message: `Reviewer rejected the session-HITL gate${
              decision.rationale !== undefined ? `: ${decision.rationale}` : ''
            }`,
            ...(decision.rationale !== undefined && { rationale: decision.rationale }),
          } as never);
        }
        // Approved: the turn proceeds through the rest of setup.
      } catch (cause) {
        if (cause instanceof WaitpointCancelledError) {
          // Emit resume node with cancelled attribute so the DAG still
          // shows the resolution — even for terminal cancellations the
          // flow reached the resume boundary before the failure.
          if (ctx.provenance !== undefined) {
            ctx.provenance.addNode({
              id: resumeNodeId,
              kind: 'resume',
              timestamp: new Date().toISOString() as never,
              actor: `agent:${ctx.input.agent.id as unknown as string}`,
              attributes: {
                gate: 'session-hitl',
                decision: 'cancelled',
                reason: cause.reason,
              },
            });
            ctx.provenance.addEdge({
              from: waitNodeId,
              to: resumeNodeId,
              kind: 'resumed-from',
            });
          }
          throwAgentTurnFailure({
            code: 'hitl-cancelled',
            message: `Session-HITL gate cancelled: ${cause.reason}`,
            reason: cause.reason,
          } as never);
        }
        // SuspensionSignal or anything else — let it propagate. The
        // kernel executor's dispatch catch handles SuspensionSignal by
        // suspending the run; other errors become step.failed.
        throw cause;
      }
    }

    const environment = await resolveTurnEnvironment(ctx);

    // Provenance builder was created earlier (before the session-HITL
    // gate) so wait/resume nodes could bracket the park boundary. Kept
    // here as a documentation anchor — see the block above `getConversation`.

    await emitTurnEvent(ctx.bindings.onEvent, {
      kind: 'turn.started',
      conversationId: ctx.input.conversationId,
      turnNumber: conversation.turnCount + 1,
      agentId: ctx.input.agent.id,
      agentVersion: ctx.input.agent.version,
      userMessage: ctx.input.userMessage,
    });

    // Kernel output — kept minimal + JSON-safe. Real state lives on ctx.
    return {
      turnNumber: conversation.turnCount + 1,
      providerId: environment.providerId,
      providerModel: environment.model,
      toolCount: environment.toolCount,
      // The version each tool resolved to: a resumed turn runs these.
      toolVersions: environment.toolVersions,
      // And each data block's.
      ...(environment.blockVersions !== undefined && {
        blockVersions: environment.blockVersions,
      }),
    };
  };
}
