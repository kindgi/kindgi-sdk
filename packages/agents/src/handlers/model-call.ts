// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import {
  type MessageFile,
  type ModelCallInput,
  type ModelCallResult,
  type ModelCallWarning,
  type ModelInfo,
  type ModelMessage,
  type ModelProvider,
  type ModelUsageRecord,
  recordModelUsage,
} from '@kindgi/capabilities';
import { attemptsOf } from '@kindgi/capabilities/attempts';
import type { NodeContext, NodeHandler } from '@kindgi/handler';
import type { Timestamp } from '@kindgi/types';

import { emitTurnEvent } from '../streaming.js';

import type { AgentTurnIterationOutput, TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';
import { agentSeesFiles, callFiles, filesLeftOut, isImageOrPdf, messagesForCall } from './files.js';
import { replayTag } from './replay.js';
import { chargeTurnMemory } from './turn-memory.js';
import { type FileRead, addModelCallNode, filesReadOf } from './turn-provenance.js';

/**
 * Loop-body node #1. Invoke the model with the current
 * `nextMessages` accumulator. Emits `model.call.started` +
 * `model.call.completed`, records provenance for the model-call node,
 * and accumulates usage on `ctx.usage`.
 *
 * Every call is recorded in the usage sink (`InvokeAgentBindings.usage`,
 * the runtime's cost ledger) before the step goes on, a call that threw
 * included. A sink that fails is tried again (a record is idempotent by
 * call id); one that still fails fails the step when the call succeeded,
 * so no answered call is left unrecorded. A call that failed keeps its
 * own failure, which says it couldn't be recorded too. The call's id goes into
 * the step's output and its provenance node, which keeps the call's
 * identity (provider, model) while its usage lives in the ledger. A dry
 * run spends nothing and records nothing.
 *
 * A call the provider refuses as an invalid request while it carries
 * images or PDFs is tried once more in the same step, with a line in each
 * one's place (`retryWithoutFiles`). When that call answers, the turn goes
 * on without them, and the files binding marks them (`refuse`). A call
 * that answers tells the binding which files its model was shown (`shown`).
 *
 * Output is a partial `AgentTurnIterationOutput` — `dispatch-tools`
 * receives it and finishes composing the iteration output.
 */
export function buildModelCallHandler(ctx: TurnContext): NodeHandler {
  return async (input: unknown, kctx) => {
    if (ctx.provider === undefined || ctx.model === undefined || ctx.tools === undefined) {
      throwAgentTurnFailure({
        code: 'model-invocation-failed',
        message: 'model-call invoked before setup completed',
        cause: null,
      });
    }
    const shaped = input as { readonly nextMessages?: readonly ModelMessage[] } | undefined;
    const nextMessages: readonly ModelMessage[] = shaped?.nextMessages ?? [];
    // The call's own copy: an agent that doesn't need `vision` reads a line
    // for each image and PDF, and any agent for each one the turn's model
    // couldn't read. The journal keeps `nextMessages` as they are.
    const seesFiles = agentSeesFiles(ctx.input.agent);
    const messages = messagesForCall(nextMessages, seesFiles, ctx.refusedFiles);

    // What the turn holds, charged before the model is called: the iterations
    // done so far are its steps (restored on a resume). A dry run holds nothing.
    if (!kctx.dryRun) {
      const files = callFiles(messages, ctx.model);
      await chargeTurnMemory(ctx, kctx, { messages, files }, ctx.usage.steps);
    }

    ctx.usage.steps += 1;
    const step = ctx.usage.steps;
    const providerId = ctx.provider.metadata.id;
    const model = ctx.model.name;
    // Each call's start: a step whose call is retried has two.
    const announce = () =>
      emitTurnEvent(ctx.bindings.onEvent, { kind: 'model.call.started', step, providerId, model });

    await announce();

    const { answered, warnings } = kctx.dryRun
      ? { answered: dryRunAnswer(providerId, model, messages), warnings: [] }
      : await callModel(ctx, kctx, {
          step,
          messages,
          nextMessages,
          seesFiles,
          model: ctx.model,
          announce,
          send: senderOf(ctx, ctx.provider, {
            model,
            ...(ctx.tools.definitions.length > 0 && {
              tools: ctx.tools.definitions,
            }),
            ...modelSettingsOf(ctx),
            abortSignal: ctx.turnAbort.signal,
          }),
        });
    const { callId, result: callResult } = answered;
    const files = callFiles(answered.messages, ctx.model);

    ctx.usage.promptTokens += callResult.usage.promptTokens;
    ctx.usage.completionTokens += callResult.usage.completionTokens;
    ctx.usage.totalCostUsd += callResult.costUsd;
    ctx.lastProvider = callResult.provider;
    addModelWarnings(ctx, warnings);

    await emitTurnEvent(ctx.bindings.onEvent, {
      kind: 'model.call.completed',
      step: ctx.usage.steps,
      finishReason: callResult.finishReason,
      promptTokens: callResult.usage.promptTokens,
      completionTokens: callResult.usage.completionTokens,
      costUsd: callResult.costUsd,
      durationMs: callResult.durationMs,
    });

    if (ctx.provenance !== undefined && ctx.userMessage !== undefined) {
      addModelCallNode(
        ctx.provenance,
        {
          step: ctx.usage.steps,
          callId,
          provider: callResult.provider,
          finishReason: callResult.finishReason,
          at: new Date().toISOString() as Timestamp,
          files,
        },
        ctx.userMessage.sequence,
        ctx.toolResultIds ?? [],
      );
    }

    // Partial iteration output — `dispatch-tools` finishes it.
    const partial: Omit<AgentTurnIterationOutput, 'iterationAppended' | 'finishedTurn'> & {
      readonly step: number;
      readonly callId: string;
      readonly files?: readonly FileRead[];
      readonly refused?: readonly string[];
    } = {
      step: ctx.usage.steps,
      callId,
      finishReason: callResult.finishReason,
      message: callResult.message,
      iterationUsage: {
        promptTokens: callResult.usage.promptTokens,
        completionTokens: callResult.usage.completionTokens,
        costUsd: callResult.costUsd,
      },
      provider: callResult.provider,
      ...(warnings.length > 0 && { warnings }),
      nextMessages,
      // For the turn's provenance when it's rebuilt on a resume.
      ...filesReadOf(files),
      // For the rest of the turn when it's resumed: the files left out.
      ...(answered.refused.length > 0 && {
        refused: answered.refused.map((file) => file.artifactId),
      }),
    };
    return partial;
  };
}

/** Keep a call's warnings for the turn's result: one per code, its first message. */
export function addModelWarnings(
  ctx: TurnContext,
  warnings: readonly { readonly code: string; readonly message: string }[] | undefined,
): void {
  if (warnings === undefined || warnings.length === 0) return;
  const kept = ctx.modelWarnings ?? new Map<string, string>();
  ctx.modelWarnings = kept;
  for (const w of warnings) if (!kept.has(w.code)) kept.set(w.code, w.message);
}

/**
 * A call that answered: record it before the step goes on. A sink that
 * still fails after its retries fails the step: an answered call isn't
 * left unrecorded.
 */
async function recordAnswer(
  ctx: TurnContext,
  kctx: NodeContext,
  callId: string,
  step: number,
  answer: Awaited<ReturnType<ModelProvider['invoke']>>,
): Promise<void> {
  const { message: _answer, ...result } = answer;
  const unrecorded = await recordCall(ctx, kctx, {
    callId,
    step,
    status: 'ok',
    result,
    durationMs: answer.durationMs,
  });
  if (unrecorded !== undefined) {
    throwAgentTurnFailure({
      code: 'persistence-error',
      message: `The model call couldn't be recorded: ${describeCause(unrecorded)}`,
      cause: unrecorded,
    });
  }
}

/** What a step's model call came to: the call that answered, and what it was sent. */
interface Answered {
  readonly callId: string;
  readonly result: ModelCallResult;
  readonly messages: readonly ModelMessage[];
  /** The images and PDFs it was sent (`carriedFiles`). */
  readonly carried: readonly MessageFile[];
  /** The ones a refused call carried, which this call was sent a line for instead. */
  readonly refused: readonly MessageFile[];
}

/**
 * Dry-run: skip the network call. A schema-conformant mock indicating the
 * model would have terminated cleanly. The mock requests no tools, so a
 * dry run does not preview tool planning.
 */
function dryRunAnswer(
  providerId: string,
  model: string,
  messages: readonly ModelMessage[],
): Answered {
  const result: ModelCallResult = {
    finishReason: 'stop',
    message: { role: 'assistant', content: '[dry-run: model call skipped]' },
    usage: { promptTokens: 0, completionTokens: 0 },
    costUsd: 0,
    durationMs: 0,
    provider: { id: providerId, model },
  };
  return { callId: randomUUID(), result, messages, carried: [], refused: [] };
}

/** The step's call, as `callModel` sends it, and retries it. */
interface StepCall {
  readonly step: number;
  /** The call's own copy of the messages (`messagesForCall`). */
  readonly messages: readonly ModelMessage[];
  /** The messages as the journal keeps them. */
  readonly nextMessages: readonly ModelMessage[];
  readonly seesFiles: boolean;
  /** The model it's sent to: which files the call's limits leave out depends on it. */
  readonly model: ModelInfo;
  /** Emits a call's `model.call.started`. */
  readonly announce: () => Promise<void>;
  readonly send: (messages: readonly ModelMessage[]) => Promise<Sent>;
}

/**
 * Send the step's call, and once more without the files it carried when
 * the provider refuses them (`retryWithoutFiles`). Record the call that
 * answered, and tell the files binding what it was shown (`markFiles`):
 * the answer's warnings, then those.
 */
async function callModel(
  ctx: TurnContext,
  kctx: NodeContext,
  call: StepCall,
): Promise<{ readonly answered: Answered; readonly warnings: readonly ModelCallWarning[] }> {
  const callId = randomUUID();
  const sent = await call.send(call.messages);
  const answered =
    'result' in sent
      ? { callId, result: sent.result, messages: call.messages, carried: sent.carried, refused: [] }
      : await retryWithoutFiles(ctx, kctx, call, { callId, failed: sent });
  await recordAnswer(ctx, kctx, answered.callId, call.step, answered.result);
  const marks = await markFiles(ctx, answered);
  return { answered, warnings: [...(answered.result.warnings ?? []), ...marks] };
}

/**
 * One call sent: its answer, or what it threw; and the images and PDFs it
 * carried. A call that threw also says which files' bytes it asked for.
 */
type Sent =
  | { readonly result: ModelCallResult; readonly carried: readonly MessageFile[] }
  | {
      readonly cause: unknown;
      readonly startedAt: number;
      readonly carried: readonly MessageFile[];
      readonly asked: ReadonlySet<string>;
    };

/**
 * Sends a call with the step's messages. The call reads a stored file's
 * bytes through the turn's files binding, which asks the run's rule again
 * first; without one, each file is a line saying it isn't stored. What it
 * read decides which files it carried.
 */
function senderOf(
  ctx: TurnContext,
  provider: ModelProvider,
  base: Omit<ModelCallInput, 'messages' | 'readFile'>,
): (messages: readonly ModelMessage[]) => Promise<Sent> {
  return async (messages) => {
    const binding = ctx.files;
    const asked = new Set<string>();
    const read = new Set<string>();
    const readFile = async (artifactId: string) => {
      asked.add(artifactId);
      const bytes = await binding?.read(artifactId);
      if (bytes !== undefined) read.add(artifactId);
      return bytes;
    };
    const startedAt = Date.now();
    try {
      const result = await provider.invoke({
        ...base,
        messages,
        ...(binding !== undefined && { readFile }),
      });
      return { result, carried: carriedFiles(messages, read) };
    } catch (cause) {
      return { cause, startedAt, carried: carriedFiles(messages, read), asked };
    }
  };
}

/**
 * The images and PDFs a call carried: those its messages hold with no
 * reason not to be shown, whose bytes its `readFile` gave. Each once.
 */
function carriedFiles(
  messages: readonly ModelMessage[],
  read: ReadonlySet<string>,
): readonly MessageFile[] {
  if (read.size === 0) return [];
  const carried = new Map<string, MessageFile>();
  for (const file of messages.flatMap((message) => message.files ?? [])) {
    if (file.notShown === undefined && isImageOrPdf(file) && read.has(file.artifactId)) {
      if (!carried.has(file.artifactId)) carried.set(file.artifactId, file);
    }
  }
  return [...carried.values()];
}

/**
 * A call that threw. The provider refused it as an invalid request
 * (`invalidRequest`) while it carried images or PDFs, so one of them may be
 * what it can't read: the same call is sent once more, in the same step,
 * with a line in each one's place. The files the first call left out for
 * its limits are left out again (`filesLeftOut`), so the second call is the
 * first without the files it carried. When that call answers, it's the
 * step's, and the turn goes on without them. When it throws too, the step
 * fails with the first call's failure.
 *
 * Any other failure fails the step as it is, and keeps the files: a 429, a
 * 5xx, no response, auth, a context too long, a content filter, an error
 * with no kind, or an aborted turn. So does a turn that has retried once,
 * or has spent its cost budget (the second call would spend more), or
 * whose failed call couldn't be recorded. Both calls are recorded, each
 * with its own id, and the second counts against the turn's cost but not
 * its steps.
 */
async function retryWithoutFiles(
  ctx: TurnContext,
  kctx: NodeContext,
  call: StepCall,
  first: { readonly callId: string; readonly failed: Extract<Sent, { readonly cause: unknown }> },
): Promise<Answered> {
  const { step } = call;
  const { cause, carried, startedAt, asked } = first.failed;
  const failure = { callId: first.callId, step, cause, startedAt };
  if (
    carried.length === 0 ||
    ctx.filesRetried === true ||
    ctx.turnAbort.signal.aborted ||
    !invalidRequest(cause)
  ) {
    return await failCall(ctx, kctx, failure);
  }
  if (spentCostBudget(ctx)) {
    const s = carried.length === 1 ? '' : 's';
    return await failCall(ctx, kctx, failure, {
      note: ` (not retried without the attached file${s} ${fileNames(carried)}: the turn has spent its cost budget)`,
    });
  }
  const unrecorded = await recordFailure(ctx, kctx, failure);
  if (unrecorded !== '') throwCallFailure(ctx, cause, unrecorded);

  ctx.filesRetried = true;
  const refused = new Set([...(ctx.refusedFiles ?? []), ...carried.map((f) => f.artifactId)]);
  const leftOut = filesLeftOut(call.messages, call.model, asked);
  const messages = messagesForCall(call.nextMessages, call.seesFiles, refused, leftOut);
  const callId = randomUUID();
  await call.announce();
  const again = await call.send(messages);
  if (!('result' in again)) {
    const retry = { callId, step, cause: again.cause, startedAt: again.startedAt };
    const retryUnrecorded = await recordFailure(ctx, kctx, retry, 'retried call');
    // The caller is told the first call's failure: the retry was the
    // turn's own. An abort meanwhile is the abort.
    throwCallFailure(ctx, ctx.turnAbort.signal.aborted ? again.cause : cause, retryUnrecorded);
  }
  ctx.refusedFiles = refused;
  return { callId, result: again.result, messages, carried: again.carried, refused: carried };
}

/**
 * The adapters' `ModelProviderError` of kind `invalid-request` (any 4xx
 * `kindOf` doesn't place otherwise), by its shape: agents doesn't depend on
 * the adapters.
 */
function invalidRequest(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.name === 'ModelProviderError' &&
    (cause as { readonly kind?: unknown }).kind === 'invalid-request'
  );
}

