// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Azure OpenAI adapter: a registration's models served by its Azure OpenAI deployments,
 * through `@kindgi/adapter-model-shared` (retries, typed errors, the reasoning state across a
 * pause, usage and cost).
 *
 * How it signs in, pinned (each has a test):
 *   - `auth: entra`: a bearer token from the runtime's own Azure identity
 *     (`AdapterFactoryInput.identities.azure`), fetched for every request (bounded), for the
 *     endpoint's cloud's scope; no `api-key` header. Only an Azure OpenAI host gets it
 *     (`AZURE_OPENAI_CLOUDS`): any other is refused at registration.
 *   - A failed sign-in (no token, no key) is an `auth` error, never retried.
 *   - `auth: api-key`: the key `secret_ref` names, read for every request, so a rotated key
 *     takes effect on the next call.
 *   - Never `AZURE_API_KEY` or `AZURE_RESOURCE_NAME` from the environment: the provider is
 *     always given its endpoint and its credential.
 */

import { createAzure } from '@ai-sdk/azure';
import { ModelProviderError, tokenCostUsd } from '@kindgi/adapter-model-shared';
import { createAiSdkModelProvider } from '@kindgi/adapter-model-shared/ai-sdk';
import {
  type AdapterConfigCheckInput,
  type AdapterConfigProblem,
  type AdapterFactory,
  type AdapterFactoryEntry,
  type AzureTokenClient,
  type ModelInfo,
  adapterConfigError,
  identitiesPresent,
} from '@kindgi/capabilities';

import { AZURE_OPENAI_ADAPTER_ID, AZURE_OPENAI_CLOUDS, readAzureOpenAIConfig } from './config.js';

/** The Entra scope Azure OpenAI takes in Azure's public cloud. */
export const AZURE_OPENAI_SCOPE = AZURE_OPENAI_CLOUDS[0].scope;

/** How long a token from the runtime's identity may take before the call fails as `auth`. */
export const IDENTITY_TIMEOUT_MS = 10_000;

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
    identities: identitiesPresent(input.identities),
  });
  if (read.kind === 'err') {
    throw adapterConfigError(
      AZURE_OPENAI_ADAPTER_ID,
      metadata.id,
      read.problems[0] as AdapterConfigProblem,
    );
  }
  const { endpoint, api, auth, scope, deployments } = read.config;
  const tokens = input.identities?.azure;
  const resolveApiKey = input.resolveApiKey;

  return createAiSdkModelProvider({
    metadata,
    ...(input.fetch !== undefined && { fetch: input.fetch }),
    languageModel: (name, fetch) => {
      const azure = createAzure({
        ...endpoint,
        ...(auth === 'entra'
          ? { tokenProvider: entraToken(tokens as AzureTokenClient, scope as string) }
          : // An explicit (empty) key keeps the provider from reading AZURE_API_KEY; the real
            // one is set on every request, so a rotated key takes effect on the next call.
            { apiKey: '', fetch: withApiKey(fetch, resolveApiKey as () => Promise<string>) }),
        ...(auth === 'entra' && { fetch }),
      });
      const deployment = deployments.get(name) as string;
      return api === 'chat-completions' ? azure.chat(deployment) : azure.responses(deployment);
    },
    // Responses keeps nothing on Azure's side: our journal is the record. Whether a model
    // reasons is the registration's to say, never guessed from the deployment's name (which the
    // library would read as the model's): Responses reads it under `azure`, Chat under `openai`.
    providerOptions: (model) =>
      api === 'responses'
        ? { azure: { store: false, forceReasoning: reasons(model) } }
        : { openai: { forceReasoning: reasons(model) } },
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

/** A registered model reasons when it thinks, or takes no sampling (GPT-5 and later, o-series). */
const reasons = (model: ModelInfo): boolean =>
  model.thinking !== undefined || model.sampling === false;

const SIGN_IN_HINT =
  'It signs in as its managed identity (KINDGI_AZURE_CLIENT_ID names a user-assigned one), which needs the Cognitive Services OpenAI User role on the resource.';

/** A bearer for each request, from the runtime's Azure identity: bounded, and `auth` when it fails. */
function entraToken(tokens: AzureTokenClient, scope: string): () => Promise<string> {
  return async () => {
    let token: string | undefined;
    try {
      token = (await withTimeout(tokens.getToken(scope), IDENTITY_TIMEOUT_MS))?.token;
    } catch (error) {
      throw new ModelProviderError(
        'auth',
        undefined,
        `The runtime's Azure identity gave no token for ${scope}: ${messageOf(error)}. ${SIGN_IN_HINT}`,
        { cause: error },
      );
    }
    if (token === undefined || token === '') {
      throw new ModelProviderError(
        'auth',
        undefined,
        `The runtime's Azure identity returned no token for ${scope}. ${SIGN_IN_HINT}`,
      );
    }
    return token;
  };
}

/** The `api-key` header set on every request from the current key; `auth` when there's none. */
function withApiKey(
  fetch: typeof globalThis.fetch,
  resolveApiKey: () => Promise<string>,
): typeof globalThis.fetch {
  return async (url, init) => {
    let key: string;
    try {
      key = await resolveApiKey();
    } catch (error) {
      throw new ModelProviderError(
        'auth',
        undefined,
        `The key secret_ref names couldn't be read: ${messageOf(error)}.`,
        { cause: error },
      );
    }
    if (key === '') {
      throw new ModelProviderError('auth', undefined, 'The key secret_ref names is empty.');
    }
    const headers = new Headers(init?.headers);
    headers.set('api-key', key);
    return fetch(url, { ...init, headers });
  };
}

function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
