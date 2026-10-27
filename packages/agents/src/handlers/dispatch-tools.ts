// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ModelMessage, ModelToolCall } from '@kindgi/capabilities';
import type { NodeContext, NodeHandler } from '@kindgi/handler';
import { WAITPOINT_TIMEOUT_REASON, WaitpointCancelledError } from '@kindgi/handler';
import { stricterToolHitlRule } from '@kindgi/policy-contract';
import { type RunMailbox, type RunStartedBy, needsPersonsYesUnattended } from '@kindgi/runtime';
import {
  BUILT_IN_TOOL_PREFIX,
  invokeTool,
  invokeToolOrPause,
  toolCallRecordKey,
  toolIdempotencyKey,
  withoutConnectionTokens,
} from '@kindgi/tools';
import type {
  Tool,
  ToolConnection,
  ToolContext,
  ToolError,
  ToolPause,
  WaitTokenTimedOutError,
} from '@kindgi/tools';
import type { Result } from '@kindgi/types';

import { toolResultForModel } from '../event-data.js';
import { REMEMBER_TOOL_ID, rememberStaysInProject } from '../remember.js';
import { emitTurnEvent } from '../streaming.js';
import type { ConversationMessage, ToolHitlMode, ToolHitlRule } from '../types.js';

import { type EffectiveHitlPolicy, separateApproverFor } from '../hitl-policy.js';

import {
  type ConnectionCallFailure,
  type ConnectionGate,
  approverNotAReviewerOf,
  connectionApprovalConflict,
  connectionApprovalOf,
  connectionFailureResult,
  connectionPersonOf,
  freshConnections,
  gateConnections,
  rejectedAgainOf,
  rejectedConnectionOf,
} from './connection-gate.js';
import type { AgentTurnIterationOutput, TurnContext } from './context.js';
import {
  type ToolInvocationError,
  type UnresolvedToolError,
  approvalsPendingLimitOf,
  throwAgentTurnFailure,
} from './errors.js';
import { TOOL_CALL_GATE_SUBJECT, readGateDecision, withdrawnGateFailure } from './gate-decision.js';
import type { ToolCallAuthorization } from './public-types.js';
import { decideReplayTool } from './replay.js';
import { requestedBy } from './requested-by.js';
import {
  effectiveToolErrorPolicy,
  toolErrorKindOf,
  toolErrorResult,
  toolRetriesSoFar,
} from './tool-errors.js';
import { TOOL_GATE_RECORD_PREFIX, computeToolCallWaitToken, hashToolArgs } from './tool-hitl.js';
import { addStepToolNodes } from './turn-provenance.js';

/**
 * Resolves the effective HITL mode + reviewer role for a specific
 * tool from the pre-resolved effective policy. Mirrors the standalone
 * `resolveToolHitl(agent, tool)` in tool-hitl.ts but consumes the
 * resolver's output, and adds the floors that sit above the agent's
 * rules: the tenant's, and in a run no person started, the unattended
 * rule (`needsPersonsYesUnattended`: the tool's own
 * `needsApprovalWhenUnattended`, a person's connection, and in a mail's
 * run a change or the run's own mailbox), unless the webhook, schedule or
 * mail trigger that started the run lists the tool.
 */
export function resolveEffectiveToolHitl(
  effective: EffectiveHitlPolicy,
  tool: Tool,
  run: {
    readonly startedBy?: RunStartedBy;
    readonly toolsAllowedUnattended?: readonly string[];
    readonly mailbox?: RunMailbox;
  },
): { readonly mode: ToolHitlMode; readonly requiredRole: 'standard' | 'senior' | 'admin' } {
  const gate = agentToolHitl(effective, tool);
  // The tenant's floor for this tool, when it names one: the stricter wins.
  const floor = effective.toolFloors?.get(tool.id as unknown as string);
  const floored = floor === undefined ? gate : stricterToolHitlRule(gate, floor);
  // In a run no person started, a tool the unattended rule covers waits
  // for a person's yes on every call, unless the run's trigger lists it.
  // Agents are reused, so their rules can't lift it, the same as the
  // tenant's floor.
  const stricter = needsPersonsYesUnattended(
    tool,
    run.startedBy,
    run.toolsAllowedUnattended,
    run.mailbox,
  )
    ? stricterToolHitlRule(floored, { mode: 'always_ask' })
    : floored;
  return { mode: stricter.mode, requiredRole: stricter.requiredRole ?? gate.requiredRole };
}

/** The agent's own gate for `tool`. */
function agentToolHitl(
  effective: EffectiveHitlPolicy,
  tool: Tool,
): { readonly mode: ToolHitlMode; readonly requiredRole: 'standard' | 'senior' | 'admin' } {
  const toolsPolicy = effective.tools;
  const defaultRole = effective.defaultReviewerRole;

  // Opt-in: no `hitl.tools` block → never gate.
  if (toolsPolicy === undefined) {
    return { mode: 'never_ask', requiredRole: defaultRole };
  }

  const rawOverride = toolsPolicy.overrides.get(tool.id as unknown as string);
  if (rawOverride !== undefined) {
    const rule: ToolHitlRule =
      typeof rawOverride === 'string'
        ? { mode: rawOverride as ToolHitlMode }
        : (rawOverride as ToolHitlRule);
    return {
      mode: rule.mode,
      requiredRole: rule.requiredRole ?? defaultRole,
    };
  }

  if (toolsPolicy.default !== undefined) {
    return { mode: toolsPolicy.default, requiredRole: defaultRole };
  }

  // Per-tool default from Tool.mutating (opt-in scope only).
  const mode: ToolHitlMode = tool.mutating === false ? 'never_ask' : 'ask_on_first_use';
  return { mode, requiredRole: defaultRole };
}

/**
 * A tool call's gate, as the step records it the first time the gate asks
 * for a review: the wait it parks on, and the review it asks for.
 */
