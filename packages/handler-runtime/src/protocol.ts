// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Pack protocol v2 — the messages a runtime exchanges with a pack
 * service (`./pack-service`) to run pack code: tool handlers and
 * guardrail checks.
 *
 * A request names a tool or check by id; the pack service resolves it
 * from its own `index.json`. The caller never chooses which module is
 * imported, and the schemas that validate input and output are the
 * ones the pack was built with.
 *
 * One request, one response. Every outcome of running pack code —
 * success, a validation failure, a throw, a deadline, an unknown tool —
 * is a response message. Transport problems (auth, overload, draining)
 * are HTTP statuses, never messages.
 */

import type { ToolConnection } from '@kindgi/tools';

/** Wire version of every v2 message. */
export const PACK_PROTOCOL_VERSION = 2 as const;
export type PackProtocolVersion = typeof PACK_PROTOCOL_VERSION;

/** Per-call context a handler receives (serializable; no functions). */
export interface PackCallContext {
  readonly tenantId: string;
  /** The kernel run this call belongs to. */
  readonly runId: string;
  /** The run's project: set by the runtime from the run, never from input (protocol 2.3.0). */
  readonly projectId?: string;
  /** That project's org, when it has one; from the project, never from input (2.3.0). */
  readonly orgId?: string;
  /** The individual call — e.g. the model's tool-call id. */
  readonly requestId?: string;
  /**
   * The call's idempotency key: the same every time this call runs (a
   * resume, a retry, a re-run after a crash), different for every other
   * call (protocol 2.6.0). A pack service from before 2.6.0 ignores it.
   */
  readonly idempotencyKey?: string;
  /**
   * The env values the tool declares (`needsSpec.env`), resolved for this
   * call: project, else org, else tenant (protocol 2.5.0). Strings.
   */
  readonly env?: Readonly<Record<string, unknown>>;
  readonly secrets?: Readonly<Record<string, unknown>>;
  /**
   * The connections the tool declares (`needsSpec.connections`), resolved
   * for this call, by the tool's name for each: an account at another app
   * and a short-lived token for it (protocol 2.9.0). Like `secrets`, never
   * logged. Absent when the tool declares none, and from an older runtime.
   */
  readonly connections?: Readonly<Record<string, ToolConnection>>;
  /** Reserved: no runtime sends it yet. */
  readonly config?: Readonly<Record<string, unknown>>;
  /** The calling agent version's settings blocks' values, by block id (protocol 2.4.0). */
  readonly settings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * The wait token a tool that declares `pauses` may answer with
   * (protocol 2.8.0): sent only for such a tool. A pack service from
   * before 2.8.0 ignores it.
   */
  readonly waitToken?: WaitTokenRef;
  /**
   * Where a tool that declares `storesFiles` or `readsFiles` stores and
   * reads files (protocol 2.10.0): sent only for such a tool, when the
   * runtime has a file store, and for one that only stores, when the call
   * has an `idempotencyKey`. Like `secrets`, never logged. The runner keeps
   * it from the handler, which gets `files`. A pack service from before
   * 2.10.0 ignores it.
   */
  readonly toolFiles?: ToolFilesRef;
}

/** A wait token: its id, and the link the other system posts its answer to. */
export interface WaitTokenRef {
  readonly id: string;
  readonly url: string;
}

/**
 * A call's tool files (protocol 2.10.0): the link the runner posts each
 * stored file's bytes to, and under which it gets each read file's bytes
 * (`<url>/<artifactId>`), and the token it sends in `Authorization`. For
 * this call only, until its deadline or its answer, and only for what the
 * tool declares.
 */
export interface ToolFilesRef {
  readonly url: string;
  readonly token: string;
}

/** The longest a pause may wait: 24 days, in milliseconds (protocol 2.8.0). */
export const MAX_PAUSE_TIMEOUT_MS = 24 * 24 * 60 * 60 * 1000;
/** The longest a pause's `name` may be (protocol 2.8.0). */
export const MAX_PAUSE_NAME_LENGTH = 200;

export interface ToolRef {
  readonly id: string;
  /** When set, the pack service refuses a different indexed version. */
  readonly version?: string;
}

