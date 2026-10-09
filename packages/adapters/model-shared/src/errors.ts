// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A failed model call, typed, the same for every adapter built on this package, whatever
 * library sends the request.
 */

/** What a failed call came to, for a caller that branches on it. */
export type ModelProviderErrorKind =
  | 'invalid-request'
  | 'auth'
  | 'rate-limited'
  | 'unavailable'
  | 'context-too-long'
  | 'content-filter'
  | 'network';

/**
 * A failed call. Its message is the vendor's own words, after the HTTP status when there is
 * one (`401 {"message":"…"}`), as other adapters' errors read in a failed call's record.
 */
export class ModelProviderError extends Error {
  constructor(
    readonly kind: ModelProviderErrorKind,
    readonly status: number | undefined,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ModelProviderError';
  }
}

/** A failed HTTP response, as the library that sent it reports it. */
export interface FailedResponse {
  /** Absent: no response at all (a dropped connection, DNS, TLS). */
  readonly status?: number;
  /** The response body, or the library's message when there's none. */
  readonly words: string;
}

const CONTEXT_TOO_LONG = /context|too long|maximum.{0,20}tokens|exceeds|token limit/i;
const CONTENT_FILTER =
  /content.?filter|filtered|content management|safety|responsible ?ai|content_policy|blocked/i;

/** The statuses whose body says why a request was refused: the words decide among them. */
const WORDED = new Set([400, 413, 422]);

/**
 * The kind of a failure: by status first, then by the vendor's words for a 400, 413 or 422.
 * A 408 is the vendor timing out (Bedrock's `ModelTimeoutException`: "took too long"), never a
 * context that's too long.
 */
export function kindOf(failure: FailedResponse): ModelProviderErrorKind {
  const { status, words } = failure;
  if (status === undefined) return 'network';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limited';
  if (status === 408 || status >= 500) return 'unavailable';
  if (WORDED.has(status) && CONTEXT_TOO_LONG.test(words)) return 'context-too-long';
  if (WORDED.has(status) && CONTENT_FILTER.test(words)) return 'content-filter';
  return 'invalid-request';
}

/** The typed error for a failure. */
export function modelProviderError(failure: FailedResponse, cause: unknown): ModelProviderError {
  const { status, words } = failure;
  return new ModelProviderError(
    kindOf(failure),
    status,
    status !== undefined ? `${status} ${words}` : words,
    { cause },
  );
}