interface ToolGateRecord {
  readonly argsHash: string;
  readonly waitTokenId: string;
  readonly requiredRole: 'standard' | 'senior' | 'admin';
  readonly timeoutMs: number;
  /** Four eyes for this call. Absent from a record made before it was kept: `false`. */
  readonly separateApprover?: boolean;
}

/**
 * Whether `call` waits for a review, decided once (`NodeContext.record`):
 * a step resumed after the park reads the gate it parked on back, so a
 * policy relaxed meanwhile can't skip the reviewer's answer, and a gate
 * recorded before its wait token took the step's scope keeps the token it
 * was recorded with. A call the gate lets through isn't recorded: it runs,
 * and its stored result is reused after a park further down the list.
 */
async function decideToolGate(
  ctx: TurnContext,
  kctx: NodeContext,
  call: ModelToolCall,
  tool: Tool,
): Promise<ToolGateRecord | undefined> {
  const effectiveHitl = ctx.hitlPolicy;
  if (effectiveHitl === undefined) {
    throwAgentTurnFailure({
      code: 'model-invocation-failed',
      message: 'dispatch-tools invoked before the turn resolved its approval rules',
      cause: null,
    });
  }
  // How the turn's run started, what its trigger lists, and a mail's
  // mailbox: all as the run recorded them when it started (a resumed
  // turn's come from its record, never from whoever resumed it), so an
  // approval doesn't make the rest of the run attended.
  const run = {
    ...(ctx.input.startedBy !== undefined && { startedBy: ctx.input.startedBy }),
    ...(ctx.input.toolsAllowedUnattended !== undefined && {
      toolsAllowedUnattended: ctx.input.toolsAllowedUnattended,
    }),
    ...(ctx.input.mailbox !== undefined && { mailbox: ctx.input.mailbox }),
  };
  return kctx.record(`${TOOL_GATE_RECORD_PREFIX}${call.id}`, (): ToolGateRecord | undefined => {
    const resolved = resolveEffectiveToolHitl(effectiveHitl, tool, run);
    if (resolved.mode === 'never_ask') return undefined;
    const argsHash = hashToolArgs(call.arguments);
    return {
      argsHash,
      waitTokenId: computeToolCallWaitToken({
        runId: kctx.runId as unknown as string,
        ...(kctx.stepScope !== undefined && { stepScope: kctx.stepScope }),
        callId: call.id,
        argsHash,
      }),
      requiredRole: resolved.requiredRole,
      timeoutMs: effectiveHitl.timeoutMs,
      separateApprover: separateApproverFor(effectiveHitl, tool.id as unknown as string),
    };
  });
}

/**
 * Loop-body node #2. If the model returned `finishReason='tool-use'`
 * with a non-empty tool-call list, persist the assistant tool-call
 * message + dispatch every tool + persist every tool result. Update
 * `nextMessages` so the next iteration's model call sees the tool
 * outputs.
 *
 * When the model returned a terminal `finishReason` (or `tool-use`
 * with no calls), pass through unchanged so
 * `budget-check` marks the iteration finished.
 */
