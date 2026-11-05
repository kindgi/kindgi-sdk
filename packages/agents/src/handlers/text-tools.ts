// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The built-in texts tools, built for each turn of a run a text trigger
 * started (`InvokeAgentInput.textThread`): `kindgi_reply_to_text` answers
 * the person who texted, when the number grants `texts.reply`, and
 * `kindgi_hand_to_person` hands the conversation to a person. They
 * dispatch like any tool (the agent's `hitl.tools` policy, the unattended
 * rule, replay and the tool error policy apply), but they aren't in the
 * tool registry: the number, channel and sender come from the run, never
 * from the model, and the runtime's `TextsToolBinding` sends.
 */

import type { ModelToolDefinition } from '@kindgi/capabilities';
import { HAND_TO_PERSON_TOOL_ID, REPLY_TO_TEXT_TOOL_ID, type RunTextThread } from '@kindgi/runtime';
import { type Tool, defineTool } from '@kindgi/tools';
import type { RunId, ToolId } from '@kindgi/types';

import type { TurnContext } from './context.js';
import type { TextRefusal } from './public-types.js';

/** The version both texts tools are built at. */
export const TEXT_TOOLS_VERSION = '1.0.0';

/** The longest reply, in characters. */
export const MAX_TEXT_BODY = 1600;

/** The longest hand-over note, in characters. */
export const MAX_HAND_OVER_NOTE = 500;

/** What the model reads back. */
export interface TextToolOutput {
  /**
   * `sent`: the reply went out. `handed-over`: a person has the thread.
   * `not-sent`: nothing was sent or changed; `reason` says which refusal,
   * when it was one, and `message` says why in a sentence.
   */
  readonly status: 'sent' | 'handed-over' | 'not-sent';
  readonly reason?: TextRefusal;
  readonly message?: string;
}

type TurnTools = NonNullable<TurnContext['tools']>;

/**
 * The turn's tools, with the texts tools added when its run answers a
 * text: the reply when the number grants `texts.reply`, and the
 * hand-over. A host with no texts binding still offers them, and a call
 * says nothing was sent.
 */
export function withTextTools(ctx: TurnContext, tools: TurnTools): TurnTools {
  const thread = ctx.input.textThread;
  if (thread === undefined) return tools;
  const added = [
    ...(thread.grants.includes('texts.reply') ? [replyTool(ctx, thread)] : []),
    handOverTool(ctx, thread),
  ];
  const byName = new Map(tools.byName);
  const definitions: ModelToolDefinition[] = [...tools.definitions];
  for (const tool of added) {
    definitions.push({
      name: tool.id,
      description: tool.description,
      inputSchema: tool.input as Readonly<Record<string, unknown>>,
    });
    byName.set(tool.id, {
      tool,
      resolvedVersion: TEXT_TOOLS_VERSION,
      requestedRange: TEXT_TOOLS_VERSION,
    });
  }
  return { definitions, byName };
}

const OUTPUT = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['sent', 'handed-over', 'not-sent'] },
    reason: {
      type: 'string',
      enum: ['texts-window-closed', 'texts-opted-out', 'texts-with-person', 'texts-not-granted'],
    },
    message: { type: 'string' },
  },
} as const;

function replyTool(ctx: TurnContext, thread: RunTextThread): Tool {
  return built(
    defineTool<{ readonly body: string }, TextToolOutput>({
      id: REPLY_TO_TEXT_TOOL_ID as ToolId,
      version: TEXT_TOOLS_VERSION,
      description: `Use ${REPLY_TO_TEXT_TOOL_ID} to answer the person who texted: give only the text of your reply, and it goes to them on the number and channel they texted. If it can't be sent, the result says why, and nothing was sent. When you hand the conversation to a person, reply first, before ${HAND_TO_PERSON_TOOL_ID}, so they know someone will follow up.`,
      input: {
        type: 'object',
        additionalProperties: false,
        required: ['body'],
        properties: {
          body: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_TEXT_BODY,
            description: 'The text of the reply, as the person will read it.',
          },
        },
      },
      output: OUTPUT,
      mutating: true,
      effects: [
        {
          kind: 'external-side-effect',
          resource: 'external:texts',
          notes: 'Sends a text to the person who texted.',
        },
        { kind: 'sensitive-data-egress', resource: 'external:texts' },
      ],
      handler: async ({ body }, toolCtx) => {
        const texts = ctx.bindings.texts;
        if (texts === undefined) return NO_TEXTS;
        const sent = await texts.reply({
          tenantId: ctx.input.tenantId,
          runId: toolCtx.runId as RunId,
          // The same on every run of this call: a resumed or retried step
          // sends nothing again.
          ...(toolCtx.idempotencyKey !== undefined && { idempotencyKey: toolCtx.idempotencyKey }),
          thread,
          body,
        });
        return sent.kind === 'sent' ? { status: 'sent' } : refused(sent.reason);
      },
    }),
  );
}

function handOverTool(ctx: TurnContext, thread: RunTextThread): Tool {
  return built(
    defineTool<{ readonly note: string }, TextToolOutput>({
      id: HAND_TO_PERSON_TOOL_ID as ToolId,
      version: TEXT_TOOLS_VERSION,
      description: `Use ${HAND_TO_PERSON_TOOL_ID} to hand this conversation to a person, when it needs one or the person who texted asks for one. After it, no run answers this thread's texts: a person does. A person reads the note: say why, and what they need to know.`,
      input: {
        type: 'object',
        additionalProperties: false,
        required: ['note'],
        properties: {
          note: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_HAND_OVER_NOTE,
            description: 'For the person who picks it up: why, and what they need to know.',
          },
        },
      },
      output: OUTPUT,
      mutating: true,
      effects: [
        {
          kind: 'writes',
          resource: 'texts:threads',
          notes: 'Hands the thread to a person: its trigger starts no runs for it.',
        },
      ],
      handler: async ({ note }, toolCtx) => {
        const texts = ctx.bindings.texts;
        if (texts === undefined) return NO_TEXTS;
        await texts.handOver({
          tenantId: ctx.input.tenantId,
          runId: toolCtx.runId as RunId,
          thread,
          note,
        });
        return { status: 'handed-over' };
      },
    }),
  );
}

/** A host with no `TextsToolBinding`. */
const NO_TEXTS: TextToolOutput = {
  status: 'not-sent',
  message: "This server can't send texts: nothing was sent.",
};

/** What the model reads for each refusal: nothing was sent. */
const REFUSALS: Readonly<Record<TextRefusal, string>> = {
  'texts-window-closed':
    'The 24-hour window for this thread is closed: nothing can be sent until the person texts again.',
  'texts-opted-out':
    'The person opted out of texts from this number on this channel: nothing was sent.',
  'texts-with-person':
    'A person has this conversation now: nothing was sent, and the person answers from here.',
  'texts-not-granted': "This number's connection doesn't grant texts.reply: nothing was sent.",
};

function refused(reason: TextRefusal): TextToolOutput {
  return { status: 'not-sent', reason, message: REFUSALS[reason] };
}

/** The schemas are fixed here: a failure is a bug, not an input problem. */
function built(
  defined:
    | { readonly kind: 'ok'; readonly value: unknown }
    | { readonly kind: 'err'; readonly error: { readonly message: string } },
): Tool {
  if (defined.kind === 'err') {
    throw new Error(`a built-in texts tool failed to build: ${defined.error.message}`);
  }
  return defined.value as Tool;
}
