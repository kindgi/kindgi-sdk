// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * SDK error surface.
 *
 * Errors round-trip as `{ code, message, ...fields }`; `code` is the
 * discriminant.
 *
 * Runtime primitives return `Result<T, DiscriminatedError>` where the
 * discriminated union uses `code` at the wire. The API layer maps
 * `Result.kind === 'err'` to HTTP 4xx/5xx with an error envelope,
 * `{ error: { code, message, details?, requestId } }`, in the body
 * (`docs/API-ROUTE-CONVENTIONS.md` §4.2). The transport unwraps the
 * envelope and the SDK hydrates it back into a typed union so callers
 * can `switch (err.code)` without string-matching.
 *
 * Adding a new error kind:
 *   1. Add its variant to `KindgiError` (a new `code` literal).
 *   2. Add a case to `fromWire()` so wire hydration recognizes it.
 *
 * Typed errors as discriminated unions is a design principle for the
 * client SDK, mirroring the authoring APIs.
 */
export type KindgiError =
  | NetworkError
  | AuthError
  | RateLimitedError
  | NotFoundError
  | ConflictError
  | InvalidRequestError
  | GuardrailViolationError
  | ServerError
  | NotImplementedInPreviewError
  | NotYetWiredError;

export interface NetworkError {
  readonly code: 'network';
  readonly message: string;
  readonly cause?: unknown;
}

export interface AuthError {
  readonly code: 'auth';
  /** The server's own error code (the wire `code`), when the error came from the server. */
  readonly serverCode?: string;
  readonly message: string;
  readonly reason: 'unauthenticated' | 'forbidden' | 'token-expired';
}

export interface RateLimitedError {
  readonly code: 'rate-limited';
  /** The server's own error code (the wire `code`), when the error came from the server. */
  readonly serverCode?: string;
  readonly message: string;
  /** Suggested seconds to wait before retry (from server `Retry-After`). */
  readonly retryAfterSeconds?: number;
}

export interface NotFoundError {
  readonly code: 'not-found';
  /** The server's own error code (the wire `code`), when the error came from the server. */
  readonly serverCode?: string;
  readonly message: string;
  readonly resource: { readonly kind: string; readonly id: string };
}

export interface ConflictError {
  readonly code: 'conflict';
  /** The server's own error code (the wire `code`), when the error came from the server. */
  readonly serverCode?: string;
  readonly message: string;
  readonly reason: string;
}

export interface InvalidRequestError {
  readonly code: 'invalid-request';
  /** The server's own error code (the wire `code`), when the error came from the server. */
  readonly serverCode?: string;
  readonly message: string;
  /** JSON-pointer issues, matching the shape used across `packages/*` validators. */
  readonly issues: readonly { readonly path: string; readonly message: string }[];
}

/**
 * A run stopped because one or more guardrails with a blocking action
 * failed. `message` names them; `violations` lists each one in
 * evaluation order.
 */
export interface GuardrailViolationError {
  readonly code: 'guardrail-violation';
  /** The server's own error code (the wire `code`), when the error came from the server. */
  readonly serverCode?: string;
  readonly message: string;
  readonly violations: readonly GuardrailViolation[];
  /**
   * Guardrails whose check could not run at all (missing check
   * implementation, bad configuration) — reported alongside, not
   * counted as violations.
   */
  readonly evaluationErrors: readonly {
    readonly guardrailId: string;
    readonly message: string;
  }[];
}

/** One guardrail that blocked a run. */
export interface GuardrailViolation {
  readonly guardrailId: string;
  /** The guardrail's severity (`info` | `warn` | `error` | `critical`). */
  readonly severity: string;
  /** The action the runtime applied — `halt` for a blocking violation. */
  readonly action: string;
  /** The check's explanation, when it gave one. */
  readonly reason?: string;
}

/**
 * Passthrough for server-side errors that have no dedicated SDK
 * variant (for example `KernelError` or `MemoryError` codes). `fromWire`
 * maps a wire `code` it doesn't list to `{ code: 'server', serverCode:
 * <wire code>, message, fields: <wire details> }` — unless its HTTP
 * status names a family (404/410 not-found, 401/403 auth, 429
 * rate-limited, 400 invalid request; 409 and 422 stay `server`).
 *
 * Callers match `err.code === 'server' && err.serverCode === '...'` to
 * handle specific primitive errors. Every error from the server carries
 * `serverCode`, so matching on it alone works whatever the family.
 */