export function buildDispatchToolsHandler(ctx: TurnContext): NodeHandler {
  return async (input: unknown, kctx: NodeContext) => {
    if (ctx.tools === undefined) {
      throwAgentTurnFailure({
        code: 'model-invocation-failed',
        message: 'dispatch-tools invoked before setup completed',
        cause: null,
      });
    }
    const partial = input as {
      readonly step: number;
      readonly finishReason: AgentTurnIterationOutput['finishReason'];
      readonly message: ModelMessage;
      readonly iterationUsage: AgentTurnIterationOutput['iterationUsage'];
      readonly provider: AgentTurnIterationOutput['provider'];
      readonly nextMessages: readonly ModelMessage[];
    };

    const assistantMsg = partial.message;
    const hasToolCalls =
      partial.finishReason === 'tool-use' &&
      assistantMsg.toolCalls !== undefined &&
      assistantMsg.toolCalls.length > 0;

    if (!hasToolCalls) {
      // No tool calls this iteration — pass through. `budget-check`
      // will finalize with `finishedTurn=true` and the loop exits.
      const forwarded: Partial<AgentTurnIterationOutput> & {
        readonly step: number;
        readonly hasToolCalls: false;
      } = {
        step: partial.step,
        finishReason: partial.finishReason,
        message: assistantMsg,
        iterationAppended: [],
        iterationUsage: partial.iterationUsage,
        provider: partial.provider,
        nextMessages: partial.nextMessages,
        hasToolCalls: false,
      };
      return forwarded;
    }

    const iterationAppended: ConversationMessage[] = [
      await persistToolCallMessage(ctx, assistantMsg, partial.step),
    ];
    let nextMessages: ModelMessage[] = [...partial.nextMessages, assistantMsg];

    for (const call of assistantMsg.toolCalls ?? []) {
      // Resumed after an approval further down this list: a call that
      // already ran keeps the result it stored.
      const stored = takeStoredBeforePark(
        ctx,
        (m) => m.role === 'tool' && m.toolCall?.invocationId === call.id,
      );
      if (stored !== undefined) {
        iterationAppended.push(stored);
        nextMessages = [...nextMessages, toolMessageOf(stored, call.id)];
        continue;
      }
      // Look up the resolved binding before emitting `tool.started` so
      // the event can carry `toolVersion` + `toolVersionRange` alongside
      // the id. Model-requested tools the
      // agent didn't declare emit a bare `tool.failed` with no version.
      const binding = ctx.tools.byName.get(call.name);
      if (binding === undefined) {
        const unresolved: UnresolvedToolError = {
          code: 'unresolved-tool',
          message: `Model requested tool "${call.name}" not registered for agent "${ctx.input.agent.id}"`,
          toolId: call.name,
        };
        await emitTurnEvent(ctx.bindings.onEvent, {
          kind: 'tool.failed',
          step: partial.step,
          toolId: call.name,
          invocationId: call.id,
          error: { code: unresolved.code, message: unresolved.message },
        });
        nextMessages = await retryOrFail(ctx, call, unresolved, undefined, {
          toolId: call.name,
          nextMessages,
          iterationAppended,
        });
        continue;
      }
      const { tool, resolvedVersion, requestedRange } = binding;

      // The turn's principal may call this tool, or the call runs nothing
      // and asks no reviewer (`authorizeToolCall`): its result tells the
      // model. Recorded with the call, so a resumed turn keeps the answer.
      const allowed = await authorizeCall(ctx, kctx, call.id, tool, 'call');
      if (allowed !== undefined && !allowed.allowed) {
        nextMessages = await appendDenied(ctx, partial.step, call, binding, allowed.reason, {
          toolId: tool.id as unknown as string,
          nextMessages,
          iterationAppended,
        });
        continue;
      }

      // Tool-level HITL gate. Resolves the effective mode
      // for this (agent, tool) pair via the effective-policy
      // resolver (framework defaults → agent → tenant cap), then parks +
      // enqueues an approval when required BEFORE dispatch. On reject,
      // returns a synthetic negative tool result so the LLM can adapt
      // without terminating the run. Same run, same conversation, same
      // provenance record across the park-and-resume — the same
      // framework guarantee as the session-level gate.
      //
      // Kernel replay: within one run, waitForToken with the same
      // deterministic tokenId returns the resolved decision from the
      // journal — no re-park. The gate itself is decided once
      // (`decideToolGate`), so a policy changed during the park can't
      // skip the reviewer's answer. Cross-turn `ask_on_first_use` caching
      // (via conversation metadata) is not implemented.
      const gate = await decideToolGate(ctx, kctx, call, tool);

      // A replay turn decides the call first: a recorded or refused call
      // runs nothing, so it asks for no approval either.
      const replayed =
        ctx.input.replay === undefined
          ? undefined
          : await decideReplayTool(ctx, kctx, {
              step: partial.step,
              callId: call.id,
              tool,
              version: resolvedVersion,
              arguments: call.arguments,
              gated: gate !== undefined,
            });
      if (replayed !== undefined && replayed.kind !== 'live' && replayed.kind !== 'recomputed') {
        const replayStarted = Date.now();
        await emitTurnEvent(ctx.bindings.onEvent, {
          kind: 'tool.started',
          step: partial.step,
          toolId: call.name,
          toolVersion: resolvedVersion,
          toolVersionRange: requestedRange,
          invocationId: call.id,
          arguments: call.arguments,
        });
        nextMessages = await appendToolResult(ctx, call, replayed.result, {
          toolId: tool.id as unknown as string,
          nextMessages,
          iterationAppended,
        });
        await emitTurnEvent(ctx.bindings.onEvent, {
          kind: 'tool.completed',
          step: partial.step,
          toolId: call.name,
          toolVersion: resolvedVersion,
          toolVersionRange: requestedRange,
          invocationId: call.id,
          output: replayed.result as never,
          durationMs: Date.now() - replayStarted,
          replay: replayed.kind,
        });
        continue;
      }

      // The call's connections (`needsSpec.connections`), before any
      // approval: a person's missing connection waits for them to connect,
      // and four eyes on a call only that person may approve can't be met.
      // A call they stop runs nothing; its result tells the model why.
      const conflict = connectionApprovalConflict(call, tool, gate?.separateApprover === true);
      const connected: ConnectionGate =
        conflict !== undefined
          ? { kind: 'failed', failure: conflict }
          : await gateConnections(ctx, kctx, call, tool);
      if (connected.kind === 'failed') {
        nextMessages = await appendConnectionFailure(ctx, partial.step, call, binding, {
          failure: connected.failure,
          started: false,
          target: { toolId: tool.id as unknown as string, nextMessages, iterationAppended },
        });
        continue;
      }

      let toolRejectionPayload: { readonly rationale?: string } | null = null;
      if (gate !== undefined) {
        const { argsHash, waitTokenId, timeoutMs } = gate;
        const asker = requestedBy(ctx.input.principal);
        const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
        // A call that acts with a person's connection is theirs to decide.
        const approval =
          connected.kind === 'ready'
            ? connectionApprovalOf(
                tool,
                connected.connections,
                connectionPersonOf(ctx.input.principal),
              )
            : undefined;
        let seatless: ConnectionCallFailure | undefined;

        if (ctx.bindings.hitl?.enqueue !== undefined) {
          try {
            await ctx.bindings.hitl.enqueue({
              tenantId: ctx.input.tenantId,
              projectId: ctx.input.projectId,
              subjectKind: TOOL_CALL_GATE_SUBJECT,
              subjectRef: {
                conversationId: ctx.input.conversationId,
                agentId: ctx.input.agent.id,
                agentVersion: ctx.input.agent.version,
                toolId: tool.id,
                toolVersion: resolvedVersion,
                callId: call.id,
                argsHash,
                arguments: call.arguments as never,
              },
              requiredRole: gate.requiredRole,
              // Who asked: the person the turn runs for, whoever resumes it.
              ...(asker !== undefined && { requestedBy: asker }),
              separateApprover: gate.separateApprover === true,
              ...approval,
              title: `HITL review: ${call.name}`,
              description: `Tool call ${call.name} awaiting reviewer approval before dispatch.`,
              waitTokenId,
              provenanceRef: { runId: kctx.runId },
              expiresAt: expiresAt as never,
            });
          } catch (cause) {
            // Past the tenant's limit on approvals waiting, the step fails
            // naming it: no approval was opened, so nobody would decide.
            const limit = approvalsPendingLimitOf(cause);
            if (limit !== undefined) throwAgentTurnFailure(limit);
            // The person whose connection it acts with has no reviewer seat:
            // no approval was opened, and nobody else may decide it.
            seatless =
              approval === undefined
                ? undefined
                : approverNotAReviewerOf(cause, call, tool, approval);
            // Any other enqueue failure is soft: waitForToken parks either way.
          }
        }
        if (seatless !== undefined) {
          nextMessages = await appendConnectionFailure(ctx, partial.step, call, binding, {
            failure: seatless,
            started: false,
            target: { toolId: tool.id as unknown as string, nextMessages, iterationAppended },
          });
          continue;
        }

        try {
          // Fails closed: only an explicit approve runs the tool. A reject,
          // or an answer that isn't a decision at all, gives the model a
          // rejected result instead.
          const decision = readGateDecision(
            await kctx.waitForToken<unknown>(waitTokenId, { timeoutMs }),
          );
          if (!decision.approved) {
            toolRejectionPayload =
              decision.rationale !== undefined ? { rationale: decision.rationale } : {};
          }
        } catch (cause) {
          if (cause instanceof WaitpointCancelledError) {
            throwAgentTurnFailure(
              withdrawnGateFailure(cause.reason, `tool call ${call.name}`) ?? {
                code: 'hitl-cancelled',
                message: `Tool-call HITL cancelled for ${call.name}: ${cause.reason}`,
                reason: cause.reason,
              },
            );
          }
          throw cause;
        }
      }

      // Approved: asked again right before it runs, since access can change
      // while a call waits for its reviewer (days, at times). A denial runs
      // nothing; the reviewer's decision stays as it was decided.
      if (gate !== undefined && toolRejectionPayload === null) {
        const still = await authorizeCall(ctx, kctx, call.id, tool, 'approved');
        if (still !== undefined && !still.allowed) {
          nextMessages = await appendDenied(
            ctx,
            partial.step,
            call,
            binding,
            `Access changed while this call waited for its approval. ${still.reason}`,
            { toolId: tool.id as unknown as string, nextMessages, iterationAppended },
          );
          continue;
        }
      }

      const toolStarted = Date.now();
      await emitTurnEvent(ctx.bindings.onEvent, {
        kind: 'tool.started',
        step: partial.step,
        toolId: call.name,
        toolVersion: resolvedVersion,
        toolVersionRange: requestedRange,
        invocationId: call.id,
        arguments: call.arguments,
      });

      // If the reviewer rejected, synthesize a tool-result message
      // carrying the rationale — the LLM reads it in the next
      // iteration and can adapt (retry with different args, ask the
      // user, apologize). NOT a run failure — reject is feedback, not
      // termination.
      if (toolRejectionPayload !== null) {
        const rejectResult = {
          status: 'rejected' as const,
          ...(toolRejectionPayload.rationale !== undefined && {
            rationale: toolRejectionPayload.rationale,
          }),
        };
        nextMessages = await appendToolResult(ctx, call, rejectResult, {
          toolId: tool.id as unknown as string,
          nextMessages,
          iterationAppended,
        });
        await emitTurnEvent(ctx.bindings.onEvent, {
          kind: 'tool.completed',
          step: partial.step,
          toolId: call.name,
          toolVersion: resolvedVersion,
          toolVersionRange: requestedRange,
          invocationId: call.id,
          output: rejectResult as never,
          durationMs: Date.now() - toolStarted,
        });
        continue;
      }

      // A replay's live call reads the env the past run's call saw.
      const replayEnv = replayed?.kind === 'live' ? replayed.env : undefined;
      // The call's tokens, asked fresh right before it runs and never
      // recorded: a connection that lapsed while it waited fails it.
      const connect: Connect | undefined =
        connected.kind === 'ready' ? () => freshConnections(ctx, kctx, call, tool) : undefined;
      const first = await dispatchOne(ctx, tool, call, kctx, replayEnv, connect);
      if (first.kind === 'not-connected') {
        nextMessages = await appendConnectionFailure(ctx, partial.step, call, binding, {
          failure: first.failure,
          started: true,
          target: { toolId: tool.id as unknown as string, nextMessages, iterationAppended },
        });
        continue;
      }
      // The app refused a connection's token: renewed, the call runs once more.
      const rejected = first.kind === 'err' ? rejectedConnectionOf(first.error, tool) : undefined;
      let dispatched = first;
      if (rejected !== undefined) {
        const renewed = await dispatchOne(ctx, tool, call, kctx, replayEnv, () =>
          freshConnections(ctx, kctx, call, tool, [rejected]),
        );
        if (renewed.kind === 'not-connected') {
          nextMessages = await appendConnectionFailure(ctx, partial.step, call, binding, {
            failure: renewed.failure,
            started: true,
            target: { toolId: tool.id as unknown as string, nextMessages, iterationAppended },
          });
          continue;
        }
        // Refused again: it fails with `connection-rejected`, as a call its
        // connections stop does, not as the tool's own failure: `toolErrors`
        // doesn't hand the model a call the app refused twice to retry.
        const again = refusedAgain(first, renewed, tool);
        if (again !== undefined) {
          nextMessages = await appendConnectionFailure(ctx, partial.step, call, binding, {
            failure: again,
            started: true,
            target: { toolId: tool.id as unknown as string, nextMessages, iterationAppended },
          });
          continue;
        }
        dispatched = renewed;
      }
      if (dispatched.kind === 'err') {
        // A token the tool echoed in what it threw goes no further: not to
        // the run's events, its record or the model.
        const error = withoutConnectionTokens(dispatched.error, [
          first.kind === 'err' ? first.connections : undefined,
          dispatched.connections,
        ]);
        await emitTurnEvent(ctx.bindings.onEvent, {
          kind: 'tool.failed',
          step: partial.step,
          toolId: call.name,
          invocationId: call.id,
          error: {
            code: error.code,
            message: error.message,
          },
        });
        nextMessages = await retryOrFail(ctx, call, error, error.validationIssues, {
          toolId: tool.id as unknown as string,
          nextMessages,
          iterationAppended,
        });
        continue;
      }

      ctx.appended.push(dispatched.value.persisted);
      iterationAppended.push(dispatched.value.persisted);
      nextMessages = [...nextMessages, dispatched.value.toolMessage];

      await emitTurnEvent(ctx.bindings.onEvent, {
        kind: 'tool.completed',
        step: partial.step,
        toolId: call.name,
        toolVersion: resolvedVersion,
        toolVersionRange: requestedRange,
        invocationId: call.id,
        output: dispatched.value.persisted.content,
        durationMs: Date.now() - toolStarted,
        // A recomputed call ran, as a live one does.
        ...(replayed !== undefined && {
          replay: replayed.kind === 'recomputed' ? ('live' as const) : replayed.kind,
        }),
      });
    }

    // Every call's nodes, once the step has all its results: the ones it
    // ran, the rejected and failed ones, and those it took from before a
    // park in this step.
    addStepToolNodes(ctx, partial.step, iterationAppended);

    const forwarded: Partial<AgentTurnIterationOutput> & {
      readonly step: number;
      readonly hasToolCalls: true;
    } = {
      step: partial.step,
      finishReason: partial.finishReason,
      message: assistantMsg,
      iterationAppended,
      iterationUsage: partial.iterationUsage,
      provider: partial.provider,
      nextMessages,
      hasToolCalls: true,
    };
    return forwarded;
  };
}

