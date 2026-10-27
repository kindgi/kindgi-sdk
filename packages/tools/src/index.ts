// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export {
  BUILT_IN_TOOL_PREFIX,
  defineTool,
  defineToolAsync,
  validateToolManifest,
  TOOL_SCHEMA_URI_EXPORTED as TOOL_SCHEMA_URI,
} from './define.js';
export type {
  DefinePausingToolSpec,
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
export { MAX_STORED_FILES_PER_CALL, MAX_STORED_FILE_BYTES } from './files.js';
export type {
  FileNotStoredReason,
  FileReadAnswer,
  FileStore,
  FileStoreAnswer,
  FileToStore,
} from './files.js';
export { invokeTool, invokeToolOrPause, toolOutputIssues } from './invoke.js';
export {
  DEFAULT_PAUSE_TIMEOUT_MS,
  MAX_PAUSE_NAME_LENGTH,
  MAX_PAUSE_TIMEOUT_MS,
  PAUSE_TOKEN_PREFIX,
  ToolRerunsExhaustedError,
  isToolRerunsExhaustedError,
  pauseOf,
  pauseOutcome,
} from './pause.js';
export type {
  PauseContext,
  ToolPause,
  ToolPauseAnswer,
  ToolPauseOptions,
  WaitToken,
} from './pause.js';
export { invokeToolForTest, toolContextForTest } from './test-context.js';
export { toolSecretNames } from './secret-names.js';
export { toolOptionalSecretNames, toolRequiredEnvNames } from './env-names.js';
export { ToolPreconditionError, isToolPreconditionError } from './precondition.js';
export {
  ConnectionRejectedError,
  ConnectionRenewError,
  connectionRejectionOf,
  isConnectionRejectedError,
  isConnectionRenewError,
} from './connections.js';
export type {
  ConnectionAccount,
  ConnectionNeed,
  ConnectionRejection,
  ConnectionResolver,
  ResolveConnectionsInput,
  ResolveConnectionsOutcome,
  ToolConnection,
  WaitingForConnection,
} from './connections.js';
export { REDACTED_TOKEN, withoutConnectionTokens } from './connection-redaction.js';
export { TOOL_ENV_RECORD_KEY, toolCallRecordKey } from './record-keys.js';
export { TOOL_IDEMPOTENCY_NAMESPACE, toolIdempotencyKey } from './idempotency-key.js';
export type { InvokeToolOptions, ToolOutcome } from './invoke.js';
export { createToolRegistry } from './registry.js';
export type { ToolRegisterOptions, ToolRegistry, ToolResolution } from './registry.js';
export { latestVersion, nextVersion, pickVersion } from './versions.js';
export type { VersionPick } from './versions.js';
export { toManifest, toMcpManifest } from './manifest.js';
export { changedToolFields, sameToolDefinition, toolDefinition } from './definition.js';
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
  ToolPauseUnsupportedError,
  ToolVersionNotFoundError,
  ToolVersionUnresolvableError,
  UnknownEffectError,
  WaitTokenRerunsExhaustedError,
  WaitTokenTimedOutError,
} from './errors.js';