export interface ServerError {
  readonly code: 'server';
  readonly serverCode: string;
  readonly message: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

/**
 * For SDK methods whose client-side transport is not implemented in
 * this preview. No current SDK method throws it; the variant and the
 * `notImplementedInPreview` constructor are part of the public error
 * surface.
 */
export interface NotImplementedInPreviewError {
  readonly code: 'not-implemented-in-preview';
  readonly message: string;
  readonly method: string;
}

export function notImplementedInPreview(method: string): NotImplementedInPreviewError {
  return {
    code: 'not-implemented-in-preview',
    message: `${method}: transport not implemented in this preview`,
    method,
  };
}

/**
 * Thrown (wrapped in `KindgiApiError`) by SDK methods that have no
 * matching route in the API, marked `@unwired` in their JSDoc. Raised
 * client-side, without a request. Distinct from
 * `NotImplementedInPreviewError` — which describes a missing client
 * transport — this describes a missing server route.
 */
export interface NotYetWiredError {
  readonly code: 'not-yet-wired';
  readonly message: string;
  readonly method: string;
  /** Free-form note on why the method is unavailable and what to use instead, if anything. */
  readonly reason: string;
}

export function notYetWired(method: string, reason: string): NotYetWiredError {
  return {
    code: 'not-yet-wired',
    message: `${method}: ${reason}`,
    method,
    reason,
  };
}

/**
 * Rehydrate a wire error body into a typed `KindgiError`.
 *
 * The API layer serializes runtime errors as
 * `{ code, message, details?, requestId }` inside its `{ error }`
 * envelope, which the transport unwraps before calling this. This
 * function reads `code` and projects the rest of the object (including
 * `details`) into the matching variant. A code this client doesn't list
 * (a newer server's) is read by the HTTP `status` instead: 404/410 a
 * not-found, 400 an invalid request, 401/403 an auth error, 429
 * rate-limited. 409 and 422 stay `ServerError`: the docs match their
 * codes there (`budget-exceeded`, `agent-version-mismatch`). Every
 * error from the server keeps the raw code as `serverCode`.
 *
 * `code` is the discriminant.
 */
export function fromWire(body: unknown, status?: number): KindgiError {
  const error = classify(body, status);
  if (error.code === 'server') return error;
  const code =
    body !== null &&
    typeof body === 'object' &&
    typeof (body as { code?: unknown }).code === 'string'
      ? (body as { code: string }).code
      : undefined;
  return code === undefined ? error : ({ ...error, serverCode: code } as KindgiError);
}

function classify(body: unknown, status: number | undefined): KindgiError {
  if (!body || typeof body !== 'object') {
    return {
      code: 'server',
      serverCode: 'unknown',
      message: 'Malformed error body from server',
    };
  }
  const obj = body as Record<string, unknown>;
  const code = typeof obj.code === 'string' ? obj.code : 'unknown';
  const message =
    typeof obj.message === 'string' ? (obj.message as string) : `Server error: ${code}`;

  const details =
    obj.details && typeof obj.details === 'object'
      ? (obj.details as Record<string, unknown>)
      : undefined;

  switch (code) {
    case 'auth':
      return {
        code: 'auth',
        message,
        reason: (obj.reason as AuthError['reason'] | undefined) ?? 'unauthenticated',
      };
    // Wire-level auth codes per API-ROUTE-CONVENTIONS §4.3.
    case 'auth-missing':
      return { code: 'auth', message, reason: 'unauthenticated' };
    case 'auth-expired':
      return { code: 'auth', message, reason: 'token-expired' };
    case 'auth-revoked':
      return { code: 'auth', message, reason: 'unauthenticated' };
    case 'permission-denied':
      return { code: 'auth', message, reason: 'forbidden' };
    case 'rate-limited':
    case 'rate-limit-exceeded':
      return rateLimited(message, obj);
    case 'not-found':
    case 'run-not-found':
    case 'agent-not-found':
    case 'tool-not-found':
    case 'guardrail-not-found':
    case 'flow-not-found':
    case 'conversation-not-found':
    case 'approval-not-found':
    case 'reviewer-not-found':
    case 'proposal-not-found':
    case 'provenance-not-found':
    case 'observation-not-found':
    case 'blob-not-found':
    case 'audit-bundle-not-found':
    case 'signing-not-configured':
    case 'signing-key-not-found':
    case 'adapter-not-found':
    case 'fact-not-found':
    case 'identity-user-not-found':
    case 'provider-not-found':
    case 'capability-not-found':
    case 'token-not-found':
    case 'agent-version-not-found':
    case 'promotion-not-found':
      return notFound(code, message, details);
    case 'conflict':
    case 'already-terminal':
    case 'run-already-terminal':
    case 'idempotency-key-body-mismatch':
    case 'hitl-required':
    case 'agent-already-registered':
    case 'tool-already-registered':
    case 'guardrail-already-registered':
    case 'flow-already-registered':
    case 'conversation-closed':
    case 'provider-already-registered':
    case 'proposal-invalid-state-transition':
    case 'approval-not-decided':
    case 'slug-conflict':
    case 'project-default-already-exists':
    case 'registry-read-only':
    case 'policy-scope-taken':
    case 'policy-scope-changed':
    case 'nothing-to-roll-back':
    case 'not-pinned':
    case 'agent-version-live':
    case 'eval-suite-already-registered':
    case 'policy-already-registered':
    case 'mcp-endpoint-already-registered':
    case 'identity-provider-already-registered':
    case 'version-already-exists':
    case 'eval-run-already-terminal':
    case 'approval-already-decided':
    case 'judge-class-name-taken':
    case 'promotion-superseded':
    case 'gate-policy-already-registered':
    case 'gate-policy-scope-taken':
    case 'gate-policy-scope-changed':
    case 'gate-policy-scope-unpinned':
    case 'gate-policy-needs-pin':
    case 'gate-policy-descendant-unpinned':
      return { code: 'conflict', message, reason: code };
    case 'invalid-request':
    case 'validation-failed':
    case 'unknown-field':
    case 'bad-input':
    case 'unresolved-tool':
    case 'unresolved-guardrail':
    case 'schema-validation-failed':
    case 'invalid-agent':
    case 'invalid-tool-definition':
    case 'invalid-schema':
    case 'unknown-effect':
    case 'invalid-guardrail':
    case 'invalid-provider':
    case 'supervisor-header-missing':
    case 'scope-invalid':
      return invalidRequest(message, obj, details);
    case 'guardrail-violation':
      return {
        code: 'guardrail-violation',
        message,
        violations: readGuardrailViolations(details?.violations),
        evaluationErrors: readEvaluationErrors(details?.evaluationErrors),
      };
    default:
      return byStatus(status, code, message, obj, details);
  }
}

type WireFields = Readonly<Record<string, unknown>>;

/** A code this client doesn't list, read by its HTTP status. */
function byStatus(
  status: number | undefined,
  code: string,
  message: string,
  obj: WireFields,
  details: WireFields | undefined,
): KindgiError {
  switch (status) {
    case 404:
    case 410:
      return notFound(code, message, details);
    case 400:
      return invalidRequest(message, obj, details);
    case 401:
      return { code: 'auth', message, reason: 'unauthenticated' };
    case 403:
      return { code: 'auth', message, reason: 'forbidden' };
    case 429:
      return rateLimited(message, obj);
    default:
      return {
        code: 'server',
        serverCode: code,
        message,
        ...(details !== undefined ? { fields: details } : {}),
      };
  }
}

function notFound(code: string, message: string, details: WireFields | undefined): KindgiError {
  return {
    code: 'not-found',
    message,
    resource: {
      kind: code.replace(/-not-found$/u, '') || 'unknown',
      id:
        readStringField(
          details,
          'agentId',
          'toolId',
          'runId',
          'adapterId',
          'userId',
          'providerId',
          'capabilityId',
          'tokenId',
          'factId',
          'guardrailId',
          'id',
        ) ?? 'unknown',
    },
  };
}

function invalidRequest(
  message: string,
  obj: WireFields,
  details: WireFields | undefined,
): KindgiError {
  return {
    code: 'invalid-request',
    message,
    issues:
      (obj.issues as InvalidRequestError['issues'] | undefined) ??
      (details?.issues as InvalidRequestError['issues'] | undefined) ??
      [],
  };
}

function rateLimited(message: string, obj: WireFields): KindgiError {
  return {
    code: 'rate-limited',
    message,
    ...(typeof obj.retryAfterSeconds === 'number'
      ? { retryAfterSeconds: obj.retryAfterSeconds as number }
      : {}),
  };
}

function readStringField(
  obj: Readonly<Record<string, unknown>> | undefined,
  ...keys: readonly string[]
): string | undefined {
  if (obj === undefined) return undefined;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * Project the wire's evaluation results (`{ guardrailId, severity,
 * action, result: { reason? } }`) onto `GuardrailViolation`. Entries
 * without a `guardrailId` are dropped.
 */
function readGuardrailViolations(raw: unknown): readonly GuardrailViolation[] {
  if (!Array.isArray(raw)) return [];
  const out: GuardrailViolation[] = [];
  for (const entry of raw) {
    const v = asRecord(entry);
    if (v === undefined || typeof v.guardrailId !== 'string') continue;
    const reason = asRecord(v.result)?.reason;
    out.push({
      guardrailId: v.guardrailId,
      severity: typeof v.severity === 'string' ? v.severity : 'unknown',
      action: typeof v.action === 'string' ? v.action : 'unknown',
      ...(typeof reason === 'string' && { reason }),
    });
  }
  return out;
}

function readEvaluationErrors(raw: unknown): GuardrailViolationError['evaluationErrors'] {
  if (!Array.isArray(raw)) return [];
  const out: { guardrailId: string; message: string }[] = [];
  for (const entry of raw) {
    const e = asRecord(entry);
    if (e === undefined || typeof e.guardrailId !== 'string') continue;
    out.push({
      guardrailId: e.guardrailId,
      message: typeof e.message === 'string' ? e.message : '',
    });
  }
  return out;
}

/**
 * Wrap a wire error as a JS `Error` so it can be `throw`n by SDK
 * methods. The typed payload rides on the `.error` property; callers
 * `catch (e)` then narrow via `e.error.code`.
 */
export class KindgiApiError extends Error {
  readonly error: KindgiError;
  constructor(error: KindgiError) {
    super(error.message);
    this.name = 'KindgiApiError';
    this.error = error;
  }
}
