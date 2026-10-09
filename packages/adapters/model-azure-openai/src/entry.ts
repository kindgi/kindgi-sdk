// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Azure OpenAI adapter: a registration's models served by its Azure OpenAI deployments,
 * through `@kindgi/adapter-model-shared` (retries, typed errors, the reasoning state across a
 * pause, usage and cost).
 *
 * How it signs in, pinned (each has a test):
 *   - `auth: entra`: a bearer token from the runtime's own Azure identity
 *     (`AdapterFactoryInput.identities.azure`), fetched for every request; no `api-key` header.
 *   - `auth: api-key`: the key `secret_ref` names, read for every request, so a rotated key
 *     takes effect on the next call.
 *   - Never `AZURE_API_KEY` or `AZURE_RESOURCE_NAME` from the environment: the provider is
 *     always given its endpoint and its credential.
 */

import { createAzure } from '@ai-sdk/azure';
import { tokenCostUsd } from '@kindgi/adapter-model-shared';
import { createAiSdkModelProvider } from '@kindgi/adapter-model-shared/ai-sdk';
import {
  type AdapterConfigCheckInput,
  type AdapterConfigProblem,
  type AdapterFactory,
  type AdapterFactoryEntry,
  type AzureTokenClient,
  adapterConfigError,
} from '@kindgi/capabilities';

import { AZURE_OPENAI_ADAPTER_ID, readAzureOpenAIConfig } from './config.js';

/** The Entra scope Azure OpenAI takes. */
export const AZURE_OPENAI_SCOPE = 'https://cognitiveservices.azure.com/.default';

/** What's wrong with a registration, for `POST /v1/providers` and `GET …/check`. */
export function azureOpenAICheckConfig(
  input: AdapterConfigCheckInput,
): readonly AdapterConfigProblem[] {
  const read = readAzureOpenAIConfig(input);
  return read.kind === 'ok' ? [] : read.problems;
}

export const azureOpenAIAdapterFactory: AdapterFactory = (input) => {
  const { metadata } = input;
  const read = readAzureOpenAIConfig({
    metadata,
    ...(input.config !== undefined && { config: input.config }),
    hasSecretRef: input.resolveApiKey !== undefined,
  });
  if (read.kind === 'err') {
    throw adapterConfigError(AZURE_OPENAI_ADAPTER_ID, metadata.id, read.problems[0] as never);
  }
  const { endpoint, api, auth, deployments } = read.config;

  const tokens = input.identities?.azure;
  if (auth === 'entra' && tokens === undefined) {
    throw adapterConfigError(AZURE_OPENAI_ADAPTER_ID, metadata.id, {
      path: '/adapter_config/auth',
      message:
        "auth = entra needs the runtime's Azure identity (its managed identity; KINDGI_AZURE_CLIENT_ID names a user-assigned one), and this runtime has none.",
    });
  }
  const resolveApiKey = input.resolveApiKey;

  return createAiSdkModelProvider({
    metadata,
    ...(input.fetch !== undefined && { fetch: input.fetch }),
    languageModel: (name, fetch) => {
      const azure = createAzure({
        ...endpoint,
        ...(auth === 'entra'
          ? { tokenProvider: entraToken(tokens as AzureTokenClient) }
          : // An explicit (empty) key keeps the provider from reading AZURE_API_KEY; the real
            // one is set on every request, so a rotated key takes effect on the next call.
            { apiKey: '', fetch: withApiKey(fetch, resolveApiKey as () => Promise<string>) }),
        ...(auth === 'entra' && { fetch }),
      });
      const deployment = deployments.get(name) as string;
      return api === 'chat-completions' ? azure.chat(deployment) : azure.responses(deployment);
    },
    // Responses keeps nothing on Azure's side: our journal is the record.
    providerOptions: () => (api === 'responses' ? { azure: { store: false } } : undefined),
    cost: (model, usage) => tokenCostUsd(model, usage),
  });
};

/** The entry a runtime registers: the factory, and its static check. */
export const azureOpenAIAdapterEntry: AdapterFactoryEntry = {
  adapterId: AZURE_OPENAI_ADAPTER_ID,
  capabilityKind: 'llm-inference',
  factory: azureOpenAIAdapterFactory,
  checkConfig: azureOpenAICheckConfig,
};

/** A bearer for each request, from the runtime's Azure identity. */
function entraToken(tokens: AzureTokenClient): () => Promise<string> {
  return async () => {
    const token = (await tokens.getToken(AZURE_OPENAI_SCOPE))?.token;
    if (token === undefined || token === '') {
      throw new Error(`The runtime's Azure identity returned no token for ${AZURE_OPENAI_SCOPE}`);
    }
    return token;
  };
}

/** The `api-key` header set on every request from the current key. */
function withApiKey(
  fetch: typeof globalThis.fetch,
  resolveApiKey: () => Promise<string>,
): typeof globalThis.fetch {
  return async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set('api-key', await resolveApiKey());
    return fetch(url, { ...init, headers });
  };
}