/**
 * Store the assistant message that makes the calls — or, resumed after a
 * park in this step, take the one stored before the park.
 */
async function persistToolCallMessage(
  ctx: TurnContext,
  assistantMsg: ModelMessage,
  step: number,
): Promise<ConversationMessage> {
  const callIds = (assistantMsg.toolCalls ?? []).map((tc) => tc.id);
  const stored = takeStoredBeforePark(ctx, (m) => m.role === 'agent' && sameCalls(m, callIds));
  if (stored !== undefined) return stored;
  const persisted = await ctx.bindings.conversationBinding.appendMessage({
    tenantId: ctx.input.tenantId,
    conversationId: ctx.input.conversationId,
    role: 'agent',
    content: {
      text: assistantMsg.content,
      toolCalls: (assistantMsg.toolCalls ?? []).map((tc) => ({ ...tc })),
    },
    actor: ctx.input.agent.id,
    isIntermediate: true,
  });
  if (persisted.kind === 'err') throwAgentTurnFailure(persisted.error);
  ctx.appended.push(persisted.value);
  await emitTurnEvent(ctx.bindings.onEvent, {
    kind: 'agent.message',
    step,
    isFinal: false,
    message: persisted.value,
  });
  return persisted.value;
}

/** Take the first message stored before the park that matches. */
function takeStoredBeforePark(
  ctx: TurnContext,
  matches: (m: ConversationMessage) => boolean,
): ConversationMessage | undefined {
  const index = ctx.storedBeforePark?.findIndex(matches) ?? -1;
  if (index < 0) return undefined;
  return ctx.storedBeforePark?.splice(index, 1)[0];
}

