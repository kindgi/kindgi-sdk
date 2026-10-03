// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/*
 * Interface shape inspired by Cloudflare Sandbox SDK.
 * https://github.com/cloudflare/sandbox-sdk (Apache 2.0)
 * Not imported — versioned independently as @kindgi/sandbox.
 */

/**
 * Sandbox seam types for Kindgi.
 *
 * These declarations are the substrate for custom handler code. Every
 * first-party or third-party sandbox adapter implements
 * `SandboxProvider`, and the runtime's executor dispatches handlers
 * through it. The MUST clauses below are the obligations a conforming
 * adapter honors.
 */

import type { ArtifactId, RunId, TenantId } from '@kindgi/types';

/**
 * A caller-supplied factory that produces `Sandbox` instances on demand.
 * The kernel dispatches to this when a handler with sandbox metadata
 * needs to run. Deployments wire in the concrete implementation.
 */
export interface SandboxProvider {
  /**
   * Provision a new sandbox instance for `spec`.
   *
   * Optional `opts.signal` is an `AbortSignal` the caller uses to
   * abort a slow cold-start (microVM and container launches can take
   * hundreds of ms; in-process is effectively synchronous). Adapters
   * that honor cancellation MUST:
   *   1. Check `signal.aborted` before allocating any resource; if
   *      already aborted, throw `SandboxError { code: 'create-cancelled' }`
   *      synchronously without allocating.
   *   2. If the signal aborts mid-create, roll back any
   *      partially-provisioned resources (containerd tasks, VM
   *      processes, mount namespaces, etc.) BEFORE throwing
   *      `create-cancelled`.
   *   3. Adapters that cannot honor cancellation MUST document the
   *      omission.
   *
   * Without a `signal`, `create` cannot be cancelled.
   */
  create(spec: SandboxSpec, opts?: { readonly signal?: AbortSignal }): Promise<Sandbox>;
  /**
   * Capabilities the adapter advertises beyond the base contract.
   * Third-party adapters extend via capabilities, not by extending the
   * base interface.
   *
   * Callers negotiate optional features by inspecting this set —
   * `provider.capabilities.has('preview-url')` — and taking a graceful
   * fallback when the capability is absent.
   */
  readonly capabilities: SandboxCapabilities;
}

/**
 * Isolation level requested by the handler; the provider chooses its
 * enforcement mechanism.
 *
 * - `'none'`: no isolation. Handler runs in the kernel's own process. Only
 *   valid for first-party handlers explicitly annotated.
 * - `'context-isolated'`: same-process, separate JS execution context.
 *   Prevents accidental global-state bleed between runs. **NOT a
 *   security boundary** against hostile code.
 * - `'strict'`: full sandbox with container/MicroVM-grade isolation.
 *   Security boundary against untrusted code; resource + network policy
 *   enforced by the provider.
 *
 * Adapters that cannot honor a requested level MUST fail loud with
 * `SandboxError { code: 'level-not-supported' }` rather than silently
 * degrading.
 */
export type SandboxLevel = 'none' | 'context-isolated' | 'strict';

/**
 * Handler invocation mode. Derived from the handler declaration. Comments
 * in this package also call these modes A, B and C, in order.
 *
 * - `'in-context'`: handler `run` closure executes directly in the
 *   sandbox's JS context. Only valid for `none` + `context-isolated`.
 * - `'json-stdio'`: handler lives in a pre-built image; kernel writes
 *   JSON input to stdin, reads JSON output from stdout. Requires
 *   `image`.
 * - `'handler-image'`: handler IS the image entrypoint; opaque program.
 *   Requires `image`; no framework-shipped wrapper.
 */
export type HandlerInvocationMode = 'in-context' | 'json-stdio' | 'handler-image';

/**
 * The complete dispatch specification the kernel hands to the provider
 * when creating a sandbox. Every field is either handler-declared or
 * kernel-derived at dispatch time; nothing is provider-defaulted.
 */
export interface SandboxSpec {
  readonly tenantId: TenantId;
  readonly runId: RunId;
  /**
   * Node identifier for the flow node whose handler is dispatching.
   * Optional; populated by the kernel at dispatch time. Serialized
   * across the wire in mode B (`json-stdio`).
   */
  readonly nodeId?: string;
  /**
   * Handler-declared image reference. Required for `mode === 'json-stdio'`
   * and `mode === 'handler-image'`. Ignored for `mode === 'in-context'`.
   */
  readonly image?: string;
  /** Handler-declared resource limits. Enforced by the provider. */
  readonly limits: SandboxLimits;
  /** Handler-declared network policy. Enforced by the provider. */
  readonly network: NetworkPolicy;
  /** Isolation level requested by the handler. */
  readonly level: SandboxLevel;
  /**
   * Which invocation shape the handler declares.
   * Derived by the kernel from the handler declaration; the provider
   * uses it only when it needs to dispatch differently per mode.
   */
  readonly mode: HandlerInvocationMode;
  /**
   * Optional additional context to serialize across the wire in mode B.
   * Populated by the kernel at dispatch time; adapter code
   * does NOT read it.
   */
  readonly invocation?: SandboxInvocationContext;
}

