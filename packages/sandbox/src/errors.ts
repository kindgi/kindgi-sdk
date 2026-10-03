// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Typed error union for the sandbox seam. Every failure that crosses the
 * `SandboxProvider` boundary — provider-side enforcement, kernel-side
 * cancellation, config validation — narrows to one of these variants.
 *
 * The union is closed. Adapters that need to surface details the base
 * codes don't cover MUST use `provider-error` and put the shape-specific
 * data on `cause` — never invent a new discriminator.
 *
 * Each variant descends from a known sandbox failure mode.
 */

/** Discriminator on `SandboxError.code`. */
export type SandboxErrorCode =
  | 'level-not-supported'
  | 'limits-exceeded'
  | 'timeout'
  | 'cancelled'
  | 'create-cancelled'
  | 'unhandled-worker-error'
  | 'config-invalid'
  | 'orphaned'
  | 'snapshot-not-supported'
  | 'restore-not-supported'
  | 'pause-not-supported'
  | 'invalid-snapshot-handle'
  | 'provider-error';

/**
 * Adapter cannot honor the requested `SandboxLevel`. Adapters MUST NOT
 * silently degrade — `strict` on a provider that only supports
 * `context-isolated` throws this at `create` time, not later.
 */
export interface LevelNotSupportedError {
  readonly code: 'level-not-supported';
  readonly message: string;
  readonly requested: 'none' | 'context-isolated' | 'strict';
  readonly supported: readonly ('none' | 'context-isolated' | 'strict')[];
}

/**
 * Provider reports usage that exceeded a declared limit
 * (`SandboxLimits.memMB`, `cpuMs`, `diskMB`, `maxProcesses`). The
 * offending dimension is named; providers return the observed usage
 * in `usage` for post-mortem.
 */
export interface LimitsExceededError {
  readonly code: 'limits-exceeded';
  readonly message: string;
  readonly limit: 'memMB' | 'cpuMs' | 'diskMB' | 'maxProcesses';
  readonly declared: number;
  readonly observed: number;
}

/**
 * Wall-clock enforcement expired from the kernel side. Sourced from the
 * unified `EdgePolicy.timeoutMs` primitive;
 * providers do NOT raise this — only the kernel does.
 */
export interface TimeoutError {
  readonly code: 'timeout';
  readonly message: string;
  readonly limitMs: number;
  readonly elapsedMs: number;
}

/**
 * External abort observed during exec. Fires when `AbortController`
 * upstream of the run cancels; distinct from `timeout` so retries can
 * be attributed correctly (cancels do not retry; timeouts do).
 */
export interface CancelledError {
  readonly code: 'cancelled';
  readonly message: string;
}

/**
 * Cancellation observed during `SandboxProvider.create()`. Fires when
 * the caller-supplied `AbortSignal` on `create(spec, { signal })`
 * aborts before the sandbox is fully provisioned — distinct from
 * `cancelled` (which fires during `exec`) so retries + telemetry can
 * attribute the failure to `create` specifically. Adapters MUST
 * roll back any partially-provisioned resources before settling with
 * this variant.
 */
export interface CreateCancelledError {
  readonly code: 'create-cancelled';
  readonly message: string;
}

/**
 * Adapter does not implement `Sandbox.snapshot()`. The lifecycle
 * primitive is optional for third-party adapters;
 * callers negotiate support via `typeof sandbox.snapshot === 'function'`
 * before invoking. Adapters that DO expose the method never raise this
 * — this variant exists so a caller who tries to snapshot on an
 * adapter that omits the method has a typed failure to catch instead of
 * a raw `TypeError`.
 */
export interface SnapshotNotSupportedError {
  readonly code: 'snapshot-not-supported';
  readonly message: string;
}

/**
 * Adapter does not implement `Sandbox.restore()`. Same negotiation
 * pattern as `snapshot-not-supported`; some adapters may implement
 * snapshot without restore (e.g., snapshot-for-audit only).
 */
export interface RestoreNotSupportedError {
  readonly code: 'restore-not-supported';
  readonly message: string;
}