function sameCalls(m: ConversationMessage, callIds: readonly string[]): boolean {
  const calls = (m.content as { readonly toolCalls?: readonly { readonly id?: unknown }[] })
    .toolCalls;
  return (
    Array.isArray(calls) &&
    calls.length === callIds.length &&
    calls.every((c, i) => c.id === callIds[i])
  );
}

/** A stored tool result, as the model sees it. */
function toolMessageOf(stored: ConversationMessage, callId: string): ModelMessage {
  return {
    role: 'tool',
    content: toolResultForModel(stored.content, stored.fromEvent === true),
    toolCallId: callId,
  };
}

interface ToolResultTarget {
  /** The tool the result is for: its id, or the name the model used when the agent has no such tool. */
  readonly toolId: string;
  readonly nextMessages: readonly ModelMessage[];
  readonly iterationAppended: ConversationMessage[];
}

/**
 * Record a result the framework writes for a call (a rejection, a failed
 * call sent back to the model) the way a tool's own result is recorded:
 * persisted to the conversation with the call it answers, and added to
 * the messages the next model call sees.
 */
async function appendToolResult(
  ctx: TurnContext,
  call: ModelToolCall,
  output: unknown,
  target: ToolResultTarget,
): Promise<ModelMessage[]> {
  const persisted = await ctx.bindings.conversationBinding.appendMessage({
    tenantId: ctx.input.tenantId,
    conversationId: ctx.input.conversationId,
    role: 'tool',
    content: output as Record<string, unknown>,
    toolCall: { toolId: target.toolId, invocationId: call.id },
  });
  if (persisted.kind === 'err') throwAgentTurnFailure(persisted.error);
  ctx.appended.push(persisted.value);
  target.iterationAppended.push(persisted.value);
  return [
    ...target.nextMessages,
    {
      role: 'tool',
      // As a tool's own result reaches the model: a string as it is.
      content: typeof output === 'string' ? output : JSON.stringify(output),
      toolCallId: call.id,
    },
  ];
}

/**
 * A failed call the turn's policy retries goes back to the model as its
 * result, while retries are left; anything else fails the turn, with the
 * retries it took when the kind is one the policy retries.
 */
async function retryOrFail(
  ctx: TurnContext,
  call: ModelToolCall,
  error: UnresolvedToolError | ToolInvocationError,
  issues: readonly unknown[] | undefined,
  target: ToolResultTarget,
): Promise<ModelMessage[]> {
  const policy =
    ctx.toolErrorPolicy ?? effectiveToolErrorPolicy(ctx.input.agent.toolErrors, undefined);
  const kind = toolErrorKindOf(error);
  const used = toolRetriesSoFar(target.nextMessages);
  if (!policy.retryOn.has(kind)) throwAgentTurnFailure(error);
  if (used >= policy.maxRetries) throwAgentTurnFailure({ ...error, toolRetries: used });
  return appendToolResult(ctx, call, toolErrorResult(kind, error.message, issues), target);
}