/**
 * Whether the turn has spent its cost budget: the loop goes on while it
 * hasn't gone past it, but another call at it would.
 */
function spentCostBudget(ctx: TurnContext): boolean {
  const limit = ctx.input.agent.budget?.maxCostUsd;
  return limit !== undefined && ctx.usage.totalCostUsd >= limit;
}

/** A file was left out after a call carrying it was refused (`retryWithoutFiles`). */
const FILE_REFUSED = 'file-refused';
/** The files binding couldn't record what a call was shown, or what it couldn't read. */
const FILE_RECORD_FAILED = 'file-record-failed';

/**
 * Tell the files binding what the answered call's model was shown, and
 * which files it was sent lines for after a refusal. The caller gets a
 * `file-refused` warning naming those. A binding that fails is a
 * `file-record-failed` warning, and the turn goes on: a later turn sends
 * the file again. A file this turn already told the binding was shown
 * isn't told again.
 */
async function markFiles(ctx: TurnContext, answered: Answered): Promise<ModelCallWarning[]> {
  const binding = ctx.files;
  const warnings: ModelCallWarning[] = [];
  if (binding === undefined) return warnings;
  const { refused } = answered;
  if (refused.length > 0) {
    const them = refused.length === 1 ? 'it' : 'them';
    warnings.push({
      code: FILE_REFUSED,
      message: `The model's provider refused the call with ${fileNames(refused)} attached as an invalid request. The same call without ${them} answered, and the turn went on without ${them}.`,
    });
    try {
      await binding.refuse(refused.map((file) => file.artifactId));
    } catch (cause) {
      warnings.push({
        code: FILE_RECORD_FAILED,
        message: `Recording that the model couldn't read ${fileNames(refused)} failed: ${describeCause(cause)}. A later turn sends ${them} again.`,
      });
    }
  }
  const told = ctx.shownFiles ?? new Set<string>();
  ctx.shownFiles = told;
  const shown = answered.carried.filter((file) => !told.has(file.artifactId));
  if (shown.length === 0) return warnings;
  try {
    await binding.shown(shown.map((file) => file.artifactId));
    for (const file of shown) told.add(file.artifactId);
  } catch (cause) {
    warnings.push({
      code: FILE_RECORD_FAILED,
      message: `Recording that the model was shown ${fileNames(shown)} failed: ${describeCause(cause)}.`,
    });
  }
  return warnings;
}

