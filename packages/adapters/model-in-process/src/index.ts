// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export {
  DEFAULT_LOCAL_MODEL,
  MODEL_SPECS,
  createInProcessModelProvider,
} from './provider.js';
export type { InProcessProviderOptions, LocalModel, ModelSpec } from './provider.js';
export { prepareInProcessModel } from './prepare.js';
export {
  IN_PROCESS_ADAPTER_ID,
  inProcessAdapterEntry,
  inProcessAdapterFactory,
  inProcessCheckConfig,
} from './entry.js';
export type { PrepareInProcessParams } from './prepare.js';
export type { ModelProvider, PrepareEvent } from '@kindgi/capabilities';
