// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * One request to the feedback intake, and what came of it. A network
 * failure, or an answer that isn't the intake's, is said, never thrown,
 * so the command can say what was and wasn't sent, and what may have
 * arrived anyway.
 */

import { networkReason } from '../license/renew.js';
import {
  type EntryPayload,
  FEEDBACK_REPORTS_PATH,
  FEEDBACK_STATUS_PATH,
  FEEDBACK_WITHDRAW_PATH,
  type ReportStatus,
  type SubmittedReport,
  type WithdrawAnswer,
  readStatusAnswer,
  readSubmitAnswer,
  readWithdrawAnswer,
} from './protocol.js';

export interface IntakeDeps {
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
}

export type Asked<T> =
  | { readonly kind: 'ok'; readonly value: T }
  /** The intake said no, in its own words (`invalid-request`, `rate-limited`, …): it did nothing. */
  | {
      readonly kind: 'refused';
      readonly status: number;
      readonly error: string;
      readonly message: string;
      /** With a 429: how long to wait, in seconds. */
      readonly retryAfter?: number;
    }
  /**
   * No answer this CLI can use. `maybeReceived` is false only when the
   * request surely never reached the intake: no connection was made, or
   * something in front of it answered 4xx. A timeout, a dropped connection,
   * a 5xx, or a success this CLI can't read may follow a request that did
   * its work.
   */
  | { readonly kind: 'failed'; readonly message: string; readonly maybeReceived: boolean };

export function sendReports(
  origin: string,
  bytes: string,
  sent: readonly EntryPayload[],
  deps: IntakeDeps,
): Promise<Asked<readonly SubmittedReport[]>> {
  return ask(
    origin,
    FEEDBACK_REPORTS_PATH,
    bytes,
    201,
    (body) => readSubmitAnswer(body, sent),
    deps,
  );
}

export function askStatus(
  origin: string,
  reportIds: readonly string[],
  deps: IntakeDeps,
): Promise<Asked<readonly ReportStatus[]>> {
  return ask(
    origin,
    FEEDBACK_STATUS_PATH,
    JSON.stringify({ reportIds }),
    200,
    (body) => readStatusAnswer(body, reportIds),
    deps,
  );
}

export function withdrawReports(
  origin: string,
  reports: readonly { readonly reportId: string; readonly withdrawKey: string }[],
  deps: IntakeDeps,
): Promise<Asked<WithdrawAnswer>> {
  return ask(
    origin,
    FEEDBACK_WITHDRAW_PATH,
    JSON.stringify({ reports }),
    200,
    (body) =>
      readWithdrawAnswer(
        body,
        reports.map((r) => r.reportId),
      ),
    deps,
  );
}

async function ask<T>(
  origin: string,
  path: string,
  bytes: string,
  expected: number,
  read: (body: unknown) => T | undefined,
  deps: IntakeDeps,
): Promise<Asked<T>> {
  let res: Response;
  let body: unknown;
  try {
    res = await deps.fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bytes,
      signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
    });
    body = await res.json().catch(() => undefined);
  } catch (cause) {
    return {
      kind: 'failed',
      message: `${origin} couldn't be reached (${networkReason(cause)})`,
      maybeReceived: !neverConnected(cause),
    };
  }
  if (res.status === expected) {
    const value = read(body);
    return value === undefined
      ? {
          kind: 'failed',
          message: `${origin}'s answer wasn't one this CLI can read`,
          maybeReceived: true,
        }
      : { kind: 'ok', value };
  }
  const said = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (res.status >= 500 || res.ok || typeof said.error !== 'string') {
    // A 5xx, a proxy's page, or a success that isn't this route's: the next try may work.
    return {
      kind: 'failed',
      message: `${origin} answered ${res.status}${res.status >= 500 && typeof said.error === 'string' ? ` (${said.error})` : ''}`,
      maybeReceived: res.status < 400 || res.status >= 500,
    };
  }
  const retryAfter =
    res.status === 429 ? retryAfterSeconds(res.headers.get('retry-after')) : undefined;
  return {
    kind: 'refused',
    status: res.status,
    error: said.error,
    message: typeof said.message === 'string' ? said.message : `${origin} answered ${res.status}`,
    ...(retryAfter !== undefined && { retryAfter }),
  };
}

/**
 * The error codes that mean no connection was made, so no byte of the
 * request left: the name didn't resolve, nothing listened, no route, or the
 * TLS handshake failed on the certificate. Anything else (a timeout, a
 * reset) may have come after the request went.
 */
const NOT_CONNECTED = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const CERTIFICATE_CODE = /^(?:CERT_|ERR_TLS_CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/;

function neverConnected(err: unknown): boolean {
  let at: unknown = err;
  for (let depth = 0; at instanceof Error && depth < 4; depth++) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === 'string' && (NOT_CONNECTED.has(code) || CERTIFICATE_CODE.test(code)))
      return true;
    at = at.cause;
  }
  return false;
}

/** `Retry-After` as whole seconds: a number of seconds, or an HTTP date. */
function retryAfterSeconds(header: string | null): number | undefined {
  if (header === null) return undefined;
  if (/^\d+$/.test(header.trim())) return Number.parseInt(header.trim(), 10);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}
