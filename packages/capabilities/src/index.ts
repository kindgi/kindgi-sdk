// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export { createAdapterFactoryRegistry } from './adapter-factory.js';
export type {
  AdapterConfig,
  AdapterFactory,
  AdapterFactoryEntry,
  AdapterFactoryInput,
  AdapterFactoryRegistry,
  PrepareEvent,
} from './adapter-factory.js';
export { CAPABILITY_SCHEMA_URI, defineCapability } from './define.js';
export { createProviderRegistry } from './registry.js';
export { matchTuples, route } from './router.js';
export type { RouteInput } from './router.js';
export { BUILT_IN_CAPABILITY_KINDS, DEFAULT_CAPABILITY_KIND, FEATURES } from './types.js';
export type {
  Budget,
  BuiltInCapabilityKind,
  Capability,
  CapabilityKind,
  ComparisonOp,
  Feature,
  ModelCallInput,
  ModelCallResult,
  ModelMessage,
  ModelInfo,
  ModelProvider,
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
} from './types.js';
export type {
  BudgetExceededError,
  CapabilityError,
  CapabilityUnsatisfiableError,
  DuplicateProviderError,
  InvalidCapabilityError,
  InvalidProviderError,
} from './errors.js';