/** Files by name, each quoted and cut to 200 characters, as the model's lines name them. */
function fileNames(files: readonly MessageFile[]): string {
  return files.map((file) => JSON.stringify((file.name ?? 'unnamed').slice(0, 200))).join(', ');
}

/**
 * A call that threw: record it, then fail the step with the call's own
 * failure (aborted, or the provider's words), then `note`. A record that
 * failed too is said after it.
 */
async function failCall(
  ctx: TurnContext,
  kctx: NodeContext,
  failed: CallFailure,
  options: { readonly note?: string } = {},
): Promise<never> {
  const unrecorded = await recordFailure(ctx, kctx, failed);
  throwCallFailure(ctx, failed.cause, `${options.note ?? ''}${unrecorded}`);
}

/** A call that threw, for `recordFailure`. */
interface CallFailure {
  readonly callId: string;
  readonly step: number;
  readonly cause: unknown;
  readonly startedAt: number;
}

/**
 * Record a call that threw. Resolves with what to say after the step's
 * failure when it couldn't be recorded, or `''`.
 */
async function recordFailure(
  ctx: TurnContext,
  kctx: NodeContext,
  failed: CallFailure,
  which = 'failed call',
): Promise<string> {
  const { cause } = failed;
  const attempts = attemptsOf(cause);
  const unrecorded = await recordCall(ctx, kctx, {
    callId: failed.callId,
    step: failed.step,
    status: 'failed',
    error: { message: describeCause(cause), ...(attempts !== undefined && { attempts }) },
    durationMs: Date.now() - failed.startedAt,
  });
  return unrecorded === undefined
    ? ''
    : ` (and the ${which} couldn't be recorded: ${describeCause(unrecorded)})`;
}

