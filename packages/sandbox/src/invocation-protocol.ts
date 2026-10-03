// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Mode B wire protocol (JSON stdio). Defines the exact frames the kernel
 * writes to the sandbox's stdin and the frames the sandbox writes back on
 * stdout. Every frame carries an explicit protocol version — future
 * breaking changes bump `v`.
 *
 * Covers mode B (`json-stdio`) and durable-wait suspend/resume. The
 * kernel-side consumer is the runtime's handler dispatch; the
 * sandbox-side consumer is the handler-base entrypoint inside the
 * sandbox image. Third-party adapters that implement `startProcess` do
 * NOT parse frames — the bytes are opaque to the adapter, the protocol
 * lives on the kernel + handler-base sides.
 *
 * Design notes:
 *  - JSON + newline. Simple, universal, debuggable. Streaming /
 *    bidirectional / binary encodings are not supported.
 *  - Every frame carries `v`. Kernel accepts current + one prior version;
 *    handler-base emits current only.
 *  - Frame kinds are closed. Adapters may not extend the union; the
 *    wire is the framework's, not the adapter's.
 */

import type { Result } from '@kindgi/types';

/**
 * Current wire protocol version. Bump when a breaking change lands
 * (new required field, removed field, changed semantics). Additive
 * fields on an existing frame kind are backwards-compatible and do
 * not bump.
 */
export const PROTOCOL_VERSION = 1 as const;

/**
 * Exit code the handler-base entrypoint uses to signal "suspended, not
 * failed". Distinguishes durable-wait from a
 * handler failure that happened to exit non-zero.
 */
export const SUSPEND_EXIT_CODE = 42 as const;

/**
 * The subset of `NodeContext` fields that cross the wire in mode B.
 * Fields that CANNOT cross (`abortSignal` — translated to timeout;
 * `clockNow` / `waitForToken` — require round-tripping) are out.
 */
export interface ProtocolContext {
  readonly runId: string;
  readonly tenantId: string;
  readonly nodeId: string;
  readonly dryRun: boolean;
  readonly state: Readonly<Record<string, unknown>>;
  readonly nodeOutputs: Readonly<Record<string, unknown>>;
}

/**
 * Kernel → sandbox: dispatch a handler with a value + reduced context.
 * The entrypoint reads ONE invoke frame from stdin per invocation.
 */
export interface InvokeFrame<TInput = unknown> {
  readonly v: typeof PROTOCOL_VERSION;
  readonly kind: 'invoke';
  readonly input: TInput;
  readonly ctx: ProtocolContext;
}

/**
 * Sandbox → kernel: handler completed successfully. Payload is
 * whatever the handler returned.
 */
export interface OutputFrame<TOutput = unknown> {
  readonly v: typeof PROTOCOL_VERSION;
  readonly kind: 'output';
  readonly output: TOutput;
}

/**
 * Sandbox → kernel: handler failed. `code` is a stable discriminator
 * the kernel maps to a `SandboxError`; `details` is optional
 * caller-defined data.
 */