export interface CheckRef {
  /** Guardrail check id (the indexed guardrail's `checkId`). */
  readonly id: string;
}

export interface ToolInvokeMessage {
  readonly v: PackProtocolVersion;
  readonly kind: 'invoke';
  readonly tool: ToolRef;
  readonly input: unknown;
  readonly ctx: PackCallContext;
}

export interface CheckInvokeMessage {
  readonly v: PackProtocolVersion;
  readonly kind: 'check-invoke';
  readonly check: CheckRef;
  readonly config: Readonly<Record<string, unknown>>;
  readonly trace: unknown;
}

export interface ToolResultMessage {
  readonly v: PackProtocolVersion;
  readonly kind: 'result';
  readonly output: unknown;
}

/**
 * A `pauses` tool's answer that its call waits for another system
 * (protocol 2.8.0). Valid only as the answer to an `invoke` whose context
 * carried `waitToken`. Without `timeoutMs`, the runtime's default applies.
 */
export interface ToolPauseMessage {
  readonly v: PackProtocolVersion;
  readonly kind: 'pause';
  readonly timeoutMs?: number;
  readonly name?: string;
}

export interface CheckResultMessage {
  readonly v: PackProtocolVersion;
  readonly kind: 'check-result';
  readonly result: unknown;
}

export type PackErrorCode =
  | 'input-validation-failed'
  | 'output-validation-failed'
  | 'handler-import-failed'
  | 'handler-shape-invalid'
  | 'handler-throw'
  | 'connection-rejected'
  | 'check-shape-invalid'
  | 'malformed-message'
  | 'unknown-protocol-version'
  | 'unexpected-message-kind'
  | 'tool-not-in-pack'
  | 'check-not-in-pack'
  | 'tool-version-mismatch'
  | 'deadline-exceeded'
  | 'cancelled'
  | 'pause-not-available';

export interface PackErrorMessage {
  readonly v: PackProtocolVersion;
  readonly kind: 'error';
  readonly code: PackErrorCode;
  readonly message: string;
  readonly toolId?: string;
  readonly checkId?: string;
  readonly cause?: unknown;
  /** Schema-validation issues (Ajv-style), for the validation codes. */
  readonly issues?: readonly unknown[];
  /**
   * For `connection-rejected` (protocol 2.9.0): the tool's name for the
   * connection whose token the app refused. The runtime renews that token
   * once and runs the call again.
   */
  readonly connection?: string;
}

export type PackRequest = ToolInvokeMessage | CheckInvokeMessage;
export type PackResponse =
  | ToolResultMessage
  | ToolPauseMessage
  | CheckResultMessage
  | PackErrorMessage;

export type ParseOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'err'; readonly error: PackErrorMessage };

export function packError(
  code: PackErrorCode,
  message: string,
  extra: Omit<Partial<PackErrorMessage>, 'v' | 'kind' | 'code' | 'message'> = {},
): PackErrorMessage {
  return { v: PACK_PROTOCOL_VERSION, kind: 'error', code, message, ...extra };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkEnvelope(value: unknown): ParseOutcome<Record<string, unknown>> {
  if (!isRecord(value)) {
    return { kind: 'err', error: packError('malformed-message', 'Message must be a JSON object') };
  }
  if (value.v !== PACK_PROTOCOL_VERSION) {
    return {
      kind: 'err',
      error: packError(
        'unknown-protocol-version',
        `Expected protocol v${PACK_PROTOCOL_VERSION}, got ${JSON.stringify(value.v)}`,
      ),
    };
  }
  return { kind: 'ok', value };
}

function parseContext(raw: unknown): PackCallContext | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.tenantId !== 'string' || typeof raw.runId !== 'string') return undefined;
  return raw as unknown as PackCallContext;
}

/** Parse a request body (already JSON-decoded) into a v2 request. */
export function parsePackRequest(value: unknown): ParseOutcome<PackRequest> {
  const env = checkEnvelope(value);
  if (env.kind === 'err') return env;
  const m = env.value;
  if (m.kind === 'invoke') return parseToolInvoke(m);
  if (m.kind === 'check-invoke') return parseCheckInvoke(m);
  return {
    kind: 'err',
    error: packError('unexpected-message-kind', `Unknown request kind ${JSON.stringify(m.kind)}`),
  };
}

