// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, test } from 'vitest';

import type { ModelMessage } from '@kindgi/capabilities';

import {
  fromAnthropicResponse,
  mapStopReason,
  toAnthropicMessages,
  toAnthropicTools,
} from '../src/translate.js';

describe('toAnthropicMessages — system lifting', () => {
  test('single system message lifts to top-level system', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'You are a helpful agent.' },
      { role: 'user', content: 'Hi' },
    ];
    const out = toAnthropicMessages(messages);
    expect(out.system).toBe('You are a helpful agent.');
    expect(out.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }]);
  });

  test('multiple system messages concatenate with blank-line separator', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'A' },
      { role: 'user', content: 'q' },
      { role: 'system', content: 'B' },
    ];
    const out = toAnthropicMessages(messages);
    expect(out.system).toBe('A\n\nB');
    expect(out.messages).toHaveLength(1);
  });

  test('no system messages → system is undefined', () => {
    const out = toAnthropicMessages([{ role: 'user', content: 'hi' }]);
    expect(out.system).toBeUndefined();
  });

  test('empty system message string is skipped', () => {
    const out = toAnthropicMessages([
      { role: 'system', content: '' },
      { role: 'user', content: 'hi' },
    ]);
    expect(out.system).toBeUndefined();
  });
});

describe('toAnthropicMessages — assistant tool_use blocks', () => {
  test('assistant with text + toolCalls produces mixed content array', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'run the tool' },
      {
        role: 'assistant',
        content: 'Sure, calling the tool.',
        toolCalls: [{ id: 'call-1', name: 'demo.echo', arguments: { message: 'hi' } }],
      },
    ];
    const out = toAnthropicMessages(messages);
    expect(out.messages).toHaveLength(2);
    const assistant = out.messages[1];
    expect(assistant?.role).toBe('assistant');
    // Tool name is encoded on the wire: '.' → '__' because Anthropic's
    // `tools[].name` regex forbids dots. Framework-side (message trail,
    // registry) still sees the canonical `demo.echo`.
    expect(assistant?.content).toEqual([
      { type: 'text', text: 'Sure, calling the tool.' },
      { type: 'tool_use', id: 'call-1', name: 'demo__echo', input: { message: 'hi' } },
    ]);
  });

  test('assistant with only toolCalls (empty text) omits text block', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'run' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c', name: 't', arguments: {} }],
      },
    ];
    const out = toAnthropicMessages(messages);
    const assistant = out.messages[1];
    expect(assistant?.content).toEqual([{ type: 'tool_use', id: 'c', name: 't', input: {} }]);
  });

  test('assistant with empty content and no toolCalls is dropped', () => {
    // Malformed input — Anthropic would reject; adapter defends.
    const out = toAnthropicMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '' },
    ]);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]?.role).toBe('user');
  });
});

describe('toAnthropicMessages — tool results fold into user turns', () => {
  test('consecutive tool messages merge into one user message with multiple tool_result blocks', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 't', arguments: {} },
          { id: 'c2', name: 't', arguments: {} },
        ],
      },
      { role: 'tool', content: 'result-1', toolCallId: 'c1' },
      { role: 'tool', content: 'result-2', toolCallId: 'c2' },
    ];
    const out = toAnthropicMessages(messages);
    expect(out.messages).toHaveLength(3);
    const userAfterTools = out.messages[2];
    expect(userAfterTools?.role).toBe('user');
    expect(userAfterTools?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'result-1' },
      { type: 'tool_result', tool_use_id: 'c2', content: 'result-2' },
    ]);
  });

  test('tool message with missing toolCallId falls back to empty string', () => {
    const out = toAnthropicMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 't', arguments: {} }] },
      { role: 'tool', content: 'result' } as ModelMessage,
    ]);
    const last = out.messages[out.messages.length - 1];
    expect(last?.content).toEqual([{ type: 'tool_result', tool_use_id: '', content: 'result' }]);
  });
});

describe('toAnthropicMessages — user turn folding', () => {
  test('consecutive user text messages fold into one user turn', () => {
    const out = toAnthropicMessages([
      { role: 'user', content: 'part 1' },
      { role: 'user', content: 'part 2' },
    ]);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]?.content).toEqual([
      { type: 'text', text: 'part 1' },
      { type: 'text', text: 'part 2' },
    ]);
  });
});

describe('toAnthropicTools', () => {
  test('framework tool defs pass through with input_schema renaming', () => {
    const tools = toAnthropicTools([
      {
        name: 'demo.echo',
        description: 'Echo back a message.',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
      },
    ]);
    // '.' is encoded to '__' on the wire — Anthropic's tool.name regex
    // is `^[a-zA-Z0-9_-]{1,128}$` (no dots). `fromAnthropicResponse`
    // reverses on the way back.
    expect(tools).toEqual([
      {
        name: 'demo__echo',
        description: 'Echo back a message.',
        input_schema: { type: 'object', properties: { message: { type: 'string' } } },
      },
    ]);
  });

  test('tool ids without dots pass through unchanged', () => {
    const tools = toAnthropicTools([
      {
        name: 'weather_forecast',
        description: 'Fetch weather.',
        inputSchema: { type: 'object' },
      },
    ]);
    expect(tools[0]?.name).toBe('weather_forecast');
  });
});

