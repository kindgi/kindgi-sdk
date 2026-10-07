// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The static check a runtime runs when a provider registers
 * (`openAICompatCheckConfig`) agrees with the factory: a registration the
 * check passes builds, and each problem it finds is the error the factory
 * throws, naming the field.
 */

import { describe, expect, test } from 'vitest';

import type { AdapterConfig, ProviderMetadata } from '@kindgi/capabilities';

import {
  BASE_URLS,
  OPENAI_COMPAT_ADAPTER_ID,
  openAICompatAdapterEntry,
  openAICompatCheckConfig,
} from '../src/index.js';

const metadata: ProviderMetadata = {
  id: 'acme-llm',
  region: 'unspecified',
  models: [
    {
      name: 'acme-model',
      contextWindow: 128000,
      features: ['tool-use'],
      cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
    },
  ],
};

/** The check's problems, and what the factory does with the same registration. */
function both(config: AdapterConfig | undefined) {
  const problems = openAICompatCheckConfig({
    metadata,
    ...(config !== undefined && { config }),
    hasSecretRef: false,
  });
  let thrown: string | undefined;
  try {
    openAICompatAdapterEntry.factory({ metadata, ...(config !== undefined && { config }) });
  } catch (err) {
    thrown = (err as Error).message;
  }
  return { problems, thrown };
}

describe('openAICompatCheckConfig agrees with the factory', () => {
  test.each([
    ['a local runner', { baseURL: BASE_URLS.OLLAMA_LOCAL }],
    ['OpenAI, Responses by default', { baseURL: BASE_URLS.OPENAI }],
    ['OpenAI, the preset', { baseURL: BASE_URLS.OPENAI, api: 'responses' }],
    [
      'OpenAI on Chat Completions',
      { baseURL: BASE_URLS.OPENAI, api: 'chat-completions', 'extraBody.store': true },
    ],
    ['Groq with extra fields', { baseURL: BASE_URLS.GROQ, 'extraBody.reasoning_effort': 'low' }],
    [
      'vLLM with a nested field',
      { baseURL: BASE_URLS.VLLM_LOCAL, 'extraBody.chat_template_kwargs.enable_thinking': false },
    ],
  ])('%s: no problems, and the factory builds it', (_name, config) => {
    const { problems, thrown } = both(config);
    expect(problems).toEqual([]);
    expect(thrown).toBeUndefined();
  });

  test.each([
    [
      'no config',
      undefined,
      '/adapter_config/baseURL',
      'needs adapter_config.baseURL, an http(s) URL',
    ],
    [
      'a base URL without a scheme',
      { baseURL: 'api.openai.com/v1' },
      '/adapter_config/baseURL',
      'needs adapter_config.baseURL',
    ],
    [
      'an API it does not speak',
      { baseURL: BASE_URLS.OPENAI, api: 'completions' },
      '/adapter_config/api',
      'adapter_config.api must be one of responses, chat-completions.',
    ],
    [
      'extra fields as one JSON key',
      { baseURL: BASE_URLS.VLLM_LOCAL, extraBody: '{"top_k":20}' },
      '/adapter_config/extraBody',
      'adapter_config takes extra request fields one per key',
    ],
    [
      'an unsafe field name',
      { baseURL: BASE_URLS.VLLM_LOCAL, 'extraBody.__proto__.polluted': true },
      '/adapter_config/extraBody.__proto__.polluted',
      "isn't a field path",
    ],
    [
      'two keys that collide',
      { baseURL: BASE_URLS.VLLM_LOCAL, 'extraBody.a': 1, 'extraBody.a.b': 2 },
      '/adapter_config/extraBody.a.b',
      'nests under a field another key sets',
    ],
    [
      'a field Chat Completions sets',
      { baseURL: BASE_URLS.VLLM_LOCAL, 'extraBody.messages': 'x' },
      '/adapter_config/extraBody.messages',
      "extraBody can't set messages: the adapter sets it",
    ],
    [
      'a field Responses sets',
      { baseURL: BASE_URLS.OPENAI, 'extraBody.store': true },
      '/adapter_config/extraBody.store',
      "extraBody can't set store: the adapter sets it",
    ],
  ])(
    '%s: the check points at the setting, and the factory throws the same message',
    (_name, config, path, says) => {
      const { problems, thrown } = both(config as AdapterConfig | undefined);
      expect(problems.length).toBeGreaterThan(0);
      const problem = problems.find((p) => p.path === path);
      expect(problem?.message).toContain(says);
      expect(problem?.message.startsWith(`${OPENAI_COMPAT_ADAPTER_ID}: provider "acme-llm"`)).toBe(
        true,
      );
      // The factory refuses it, with one of the check's own messages.
      expect(thrown).toBeDefined();
      expect(problems.map((p) => p.message)).toContain(thrown);
    },
  );

  test('every problem in a registration is reported, not only the first', () => {
    const { problems } = both({ api: 'completions', 'extraBody.model': 'x' });
    expect(problems.map((p) => p.path)).toEqual([
      '/adapter_config/baseURL',
      '/adapter_config/api',
      '/adapter_config/extraBody.model',
    ]);
  });

  test('the entry a runtime registers carries the check', () => {
    expect(openAICompatAdapterEntry).toMatchObject({
      adapterId: OPENAI_COMPAT_ADAPTER_ID,
      capabilityKind: 'llm-inference',
      checkConfig: openAICompatCheckConfig,
    });
  });
});
