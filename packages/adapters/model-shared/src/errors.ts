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
  /** Absent: no response at all (a dropped connection, DNS, TLS), or one with no status to read. */
  readonly status?: number;
  /** The response body, or the library's message when there's none. */
  readonly words: string;
  /**
   * The kind, when the engine knows it better than a status can say (an answer the library
   * couldn't read is `unavailable`, though it came with none). Absent: from the status.
   */
  readonly kind?: ModelProviderErrorKind;
}

/**
 * The vendors' own words for a prompt too long for the model (OpenAI and Azure's
 * `context_length_exceeded` / "maximum context length", Anthropic's "prompt is too long",
 * Bedrock's "Input is too long", Gemini's "exceeds the maximum number of tokens"), not any
 * mention of "context" or "exceeds" (`Invalid value for 'context'` is a bad request).
 */
const CONTEXT_TOO_LONG =
  /context[_ -]?length|context window|maximum context|prompt is too long|input is too long|too many tokens|token limit|exceeds the maximum (number of )?(input )?tokens|input token count/i;
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
  if (failure.kind !== undefined) return failure.kind;
  if (status === undefined) return 'network';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limited';
  // 408: the vendor timed out; 409: a conflict it says to retry; 424: the model failed
  // (Bedrock's ModelErrorException). None is the caller's request at fault.
  if (status === 408 || status === 409 || status === 424 || status >= 500) return 'unavailable';
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
