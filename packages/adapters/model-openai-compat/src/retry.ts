// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { APIConnectionError, APIError } from 'openai';

import {
  type RetryableFailure,
  isTransport,
  modelProviderError,
  refusedConnection,
  withRetries,
} from '@kindgi/adapter-model-shared';

/**
 * The adapter owns the retry policy on every OpenAI-compatible call (chat,
 * responses, embeddings), so a connection the runtime refuses the same way
 * every time — an egress or body-size guard, or a redirect the request won't
 * follow — isn't retried, and its own words reach the run instead of the
 * OpenAI SDK's "Connection error." The SDK client is built with
 * `maxRetries: 0`; `withRetries` decides what to try again (a dropped
 * connection, 408/409/429/5xx) and waits what the vendor's `retry-after` asks.
 */

/** A described OpenAI-SDK failure, as `withRetries` needs it. */
interface OpenAIFailure extends RetryableFailure {
  /** Not a refusal, a status, or a dropped connection: a bug or a pre-send error. Rethrown as it is. */
  readonly unrecognized?: true;
}

/** The statuses the policy tries again: the vendor timing out, a conflict, a rate limit, its own 5xx. */
function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Whether to retry an `APIError`, as the OpenAI SDK decided before we took the
 * policy over: a vendor's explicit `x-should-retry` wins over the status
 * (`'true'` → retry any status, `'false'` → retry none), read first; otherwise
 * the status (openai 7.17.0 `client.js`, `shouldRetry`).
 */
function shouldRetry(headers: Headers | undefined, status: number): boolean {
  const header = headers?.get('x-should-retry');
  if (header === 'true') return true;
  if (header === 'false') return false;
  return retryableStatus(status);
}

/**
 * An OpenAI `APIError`'s own words, without the status `makeMessage` puts in
 * front of them (`modelProviderError` adds the status back): the body's
 * `message` when it has one, else the body, else the message without the prefix.
 */
function apiErrorWords(error: APIError): string {
  const body = error.error as { readonly message?: unknown } | undefined;
  if (body !== undefined && body !== null) {
    if (typeof body.message === 'string' && body.message !== '') return body.message;
    return JSON.stringify(body);
  }
  const prefix = error.status !== undefined ? `${error.status} ` : '';
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

/** The `retry-after(-ms)` headers the policy reads, from the response's `Headers`. */
function retryAfterHeaders(headers: Headers | undefined): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const name of ['retry-after-ms', 'retry-after']) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** An OpenAI-SDK failure, classified for the retry policy. */
export function describeOpenAIFailure(error: unknown): OpenAIFailure {
  // Refused by policy, the same every attempt (an egress/body guard, a redirect): not retried, and
  // its own words on top — before the SDK's "Connection error." that wraps the refusal.
  const refused = refusedConnection(error);
  if (refused !== undefined) return { ...refused, retryable: false };
  if (error instanceof APIError && typeof error.status === 'number') {
    const headers = retryAfterHeaders(error.headers);
    return {
      status: error.status,
      words: apiErrorWords(error),
      retryable: shouldRetry(error.headers, error.status),
      ...(headers !== undefined && { headers }),
    };
  }
  // No response reached the endpoint: a dropped connection, DNS, TLS. Retried.
  if (error instanceof APIConnectionError || isTransport(error)) {
    return { words: error instanceof Error ? error.message : String(error), retryable: true };
  }
  return {
    words: error instanceof Error ? error.message : String(error),
    retryable: false,
    unrecognized: true,
  };
}

/**
 * Send one request and retry it per the adapter's policy: `attempts` HTTP
 * attempts in all (map the caller's `maxRetries` with `retryAttempts`), the
 * abort signal when the call has one. A recognized failure comes back as the
 * shared typed `ModelProviderError`, its words on top; anything else is
 * rethrown unchanged, so a caller can still read its type.
 */
export function sendWithRetries<T>(
  send: () => PromiseLike<T>,
  options: { readonly attempts: number; readonly signal?: AbortSignal },
): Promise<T> {
  return withRetries(send, {
    attempts: options.attempts,
    ...(options.signal !== undefined && { signal: options.signal }),
    describe: describeOpenAIFailure,
    toError: (failure, error) =>
      failure.unrecognized === true
        ? error instanceof Error
          ? error
          : new Error(String(error))
        : modelProviderError(failure, error),
  });
}

/**
 * The HTTP attempts the policy makes for a caller's `clientOptions.maxRetries`.
 * The OpenAI SDK counts retries (default 2, so 3 attempts in all); `withRetries`
 * counts attempts, so the caller's setting keeps its meaning. The client itself
 * is built with `maxRetries: 0` — the adapter owns the retries.
 */
export function retryAttempts(maxRetries: number | undefined): number {
  return Math.max(1, (maxRetries ?? 2) + 1);
}
