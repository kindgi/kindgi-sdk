// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * How many tokens a call may write, in process: the call's own
 * `maxOutputTokens`, else the one its model is registered with, else 512.
 * The transformers.js pipeline is replaced by one that records what it's
 * asked, so no model is downloaded.
 */

import { describe, expect, test, vi } from 'vitest';

import type { ProviderMetadata } from '@kindgi/capabilities';

import {
  DEFAULT_LOCAL_MODEL,
  createInProcessModelProvider,
  inProcessAdapterEntry,
} from '../src/index.js';

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

/** A registration of the default model, with `maxOutputTokens` when given. */
const registered = (maxOutputTokens?: number): ProviderMetadata => ({
  id: 'acme-local',
  region: 'local',
  models: [
    {
      name: DEFAULT_LOCAL_MODEL,
      contextWindow: 8192,
      ...(maxOutputTokens !== undefined && { maxOutputTokens }),
      features: [],
      cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
    },
  ],
});

const ask = { model: DEFAULT_LOCAL_MODEL, messages: [{ role: 'user' as const, content: 'Hi' }] };

describe('max_new_tokens, in process', () => {
  test.each([
    { name: "the call sets one: the call's", metadata: registered(128), call: 64, sent: 64 },
    {
      name: "the call sets none: the model's registered one",
      metadata: registered(128),
      call: undefined,
      sent: 128,
    },
    { name: 'neither sets one: 512', metadata: registered(), call: undefined, sent: 512 },
  ])('$name', async ({ metadata, call, sent }) => {
    const provider = inProcessAdapterEntry.factory({ metadata });
    await provider.invoke({ ...ask, ...(call !== undefined && { maxOutputTokens: call }) });
    expect(options.at(-1)?.max_new_tokens).toBe(sent);
  });

  test("the provider lists a model's registered maxOutputTokens; one built without a registration lists none", () => {
    expect(
      inProcessAdapterEntry.factory({ metadata: registered(128) }).metadata.models[0]
        ?.maxOutputTokens,
    ).toBe(128);
    expect(createInProcessModelProvider().metadata.models[0]).not.toHaveProperty('maxOutputTokens');
  });
});