describe('fromAnthropicResponse', () => {
  test('text-only response → message with concatenated text, no toolCalls', () => {
    const response = fakeMessage([
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world.' },
    ]);
    const msg = fromAnthropicResponse(response);
    expect(msg).toEqual({ role: 'assistant', content: 'Hello world.' });
  });

  test('tool_use blocks become toolCalls (decoded from wire form)', () => {
    // Anthropic returns the encoded `demo__echo` (mirror of what we
    // sent in `toAnthropicTools`); the framework side should see it
    // decoded back to canonical `demo.echo`.
    const response = fakeMessage([
      { type: 'text', text: 'Calling tool.' },
      { type: 'tool_use', id: 'tu-1', name: 'demo__echo', input: { message: 'hi' } },
    ]);
    const msg = fromAnthropicResponse(response);
    expect(msg.content).toBe('Calling tool.');
    expect(msg.toolCalls).toEqual([
      { id: 'tu-1', name: 'demo.echo', arguments: { message: 'hi' } },
    ]);
  });

  test('a text answer with thinking gives the text, and keeps no thinking: no call follows it', () => {
    const response = fakeMessage([
      { type: 'thinking', thinking: 'reasoning...', signature: 'sig' },
      { type: 'text', text: 'answer' },
    ]);
    const msg = fromAnthropicResponse(response, undefined, MODEL);
    expect(msg).toEqual({ role: 'assistant', content: 'answer' });
  });
});