/**
 * Cross-wire invocation context for mode B. Complements the fields
 * already present on `SandboxSpec` (`tenantId`, `runId`, `nodeId`).
 * All fields are optional; missing values are treated as empty objects
 * (state / nodeOutputs) or `false` (dryRun) on the sandbox side.
 */
export interface SandboxInvocationContext {
  readonly dryRun?: boolean;
  readonly state?: Readonly<Record<string, unknown>>;
  readonly nodeOutputs?: Readonly<Record<string, unknown>>;
  /**
   * Resume value from a prior suspension. Set by the kernel when
   * re-dispatching after `completeToken`. The entrypoint receives an
   * explicit `resume` frame BEFORE the `invoke` frame; `ctx.waitForToken`
   * calls that match the `tokenId` short-circuit with `value`.
   */
  readonly resume?: { readonly tokenId: string; readonly value: unknown };
}

/**
 * Handler-declared resource limits enforced by the provider.
 *
 * `wallMs` is INTENTIONALLY OMITTED — wall-clock enforcement is unified
 * with `EdgePolicy.timeoutMs` on the incoming flow edge. Handler
 * declarations MUST NOT set a wall on the sandbox spec; the kernel
 * enforces the wall outside the sandbox so
 * a compromised sandbox cannot circumvent its own limit.
 */
export interface SandboxLimits {
  readonly memMB: number;
  readonly cpuMs: number;
  readonly diskMB?: number;
  readonly maxProcesses?: number;
}

/**
 * Network egress policy. Enforcement is the provider's responsibility;
 * the contract obligates it to fail closed (block by default when the
 * policy is `'none'`) rather than open.
 */
export type NetworkPolicy =
  | { readonly kind: 'none' }
  | { readonly kind: 'allowlist'; readonly hosts: readonly string[] }
  | { readonly kind: 'unrestricted' };

/**
 * A running sandbox instance. Cheap to hold a handle; expensive
 * resources are acquired on first `exec` / `startProcess`. `destroy`
 * releases everything and MUST be idempotent — the kernel may call it
 * repeatedly during crash recovery.
 *
 * The four lifecycle primitives (`snapshot`, `restore`, `pause`,
 * `resume`) are OPTIONAL. Adapters that cannot honor a primitive omit
 * it entirely; callers negotiate support with
 * `typeof sandbox.snapshot === 'function'` and degrade gracefully when
 * absent. Third-party
 * adapters extend via capabilities + optional methods, never by
 * subclassing the base interface.
 */
export interface Sandbox {
  exec(cmd: readonly string[], opts?: ExecOpts): Promise<ExecResult>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  startProcess(cmd: readonly string[], opts?: ProcessOpts): Promise<ProcessHandle>;
  destroy(): Promise<void>;
  /**
   * Capture the sandbox's durable state to a `SnapshotHandle` the
   * caller can persist and later feed to a fresh `create()` +
   * `restore()` (or to `restore()` on this same instance after a
   * matching `resume()`). Adapters MUST NOT mutate handler state
   * during snapshot — the handler is frozen for the duration.
   *
   * Durable waits (`waitForToken` backed by a warm pool + snapshot) are
   * the primary consumer. MicroVM adapters map this to the VMM's own
   * snapshot primitive; in-process adapters omit the method entirely —
   * snapshot semantics do not apply to a shared JS heap.
   */
  readonly snapshot?: () => Promise<SnapshotHandle>;
  /**
   * Restore the sandbox from a `SnapshotHandle` produced by an
   * earlier `snapshot()` on this adapter. If the handle's
   * `adapterId` does not match this adapter, or the envelope's `v`
   * is unknown, or the payload is malformed, MUST throw
   * `SandboxError { code: 'invalid-snapshot-handle' }`. Snapshots are
   * adapter-scoped; there is no cross-adapter portability.
   */
  readonly restore?: (handle: SnapshotHandle) => Promise<void>;
  /**
   * Pause the sandbox's execution transiently. State stays in memory;
   * `resume()` continues from the same point. For durable capture
   * across a process restart, use `snapshot()` instead.
   */
  readonly pause?: () => Promise<void>;
  /**
   * Resume from a matching `pause()`. Ignoring the call on an
   * already-resumed sandbox is idempotent (mirrors `destroy()`'s
   * idempotency requirement).
   */
  readonly resume?: () => Promise<void>;
}