/**
 * Adapter does not implement `Sandbox.pause()` / `Sandbox.resume()`.
 * Pause/resume are transient (in-memory); snapshot is durable. Adapters
 * that expose one lifecycle primitive without the other are legitimate;
 * callers check + degrade gracefully.
 */
export interface PauseNotSupportedError {
  readonly code: 'pause-not-supported';
  readonly message: string;
}

/**
 * Adapter received a `SnapshotHandle` it cannot restore. Fires when
 * (a) the envelope's `adapterId` names a different adapter (snapshots
 * are adapter-scoped — there is no cross-adapter portability); (b) the
 * envelope's `v` is a version this adapter does not understand; (c) the
 * `doc` payload fails the adapter's own validation (missing files,
 * stale reference, hash mismatch).
 */
export interface InvalidSnapshotHandleError {
  readonly code: 'invalid-snapshot-handle';
  readonly message: string;
  readonly reason: 'wrong-adapter' | 'unknown-version' | 'malformed-doc';
}

/**
 * Uncaught worker-side error escaped the handler; the wrapper installed
 * an `uncaughtException` handler and observed it. Prevents a
 * silently failing sandbox from drifting until the wall-clock timeout.
 */
export interface UnhandledWorkerError {
  readonly code: 'unhandled-worker-error';
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Tenant-supplied field failed the strict per-field allowlist regex.
 * Adapters fail closed and never attempt to sanitize.
 * `field` names the config slot that rejected the value (image name,
 * host, cwd, env key, env value); `value` is the offending input
 * (truncated for logs).
 */
export interface ConfigInvalidError {
  readonly code: 'config-invalid';
  readonly message: string;
  readonly field: string;
  readonly value: string;
}

/**
 * Sandbox instance no longer tracked. Fires when an orphan sweep
 * finds a live sandbox whose owning run is gone. Also raised when the
 * kernel attempts an operation on a
 * `Sandbox` handle whose provider-side resource was reclaimed
 * out-of-band.
 */
export interface OrphanedError {
  readonly code: 'orphaned';
  readonly message: string;
}

/**
 * Catch-all for provider-side failures the base codes do not model.
 * Adapters put the underlying failure on `cause`; the kernel logs the
 * cause but does not depend on its shape.
 */
export interface ProviderError {
  readonly code: 'provider-error';
  readonly message: string;
  readonly cause?: unknown;
}

/** Discriminated union of every sandbox-seam error. */
export type SandboxError =
  | LevelNotSupportedError
  | LimitsExceededError
  | TimeoutError
  | CancelledError
  | CreateCancelledError
  | UnhandledWorkerError
  | ConfigInvalidError
  | OrphanedError
  | SnapshotNotSupportedError
  | RestoreNotSupportedError
  | PauseNotSupportedError
  | InvalidSnapshotHandleError
  | ProviderError;

/** Assemble an err-Result for the `level-not-supported` variant. */
export function levelNotSupported(
  requested: LevelNotSupportedError['requested'],
  supported: readonly LevelNotSupportedError['supported'][number][],
  detail?: string,
): { readonly kind: 'err'; readonly error: LevelNotSupportedError } {
  const message = detail ?? `sandbox level '${requested}' not supported by this adapter`;
  return { kind: 'err', error: { code: 'level-not-supported', message, requested, supported } };
}

/** Assemble an err-Result for the `provider-error` catch-all variant. */
export function providerError(
  message: string,
  cause?: unknown,
): { readonly kind: 'err'; readonly error: ProviderError } {
  return {
    kind: 'err',
    error:
      cause === undefined
        ? { code: 'provider-error', message }
        : { code: 'provider-error', message, cause },
  };
}

/** Assemble an err-Result for the `create-cancelled` variant. */
export function createCancelled(detail?: string): {
  readonly kind: 'err';
  readonly error: CreateCancelledError;
} {
  const message = detail ?? 'sandbox create() was cancelled via AbortSignal';
  return { kind: 'err', error: { code: 'create-cancelled', message } };
}
