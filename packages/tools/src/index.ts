// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export {
  defineTool,
  defineToolAsync,
  validateToolManifest,
  TOOL_SCHEMA_URI_EXPORTED as TOOL_SCHEMA_URI,
} from './define.js';
export type {
  DefineToolOptions,
  DefineToolSpec,
  DefinedTool,
  InferInput,
  InferOutput,
} from './define.js';
// Side-effect import — registers the 'http' spec synthesizer at
// package load so `defineTool({spec: {kind: 'http', ...}})` works
// out of the box for any consumer that imports @kindgi/tools.
import './http.js';
export { registerToolSpecSynthesizer, getToolSpecSynthesizer } from './spec-registry.js';
export type { ToolSpecSynthesizer, ToolSpecSynthesizerOptions } from './spec-registry.js';
export { invokeTool } from './invoke.js';
export { ToolPreconditionError, isToolPreconditionError } from './precondition.js';
export type { InvokeToolOptions } from './invoke.js';
export { createToolRegistry } from './registry.js';
export type { ToolRegisterOptions, ToolRegistry, ToolResolution } from './registry.js';
export { latestVersion, pickVersion } from './versions.js';
export type { VersionPick } from './versions.js';
export { toManifest, toMcpManifest } from './manifest.js';
export { EFFECT_KINDS } from './types.js';
export type {
  AnyTool,
  CodeArtifactRef,
  Effect,
  EffectKind,
  HttpAuthSpec,
  HttpHeaderSpec,
  HttpMethod,
  HttpRequestBodySpec,
  HttpToolSpec,
  JsonSchema,
  McpToolManifest,
  Need,
  NetworkPolicy,
  RuntimeLimits,
  SandboxMode,
  Tool,
  ToolContext,
  ToolManifest,
  ToolSecretRef,
  ToolSpec,
  TypedNeeds,
} from './types.js';
export type {
  DuplicateToolError,
  DuplicateToolVersionError,
  HandlerError,
  InputValidationError,
  InvalidSchemaError,
  InvalidToolDefinitionError,
  InvalidVersionRangeError,
  OutputValidationError,
  PreconditionFailedError,
  ToolError,
  ToolNotFoundError,
  ToolVersionNotFoundError,
  ToolVersionUnresolvableError,
  UnknownEffectError,
} from './errors.js';
