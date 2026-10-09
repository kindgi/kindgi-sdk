// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Amazon Bedrock adapter: a registration's models (model or inference-profile ids, such as
 * `us.amazon.nova-pro-v1:0`) on Bedrock's Converse API, through `@kindgi/adapter-model-shared`
 * (retries, typed errors, the reasoning state across a pause, usage and cost).
 *
 * Pinned, each with a test:
 *   - `auth: aws-identity` (the default): requests signed with SigV4, with credentials from the
 *     runtime's AWS identity (`AdapterFactoryInput.identities.aws`), asked for every request (it
 *     refreshes them itself), within 10 seconds. `apiKey: ''` keeps a stray
 *     `AWS_BEARER_TOKEN_BEDROCK` from switching the provider to a bearer key. Only Bedrock's
 *     runtime in the region gets them (`isBedrockRuntimeHost`): any other host is refused.
 *   - A failed sign-in (no credentials, no key) is an `auth` error, never retried. The library
 *     reports a credential failure as a plain error, so they're asked for before each attempt
 *     (`beforeAttempt`), where the failure is typed.
 *   - `auth: api-key`: the key `secret_ref` names, read for every request and sent as the
 *     bearer token, so a rotated key takes effect on the next call. No SigV4, so no AWS
 *     credentials are looked for.
 *   - The region is the registration's (`metadata.region`), never `AWS_REGION`, and the endpoint
 *     is always given (the region's own, or `adapter_config.baseURL`), so
 *     `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` and `AWS_ENDPOINT_URL` are never read.
 */

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { ModelProviderError, tokenCostUsd } from '@kindgi/adapter-model-shared';
import { createAiSdkModelProvider } from '@kindgi/adapter-model-shared/ai-sdk';
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

  const credentials =
    auth === 'aws-identity' ? signedIn(input.identities?.aws as AwsCredentialClient) : undefined;
  // Asked for before each attempt (`beforeAttempt`), then handed to the library's own ask for
  // that attempt, so each attempt asks the identity once. Calls running at once may take each
  // other's: they're the same identity's, all valid.
  let prefetched: AwsCredentials | undefined;
  const credentialProvider: AwsCredentialClient = async () => {
    const ready = prefetched;
    prefetched = undefined;
    return ready ?? (credentials as AwsCredentialClient)();
  };
  const resolveApiKey = input.resolveApiKey;

  const provider = createAiSdkModelProvider({
    metadata,
    ...(input.fetch !== undefined && { fetch: input.fetch }),
    languageModel: (name, fetch) =>
      createAmazonBedrock({
        region,
        baseURL,
        ...(auth === 'aws-identity'
          ? {
              apiKey: '',
              credentialProvider,
              fetch,
            }
          : {
              apiKey: KEY_SET_PER_REQUEST,
              fetch: withBearerKey(fetch, resolveApiKey as () => Promise<string>),
            }),
      })(name),
    cost: (model, usage) => tokenCostUsd(model, usage),
    // The library would wrap a credential failure in a plain error (and so retry it): asked
    // for here first, a failure is `auth` at once.
    ...(credentials !== undefined && {
      beforeAttempt: async () => {
        prefetched = await credentials();
      },
    }),
    explain: (error) => (error.status === 403 ? accessHint(region) : undefined),
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

/** What a 403 from Bedrock can mean, beyond its own words. */
function accessHint(region: string): string {
  return `Bedrock refuses when the identity's policy lacks bedrock:InvokeModel on the model (for an inference profile, on the profile and on the foundation model in each of its Regions), when the account has no access to the model in ${region} (model access, or a Marketplace agreement still being made: retry in 15 minutes), or when the credentials have expired.`;
}

/** The runtime's AWS credentials, bounded, and `auth` when there are none. */
function signedIn(identity: AwsCredentialClient): AwsCredentialClient {
  return async () => {
    let credentials: AwsCredentials;
    try {
      credentials = await withTimeout(identity(), IDENTITY_TIMEOUT_MS);
    } catch (error) {
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
  };
}

/** The bearer token set on every request from the current key; `auth` when there's none. */
function withBearerKey(
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
        `The Bedrock API key secret_ref names couldn't be read: ${messageOf(error)}.`,
        { cause: error },
      );
    }
    if (key === '') {
      throw new ModelProviderError(
        'auth',
        undefined,
        'The Bedrock API key secret_ref names is empty.',
      );
    }
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${key}`);
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