/**
 * The turn's `authorizeToolCall` answer for a call, recorded with the call
 * (`when`: before any approval, or once it's approved); `undefined` when
 * there's nothing to ask. Each check is recorded under its own key, outside
 * the tool's own `ToolContext.record` keys (`toolCallRecordKey`). A throw
 * records nothing and fails the step: no answer never runs a call.
 */
async function authorizeCall(
  ctx: TurnContext,
  kctx: NodeContext,
  callId: string,
  tool: Tool,
  when: 'call' | 'approved',
): Promise<ToolCallAuthorization | undefined> {
  const authorize = ctx.bindings.authorizeToolCall;
  const toolId = tool.id as unknown as string;
  if (authorize === undefined || !asksAuthorization(ctx, toolId)) return undefined;
  // The version the call runs: the one the turn resolved for it (`resolveTurnTools`).
  const toolVersion = ctx.tools?.byName.get(toolId)?.resolvedVersion;
  return kctx.record(
    `${TOOL_AUTHORIZE_RECORD_PREFIX}${callId}:${toolId}${when === 'approved' ? ':approved' : ''}`,
    () =>
      authorize({
        tenantId: ctx.input.tenantId,
        projectId: ctx.input.projectId,
        ...(ctx.input.principal !== undefined && { principal: ctx.input.principal }),
        toolId,
        ...(toolVersion !== undefined && { toolVersion }),
      }),
  );
}

/** The record key prefix of a call's authorization decisions (`authorizeCall`). */
const TOOL_AUTHORIZE_RECORD_PREFIX = 'tool-authorize:';

/**
 * Whether a call is asked of `authorizeToolCall`: a registered tool's,
 * always; a built-in's (`kindgi_<verb>`), only when what it touches
 * reaches beyond the run's project (the rule is in `remember.ts`). A
 * built-in with no rule here is asked.
 */
function asksAuthorization(ctx: TurnContext, toolId: string): boolean {
  if (!toolId.startsWith(BUILT_IN_TOOL_PREFIX)) return true;
  const remember = ctx.input.agent.memory?.remember;
  if (toolId === REMEMBER_TOOL_ID && remember !== undefined) {
    return !rememberStaysInProject(remember);
  }
  return true;
}

/** A denied call's result, `{ status: 'denied', reason }`, stored and told to the model like any other. */
async function appendDenied(
  ctx: TurnContext,
  step: number,
  call: ModelToolCall,
  binding: { readonly resolvedVersion: string; readonly requestedRange: string },
  reason: string,
  target: ToolResultTarget,
): Promise<ModelMessage[]> {
  const started = Date.now();
  const denied = { status: 'denied' as const, reason };
  await emitTurnEvent(ctx.bindings.onEvent, {
    kind: 'tool.started',
    step,
    toolId: call.name,
    toolVersion: binding.resolvedVersion,
    toolVersionRange: binding.requestedRange,
    invocationId: call.id,
    arguments: call.arguments,
  });
  const nextMessages = await appendToolResult(ctx, call, denied, target);
  await emitTurnEvent(ctx.bindings.onEvent, {
    kind: 'tool.completed',
    step,
    toolId: call.name,
    toolVersion: binding.resolvedVersion,
    toolVersionRange: binding.requestedRange,
    invocationId: call.id,
    output: denied as never,
    durationMs: Date.now() - started,
  });
  return nextMessages;
}

/**
 * A call its connections stopped: it ran nothing, or the app refused its
 * renewed token too (`connection-rejected`). It fails with a
 * `connection-*` code (`tool.failed`), which the model reads as its result
 * (`{ status: 'failed', error }`). The turn goes on, and the failure counts
 * as no retry. `started`: `tool.started` was already sent for it.
 */
async function appendConnectionFailure(
  ctx: TurnContext,
  step: number,
  call: ModelToolCall,
  binding: { readonly resolvedVersion: string; readonly requestedRange: string },
  failed: {
    readonly failure: ConnectionCallFailure;
    readonly started: boolean;
    readonly target: ToolResultTarget;
  },
): Promise<ModelMessage[]> {
  if (!failed.started) {
    await emitTurnEvent(ctx.bindings.onEvent, {
      kind: 'tool.started',
      step,
      toolId: call.name,
      toolVersion: binding.resolvedVersion,
      toolVersionRange: binding.requestedRange,
      invocationId: call.id,
      arguments: call.arguments,
    });
  }
  await emitTurnEvent(ctx.bindings.onEvent, {
    kind: 'tool.failed',
    step,
    toolId: call.name,
    invocationId: call.id,
    error: { code: failed.failure.code, message: failed.failure.message },
  });
  return appendToolResult(ctx, call, connectionFailureResult(failed.failure), failed.target);
}

/** A call's run: what `dispatchOne` gives back. */
type Dispatched = Awaited<ReturnType<typeof dispatchOne>>;

/**
 * The renewed run's refusal, when the app refused its token too, with
 * both runs' tokens redacted (`rejectedAgainOf`).
 */
function refusedAgain(
  first: Dispatched,
  renewed: Dispatched,
  tool: Tool,
): ConnectionCallFailure | undefined {
  if (renewed.kind !== 'err') return undefined;
  const error = withoutConnectionTokens(renewed.error, [
    first.kind === 'err' ? first.connections : undefined,
    renewed.connections,
  ]);
  return rejectedAgainOf(error, tool);
}

