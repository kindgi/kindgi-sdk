// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export { adapterConfigError, createAdapterFactoryRegistry } from './adapter-factory.js';
export type {
  AdapterConfig,
  AdapterConfigCheckInput,
  AdapterConfigProblem,
  AdapterFactory,
  AdapterFactoryEntry,
  AdapterFactoryInput,
  AdapterFactoryRegistry,
  PrepareEvent,
} from './adapter-factory.js';
export { CAPABILITY_SCHEMA_URI, defineCapability } from './define.js';
export {
  PROVIDER_LABEL_KEY,
  PROVIDER_LABEL_MANAGED_BY,
  PROVIDER_LABEL_VALUE_MAX_LENGTH,
  PROVIDER_LABELS_MAX_KEYS,
  validateProviderLabels,
} from './provider-labels.js';
export { createProviderRegistry, isModelThinking } from './registry.js';
export { matchTuples, route } from './router.js';
export type { RouteInput } from './router.js';
export { SAMPLING_UNSUPPORTED, samplingFor } from './sampling.js';
export type { Sampling } from './sampling.js';
export { recordModelUsage } from './usage.js';
export { nameToolsAsSent } from './tool-names.js';
export type { RecordModelUsageOptions } from './usage.js';
export {
  BUILT_IN_CAPABILITY_KINDS,
  DEFAULT_CAPABILITY_KIND,
  FEATURE_DESCRIPTIONS,
  FEATURES,
} from './types.js';
export type {
  Budget,
  BuiltInCapabilityKind,
  Capability,
  CapabilityKind,
  ComparisonOp,
  Feature,
  ModelCallInput,
  ModelUsageRecord,
  ModelCallResult,
  ModelCallWarning,
  ModelMessage,
  ModelInfo,
  ModelProvider,
  ModelThinking,
  ModelToolCall,
  ModelToolDefinition,
  Preference,
  ProviderMetadata,
  ProviderModelPick,
  ProviderRegistry,
  RejectionReason,
  Requirement,
  RoutingDecision,
  StructuredOutputRequest,
  TenantPolicy,
  UpperBoundOp,
  UsageCounters,
  UsageSink,
} from './types.js';
export type {
  BudgetExceededError,
  CapabilityError,
  CapabilityUnsatisfiableError,
  DuplicateProviderError,
  InvalidCapabilityError,
  InvalidProviderError,
} from './errors.js';
