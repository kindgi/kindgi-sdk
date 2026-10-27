// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { MessageFile, ModelMessage, ModelToolCall } from '@kindgi/capabilities';
import type { NodeHandler } from '@kindgi/handler';

import {
  EVENT_DATA_RULE,
  formatEventForPrompt,
  toolResultForModel,
  turnMessageIsEvent,
} from '../event-data.js';
import {
  MEMORY_DATA_RULE,
  formatPoliciesForPrompt,
  formatRetrievedForPrompt,
  isPolicyFact,
} from '../retrieval.js';
import type { ConversationMessage } from '../types.js';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';
import { admitHistoryFiles, asMessageFile } from './files.js';
import { readHistory } from './history.js';
import { outputSection } from './structured-output.js';

/**
 * Compose the initial `modelMessages` array the loop's first iteration
 * feeds to the model:
 *
 *   [ system: rendered prompt
 *             (+ the memory rule, + the event rule, + "Policies (verified)",
 *              when there are, + the output's section, for a typed agent),
 *     ...history (a message from an event: an <event> data block),
 *     user: <memory> data block (if anything was retrieved),
 *     user: current message (an <event> data block, in a run a webhook
 *           or an event started) ]
 *
 * Retrieved facts are data: a labelled block in a user-role message, read
 * as information about the world, never as instructions. Only a verified
 * fact of a type the agent lists in `memory.instructionTypes` is an
 * instruction, in the system message. So is a message from outside: in a
 * run a webhook or an event started, the turn's message is the event, and
 * it stays one in every later turn's history, whoever started that turn.
 *
 * Output shape: `{ nextMessages: ModelMessage[] }` — matches the loop
 * iteration output's `nextMessages` field so the loop body can treat
 * iteration 0's input identically to subsequent iterations'.
 */
export function buildBuildInitialMessagesHandler(ctx: TurnContext): NodeHandler {
  return async (input: unknown) => {
    if (ctx.conversation === undefined || ctx.retrieved === undefined) {
      throwAgentTurnFailure({
        code: 'model-invocation-failed',
        message: 'build-initial-messages invoked before setup / retrievals completed',
        cause: null,
      });
    }
    // `input` is `run-retrievals`'s output; discarded — the rendered
    // prompt is read from setup's sibling output via ctx (retained on
    // the closure by render-prompt through the local field `renderedPrompt`).
    void input;

    const history = await readHistory(ctx);
    // The run's rule, asked again for each earlier message's files.
    const historyFiles = await admitHistoryFiles(
      ctx,
      history.map((m) => m.files),
    );
    // The turn's own files were admitted when its message was kept.
    const files = (ctx.userMessage?.files ?? []).map(asMessageFile);

    const agent = ctx.input.agent;
    const policies = ctx.retrieved.filter((r) => isPolicyFact(agent, r));
    const data = ctx.retrieved.filter((r) => !isPolicyFact(agent, r));
    const memoryBlock = formatRetrievedForPrompt(data, ctx.recalled ?? []);
    const memoryMessage: ModelMessage | undefined =
      memoryBlock.length > 0 ? { role: 'user', content: memoryBlock } : undefined;

    const rendered = ctx.renderedPrompt;
    if (rendered === undefined) {
      throwAgentTurnFailure({
        code: 'model-invocation-failed',
        message: 'build-initial-messages invoked before render-prompt completed',
        cause: null,
      });
    }

    const isEvent = turnMessageIsEvent(ctx.input);
    const readsEvent = readsOutsideData(ctx, history, [files, ...historyFiles]);
    const system = [
      rendered,
      ...(memoryMessage !== undefined ? [MEMORY_DATA_RULE] : []),
      ...(readsEvent ? [EVENT_DATA_RULE] : []),
      ...(policies.length > 0 ? [formatPoliciesForPrompt(policies)] : []),
      // A typed agent's output, from the turn's start: the first answer can
      // fit, and a repair (`budget-check`) is the fallback, not every turn's
      // second model call.
      ...(agent.output !== undefined ? [outputSection(agent.output, offersTools(ctx))] : []),
    ].join('\n\n');
    const modelMessages: ModelMessage[] = [
      { role: 'system', content: system },
      ...history.map((m, i) => conversationToModelMessage(m, historyFiles[i] ?? [])),
      ...(memoryMessage !== undefined ? [memoryMessage] : []),
      turnMessage(ctx, isEvent, files),
    ];

    return { nextMessages: modelMessages };
  };
}

/**
 * Whether the turn reads outside data, so its system message holds the data
 * rule: its message is an event's, its history holds one, a stored file is
 * in its first messages, or a tool it offers may answer with outside data. A
 * pausing tool's answer, or an outside-data tool's result, comes in the
 * middle of the turn, so the rule is there from the turn's start, and the
 * same on replay.
 */
function readsOutsideData(
  ctx: TurnContext,
  history: readonly ConversationMessage[],
  files: readonly (readonly MessageFile[])[],
): boolean {
  return (
    turnMessageIsEvent(ctx.input) ||
    history.some((m) => m.fromEvent === true) ||
    files.some((list) => list.length > 0) ||
    offersOutsideDataTool(ctx)
  );
}

/** Whether the turn's model calls offer tools: setup's, `remember` included. */
function offersTools(ctx: TurnContext): boolean {
  return (ctx.tools?.definitions.length ?? 0) > 0;
}

/**
 * Whether a tool the turn offers may answer with outside data: another
 * system's answer (`Tool.pauses`), or results that are (`Tool.resultIsOutsideData`).
 */
function offersOutsideDataTool(ctx: TurnContext): boolean {
  return [...(ctx.tools?.byName.values() ?? [])].some(
    ({ tool }) => tool.pauses === true || tool.resultIsOutsideData === true,
  );
}

/**
 * The turn's own message: an `<event>` data block in a run a webhook, an
 * event or a mail started, with the files it carries.
 */
function turnMessage(
  ctx: TurnContext,
  isEvent: boolean,
  files: readonly MessageFile[],
): ModelMessage {
  const text = ctx.input.userMessage;
  return {
    role: 'user',
    content: isEvent ? formatEventForPrompt(text) : text,
    ...(files.length > 0 && { files }),
  };
}

/** A history message as the model reads it, with its files as the run's rule admits them now. */
function conversationToModelMessage(
  msg: ConversationMessage,
  files: readonly MessageFile[],
): ModelMessage {
  if (msg.role === 'tool') {
    return {
      role: 'tool',
      // Another system's answer to a paused call, or an outside-data
      // tool's result, stays data.
      content: toolResultForModel(msg.content, msg.fromEvent === true),
      ...(msg.toolCall !== undefined && { toolCallId: msg.toolCall.invocationId }),
      ...(files.length > 0 && { files }),
    };
  }
  if (msg.role === 'agent' && typeof msg.content === 'object' && msg.content !== null) {
    const structured = msg.content as {
      readonly text?: string;
      readonly toolCalls?: readonly ModelToolCall[];
    };
    return {
      role: 'assistant',
      content: structured.text ?? '',
      ...(structured.toolCalls !== undefined && { toolCalls: structured.toolCalls }),
    };
  }
  const role: ModelMessage['role'] = msg.role === 'agent' ? 'assistant' : msg.role;
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  // An event's message stays data in every later turn's history.
  return {
    role,
    content: msg.fromEvent === true ? formatEventForPrompt(content) : content,
    // Files ride on user messages (and tool results, above) only.
    ...(role === 'user' && files.length > 0 && { files }),
  };
}