/** Fail the step with a call's failure: the turn's abort, or the provider's words. */
function throwCallFailure(ctx: TurnContext, cause: unknown, after: string): never {
  if (ctx.turnAbort.signal.aborted) {
    throwAgentTurnFailure({
      code: 'agent-turn-aborted',
      message: `Agent turn aborted: ${cause instanceof Error ? cause.message : String(cause)}${after}`,
      reason: ctx.abortReason ?? 'timeout',
    });
  }
  // The provider's own words (a 401's "invalid x-api-key", a 429) are
  // what the caller needs; they're in `cause` too, but callers show
  // `message`.
  throwAgentTurnFailure({
    code: 'model-invocation-failed',
    message: `Model call to ${ctx.provider?.metadata.id} (${ctx.model?.name}) failed: ${describeCause(cause)}${after}`,
    cause,
  });
}

/** What the call came to, for `recordCall`. */
type CallOutcome = Pick<
  ModelUsageRecord,
  'callId' | 'step' | 'status' | 'result' | 'error' | 'durationMs'
>;

/**
 * Record a model call in the usage sink, when the turn has one, trying
 * a failing sink again. Resolves with the sink's last failure when it
 * couldn't record; the caller decides what that means for the step.
 */
async function recordCall(
  ctx: TurnContext,
  kctx: NodeContext,
  call: CallOutcome,
): Promise<unknown | undefined> {
  const sink = ctx.bindings.usage;
  if (sink === undefined || ctx.provider === undefined || ctx.model === undefined) return;
  const { input } = ctx;
  const recorded = await recordModelUsage(sink, {
    ...call,
    tenantId: input.tenantId,
    projectId: input.projectId,
    runId: kctx.runId,
    agentId: input.agent.id as unknown as string,
    agentVersion: input.agent.version,
    conversationId: input.conversationId as unknown as string,
    nodeId: kctx.nodeId as unknown as string,
    providerId: ctx.provider.metadata.id,
    model: ctx.model.name,
    ...(ctx.provider.metadata.fallback === true && { fallback: true }),
    ...(input.replay !== undefined && { replay: replayTag(input.replay) }),
    occurredAt: new Date().toISOString(),
  });
  return recorded.kind === 'err' ? (recorded.error ?? new Error('no detail')) : undefined;
}

/** Longest cause text a failure message carries. */
const MAX_CAUSE_CHARS = 500;

/** A thrown value's message on one line, at most `MAX_CAUSE_CHARS` long. */
function describeCause(cause: unknown): string {
  const text = (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, ' ').trim();
  if (text.length === 0) return cause instanceof Error ? cause.name : 'no detail';
  return text.length > MAX_CAUSE_CHARS ? `${text.slice(0, MAX_CAUSE_CHARS - 1)}…` : text;
}

/** The pinned model-settings block's values, as model-call fields; none when it has none. */
function modelSettingsOf(
  ctx: TurnContext,
): Pick<ModelCallInput, 'temperature' | 'maxOutputTokens'> {
  const settings = ctx.blocks?.modelSettings;
  return {
    ...(settings?.temperature !== undefined && { temperature: settings.temperature }),
    ...(settings?.maxOutputTokens !== undefined && { maxOutputTokens: settings.maxOutputTokens }),
  };
}
