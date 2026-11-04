// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The built-in texts tools: a run a text started answers its sender with
 * `kindgi_reply_to_text` (when the number grants `texts.reply`) and hands
 * the conversation to a person with `kindgi_hand_to_person`. The number,
 * channel and sender come from the run, never from the model; a refusal
 * comes back as the tool's output, and nothing is sent.
 */

import type { NodeContext } from '@kindgi/handler';
import { newBuilder } from '@kindgi/provenance';
import {
  HAND_TO_PERSON_TOOL_ID,
  REPLY_TO_TEXT_TOOL_ID,
  type RunTextThread,
  SEND_TEXT_TOOL_ID,
} from '@kindgi/runtime';
import type { ConversationId, ProjectId, ProvenanceId, RunId, TenantId } from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { buildDispatchToolsHandler } from '../src/handlers/dispatch-tools.js';
import type { InvokeAgentInput, TextsToolBinding } from '../src/handlers/public-types.js';
import { writeRunSnapshot } from '../src/handlers/run-snapshot.js';
import { type TextToolOutput, withTextTools } from '../src/handlers/text-tools.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import { turnInputFromSnapshot } from '../src/invoke.js';
import type { RunSnapshotRecord } from '../src/run-snapshot-binding.js';
import type { Agent, ConversationMessage } from '../src/types.js';
import { testNodeContext } from './node-context.js';

const tenantId = 't-1' as TenantId;

const thread: RunTextThread = {
  connectionId: 'conn-1',
  number: '+15550100100',
  channel: 'sms',
  sender: '+15550100200',
  threadId: 'thread-1',
  grants: ['texts.reply'],
};

const agent = { id: 'acme.desk', version: '1.0.0', tools: [] } as unknown as Agent;

interface Turn {
  readonly calls: { readonly op: string; readonly input: unknown }[];
  readonly asked: readonly string[];
  readonly waits: readonly string[];
  readonly snapshot: RunSnapshotRecord | undefined;
  readonly outputs: readonly TextToolOutput[];
  readonly definitions: readonly string[];
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
  }[];
}

/**
 * One model step that makes `calls`, through dispatch-tools, in a run a
 * text started whose trigger lists `listed` (the reply, unless given).
 * Its snapshot is written first; a wait is approved. `resumed` is the input
 * of a turn resumed from a snapshot, in place of the text's own.
 */
