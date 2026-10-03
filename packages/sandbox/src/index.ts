// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// ============ Wire types ============
export type {
  ExecOpts,
  ExecResult,
  HandlerInvocationMode,
  HandlerRef,
  KnownSandboxCapability,
  NetworkPolicy,
  ProcessHandle,
  ProcessOpts,
  ProcessStdin,
  ResourceUsage,
  Sandbox,
  SandboxCapabilities,
  SandboxInvocationContext,
  SandboxLevel,
  SandboxLimits,
  SandboxProvider,
  SandboxSpec,
  SnapshotHandle,
} from './types.js';
export { DEFAULT_ENTRYPOINT_PATH } from './types.js';

// ============ Errors + pure constructors ============
export type {
  CancelledError,
  ConfigInvalidError,
  CreateCancelledError,
  InvalidSnapshotHandleError,
  LevelNotSupportedError,
  LimitsExceededError,
  OrphanedError,
  PauseNotSupportedError,
  ProviderError,
  RestoreNotSupportedError,
  SandboxError,
  SandboxErrorCode,
  SnapshotNotSupportedError,
  TimeoutError,
  UnhandledWorkerError,
} from './errors.js';
export { createCancelled, levelNotSupported, providerError } from './errors.js';

// ============ Invocation protocol (wire frames + serialization) ============
export type {
  ErrorFrame,
  InvokeFrame,
  OutputFrame,
  ProtocolContext,
  ProtocolError,
  ResumeFrame,
  StdinFrame,
  StdoutFrame,
  SuspendFrame,
  WireFrame,
} from './invocation-protocol.js';
export {
  encodeFrame,
  parseFrame,
  parseFrames,
  PROTOCOL_VERSION,
  SUSPEND_EXIT_CODE,
} from './invocation-protocol.js';

// ============ Suspension request (thrown in the sandbox on a durable wait) ============
export { SandboxSuspensionRequest } from './suspension.js';
