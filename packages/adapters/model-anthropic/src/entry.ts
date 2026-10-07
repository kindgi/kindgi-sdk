// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  AdapterConfigCheckInput,
  AdapterConfigProblem,
  AdapterFactory,
  AdapterFactoryEntry,
} from '@kindgi/capabilities';

import { createAnthropicProvider } from './provider.js';

/** The id the runtime registers this adapter under. */
export const ANTHROPIC_ADAPTER_ID = '@kindgi/adapter-model-anthropic';

/**
 * The runtime's factory. A provider registered with it names its Anthropic
 * API key in `secret_ref`, resolved on every call, so a rotated key takes
 * effect on the next one.
 */
export const anthropicAdapterFactory: AdapterFactory = (input) => {
  const problem = keyProblem(input.metadata.id, input.resolveApiKey !== undefined);
  if (problem !== undefined) throw new Error(problem.message);
  return createAnthropicProvider({
    apiKey: input.resolveApiKey as () => Promise<string>,
    metadata: input.metadata,
  });
};

/**
 * What's wrong with a registration for this adapter, read without building
 * it (`AdapterFactoryEntry.checkConfig`): it needs a `secret_ref`. The
 * problem's message is the error the factory throws for it.
 */
export function anthropicCheckConfig(
  input: AdapterConfigCheckInput,
): readonly AdapterConfigProblem[] {
  const problem = keyProblem(input.metadata.id, input.hasSecretRef);
  return problem !== undefined ? [problem] : [];
}

/** The entry a runtime registers: the factory, and its static check. */
export const anthropicAdapterEntry: AdapterFactoryEntry = {
  adapterId: ANTHROPIC_ADAPTER_ID,
  capabilityKind: 'llm-inference',
  factory: anthropicAdapterFactory,
  checkConfig: anthropicCheckConfig,
};

function keyProblem(providerId: string, hasSecretRef: boolean): AdapterConfigProblem | undefined {
  if (hasSecretRef) return undefined;
  return {
    path: '/secret_ref',
    message: `${ANTHROPIC_ADAPTER_ID}: provider "${providerId}" needs secret_ref: its Anthropic API key.`,
  };
}