export interface ErrorFrame {
  readonly v: typeof PROTOCOL_VERSION;
  readonly kind: 'error';
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

/**
 * Sandbox → kernel: handler is durably suspending on `tokenId`. The
 * entrypoint exits with `SUSPEND_EXIT_CODE` immediately after
 * emitting this frame; the kernel journals `wait.suspended`, destroys
 * the sandbox, and resumes via a fresh sandbox + `ResumeFrame` when
 * `completeToken` fires.
 */
export interface SuspendFrame {
  readonly v: typeof PROTOCOL_VERSION;
  readonly kind: 'suspend';
  readonly tokenId: string;
}

/**
 * Kernel → sandbox (on resume from suspension): pre-seed the handler
 * with the value that `completeToken` provided. The entrypoint writes
 * this into a local "resume map" BEFORE dispatching to `handler.run`;
 * during handler re-execution, `ctx.waitForToken(tokenId)` reads the
 * map and returns the value without re-suspending.
 */
export interface ResumeFrame {
  readonly v: typeof PROTOCOL_VERSION;
  readonly kind: 'resume';
  readonly tokenId: string;
  readonly value: unknown;
}

/** Union of frames the kernel writes to the sandbox's stdin. */
export type StdinFrame = InvokeFrame | ResumeFrame;

/** Union of frames the sandbox writes to stdout. */
export type StdoutFrame = OutputFrame | ErrorFrame | SuspendFrame;

/** Every frame. */
export type WireFrame = StdinFrame | StdoutFrame;

/**
 * Parse-time failure modes. Distinct from `SandboxError` because the
 * error surfaces at the wire layer — the kernel's caller wraps these
 * into `unhandled-worker-error` or `provider-error` per context.
 */
export type ProtocolError =
  | { readonly kind: 'malformed-json'; readonly cause: unknown; readonly raw: string }
  | { readonly kind: 'unknown-version'; readonly version: unknown; readonly raw: string }
  | { readonly kind: 'unknown-kind'; readonly value: unknown; readonly raw: string }
  | { readonly kind: 'malformed-frame'; readonly reason: string; readonly raw: string };

/** Encode a frame as bytes (JSON + trailing newline). */
export function encodeFrame(frame: WireFrame): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
}

/**
 * Parse one line of the wire stream into a `WireFrame`. Rejects loud
 * on version mismatch, unknown kind, or malformed shape. Does NOT
 * validate the `input` / `output` payloads — those are user data and
 * the kernel's caller handles them.
 */
export function parseFrame(line: string): Result<WireFrame, ProtocolError> {
  const trimmed = line.replace(/\n$/, '');
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch (cause) {
    return { kind: 'err', error: { kind: 'malformed-json', cause, raw: trimmed } };
  }
  if (typeof obj !== 'object' || obj === null) {
    return {
      kind: 'err',
      error: { kind: 'malformed-frame', reason: 'top-level value is not an object', raw: trimmed },
    };
  }
  const record = obj as Record<string, unknown>;
  if (record.v !== PROTOCOL_VERSION) {
    return { kind: 'err', error: { kind: 'unknown-version', version: record.v, raw: trimmed } };
  }
  const kind = record.kind;
  switch (kind) {
    case 'invoke':
      return validateInvoke(record, trimmed);
    case 'output':
      return validateOutput(record, trimmed);
    case 'error':
      return validateError(record, trimmed);
    case 'suspend':
      return validateSuspend(record, trimmed);
    case 'resume':
      return validateResume(record, trimmed);
    default:
      return { kind: 'err', error: { kind: 'unknown-kind', value: kind, raw: trimmed } };
  }
}

/**
 * Parse a stream of newline-delimited JSON frames from a source of
 * `Uint8Array` chunks (typically `ProcessHandle.stdout`). Yields one
 * `WireFrame` per parsed line; propagates parse errors as-is.
 */
export async function* parseFrames(
  source: AsyncIterable<Uint8Array>,
): AsyncIterableIterator<Result<WireFrame, ProtocolError>> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineAt = buffer.indexOf('\n');
    while (newlineAt !== -1) {
      const line = buffer.slice(0, newlineAt);
      buffer = buffer.slice(newlineAt + 1);
      if (line.length > 0) {
        yield parseFrame(line);
      }
      newlineAt = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) {
    yield parseFrame(buffer);
  }
}

