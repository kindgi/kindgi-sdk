// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ToolId } from '@kindgi/types';

/**
 * Errors emitted by @kindgi/tools. Every variant carries a `code` for
 * pattern matching; messages are human-readable, not API contract.
 */
export type ToolError =
  | InvalidToolDefinitionError
  | InvalidSchemaError
  | UnknownEffectError
  | DuplicateToolError
  | DuplicateToolVersionError
  | ToolNotFoundError
  | ToolVersionNotFoundError
  | InvalidVersionRangeError
  | ToolVersionUnresolvableError
  | InputValidationError
  | OutputValidationError
  | HandlerError
  | PreconditionFailedError;

/** `defineTool` was called with something the schema loader rejects. */
export interface InvalidToolDefinitionError {
  readonly code: 'invalid-tool-definition';
  readonly message: string;
  readonly issues: readonly { readonly path: string; readonly message: string }[];
}

/** The provided `input` or `output` is not a valid JSON Schema Draft 2020-12. */
export interface InvalidSchemaError {
  readonly code: 'invalid-schema';
  readonly message: string;
  readonly where: 'input' | 'output';
  readonly cause: unknown;
}

/** An effect kind not in `EFFECT_KINDS` was declared. */
export interface UnknownEffectError {
  readonly code: 'unknown-effect';
  readonly message: string;
  readonly kind: string;
}

/**
 * ToolRegistry.register was called with an id that already exists AND the
 * registry doesn't support multiple versions per id. `createToolRegistry`
 * holds several versions per id and returns `duplicate-tool-version`
 * instead when the same (id, version) is registered twice.
 */
export interface DuplicateToolError {
  readonly code: 'duplicate-tool';
  readonly message: string;
  readonly id: ToolId;
}

/** Same `(id, version)` pair was registered twice — versions must be unique. */
export interface DuplicateToolVersionError {
  readonly code: 'duplicate-tool-version';
  readonly message: string;
  readonly id: ToolId;
  readonly version: string;
}

/** ToolRegistry.get was called with an id that isn't registered. */
export interface ToolNotFoundError {
  readonly code: 'tool-not-found';
  readonly message: string;
  readonly id: ToolId;
}

/** The id exists but the requested exact version doesn't. */
export interface ToolVersionNotFoundError {
  readonly code: 'tool-version-not-found';
  readonly message: string;
  readonly id: ToolId;
  readonly version: string;
}

/** The provided version range isn't a valid semver range (per npm grammar). */
export interface InvalidVersionRangeError {
  readonly code: 'invalid-version-range';
  readonly message: string;
  readonly id: ToolId;
  readonly range: string;
}

/**
 * `resolve(id, range)` found the id but no registered version satisfies
 * the range. Distinct from `tool-not-found` (no id at all) and from
 * `invalid-version-range` (grammar error on the range string).
 */
export interface ToolVersionUnresolvableError {
  readonly code: 'tool-version-unresolvable';
  readonly message: string;
  readonly id: ToolId;
  readonly range: string;
  readonly availableVersions: readonly string[];
}

/** invokeTool: the caller's input didn't validate against tool.input. */
export interface InputValidationError {
  readonly code: 'input-validation-failed';
  readonly message: string;
  readonly toolId: ToolId;
  readonly errors: readonly unknown[];
}

/** invokeTool: the handler returned something that didn't validate against tool.output. */
export interface OutputValidationError {
  readonly code: 'output-validation-failed';
  readonly message: string;
  readonly toolId: ToolId;
  readonly errors: readonly unknown[];
}

/** invokeTool: the handler threw. */
export interface HandlerError {
  readonly code: 'handler-error';
  readonly message: string;
  readonly toolId: ToolId;
  readonly cause: unknown;
}

/**
 * invokeTool: the runtime refused to run the tool — something it declares
 * wasn't there (a `ToolPreconditionError` from the runtime's handler
 * wrapper). The tool's own code never ran.
 */
export interface PreconditionFailedError {
  readonly code: 'precondition-failed';
  readonly message: string;
  readonly toolId: ToolId;
  /** The runtime's code for what was missing (`secret-unavailable`, …). */
  readonly reason: string;
  readonly cause: unknown;
}
