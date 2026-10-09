// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Amazon Bedrock adapter: a registration's models (model or inference-profile ids, such as
 * `us.amazon.nova-pro-v1:0`) on Bedrock's Converse API, through `@kindgi/adapter-model-shared`
 * (retries, typed errors, the reasoning state across a pause, usage and cost).
 *
 * Pinned, each with a test:
 *   - It signs in before each attempt (`beforeAttempt`), with the call's abort signal, and the
 *     attempt's request reads what it got (`attemptPrepared()`): calls at once never share one,
 *     and a failure is typed there (the library would report a credential failure as a plain
 *     error, and retry it).
 *   - `auth: aws-identity` (the default): requests signed with SigV4, with credentials from the
 *     runtime's AWS identity (`AdapterFactoryInput.identities.aws`), asked for every attempt (it
 *     refreshes them itself), within 10 seconds. `apiKey: ''` keeps a stray
 *     `AWS_BEARER_TOKEN_BEDROCK` from switching the provider to a bearer key. Only Bedrock's
 *     runtime in the region gets them (`isBedrockRuntimeHost`): any other host is refused.
 *   - `auth: api-key`: the key `secret_ref` names, read for every attempt and sent as the
 *     bearer token, so a rotated key takes effect on the next call. No SigV4, so no AWS
 *     credentials are looked for.
 *   - A failed sign-in (no credentials, no key, a blank one) is an `auth` error, never retried.
 *   - No request follows a redirect: the credential goes to the endpoint, nowhere else.
 *   - The region is the registration's (`metadata.region`), never `AWS_REGION`, and the endpoint
 *     is always given (the region's own, or `adapter_config.baseURL`), so
 *     `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` and `AWS_ENDPOINT_URL` are never read.
 */

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { ModelProviderError, tokenCostUsd } from '@kindgi/adapter-model-shared';
import { attemptPrepared, createAiSdkModelProvider } from '@kindgi/adapter-model-shared/ai-sdk';
import {
  type AdapterConfigCheckInput,
  type AdapterConfigProblem,
  type AdapterFactory,
  type AdapterFactoryEntry,
  type AwsCredentialClient,
  type AwsCredentials,
  adapterConfigError,
  identitiesPresent,
} from '@kindgi/capabilities';

import { BEDROCK_ADAPTER_ID, readBedrockConfig } from './config.js';
import { isNovaModel, withoutLeadingThinking } from './nova-thinking.js';

/**
 * What the provider is built with in `api-key` mode, so it sends a bearer token: never sent,
 * since the current key replaces it on every request.
 */
const KEY_SET_PER_REQUEST = 'set-per-request';

/** How long the runtime's AWS identity may take before the call fails as `auth`. */
export const IDENTITY_TIMEOUT_MS = 10_000;

/** What's wrong with a registration, for `POST /v1/providers` and `GET …/check`. */
export function bedrockCheckConfig(
  input: AdapterConfigCheckInput,
): readonly AdapterConfigProblem[] {
  const read = readBedrockConfig(input);
  return read.kind === 'ok' ? [] : read.problems;
}

export const bedrockAdapterFactory: AdapterFactory = (input) => {
  const { metadata } = input;
  const read = readBedrockConfig({
    metadata,
    ...(input.config !== undefined && { config: input.config }),
    hasSecretRef: input.resolveApiKey !== undefined,
    identities: identitiesPresent(input.identities),
  });
  if (read.kind === 'err') {
    throw adapterConfigError(
      BEDROCK_ADAPTER_ID,
      metadata.id,
      read.problems[0] as AdapterConfigProblem,
    );
  }
  const { region, baseURL, auth } = read.config;
  const identity = input.identities?.aws;
  const resolveApiKey = input.resolveApiKey;

  const provider = createAiSdkModelProvider({
    metadata,
    ...(input.fetch !== undefined && { fetch: input.fetch }),
    beforeAttempt: (signal): Promise<SignedIn> =>
      auth === 'aws-identity'
        ? awsCredentials(identity as AwsCredentialClient, signal).then((credentials) => ({
            credentials,
          }))
        : bedrockKey(resolveApiKey as () => Promise<string>).then((key) => ({ key })),
    languageModel: (name, fetch) => {
      const send = withoutRedirects(fetch);
      return createAmazonBedrock({
        region,
        baseURL,
        ...(auth === 'aws-identity'
          ? {
              apiKey: '',
              // This attempt's, asked for in `beforeAttempt`: the library's own ask never fails.
              credentialProvider: async () => signedIn().credentials as AwsCredentials,
              fetch: send,
            }
          : { apiKey: KEY_SET_PER_REQUEST, fetch: withBearerKey(send) }),
      })(name);
    },
    cost: (model, usage) => tokenCostUsd(model, usage),
    explain: (error) => (error.status === 403 ? accessHint(auth, region) : undefined),
  });
  // Nova's chain of thought, written into its answer, is taken out (`nova-thinking.ts`).
  return {
    ...provider,
    invoke: async (call) => {
      const result = await provider.invoke(call);
      return isNovaModel(call.model) ? withoutLeadingThinking(result) : result;
    },
  };
};

/** The entry a runtime registers: the factory, and its static check. */
export const bedrockAdapterEntry: AdapterFactoryEntry = {
  adapterId: BEDROCK_ADAPTER_ID,
  capabilityKind: 'llm-inference',
  factory: bedrockAdapterFactory,
  checkConfig: bedrockCheckConfig,
};

/** What a 403 from Bedrock can mean, beyond its own words, for how the adapter signed in. */
function accessHint(auth: 'aws-identity' | 'api-key', region: string): string {
  const noAccess = `when the account has no access to the model in ${region} (model access, or a Marketplace agreement still being made: retry in 15 minutes)`;
  return auth === 'aws-identity'
    ? `Bedrock refuses when the runtime's identity's policy lacks bedrock:InvokeModel on the model (for an inference profile, on the profile and on the foundation model in each of its Regions), ${noAccess}, or when the credentials have expired.`
    : `Bedrock refuses when the IAM user the API key belongs to lacks bedrock:InvokeModel on the model (for an inference profile, on the profile and on the foundation model in each of its Regions), ${noAccess}, or when the key has expired or been revoked.`;
}

/** What an attempt signed in with: the identity's credentials, or a key. */
interface SignedIn {
  readonly credentials?: AwsCredentials;
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

/** The runtime's AWS credentials for an attempt: bounded, stopped with the call, `auth` when none. */
async function awsCredentials(
  identity: AwsCredentialClient,
  signal: AbortSignal | undefined,
): Promise<AwsCredentials> {
  let credentials: AwsCredentials;
  try {
    credentials = await bounded(identity(), IDENTITY_TIMEOUT_MS, signal);
  } catch (error) {
    // (A call stopped meanwhile ends with its own reason: the retries check the signal first.)
    throw new ModelProviderError(
      'auth',
      undefined,
      `The runtime's AWS identity gave no credentials: ${messageOf(error)}. KINDGI_AWS_IDENTITY says where they come from.`,
      { cause: error },
    );
  }
  if (credentials?.accessKeyId === undefined || credentials.accessKeyId === '') {
    throw new ModelProviderError(
      'auth',
      undefined,
      "The runtime's AWS identity returned no credentials. KINDGI_AWS_IDENTITY says where they come from.",
    );
  }
  return credentials;
}

/** The current key `secret_ref` names, for an attempt; `auth` when there's none. */
async function bedrockKey(resolveApiKey: () => Promise<string>): Promise<string> {
  let key: string;
  try {
    key = await resolveApiKey();
  } catch (error) {
    throw new ModelProviderError(
      'auth',
      undefined,
      `The Bedrock API key secret_ref names couldn't be read: ${messageOf(error)}.`,
      { cause: error },
    );
  }
  // Whitespace around a key (a stored file's newline) is never the key's.
  const trimmed = key.trim();
  if (trimmed === '') {
    throw new ModelProviderError(
      'auth',
      undefined,
      'The Bedrock API key secret_ref names is empty.',
    );
  }
  return trimmed;
}

/** The bearer token on the request, from this attempt's key. */
function withBearerKey(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${signedIn().key as string}`);
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