/**
 * Opaque envelope for a snapshot produced by `Sandbox.snapshot()`.
 * Follows the versioned `{ v, …, doc }` envelope used for stored wire
 * types, so persistence layers can store snapshot handles as JSON
 * without a bespoke discriminator.
 *
 *  - `v` — envelope version; `1` is the initial shape. New handle
 *    fields land as `v: 2`; adapters MAY refuse older envelopes.
 *  - `adapterId` — the adapter that produced this snapshot. Restores
 *    MUST hit an adapter whose id matches, or the restore fails with
 *    `SandboxError { code: 'invalid-snapshot-handle', reason:
 *    'wrong-adapter' }`. Cross-adapter portability is deliberately
 *    not supported.
 *  - `doc` — adapter-specific payload. Callers do NOT parse this;
 *    only the producing adapter interprets it. Persistence layers
 *    treat it as opaque JSON.
 */
export interface SnapshotHandle {
  readonly v: 1;
  readonly adapterId: string;
  readonly doc: unknown;
}

export interface ExecResult {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitCode: number;
  readonly usage: ResourceUsage;
}

/**
 * Resource usage returned from every `exec` and process termination.
 * Providers that cannot measure a dimension return `0` for that field;
 * missing values are not permitted. Zeroes signal "provider does not
 * measure this" and downstream aggregators handle them explicitly.
 */
export interface ResourceUsage {
  readonly cpuMs: number;
  readonly wallMs: number;
  readonly peakMemMB: number;
}

export interface ProcessOpts {
  readonly stdin?: Uint8Array;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly abortSignal?: AbortSignal;
}

export interface ExecOpts extends ProcessOpts {
  /**
   * Timeout for this single `exec` call. Bounded by the outer wall
   * (`EdgePolicy.timeoutMs`); this exists
   * for handler-local overrides on mode B/C sandbox operations.
   */
  readonly timeoutMs?: number;
}

export interface ProcessHandle {
  /**
   * Writable stdin sink. Consumers write full frames (e.g. the mode-B
   * `InvokeFrame` / `ResumeFrame` JSON lines) and optionally `close()`
   * to signal EOF. Present on every conforming adapter — mode-B
   * dispatch requires it. Streaming stdout in the other direction is
   * already available on `stdout`.
   */
  readonly stdin: ProcessStdin;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly done: Promise<ExecResult>;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
}

/**
 * Writable-half of a running sandbox process. Bytes are opaque to the
 * adapter — mode B writes newline-delimited JSON frames; a caller may
 * write anything a specific handler expects.
 */
export interface ProcessStdin {
  write(chunk: Uint8Array): Promise<void>;
  /**
   * Signal end-of-input to the sandbox process. Optional — some
   * handlers keep stdin open across many frames (resume/invoke); most
   * exit after one exchange.
   */
  close?(): Promise<void>;
}

/**
 * Opaque reference to a handler artifact — what the kernel dispatches
 * to a sandbox. The resolution mechanism (how a
 * `HandlerRef` becomes a runnable artifact) is resolved by the runtime;
 * this declaration is extensible so it can broaden without breaking
 * earlier callers.
 */
export interface HandlerRef {
  readonly artifactId: ArtifactId;
  readonly version: string;
  /**
   * Path inside the sandbox where the handler module lives, populated
   * when the handler is available as a loadable file (mode B — the
   * handler-base entrypoint imports this path). Absent
   * for mode A (in-process closure) and mode C (opaque program image;
   * entrypoint is the image's own CMD/ENTRYPOINT).
   */
  readonly modulePath?: string;
  /**
   * Path inside the sandbox to the handler-base entrypoint script that
   * dispatches the JSON stdio protocol. Defaults to
   * `/kindgi/handler-base/entrypoint.js` — the well-known location
   * baked into handler-base images. Override for tests or
   * custom base images.
   */
  readonly entrypointPath?: string;
}

/**
 * Default location of the handler-base entrypoint script
 * inside a strict-mode sandbox image. Third-party base images that
 * ship their own copy override via `HandlerRef.entrypointPath`.
 */
export const DEFAULT_ENTRYPOINT_PATH = '/kindgi/handler-base/entrypoint.js';

/**
 * Capability strings adapters advertise on `SandboxProvider.capabilities`.
 * Kept as a string union for spec-legibility; the `SandboxCapabilities`
 * set below is typed `Set<string>` so third-party adapters can advertise
 * capabilities not in this union without a breaking change.
 *
 * Third-party adapters extend via capabilities, not by extending the
 * base interface.
 */
export type KnownSandboxCapability =
  | 'preview-url'
  | 'streaming'
  | 'warm-pool'
  | 'strict'
  | 'context-isolated'
  | 'network-allowlist'
  | 'network-unrestricted';

export type SandboxCapabilities = ReadonlySet<KnownSandboxCapability | string>;
