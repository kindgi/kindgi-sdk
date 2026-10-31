// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * How much a model thinks, in process: these models carry no thinking
 * setting, so a level a call asks for is sent nowhere, and the answer
 * says so (`thinking-unsupported`). The transformers.js pipeline is
 * replaced by one that echoes, so no model is downloaded.
 */

import { describe, expect, test, vi } from 'vitest';

import { createInProcessModelProvider } from '../src/index.js';

const options: Record<string, unknown>[] = [];

vi.mock('@huggingface/transformers', () => ({
  async pipeline() {
    const generate = async (
      messages: { role: string; content: string }[],
      opts: Record<string, unknown>,
    ) => {
      options.push(opts);
      return [{ generated_text: [...messages, { role: 'assistant', content: 'OK' }] }];
    };
    return Object.assign(generate, { tokenizer: {} });
  },
}));

describe('thinking, in process', () => {
  const ask = { model: 'smollm2-360m', messages: [{ role: 'user' as const, content: 'Hi' }] };

  test('a level asked is sent nowhere, with a warning, and none is reported', async () => {
    const result = await createInProcessModelProvider().invoke({ ...ask, thinking: 'high' });
    expect(result.message.content).toBe('OK');
    expect(result.thinking).toBeUndefined();
    expect(result.warnings).toEqual([
      {
        code: 'thinking-unsupported',
        message:
          "smollm2-360m doesn't think, or how it thinks isn't known, so the call sent no level (it asked for high).",
      },
    ]);
    expect(Object.keys(options.at(-1) ?? {})).toEqual(['max_new_tokens', 'do_sample']);
  });

  test('none asked: no warning', async () => {
    const result = await createInProcessModelProvider().invoke(ask);
    expect(result).not.toHaveProperty('warnings');
    expect(result).not.toHaveProperty('thinking');
  });
});