async function dispatchOne(
  ctx: TurnContext,
  tool: Tool,
  call: ModelToolCall,
  kctx: NodeContext,
  replayEnv: Readonly<Record<string, string>> | undefined,
  connect: Connect | undefined,
): Promise<
  | {
      readonly kind: 'ok';
      readonly value: {
        readonly persisted: ConversationMessage;
        readonly toolMessage: ModelMessage;
      };
    }
  | {
      readonly kind: 'err';
      readonly error: {
        readonly code: 'tool-invocation-failed';
        readonly message: string;
        readonly toolId: string;
        readonly cause: unknown;
        readonly validationIssues?: readonly Readonly<Record<string, unknown>>[];
        readonly receivedInput?: unknown;
      };
      /** The tokens it ran with, kept out of what it threw. */
      readonly connections?: Readonly<Record<string, ToolConnection>>;
    }
  | { readonly kind: 'not-connected'; readonly failure: ConnectionCallFailure }
> {
  const toolCtx = toolContextFor(ctx, tool, call, kctx, replayEnv);
  const called = await callOrWait(tool, call, toolCtx, kctx, connect);
  if (called.kind === 'not-connected') return called;
  const { result, connections } = called;
  // Another system's answer, or a result the tool says is outside data.
  const fromOutside = called.fromOutside || tool.resultIsOutsideData === true;
  if (result.kind === 'err') {
    // Hoist AJV validation detail from the inner error so it survives
    // `toWireError` (which filters `cause` to avoid Error-instance /
    // cycle hazards). Two validation paths emit different field names
    // for the AJV array:
    //   - `packages/handler-runtime/src/handler-runner.ts` (pack code,
    //     run by the pack service) → `issues`
    //   - `packages/tools/src/invoke.ts` (in-process dispatch) → `errors`
    // Accept either. If neither shape is present, no hoisting —
    // the outer `tool-invocation-failed` stays minimal.
    const inner = result.error as {
      readonly code?: string;
      readonly issues?: readonly Readonly<Record<string, unknown>>[];
      readonly errors?: readonly Readonly<Record<string, unknown>>[];
    };
    const rawIssues = Array.isArray(inner.issues)
      ? inner.issues
      : Array.isArray(inner.errors)
        ? inner.errors
        : undefined;
    const isValidationFailure = inner.code === 'input-validation-failed' && rawIssues !== undefined;
    return {
      kind: 'err',
      error: {
        code: 'tool-invocation-failed',
        message: result.error.message,
        toolId: call.name,
        cause: result.error,
        ...(isValidationFailure && {
          validationIssues: rawIssues,
          receivedInput: truncateForWire(call.arguments),
        }),
      },
      ...(connections !== undefined && { connections }),
    };
  }
  const persist = await ctx.bindings.conversationBinding.appendMessage({
    tenantId: ctx.input.tenantId,
    conversationId: ctx.input.conversationId,
    role: 'tool',
    content: (result.value as unknown as string | Record<string, unknown>) ?? '',
    toolCall: { toolId: tool.id, invocationId: call.id },
    // Outside data stays data in every later turn's history.
    ...(fromOutside && { fromEvent: true as const }),
  });
  if (persist.kind === 'err') {
    // A DB failure persisting the tool result surfaces as the more
    // generic invocation-failed to keep the caller's error shape stable.
    return {
      kind: 'err',
      error: {
        code: 'tool-invocation-failed',
        message: persist.error.message,
        toolId: tool.id,
        cause: persist.error,
      },
    };
  }
  return {
    kind: 'ok',
    value: {
      persisted: persist.value,
      toolMessage: {
        role: 'tool',
        content: toolResultForModel(result.value, fromOutside),
        toolCallId: call.id,
      },
    },
  };
}

/** The context a call's tool runs with. */
function toolContextFor(
  ctx: TurnContext,
  tool: Tool,
  call: ModelToolCall,
  kctx: NodeContext,
  replayEnv: Readonly<Record<string, string>> | undefined,
): ToolContext {
  const runId = kctx.runId as unknown as string;
  const toolId = tool.id as unknown as string;
  return {
    tenantId: ctx.input.tenantId,
    runId,
    // The run's own project and org, never the model's arguments.
    projectId: ctx.input.projectId,
    ...(ctx.input.orgId !== undefined && { orgId: ctx.input.orgId }),
    requestId: call.id,
    // The same every time this call runs, so the tool can dedupe a side
    // effect on it; with the step's scope, since a model's call id is only
    // unique within one answer (two loop iterations may share one).
    ...(kctx.stepScope !== undefined && {
      idempotencyKey: toolIdempotencyKey({
        runId,
        stepScope: kctx.stepScope,
        toolId,
        callId: call.id,
      }),
    }),
    ...(kctx.attempt !== undefined && { attempt: kctx.attempt }),
    abortSignal: ctx.turnAbort.signal,
    // HTTP tools built via defineTool({spec: {kind: 'http'}}) resolve declared
    // secret_refs at invoke time. Present iff the caller wired
    // `bindings.resolveSecret` from a tenant-scoped `SecretBinding`.
    ...(ctx.bindings.resolveSecret !== undefined && { resolveSecret: ctx.bindings.resolveSecret }),
    // The pinned settings blocks' values, by block id.
    ...(ctx.blocks !== undefined && { settings: ctx.blocks.settings }),
    // The call's durable decisions (its resolved env): this step's own
    // record, keyed by the call and the tool (`toolCallRecordKey`).
    record: (key, decide) =>
      kctx.record(toolCallRecordKey({ toolId, key, callId: call.id }), decide),
    // A replay's live call: the past run's env values for the tool.
    ...(replayEnv !== undefined && { env: replayEnv }),
  };
}

/** The call's tokens, asked fresh right before its tool runs (`freshConnections`). */
type Connect = () => ReturnType<typeof freshConnections>;

/**
 * The context the call's tool runs with: with the connections it declares,
 * asked fresh for this run of it (`connect`).
 */
