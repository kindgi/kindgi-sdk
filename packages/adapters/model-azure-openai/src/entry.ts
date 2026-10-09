// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Azure OpenAI adapter: a registration's models served by its Azure OpenAI deployments,
 * through `@kindgi/adapter-model-shared` (retries, typed errors, the reasoning state across a
 * pause, usage and cost).
 *
 * How it signs in, pinned (each has a test):
 *   - Before each attempt (`beforeAttempt`), with the call's abort signal; the attempt's
 *     request reads what it got (`attemptPrepared()`), so calls at once never share one.
 *   - `auth: entra`: a bearer token from the runtime's own Azure identity
 *     (`AdapterFactoryInput.identities.azure`), asked for every attempt (bounded), for the
 *     endpoint's cloud's scope; no `api-key` header. Only an Azure OpenAI host gets it
 *     (`AZURE_OPENAI_CLOUDS`): any other is refused at registration.
 *   - `auth: api-key`: the key `secret_ref` names, read for every attempt, so a rotated key
 *     takes effect on the next call.
 *   - A failed sign-in (no token, no key, a blank one) is an `auth` error, never retried.
 *   - No request follows a redirect: the credential goes to the endpoint, nowhere else.
 *   - Never `AZURE_API_KEY` or `AZURE_RESOURCE_NAME` from the environment: the provider is
 *     always given its endpoint and its credential.
 */

import { createAzure } from '@ai-sdk/azure';
import { ModelProviderError, tokenCostUsd } from '@kindgi/adapter-model-shared';
import { attemptPrepared, createAiSdkModelProvider } from '@kindgi/adapter-model-shared/ai-sdk';
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
    beforeAttempt: (signal): Promise<SignedIn> =>
      auth === 'entra'
        ? entraToken(tokens as AzureTokenClient, scope as string, signal).then((token) => ({
            token,
          }))
        : apiKey(resolveApiKey as () => Promise<string>).then((key) => ({ key })),
    languageModel: (name, fetch) => {
      const send = withoutRedirects(fetch);
      const azure = createAzure({
        ...endpoint,
        ...(auth === 'entra'
          ? { tokenProvider: async () => signedIn().token as string, fetch: send }
          : // An explicit (empty) key keeps the provider from reading AZURE_API_KEY; the real
            // one, this attempt's, is set on its request.
            { apiKey: '', fetch: withApiKey(send) }),
      });
      const deployment = deployments.get(name) as string;
      return api === 'chat-completions' ? azure.chat(deployment) : azure.responses(deployment);
    },
    // Responses keeps nothing on Azure's side: our journal is the record. Whether a model
    // reasons is the registration's to say where it says (the deployment's name, which the
    // library reads as the model's, can say nothing); where it doesn't, the library decides.
    // Responses reads it under `azure`, Chat under `openai`.
    providerOptions: (model) => {
      const forced = reasons(model);
      const reasoning = forced === undefined ? {} : { forceReasoning: forced };
      return api === 'responses'
        ? { azure: { store: false, ...reasoning } }
        : forced === undefined
          ? undefined
          : { openai: reasoning };
    },
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

/**
 * Whether the registration says a model reasons: yes when it thinks or takes no sampling (GPT-5
 * and later, o-series), no when it takes sampling, said; undefined when it says neither.
 */
function reasons(model: ModelInfo): boolean | undefined {
  if (model.thinking !== undefined || model.sampling === false) return true;
  return model.sampling === true ? false : undefined;
}

/** What an attempt signed in with: a token (Entra) or a key. */
interface SignedIn {
  readonly token?: string;
  readonly key?: string;
}

/** This attempt's sign-in, read by its request. */
function signedIn(): SignedIn {
  const signed = attemptPrepared<SignedIn>();
  if (signed === undefined) {
    throw new ModelProviderError('auth', undefined, 'The request has no sign-in of its own.');
  }
  return signed;
}

const SIGN_IN_HINT =
  'It signs in as its managed identity (KINDGI_AZURE_CLIENT_ID names a user-assigned one), which needs the Cognitive Services OpenAI User role on the resource.';

/**
 * A bearer for an attempt, from the runtime's Azure identity: bounded, stopped with the call,
 * and `auth` when it fails.
 */
async function entraToken(
  tokens: AzureTokenClient,
  scope: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  let token: string | undefined;
  try {
    const asked =
      signal !== undefined
        ? tokens.getToken(scope, { abortSignal: signal })
        : tokens.getToken(scope);
    token = (await bounded(asked, IDENTITY_TIMEOUT_MS, signal))?.token;
  } catch (error) {
    // (A call stopped meanwhile ends with its own reason: the retries check the signal first.)
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
}

/** The current key `secret_ref` names, for an attempt; `auth` when there's none. */
async function apiKey(resolveApiKey: () => Promise<string>): Promise<string> {
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
  // Whitespace around a key (a stored file's newline) is never the key's.
  const trimmed = key.trim();
  if (trimmed === '') {
    throw new ModelProviderError('auth', undefined, 'The key secret_ref names is empty.');
  }
  return trimmed;
}

/** The `api-key` header on the request, from this attempt's key. */
function withApiKey(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set('api-key', signedIn().key as string);
    return fetch(url, { ...init, headers });
  };
}

/** No request follows a redirect, so its credential reaches the endpoint and nothing else. */
function withoutRedirects(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return (url, init) => fetch(url, { ...init, redirect: 'error' });
}

/** The promise, or a failure after `ms`, or the signal's reason when the call stops first. */
function bounded<T>(promise: PromiseLike<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms);
    if (signal !== undefined) {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  return Promise.race([Promise.resolve(promise), stop]).finally(() => {
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  });
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
