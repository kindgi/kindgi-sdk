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
   * The env values the tool declares (`needsSpec.env`), resolved for this
   * call: project, else org, else tenant (protocol 2.5.0). Strings.
   */
  readonly env?: Readonly<Record<string, unknown>>;
  readonly secrets?: Readonly<Record<string, unknown>>;
  /** Reserved: no runtime sends it yet. */
  readonly config?: Readonly<Record<string, unknown>>;
  /** The calling agent version's settings blocks' values, by block id (protocol 2.4.0). */
  readonly settings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

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
  | 'check-shape-invalid'
  | 'malformed-message'
  | 'unknown-protocol-version'
  | 'unexpected-message-kind'
  | 'tool-not-in-pack'
  | 'check-not-in-pack'
  | 'tool-version-mismatch'
  | 'deadline-exceeded'
  | 'cancelled';

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
}

export type PackRequest = ToolInvokeMessage | CheckInvokeMessage;
export type PackResponse = ToolResultMessage | CheckResultMessage | PackErrorMessage;

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
  if (m.kind === 'error' && typeof m.code === 'string' && typeof m.message === 'string') {
    return { kind: 'ok', value: m as unknown as PackErrorMessage };
  }
  return {
    kind: 'err',
    error: packError('unexpected-message-kind', `Unknown response kind ${JSON.stringify(m.kind)}`),
  };
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
} as const;