async function textTurn(options: {
  readonly calls: readonly { readonly tool: string; readonly args: Record<string, unknown> }[];
  readonly thread?: RunTextThread;
  readonly binding?: false | Partial<TextsToolBinding>;
  readonly listed?: readonly string[];
  readonly resumed?: InvokeAgentInput;
}): Promise<Turn> {
  const calls: { op: string; input: unknown }[] = [];
  const asked: string[] = [];
  const waits: string[] = [];
  const stored: ConversationMessage[] = [];
  let snapshot: RunSnapshotRecord | undefined;
  const binding: TextsToolBinding = {
    reply: async (input) => {
      calls.push({ op: 'reply', input });
      return { kind: 'sent' };
    },
    handOver: async (input) => {
      calls.push({ op: 'handOver', input });
      return { kind: 'handed-over' };
    },
    ...(options.binding !== false && options.binding),
  };
  const ctx = {
    input: options.resumed ?? {
      tenantId,
      projectId: 'p-1' as ProjectId,
      conversationId: 'conv-1' as ConversationId,
      agent,
      userMessage: 'Is my order in?',
      startedBy: 'text',
      toolsAllowedUnattended: options.listed ?? [REPLY_TO_TEXT_TOOL_ID],
      ...(options.thread !== undefined && { textThread: options.thread }),
    },
    bindings: {
      conversationBinding: {
        appendMessage: async (m: Record<string, unknown>) => {
          const message = {
            id: `msg-${stored.length + 1}`,
            ...m,
          } as unknown as ConversationMessage;
          stored.push(message);
          return { kind: 'ok', value: message };
        },
      },
      ...(options.binding !== false && { texts: binding }),
      authorizeToolCall: async (input: { readonly toolId: string }) => {
        asked.push(input.toolId);
        return { kind: 'allowed' };
      },
      hitl: { enqueue: async () => undefined },
      runSnapshotBinding: {
        write: async (record: RunSnapshotRecord) => {
          snapshot = record;
        },
      },
    },
    turnAbort: new AbortController(),
    appended: [],
    usage: { steps: 1, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
    provenance: newBuilder({ id: 'prov-1' as ProvenanceId, runId: 'run-42' as RunId, tenantId }),
    hitlPolicy: resolveEffectiveHitlPolicy({ tenant: undefined, agent }),
    initialMessageCount: 0,
  } as unknown as TurnContext;
  ctx.tools = withTextTools(ctx, { definitions: [], byName: new Map() });
  const node = testNodeContext({
    runId: 'run-42' as RunId,
    waitForToken: (async (tokenId: string) => {
      waits.push(tokenId);
      return { decided: 'approve' };
    }) as NodeContext['waitForToken'],
  });
  await writeRunSnapshot(ctx, node);

  if (options.calls.length > 0) {
    await buildDispatchToolsHandler(ctx)(
      {
        step: 1,
        finishReason: 'tool-use',
        message: {
          role: 'assistant',
          content: '',
          toolCalls: options.calls.map((c, i) => ({
            id: `call-${i + 1}`,
            name: c.tool,
            arguments: c.args,
          })),
        },
        iterationUsage: { promptTokens: 0, completionTokens: 0 },
        provider: { id: 'p', model: 'm' },
        nextMessages: [],
      },
      node,
    );
  }
  return {
    calls,
    asked,
    waits,
    snapshot,
    outputs: stored
      .filter((m) => m.role === 'tool')
      .map((m) => m.content as unknown as TextToolOutput),
    definitions: ctx.tools.definitions.map((d) => d.name),
    tools: ctx.tools.definitions as unknown as Turn['tools'],
  };
}

const reply = (body: string) => ({ tool: REPLY_TO_TEXT_TOOL_ID, args: { body } });

describe('which texts tools a turn offers', () => {
  test('a run with a text thread whose number grants texts.reply: the reply and the hand-over', async () => {
    const turn = await textTurn({ calls: [], thread });
    expect(turn.definitions).toEqual([REPLY_TO_TEXT_TOOL_ID, HAND_TO_PERSON_TOOL_ID]);
  });

  test('a number without texts.reply: only the hand-over', async () => {
    const turn = await textTurn({ calls: [], thread: { ...thread, grants: [] } });
    expect(turn.definitions).toEqual([HAND_TO_PERSON_TOOL_ID]);
  });

  test('a run with no text thread (any other run, one a tool or a step started included): none', async () => {
    const turn = await textTurn({ calls: [] });
    expect(turn.definitions).toEqual([]);
  });

  test('the send tool is never offered yet', async () => {
    const turn = await textTurn({
      calls: [],
      thread: { ...thread, grants: ['texts.reply', 'texts.send'] },
    });
    expect(turn.definitions).not.toContain(SEND_TEXT_TOOL_ID);
  });

  test('a host with no texts binding still offers them; a call says nothing was sent', async () => {
    const turn = await textTurn({ calls: [reply('Hello')], thread, binding: false });
    expect(turn.definitions).toContain(REPLY_TO_TEXT_TOOL_ID);
    expect(turn.outputs).toEqual([
      { status: 'not-sent', message: expect.stringMatching(/can't send texts/) },
    ]);
  });
});

describe('what the model sees', () => {
  test('the exact ids it calls, and the inputs it gives: a body, or a note, and nothing else', async () => {
    const turn = await textTurn({ calls: [], thread });
    const seen = turn.tools.map((d) => ({ name: d.name, inputSchema: d.inputSchema }));
    expect(REPLY_TO_TEXT_TOOL_ID).toBe('kindgi_reply_to_text');
    expect(HAND_TO_PERSON_TOOL_ID).toBe('kindgi_hand_to_person');
    expect(SEND_TEXT_TOOL_ID).toBe('kindgi_send_text');
    expect(seen).toEqual([
      {
        name: REPLY_TO_TEXT_TOOL_ID,
        inputSchema: expect.objectContaining({
          type: 'object',
          properties: { body: expect.objectContaining({ minLength: 1, maxLength: 1600 }) },
          required: ['body'],
          additionalProperties: false,
        }),
      },
      {
        name: HAND_TO_PERSON_TOOL_ID,
        inputSchema: expect.objectContaining({
          type: 'object',
          properties: { note: expect.objectContaining({ minLength: 1 }) },
          required: ['note'],
          additionalProperties: false,
        }),
      },
    ]);
  });

  test('the reply says to answer before handing over; the hand-over says a person reads the note', async () => {
    const turn = await textTurn({ calls: [], thread });
    const [replyTool, handOver] = turn.tools;
    expect(replyTool?.description).toMatch(/^Use kindgi_reply_to_text to answer/);
    expect(replyTool?.description).toContain(`before ${HAND_TO_PERSON_TOOL_ID}`);
    expect(handOver?.description).toMatch(/^Use kindgi_hand_to_person to hand/);
    expect(handOver?.description).toContain('A person reads the note');
  });
});

describe('kindgi_reply_to_text', () => {
  test("it answers the run's thread, with the body as given", async () => {
    const turn = await textTurn({ calls: [reply('Hello')], thread });
    expect(turn.calls).toEqual([
      { op: 'reply', input: { tenantId, runId: 'run-42', thread, body: 'Hello' } },
    ]);
    expect(turn.outputs).toEqual([{ status: 'sent' }]);
  });

  test.each([
    'texts-window-closed',
    'texts-opted-out',
    'texts-with-person',
    'texts-not-granted',
  ] as const)(
    'a %s refusal comes back as the output, with a sentence for the agent',
    async (reason) => {
      const turn = await textTurn({
        calls: [reply('Hello')],
        thread,
        binding: { reply: async () => ({ kind: 'refused', reason }) },
      });
      expect(turn.outputs).toEqual([{ status: 'not-sent', reason, message: expect.any(String) }]);
    },
  );

  test('the window refusal says nothing can be sent until the person texts again', async () => {
    const turn = await textTurn({
      calls: [reply('Hello')],
      thread,
      binding: { reply: async () => ({ kind: 'refused', reason: 'texts-window-closed' }) },
    });
    expect(turn.outputs[0]?.message).toBe(
      'The 24-hour window for this thread is closed: nothing can be sent until the person texts again.',
    );
  });

  test('the grant refusal names the permission', async () => {
    const turn = await textTurn({
      calls: [reply('Hello')],
      thread,
      binding: { reply: async () => ({ kind: 'refused', reason: 'texts-not-granted' }) },
    });
    expect(turn.outputs[0]?.message).toContain('texts.reply');
  });

  test('after a with-person refusal, a second reply asks the binding again: the runtime decides', async () => {
    let n = 0;
    const turn = await textTurn({
      calls: [reply('Hello'), reply('Are you there?')],
      thread,
      binding: {
        reply: async () => {
          n += 1;
          return { kind: 'refused', reason: 'texts-with-person' };
        },
      },
    });
    expect(n).toBe(2);
    expect(turn.outputs.map((o) => o.reason)).toEqual(['texts-with-person', 'texts-with-person']);
  });

  test('a body over 1600 characters, or a number from the model, is refused before anything is sent', async () => {
    const long = await textTurn({ calls: [reply('x'.repeat(1601))], thread });
    const to = await textTurn({
      calls: [{ tool: REPLY_TO_TEXT_TOOL_ID, args: { body: 'Hello', to: '+15550100300' } }],
      thread,
    });
    expect(long.calls).toEqual([]);
    expect(to.calls).toEqual([]);
  });

  test('its call is asked of authorizeToolCall, under its built-in id', async () => {
    const turn = await textTurn({ calls: [reply('Hello')], thread });
    expect(turn.asked).toEqual([REPLY_TO_TEXT_TOOL_ID]);
  });
});

describe('a reply that waits for a yes', () => {
  test("the run's snapshot records its text thread", async () => {
    const turn = await textTurn({ calls: [], thread });
    expect(turn.snapshot?.textThread).toEqual(thread);
    expect((await textTurn({ calls: [] })).snapshot).not.toHaveProperty('textThread');
  });

  test("unlisted, it waits; resumed from the snapshot, the approved reply goes to the snapshot's thread", async () => {
    const parked = await textTurn({ calls: [reply('Hello')], thread, listed: [] });
    expect(parked.waits).toHaveLength(1);
    const snapshot = parked.snapshot as RunSnapshotRecord;
    const resumed = await textTurn({
      calls: [reply('Hello')],
      resumed: turnInputFromSnapshot(snapshot, { agent }),
    });
    expect(resumed.waits).toHaveLength(1);
    expect(resumed.calls).toEqual([
      { op: 'reply', input: { tenantId, runId: 'run-42', thread, body: 'Hello' } },
    ]);
    expect(resumed.outputs).toEqual([{ status: 'sent' }]);
  });
});

describe('kindgi_hand_to_person', () => {
  test("it marks the run's thread with the note, and isn't asked of authorizeToolCall", async () => {
    const turn = await textTurn({
      calls: [
        { tool: HAND_TO_PERSON_TOOL_ID, args: { note: 'Asked for a refund over the limit.' } },
      ],
      thread: { ...thread, grants: [] },
    });
    expect(turn.calls).toEqual([
      {
        op: 'handOver',
        input: {
          tenantId,
          runId: 'run-42',
          thread: { ...thread, grants: [] },
          note: 'Asked for a refund over the limit.',
        },
      },
    ]);
    expect(turn.outputs).toEqual([{ status: 'handed-over' }]);
    expect(turn.asked).toEqual([]);
  });
});

describe('an agent naming a texts tool', () => {
  test("can't list one in its tools: a run a text started gets them", () => {
    const r = defineAgent({
      id: 'acme.desk',
      version: '1.0.0',
      name: 'Desk',
      instructions: 'Answer the person who texted.',
      capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
      tools: [{ id: REPLY_TO_TEXT_TOOL_ID, version: '1.0.0' }],
      retrieval: [],
      guardrails: [],
    } as never);
    expect(r.kind).toBe('err');
    expect(r.kind === 'err' && r.error.message).toContain(
      `a run a text started gets ${REPLY_TO_TEXT_TOOL_ID} and ${HAND_TO_PERSON_TOOL_ID}`,
    );
  });
});
