// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  AdapterConfigCheckInput,
  AdapterConfigProblem,
  AdapterFactory,
  AdapterFactoryEntry,
} from '@kindgi/capabilities';

import { type PrepareInProcessParams, prepareInProcessModel } from './prepare.js';
import { type LocalModel, MODEL_SPECS, createInProcessModelProvider } from './provider.js';

/** The id the runtime registers this adapter under. */
export const IN_PROCESS_ADAPTER_ID = '@kindgi/adapter-model-in-process';

/**
 * The runtime's factory. A provider registered with it lists models by
 * their `MODEL_SPECS` key in `metadata.models[].name`.
 */
export const inProcessAdapterFactory: AdapterFactory = (input) => {
  const problem = modelsProblem(input.metadata);
  if (problem !== undefined) throw new Error(problem.message);
  return createInProcessModelProvider({
    models: input.metadata.models.map((m) => m.name as LocalModel),
    providerId: input.metadata.id,
  });
};

/**
 * What's wrong with a registration for this adapter, read without building
 * it (`AdapterFactoryEntry.checkConfig`): a model that isn't one of
 * `MODEL_SPECS`. The problem's message is the error the factory throws.
 */
export function inProcessCheckConfig(
  input: AdapterConfigCheckInput,
): readonly AdapterConfigProblem[] {
  const problem = modelsProblem(input.metadata);
  return problem !== undefined ? [problem] : [];
}

/** The entry a runtime registers: the factory, its model download, and its static check. */
export const inProcessAdapterEntry: AdapterFactoryEntry = {
  adapterId: IN_PROCESS_ADAPTER_ID,
  capabilityKind: 'llm-inference',
  factory: inProcessAdapterFactory,
  prepare: (params) => prepareInProcessModel(params as PrepareInProcessParams),
  checkConfig: inProcessCheckConfig,
};

function modelsProblem(
  metadata: AdapterConfigCheckInput['metadata'],
): AdapterConfigProblem | undefined {
  const index = metadata.models.findIndex((m) => !Object.hasOwn(MODEL_SPECS, m.name));
  const unknown = metadata.models[index];
  if (unknown === undefined) return undefined;
  return {
    path: `/metadata/models/${index}/name`,
    message:
      `${IN_PROCESS_ADAPTER_ID}: unknown model "${unknown.name}" in provider "${metadata.id}". ` +
      `Valid values: ${Object.keys(MODEL_SPECS).join(', ')}.`,
  };
}
