// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ModelMessage, ModelToolCall } from '@kindgi/capabilities';
import type { NodeContext, NodeHandler } from '@kindgi/handler';
import { WaitpointCancelledError } from '@kindgi/handler';
import { stricterToolHitlRule } from '@kindgi/policy-contract';
import { invokeTool } from '@kindgi/tools';
import type { Tool, ToolContext } from '@kindgi/tools';

import { emitTurnEvent } from '../streaming.js';
import type { ConversationMessage, ToolHitlMode, ToolHitlRule } from '../types.js';

import type { EffectiveHitlPolicy } from '../hitl-policy.js';

import type { AgentTurnIterationOutput, TurnContext } from './context.js';
import {
  type ToolInvocationError,
  type UnresolvedToolError,
  throwAgentTurnFailure,
} from './errors.js';
import { TOOL_CALL_GATE_SUBJECT, readGateDecision } from './gate-decision.js';
import { decideReplayTool } from './replay.js';
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
 * resolver's output.
 */
function resolveEffectiveToolHitl(
  effective: EffectiveHitlPolicy,
  tool: Tool,
): { readonly mode: ToolHitlMode; readonly requiredRole: 'standard' | 'senior' | 'admin' } {
  const gate = agentToolHitl(effective, tool);
  // The tenant's floor for this tool, when it names one: the stricter wins.
  const floor = effective.toolFloors?.get(tool.id as unknown as string);
  if (floor === undefined) return gate;
  const stricter = stricterToolHitlRule(gate, floor);
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
}

/**
 * Whether `call` waits for a review, decided once (`NodeContext.record`):
 * a step resumed after the park reads the gate it parked on back, so a
 * policy relaxed meanwhile can't skip the reviewer's answer. A call the
 * gate lets through isn't recorded: it runs, and its stored result is
 * reused after a park further down the list.
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
  return kctx.record(`${TOOL_GATE_RECORD_PREFIX}${call.id}`, (): ToolGateRecord | undefined => {
    const resolved = resolveEffectiveToolHitl(effectiveHitl, tool);
    if (resolved.mode === 'never_ask') return undefined;
    const argsHash = hashToolArgs(call.arguments);
    return {
      argsHash,
      waitTokenId: computeToolCallWaitToken({
        runId: kctx.runId as unknown as string,
        callId: call.id,
        argsHash,
      }),
      requiredRole: resolved.requiredRole,
      timeoutMs: effectiveHitl.timeoutMs,
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
      if (replayed !== undefined && replayed.kind !== 'live') {
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

      let toolRejectionPayload: { readonly rationale?: string } | null = null;
      if (gate !== undefined) {
        const { argsHash, waitTokenId, timeoutMs } = gate;
        const expiresAt = new Date(Date.now() + timeoutMs).toISOString();

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
              title: `HITL review: ${call.name}`,
              description: `Tool call ${call.name} awaiting reviewer approval before dispatch.`,
              waitTokenId,
              provenanceRef: { runId: kctx.runId },
              expiresAt: expiresAt as never,
            });
          } catch {
            // Enqueue failure is soft — waitForToken parks either way.
          }
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
            throwAgentTurnFailure({
              code: 'hitl-cancelled',
              message: `Tool-call HITL cancelled for ${call.name}: ${cause.reason}`,
              reason: cause.reason,
            } as never);
          }
          throw cause;
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

      const dispatched = await dispatchOne(ctx, tool, call, kctx.runId as unknown as string);
      if (dispatched.kind === 'err') {
        await emitTurnEvent(ctx.bindings.onEvent, {
          kind: 'tool.failed',
          step: partial.step,
          toolId: call.name,
          invocationId: call.id,
          error: {
            code: dispatched.error.code,
            message: dispatched.error.message,
          },
        });
        nextMessages = await retryOrFail(
          ctx,
          call,
          dispatched.error,
          dispatched.error.validationIssues,
          { toolId: tool.id as unknown as string, nextMessages, iterationAppended },
        );
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
        ...(replayed !== undefined && { replay: replayed.kind }),
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
    content: typeof stored.content === 'string' ? stored.content : JSON.stringify(stored.content),
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

async function dispatchOne(
  ctx: TurnContext,
  tool: Tool,
  call: ModelToolCall,
  runId: string,
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
    }
> {
  const toolCtx: ToolContext = {
    tenantId: ctx.input.tenantId,
    runId,
    // The run's own project and org, never the model's arguments.
    projectId: ctx.input.projectId,
    ...(ctx.input.orgId !== undefined && { orgId: ctx.input.orgId }),
    requestId: call.id,
    abortSignal: ctx.turnAbort.signal,
    // HTTP tools built via defineTool({spec: {kind: 'http'}}) resolve declared
    // secret_refs at invoke time. Present iff the caller wired
    // `bindings.resolveSecret` from a tenant-scoped `SecretBinding`.
    ...(ctx.bindings.resolveSecret !== undefined && { resolveSecret: ctx.bindings.resolveSecret }),
    // The pinned settings blocks' values, by block id.
    ...(ctx.blocks !== undefined && { settings: ctx.blocks.settings }),
  };
  const result = await invokeTool(tool, call.arguments, toolCtx);
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
    };
  }
  const persist = await ctx.bindings.conversationBinding.appendMessage({
    tenantId: ctx.input.tenantId,
    conversationId: ctx.input.conversationId,
    role: 'tool',
    content: (result.value as unknown as string | Record<string, unknown>) ?? '',
    toolCall: { toolId: tool.id, invocationId: call.id },
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
        content: typeof result.value === 'string' ? result.value : JSON.stringify(result.value),
        toolCallId: call.id,
      },
    },
  };
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
