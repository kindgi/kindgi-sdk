// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import {
  type AdapterConfigCheckInput,
  type AdapterConfigProblem,
  type AdapterFactory,
  type AdapterFactoryEntry,
  adapterConfigError,
} from '@kindgi/capabilities';

import { createAnthropicProvider } from './provider.js';

/** The id the runtime registers this adapter under. */
export const ANTHROPIC_ADAPTER_ID = '@kindgi/adapter-model-anthropic';

/**
 * The runtime's factory. A provider registered with it names its Anthropic
 * API key in `secret_ref`, resolved on every call, so a rotated key takes
 * effect on the next one. Its calls go to Anthropic's API, or to
 * `adapter_config.baseURL` when the registration gives one: a gateway or a
 * proxy that serves the same API, which is sent the same key.
 */
export const anthropicAdapterFactory: AdapterFactory = (input) => {
  const problem =
    keyProblem(input.resolveApiKey !== undefined) ?? baseURLProblem(input.config?.baseURL);
  if (problem !== undefined)
    throw adapterConfigError(ANTHROPIC_ADAPTER_ID, input.metadata.id, problem);
  const baseURL = input.config?.baseURL as string | undefined;
  return createAnthropicProvider({
    apiKey: input.resolveApiKey as () => Promise<string>,
    metadata: input.metadata,
    ...(baseURL !== undefined ? { baseURL } : {}),
  });
};

/**
 * What's wrong with a registration for this adapter, read without building
 * it (`AdapterFactoryEntry.checkConfig`): it needs a `secret_ref`, and a
 * `baseURL` it's given must be https, or http on this machine. Each problem's message is the
 * error the factory throws for it.
 */
export function anthropicCheckConfig(
  input: AdapterConfigCheckInput,
): readonly AdapterConfigProblem[] {
  return [keyProblem(input.hasSecretRef), baseURLProblem(input.config?.baseURL)].filter(
    (problem): problem is AdapterConfigProblem => problem !== undefined,
  );
}

/**
 * The entry a runtime registers: the factory, its static check, and the one
 * `adapter_config` key it takes, `baseURL` (any other is refused).
 */
export const anthropicAdapterEntry: AdapterFactoryEntry = {
  adapterId: ANTHROPIC_ADAPTER_ID,
  capabilityKind: 'llm-inference',
  factory: anthropicAdapterFactory,
  checkConfig: anthropicCheckConfig,
  configKeys: ['baseURL'],
};

function keyProblem(hasSecretRef: boolean): AdapterConfigProblem | undefined {
  if (hasSecretRef) return undefined;
  return { path: '/secret_ref', message: 'needs secret_ref: its Anthropic API key.' };
}

/**
 * `adapter_config.baseURL`, when given: an https URL, since the provider's key
 * goes with every call, or an http one on this machine (`LOCAL_HOSTS`), where
 * the key never crosses a network: a gateway run locally to test against. No
 * credentials, query or fragment. A path is fine (a gateway's own prefix): the
 * adapter adds the API's, `/v1/messages`.
 */
function baseURLProblem(value: unknown): AdapterConfigProblem | undefined {
  if (value === undefined) return undefined;
  const path = '/adapter_config/baseURL';
  const url = typeof value === 'string' ? parseUrl(value) : undefined;
  const local = url?.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  if (url === undefined || (url.protocol !== 'https:' && !local)) {
    return {
      path,
      message:
        'adapter_config.baseURL must be an https URL of a gateway or a proxy that serves the Anthropic API, or an http one on this machine (localhost, 127.0.0.1, [::1], host.docker.internal, host.containers.internal).',
    };
  }
  const raw = value as string;
  if (url.username !== '' || url.password !== '') {
    return {
      path,
      message:
        "adapter_config.baseURL can't hold credentials: the key goes in secret_ref, never in the URL.",
    };
  }
  if (url.search !== '' || raw.includes('?') || url.hash !== '' || raw.includes('#')) {
    return { path, message: "adapter_config.baseURL can't hold a query or a fragment." };
  }
  return undefined;
}

/**
 * The hosts an http `baseURL` may name, as `URL` gives a hostname: this
 * machine's loopback names, and the names a container reaches the machine
 * it runs on by (Docker's and Podman's).
 */
const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  'host.docker.internal',
  'host.containers.internal',
]);

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