function validateInvoke(
  record: Record<string, unknown>,
  raw: string,
): Result<InvokeFrame, ProtocolError> {
  if (!('input' in record)) {
    return {
      kind: 'err',
      error: { kind: 'malformed-frame', reason: "'invoke' missing 'input'", raw },
    };
  }
  const ctx = record.ctx;
  if (typeof ctx !== 'object' || ctx === null) {
    return {
      kind: 'err',
      error: { kind: 'malformed-frame', reason: "'invoke' missing or invalid 'ctx'", raw },
    };
  }
  const ctxRecord = ctx as Record<string, unknown>;
  for (const key of ['runId', 'tenantId', 'nodeId'] as const) {
    if (typeof ctxRecord[key] !== 'string') {
      return {
        kind: 'err',
        error: { kind: 'malformed-frame', reason: `'invoke.ctx.${key}' is not a string`, raw },
      };
    }
  }
  if (typeof ctxRecord.dryRun !== 'boolean') {
    return {
      kind: 'err',
      error: { kind: 'malformed-frame', reason: "'invoke.ctx.dryRun' not boolean", raw },
    };
  }
  if (typeof ctxRecord.state !== 'object' || ctxRecord.state === null) {
    return {
      kind: 'err',
      error: { kind: 'malformed-frame', reason: "'invoke.ctx.state' not object", raw },
    };
  }
  if (typeof ctxRecord.nodeOutputs !== 'object' || ctxRecord.nodeOutputs === null) {
    return {
      kind: 'err',
      error: { kind: 'malformed-frame', reason: "'invoke.ctx.nodeOutputs' not object", raw },
    };
  }
  return {
    kind: 'ok',
    value: {
      v: PROTOCOL_VERSION,
      kind: 'invoke',
      input: record.input,
      ctx: {
        runId: ctxRecord.runId as string,
        tenantId: ctxRecord.tenantId as string,
        nodeId: ctxRecord.nodeId as string,
        dryRun: ctxRecord.dryRun,
        state: ctxRecord.state as Readonly<Record<string, unknown>>,
        nodeOutputs: ctxRecord.nodeOutputs as Readonly<Record<string, unknown>>,
      },
    },
  };
}

function validateOutput(
  record: Record<string, unknown>,
  raw: string,
): Result<OutputFrame, ProtocolError> {
  if (!('output' in record)) {
    return {
      kind: 'err',
      error: { kind: 'malformed-frame', reason: "'output' missing 'output'", raw },
    };
  }
  return { kind: 'ok', value: { v: PROTOCOL_VERSION, kind: 'output', output: record.output } };
}

function validateError(
  record: Record<string, unknown>,
  raw: string,
): Result<ErrorFrame, ProtocolError> {
  const err = record.error;
  if (typeof err !== 'object' || err === null) {
    return {
      kind: 'err',
      error: { kind: 'malformed-frame', reason: "'error' missing 'error' object", raw },
    };
  }
  const errRecord = err as Record<string, unknown>;
  if (typeof errRecord.code !== 'string' || typeof errRecord.message !== 'string') {
    return {
      kind: 'err',
      error: { kind: 'malformed-frame', reason: "'error.error' missing 'code'/'message'", raw },
    };
  }
  const details = errRecord.details;
  const isDetailsObject = typeof details === 'object' && details !== null;
  return {
    kind: 'ok',
    value: {
      v: PROTOCOL_VERSION,
      kind: 'error',
      error: {
        code: errRecord.code,
        message: errRecord.message,
        ...(isDetailsObject ? { details: details as Readonly<Record<string, unknown>> } : {}),
      },
    },
  };
}

function validateSuspend(
  record: Record<string, unknown>,
  raw: string,
): Result<SuspendFrame, ProtocolError> {
  if (typeof record.tokenId !== 'string') {
    return {
      kind: 'err',
      error: { kind: 'malformed-frame', reason: "'suspend.tokenId' not string", raw },
    };
  }
  return { kind: 'ok', value: { v: PROTOCOL_VERSION, kind: 'suspend', tokenId: record.tokenId } };
}

function validateResume(
  record: Record<string, unknown>,
  raw: string,
): Result<ResumeFrame, ProtocolError> {
  if (typeof record.tokenId !== 'string') {
    return {
      kind: 'err',
      error: { kind: 'malformed-frame', reason: "'resume.tokenId' not string", raw },
    };
  }
  if (!('value' in record)) {
    return {
      kind: 'err',
      error: { kind: 'malformed-frame', reason: "'resume' missing 'value'", raw },
    };
  }
  return {
    kind: 'ok',
    value: { v: PROTOCOL_VERSION, kind: 'resume', tokenId: record.tokenId, value: record.value },
  };
}
