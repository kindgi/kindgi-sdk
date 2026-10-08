// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type Anthropic from '@anthropic-ai/sdk';
import type { ModelMessage } from '@kindgi/capabilities';
import { describe, expect, test } from 'vitest';

import {
  PROMPT_CACHE,
  toAnthropicMessages,
  toAnthropicTools,
  withPromptCache,
} from '../src/index.js';

const TOOLS = toAnthropicTools([
  { name: 'acme.lookup_order', description: 'Look up an order.', inputSchema: { type: 'object' } },
  { name: 'acme.cancel_order', description: 'Cancel an order.', inputSchema: { type: 'object' } },
]);

/** Every block that carries a breakpoint, as `<where>:<type>`. */
function breakpoints(request: ReturnType<typeof withPromptCache>): string[] {
  const marked: string[] = [];
  for (const tool of request.tools ?? []) {
    if (tool.cache_control !== undefined) marked.push(`tools:${tool.name}`);
  }
  request.system?.forEach((block, i) => {
    if (block.cache_control !== undefined) marked.push(`system:${i}`);
  });
  request.messages.forEach((message, m) => {
    if (typeof message.content === 'string') return;
    message.content.forEach((block, b) => {
      if ('cache_control' in block && block.cache_control !== undefined) {
        marked.push(`messages:${m}.${b}:${block.type}`);
      }
    });
  });
  return marked;
}

function request(messages: readonly ModelMessage[], tools?: readonly Anthropic.Tool[]) {
  const translated = toAnthropicMessages(messages);
  return withPromptCache({
    systemParts: translated.systemParts,
    tools,
    messages: translated.messages,
  });
}

describe('withPromptCache', () => {
  test("a tool loop's step: the last tool, the agent's prompt, and the last tool result", () => {
    const cached = request(
      [
        { role: 'system', content: 'You answer questions about orders.' },
        { role: 'system', content: 'Retrieved: order A-1042 was placed on 2026-09-30.' },
        { role: 'user', content: 'Where is A-1042?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call-1', name: 'acme.lookup_order', arguments: { orderId: 'A-1042' } },
            { id: 'call-2', name: 'acme.lookup_order', arguments: { orderId: 'A-1043' } },
          ],
        },
        { role: 'tool', toolCallId: 'call-1', content: '{"status":"shipped"}' },
        { role: 'tool', toolCallId: 'call-2', content: '{"status":"packed"}' },
      ],
      TOOLS,
    );
    expect(breakpoints(cached)).toEqual([
      'tools:acme__cancel_order',
      'system:0',
      'messages:2.1:tool_result',
    ]);
    // Each system message is its own block; only the agent's prompt is marked,
    // since retrieved context changes from turn to turn.
    expect(cached.system).toEqual([
      { type: 'text', text: 'You answer questions about orders.', cache_control: PROMPT_CACHE },
      { type: 'text', text: 'Retrieved: order A-1042 was placed on 2026-09-30.' },
    ]);
  });

  test('a conversation with an earlier answer marks its last message, tools or not', () => {
    const cached = request([
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello.' },
      { role: 'user', content: 'What can you do?' },
    ]);
    expect(breakpoints(cached)).toEqual(['system:0', 'messages:2.0:text']);
  });

  test("a one-off call (no tools, no earlier answer) leaves its message unmarked: a judge's tail is never sent again", () => {
    const cached = request([
      { role: 'system', content: 'Judge whether the answer cites its source.' },
      { role: 'user', content: 'Answer: the order shipped [1].' },
    ]);
    expect(breakpoints(cached)).toEqual(['system:0']);
  });

  test('no system and no tools: only a continuing conversation is marked', () => {
    expect(breakpoints(request([{ role: 'user', content: 'Hi' }]))).toEqual([]);
    const cached = request([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello.' },
      { role: 'user', content: 'Again' },
    ]);
    expect(cached.system).toBeUndefined();
    expect(cached.tools).toBeUndefined();
    expect(breakpoints(cached)).toEqual(['messages:2.0:text']);
  });

  test('the last block that can carry a breakpoint gets it: an empty text block is passed over', () => {
    const cached = withPromptCache({
      systemParts: [],
      tools: TOOLS,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call-1', content: 'ok' },
            { type: 'text', text: '' },
          ],
        },
      ],
    });
    expect(breakpoints(cached)).toEqual(['tools:acme__cancel_order', 'messages:0.0:tool_result']);
  });

  test('a string message is turned into a marked text block', () => {
    const cached = withPromptCache({
      systemParts: [],
      tools: TOOLS,
      messages: [{ role: 'user', content: 'Where is A-1042?' }],
    });
    expect(cached.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Where is A-1042?', cache_control: PROMPT_CACHE }],
      },
    ]);
  });

  test('never more than three breakpoints (Anthropic allows four), and the inputs are left as they were', () => {
    const tools = TOOLS.map((tool) => ({ ...tool }));
    const translated = toAnthropicMessages([
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
      { role: 'system', content: 'C' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello.' },
      { role: 'user', content: 'Again' },
    ]);
    const before = JSON.stringify({ tools, messages: translated.messages });
    const cached = withPromptCache({
      systemParts: translated.systemParts,
      tools,
      messages: translated.messages,
    });
    expect(breakpoints(cached)).toHaveLength(3);
    expect(JSON.stringify({ tools, messages: translated.messages })).toBe(before);
  });

  test('the breakpoints use the 5-minute cache', () => {
    expect(PROMPT_CACHE).toEqual({ type: 'ephemeral' });
  });
});
