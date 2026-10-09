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
 *     refreshes them itself). `apiKey: ''` keeps a stray `AWS_BEARER_TOKEN_BEDROCK` from
 *     switching the provider to a bearer key.
 *   - `auth: api-key`: the key `secret_ref` names, read for every request and sent as the
 *     bearer token, so a rotated key takes effect on the next call. No SigV4, so no AWS
 *     credentials are looked for.
 *   - The region is the registration's (`metadata.region`), never `AWS_REGION`, and the endpoint
 *     is always given (the region's own, or `adapter_config.baseURL`), so
 *     `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` and `AWS_ENDPOINT_URL` are never read.
 */

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { tokenCostUsd } from '@kindgi/adapter-model-shared';
import { createAiSdkModelProvider } from '@kindgi/adapter-model-shared/ai-sdk';
import {
  type AdapterConfigCheckInput,
  type AdapterConfigProblem,
  type AdapterFactory,
  type AdapterFactoryEntry,
  type AwsCredentialClient,
  adapterConfigError,
} from '@kindgi/capabilities';

import { BEDROCK_ADAPTER_ID, readBedrockConfig } from './config.js';

/**
 * What the provider is built with in `api-key` mode, so it sends a bearer token: never sent,
 * since the current key replaces it on every request.
 */
const KEY_SET_PER_REQUEST = 'set-per-request';

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
  });
  if (read.kind === 'err') {
    throw adapterConfigError(BEDROCK_ADAPTER_ID, metadata.id, read.problems[0] as never);
  }
  const { region, baseURL, auth } = read.config;

  const credentials = input.identities?.aws;
  if (auth === 'aws-identity' && credentials === undefined) {
    throw adapterConfigError(BEDROCK_ADAPTER_ID, metadata.id, {
      path: '/adapter_config/auth',
      message:
        "adapter_config.auth = aws-identity needs the runtime's AWS identity (KINDGI_AWS_IDENTITY says where it comes from), and this runtime has none.",
    });
  }
  const resolveApiKey = input.resolveApiKey;

  return createAiSdkModelProvider({
    metadata,
    ...(input.fetch !== undefined && { fetch: input.fetch }),
    languageModel: (name, fetch) =>
      createAmazonBedrock({
        region,
        baseURL,
        ...(auth === 'aws-identity'
          ? {
              apiKey: '',
              credentialProvider: credentials as AwsCredentialClient,
              fetch,
            }
          : {
              apiKey: KEY_SET_PER_REQUEST,
              fetch: withBearerKey(fetch, resolveApiKey as () => Promise<string>),
            }),
      })(name),
    cost: (model, usage) => tokenCostUsd(model, usage),
  });
};

/** The entry a runtime registers: the factory, and its static check. */
export const bedrockAdapterEntry: AdapterFactoryEntry = {
  adapterId: BEDROCK_ADAPTER_ID,
  capabilityKind: 'llm-inference',
  factory: bedrockAdapterFactory,
  checkConfig: bedrockCheckConfig,
};

/** The bearer token set on every request from the current key. */
function withBearerKey(
  fetch: typeof globalThis.fetch,
  resolveApiKey: () => Promise<string>,
): typeof globalThis.fetch {
  return async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${await resolveApiKey()}`);
    return fetch(url, { ...init, headers });
  };
}