function malformed(message: string): ParseOutcome<never> {
  return { kind: 'err', error: packError('malformed-message', message) };
}

function parseToolInvoke(m: Record<string, unknown>): ParseOutcome<ToolInvokeMessage> {
  const tool = m.tool;
  if (!isRecord(tool) || typeof tool.id !== 'string' || tool.id.length === 0) {
    return malformed('`tool.id` is required');
  }
  if (tool.version !== undefined && typeof tool.version !== 'string') {
    return malformed('`tool.version` must be a string');
  }
  if (parseContext(m.ctx) === undefined)
    return malformed('`ctx` needs string `tenantId` and `runId`');
  return { kind: 'ok', value: m as unknown as ToolInvokeMessage };
}

function parseCheckInvoke(m: Record<string, unknown>): ParseOutcome<CheckInvokeMessage> {
  const check = m.check;
  if (!isRecord(check) || typeof check.id !== 'string' || check.id.length === 0) {
    return malformed('`check.id` is required');
  }
  if (!isRecord(m.config)) return malformed('`config` must be an object');
  return { kind: 'ok', value: m as unknown as CheckInvokeMessage };
}

/** Parse a response body (already JSON-decoded) into a v2 response. */
export function parsePackResponse(value: unknown): ParseOutcome<PackResponse> {
  const env = checkEnvelope(value);
  if (env.kind === 'err') return env;
  const m = env.value;
  if (m.kind === 'result' || m.kind === 'check-result') {
    return { kind: 'ok', value: m as unknown as PackResponse };
  }
  if (m.kind === 'pause') return parseToolPause(m);
  if (m.kind === 'error' && typeof m.code === 'string' && typeof m.message === 'string') {
    return { kind: 'ok', value: m as unknown as PackErrorMessage };
  }
  return {
    kind: 'err',
    error: packError('unexpected-message-kind', `Unknown response kind ${JSON.stringify(m.kind)}`),
  };
}

function parseToolPause(m: Record<string, unknown>): ParseOutcome<ToolPauseMessage> {
  const { timeoutMs, name } = m;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_PAUSE_TIMEOUT_MS)
  ) {
    return malformed(`\`timeoutMs\` must be a whole number from 1 to ${MAX_PAUSE_TIMEOUT_MS}`);
  }
  // In code points, as the schema's `maxLength` and a Python pack count it.
  if (
    name !== undefined &&
    (typeof name !== 'string' || name.length === 0 || [...name].length > MAX_PAUSE_NAME_LENGTH)
  ) {
    return malformed(`\`name\` must be a string of 1 to ${MAX_PAUSE_NAME_LENGTH} characters`);
  }
  return { kind: 'ok', value: m as unknown as ToolPauseMessage };
}

/**
 * HTTP headers of the v2 transport. `Authorization` is deliberately not
 * used: on platforms like Cloud Run it carries the platform's identity
 * token, so the pack token travels separately.
 */
export const PACK_HEADERS = {
  protocol: 'kindgi-protocol',
  token: 'kindgi-pack-token',
  /** Relative deadline for the call, in milliseconds. */
  timeoutMs: 'kindgi-timeout-ms',
  runId: 'kindgi-run-id',
  requestId: 'kindgi-request-id',
  artifactVersion: 'kindgi-artifact-version',
  durationMs: 'kindgi-duration-ms',
  /**
   * W3C Trace Context: the run's trace, so a pack service's records carry
   * the same `traceId` as the runtime's. Optional: runtimes from 0.1.5 send
   * it on every call; a pack service that doesn't read it ignores it.
   */
  traceparent: 'traceparent',
  /**
   * The workspace the call is for, set by the server from the deployment it
   * routed the call to (never copied from a caller), on `/v1/invoke` and
   * `/v1/info`. A pack service with `KINDGI_PACK_TENANT_ID` refuses a call
   * whose header is missing or names another tenant, with 421. Optional: a
   * pack service that doesn't read it ignores it.
   */
  tenantId: 'kindgi-tenant-id',
} as const;