async function connectedContext(
  toolCtx: ToolContext,
  connect: Connect | undefined,
): Promise<
  | {
      readonly kind: 'ready';
      readonly toolCtx: ToolContext;
      readonly connections?: Readonly<Record<string, ToolConnection>>;
    }
  | { readonly kind: 'failed'; readonly failure: ConnectionCallFailure }
> {
  if (connect === undefined) return { kind: 'ready', toolCtx };
  const fresh = await connect();
  if (fresh.kind === 'failed') return fresh;
  const { connections } = fresh;
  return { kind: 'ready', toolCtx: { ...toolCtx, connections }, connections };
}

/** The record key prefix of a pausing call's pause (`callOrWait`). */
const TOOL_PAUSE_RECORD_PREFIX = 'tool-pause:';

/**
 * Call `tool`. A tool that pauses (`Tool.pauses`) may make the call wait
 * for another system's answer: the step parks on the call's wait token
 * until the answer comes, or the pause's time passes
 * (`wait-token-timed-out`, a failed call). The answer, which the runtime
 * checked against the tool's output schema before it took it, is the
 * call's result, from outside the run (`fromOutside`).
 *
 * The pause is recorded before the step parks, so the step the answer
 * resumes waits on the same token instead of calling the tool again. Its
 * key carries the attempt: a step's records are shared by its attempts,
 * and a retried step's call waits on a new token. A result isn't recorded
 * (a `decide` that returns `undefined` isn't journaled): the conversation
 * keeps it already.
 *
 * The call's tokens are asked (`connect`) only when the tool runs: the
 * step the answer resumes reads the pause back and runs nothing, so a
 * connection that lapsed while it waited doesn't lose the answer. A call
 * its connections stop runs nothing (`not-connected`).
 */
async function callOrWait(
  tool: Tool,
  call: ModelToolCall,
  toolCtx: ToolContext,
  kctx: NodeContext,
  connect: Connect | undefined,
): Promise<
  | {
      readonly kind: 'called';
      readonly result: Result<unknown, ToolError>;
      readonly fromOutside: boolean;
      /** The tokens it ran with: none for an answer from outside. */
      readonly connections?: Readonly<Record<string, ToolConnection>>;
    }
  | { readonly kind: 'not-connected'; readonly failure: ConnectionCallFailure }
> {
  if (tool.pauses !== true) {
    const ready = await connectedContext(toolCtx, connect);
    if (ready.kind === 'failed') return { kind: 'not-connected', failure: ready.failure };
    const result = await invokeTool(tool, call.arguments, ready.toolCtx);
    return {
      kind: 'called',
      result,
      fromOutside: false,
      ...(ready.connections !== undefined && { connections: ready.connections }),
    };
  }
  const toolId = tool.id as unknown as string;
  const answered: {
    result?: Result<unknown, ToolError>;
    connections?: Readonly<Record<string, ToolConnection>>;
    failure?: ConnectionCallFailure;
  } = {};
  const pause = await kctx.record(
    `${TOOL_PAUSE_RECORD_PREFIX}${toolId}:${call.id}:${kctx.attempt ?? 1}`,
    async (): Promise<ToolPause | undefined> => {
      const ready = await connectedContext(toolCtx, connect);
      if (ready.kind === 'failed') {
        answered.failure = ready.failure;
        return undefined;
      }
      if (ready.connections !== undefined) answered.connections = ready.connections;
      const outcome = await invokeToolOrPause(tool, call.arguments, ready.toolCtx);
      if (outcome.kind === 'pause') return outcome.pause;
      answered.result = outcome;
      return undefined;
    },
  );
  if (pause === undefined) {
    if (answered.failure !== undefined) return { kind: 'not-connected', failure: answered.failure };
    if (answered.result === undefined) {
      // Only a host whose `record` keeps an `undefined` gets here.
      throw new Error(`The call ${call.id} to ${toolId} recorded no pause and kept no result`);
    }
    return {
      kind: 'called',
      result: answered.result,
      fromOutside: false,
      ...(answered.connections !== undefined && { connections: answered.connections }),
    };
  }
  return { kind: 'called', ...(await answerOf(tool, pause, kctx)) };
}

/**
 * A recorded pause's answer, from outside the run; or its time passing
 * (`wait-token-timed-out`), a failed call.
 */
async function answerOf(
  tool: Tool,
  pause: ToolPause,
  kctx: NodeContext,
): Promise<{ readonly result: Result<unknown, ToolError>; readonly fromOutside: boolean }> {
  try {
    const answer = await kctx.waitForToken<unknown>(pause.tokenId, {
      timeoutMs: pause.timeoutMs,
    });
    return { result: { kind: 'ok', value: answer }, fromOutside: true };
  } catch (cause) {
    if (!(cause instanceof WaitpointCancelledError) || cause.reason !== WAITPOINT_TIMEOUT_REASON) {
      throw cause;
    }
    const timedOut: WaitTokenTimedOutError = {
      code: 'wait-token-timed-out',
      message: `Tool "${tool.id as unknown as string}" waited ${pause.timeoutMs} ms for ${pause.name ?? "another system's answer"}, and no answer came`,
      toolId: tool.id,
      tokenId: pause.tokenId,
      timeoutMs: pause.timeoutMs,
    };
    return { result: { kind: 'err', error: timedOut }, fromOutside: false };
  }
}

/**
 * Cap `receivedInput` on validation errors so a huge tool-arg blob
 * doesn't bloat the wire response body. 4 KiB stringified is
 * comfortably larger than a typical LLM tool-call payload
 * (place-name, query, message) but small enough that a
 * pathological array/document truncates rather than round-trips
 * megabytes. Truncated payloads land as a string with a trailing
 * marker so callers can tell the value was elided.
 */
function truncateForWire(input: unknown, maxBytes = 4096): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return '<unserializable input>';
  }
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return input;
  return `${serialized.slice(0, maxBytes)}… (truncated at ${maxBytes} bytes)`;
}