const MODEL = 'claude-sonnet-5-5';
const THINKING = {
  type: 'thinking',
  thinking: 'The order number is in the message; look it up first.',
  signature: 'EqQBCkgIBxABGAIiQL…',
} as const;
const REDACTED = { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix/LafPsn4aDFIT…' } as const;
const lookup = (id: string) =>
  ({ type: 'tool_use', id, name: 'acme__orders__lookup', input: { order: 'A-1' } }) as const;

/** The trail the agent loop sends next: the user's message, the answer, its tool results. */
function trailAfter(answer: ModelMessage): ModelMessage[] {
  return [
    { role: 'user', content: 'Where is order A-1?' },
    answer,
    ...(answer.toolCalls ?? []).map(
      (c): ModelMessage => ({ role: 'tool', content: '{"status":"shipped"}', toolCallId: c.id }),
    ),
  ];
}

/** The blocks an answer goes back as, on the next call to the model that answered. */
function sentBack(answer: ModelMessage) {
  return toAnthropicMessages(trailAfter(answer), MODEL).messages[1]?.content;
}

const toolUseSent = (id: string) => ({
  type: 'tool_use',
  id,
  name: 'acme__orders__lookup',
  input: { order: 'A-1' },
});

describe('thinking through a tool loop', () => {
  test("an answer with thinking and a tool call goes back with its thinking unchanged, in place, before the call's result", () => {
    const answer = fromAnthropicResponse(
      fakeMessage([THINKING, { type: 'text', text: 'Let me look.' }, lookup('tu-1')]),
      undefined,
      MODEL,
    );
    expect(answer.content).toBe('Let me look.');
    expect(answer.toolCalls?.[0]?.signature).toMatch(/^anth1\./);

    const sent = toAnthropicMessages(trailAfter(answer), MODEL).messages;
    expect(sent).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Where is order A-1?' }] },
      {
        role: 'assistant',
        content: [THINKING, { type: 'text', text: 'Let me look.' }, toolUseSent('tu-1')],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: '{"status":"shipped"}' }],
      },
    ]);
  });

  test('redacted thinking goes back as it came', () => {
    const answer = fromAnthropicResponse(
      fakeMessage([REDACTED, THINKING, lookup('tu-1')]),
      undefined,
      MODEL,
    );
    expect(sentBack(answer)).toEqual([REDACTED, THINKING, toolUseSent('tu-1')]);
  });

  test('thinking between text and calls keeps its order; only the first call carries it', () => {
    const answer = fromAnthropicResponse(
      fakeMessage([
        THINKING,
        { type: 'text', text: 'Checking both. ' },
        { ...THINKING, thinking: 'Now the second order.', signature: 'sig-2' },
        lookup('tu-1'),
        { type: 'text', text: 'And the other.' },
        lookup('tu-2'),
      ]),
      undefined,
      MODEL,
    );
    expect(answer.content).toBe('Checking both. And the other.');
    expect(answer.toolCalls?.[1]?.signature).toBeUndefined();
    expect(sentBack(answer)).toEqual([
      THINKING,
      { type: 'text', text: 'Checking both. ' },
      { type: 'thinking', thinking: 'Now the second order.', signature: 'sig-2' },
      toolUseSent('tu-1'),
      { type: 'text', text: 'And the other.' },
      toolUseSent('tu-2'),
    ]);
  });

  test('kept as JSON (a journaled step, a stored message), it still goes back with its thinking', () => {
    const answer = fromAnthropicResponse(
      fakeMessage([THINKING, { type: 'text', text: 'Let me look.' }, lookup('tu-1')]),
      undefined,
      MODEL,
    );
    const kept = JSON.parse(JSON.stringify(answer)) as ModelMessage;
    expect(sentBack(kept)).toEqual([
      THINKING,
      { type: 'text', text: 'Let me look.' },
      toolUseSent('tu-1'),
    ]);
  });

  test('an empty text block is left out, which the API would refuse', () => {
    const answer = fromAnthropicResponse(
      fakeMessage([THINKING, { type: 'text', text: '' }, lookup('tu-1')]),
      undefined,
      MODEL,
    );
    expect(sentBack(answer)).toEqual([THINKING, toolUseSent('tu-1')]);
  });

  test('an answer with no thinking keeps nothing, and goes back as before', () => {
    const answer = fromAnthropicResponse(
      fakeMessage([{ type: 'text', text: 'Let me look.' }, lookup('tu-1')]),
      undefined,
      MODEL,
    );
    expect(answer.toolCalls?.[0]).not.toHaveProperty('signature');
    expect(sentBack(answer)).toEqual([{ type: 'text', text: 'Let me look.' }, toolUseSent('tu-1')]);
  });

  test('without the model that answered, nothing is kept', () => {
    const answer = fromAnthropicResponse(fakeMessage([THINKING, lookup('tu-1')]));
    expect(answer.toolCalls?.[0]).not.toHaveProperty('signature');
  });

  describe('goes back without its thinking, as text then calls, when', () => {
    const answer = fromAnthropicResponse(
      fakeMessage([
        THINKING,
        { type: 'text', text: 'Let me look.' },
        lookup('tu-1'),
        lookup('tu-2'),
      ]),
      undefined,
      MODEL,
    );
    const calls = answer.toolCalls ?? [];
    const signature = calls[0]?.signature ?? '';
    const withSignature = (s: string): ModelMessage => ({
      ...answer,
      toolCalls: calls.map((c, i) => (i === 0 ? { ...c, signature: s } : c)),
    });
    const encoded = (value: unknown) =>
      `anth1.${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
    const carried = JSON.parse(
      Buffer.from(signature.slice('anth1.'.length), 'base64url').toString('utf8'),
    ) as { model: string; blocks: unknown[] };

    test.each([
      ['another model is called', answer, 'claude-opus-5-5'],
      ['the caller names no model', answer, undefined],
      ['its text was edited', { ...answer, content: 'Let me look it up.' }, MODEL],
      ['a call was removed', { ...answer, toolCalls: calls.slice(0, 1) }, MODEL],
      ['its calls were reordered', { ...answer, toolCalls: [...calls].reverse() }, MODEL],
      ["the signature is another adapter's (OpenAI Responses)", withSignature('oair1.e30'), MODEL],
      [
        "the signature is another adapter's (the shared engine)",
        withSignature('aisdk1.e30'),
        MODEL,
      ],
      ["the carry isn't JSON", withSignature('anth1.bm90IGpzb24'), MODEL],
      ['the carry has no blocks', withSignature(encoded({ model: MODEL })), MODEL],
      [
        'a carried block is malformed',
        withSignature(encoded({ ...carried, blocks: [{ type: 'thinking', thinking: 'x' }] })),
        MODEL,
      ],
      [
        'a carried block is of a kind it never keeps',
        withSignature(encoded({ ...carried, blocks: [...carried.blocks, { type: 'image' }] })),
        MODEL,
      ],
    ] as const)('%s', (_, message, model) => {
      // Called directly: `sentBack`'s default would stand in for a missing model.
      const sent = toAnthropicMessages(trailAfter(message as ModelMessage), model).messages[1]
        ?.content;
      expect(sent).toEqual([
        { type: 'text', text: (message as ModelMessage).content },
        ...((message as ModelMessage).toolCalls ?? []).map((c) => toolUseSent(c.id)),
      ]);
    });
  });
});

describe('mapStopReason', () => {
  test.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['pause_turn', 'stop'],
    ['max_tokens', 'length'],
    ['tool_use', 'tool-use'],
    ['refusal', 'content-filter'],
  ] as const)('%s → %s', (input, expected) => {
    expect(mapStopReason(input as Anthropic.Message['stop_reason'])).toBe(expected);
  });

  test('null (streaming edge) → stop', () => {
    expect(mapStopReason(null)).toBe('stop');
  });
});

function fakeMessage(content: readonly unknown[]): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: content as Anthropic.ContentBlock[],
    model: 'claude-opus-4-7',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  } as unknown as Anthropic.Message;
}
