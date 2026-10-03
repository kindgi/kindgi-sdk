// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Following a run's event stream (`GET /v1/runs/{runId}/stream`) until the
 * run ends.
 *
 * The server ends a stream after the run's terminal event, or after a time
 * limit while the run is still going. `followRun` reconnects in the second
 * case, resuming after the last event it saw (`Last-Event-Id`), so the
 * caller sees every event once, through to `run.completed`, `run.failed`
 * or `run.cancelled`. Network errors are retried with backoff; an HTTP 401
 * can refresh the credentials and continue (public run tokens expire).
 */

import { SseHttpError, readSse, sleep } from './streaming.js';

/**
 * A run event without its payload: what happened, on which node, when
 * (`RunProgressEvent` in the OpenAPI document). What
 * `GET /v1/runs/{runId}/progress/stream` sends.
 */
export interface RunProgressEvent {
  /** `<runId>:<sequence>`; the SSE `id:`, used to resume. */
  readonly eventId: string;
  readonly runId: string;
  readonly timestamp: string;
  /** `run.started`, `run.step-started`, `run.step-completed`, …, `run.completed`. */
  readonly kind: string;
  readonly sequence: number;
  /** The flow node the event is about, when there is one. */
  readonly nodeId?: string;
}

/** Consecutive 401s, each after a refresh, before giving up. */
const MAX_REFRESHES_IN_A_ROW = 3;

const TERMINAL_KINDS: ReadonlySet<string> = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

export interface FollowRunOptions {
  /** The stream URL. */
  readonly url: string;
  /** Headers for each connection (evaluated per attempt, so they can change). */
  readonly headers: () =>
    | Readonly<Record<string, string>>
    | Promise<Readonly<Record<string, string>>>;
  /**
   * Called when the server answers 401. Return `true` after refreshing the
   * credentials `headers` returns, to reconnect; `false` to stop with the
   * error. Absent → stop.
   */
  readonly onUnauthorized?: () => Promise<boolean>;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

/** Yield a run's events, once each, until its terminal event. */
export async function* followRun<E extends { readonly kind: string }>(
  options: FollowRunOptions,
): AsyncIterable<E> {
  const state: FollowState = { lastEventId: undefined, refreshesInARow: 0 };
  while (options.signal?.aborted !== true) {
    const outcome = yield* followOnce<E>(options, state);
    if (outcome === 'terminal' || outcome === 'aborted') return;
    // The server closed the stream before the run ended (its time limit):
    // reconnect after the last event. Pause first when the connection
    // brought nothing, so a server that keeps closing doesn't spin us.
    if (outcome === 'empty') await sleep(options.initialBackoffMs ?? 500, options.signal);
  }
}

interface FollowState {
  lastEventId: string | undefined;
  refreshesInARow: number;
}

type ConnectionOutcome = 'terminal' | 'closed' | 'empty' | 'refreshed' | 'aborted';

/** One connection: its events, then how it ended. */
async function* followOnce<E extends { readonly kind: string }>(
  options: FollowRunOptions,
  state: FollowState,
): AsyncGenerator<E, ConnectionOutcome> {
  let received = 0;
  try {
    for await (const event of readSse<E>(connectionOptions(options, state.lastEventId))) {
      received += 1;
      state.refreshesInARow = 0;
      if (event.id !== undefined) state.lastEventId = event.id;
      yield event.data;
      if (TERMINAL_KINDS.has(event.data.kind)) return 'terminal';
    }
  } catch (error) {
    if (options.signal?.aborted === true) return 'aborted';
    if (!(await refreshAfter(error, options, state.refreshesInARow))) throw error;
    state.refreshesInARow += 1;
    return 'refreshed';
  }
  return received === 0 ? 'empty' : 'closed';
}

/** One connection's options: resume after `lastEventId`, and don't retry client errors. */
function connectionOptions(options: FollowRunOptions, lastEventId: string | undefined) {
  return {
    url: options.url,
    headers: options.headers,
    ...(lastEventId !== undefined && { lastEventId }),
    ...(options.fetchImpl !== undefined && { fetchImpl: options.fetchImpl }),
    ...(options.signal !== undefined && { signal: options.signal }),
    ...(options.initialBackoffMs !== undefined && { initialBackoffMs: options.initialBackoffMs }),
    ...(options.maxBackoffMs !== undefined && { maxBackoffMs: options.maxBackoffMs }),
    // Client errors (401 expired token, 403, 404) don't heal by retrying.
    shouldRetry: (attempt: number, error: unknown) =>
      !(error instanceof SseHttpError && error.status >= 400 && error.status < 500) && attempt < 10,
  };
}

/** Whether a 401 was answered by refreshing the credentials (so: reconnect). */
async function refreshAfter(
  error: unknown,
  options: FollowRunOptions,
  refreshesInARow: number,
): Promise<boolean> {
  if (!(error instanceof SseHttpError) || error.status !== 401) return false;
  if (options.onUnauthorized === undefined || refreshesInARow >= MAX_REFRESHES_IN_A_ROW) {
    return false;
  }
  return options.onUnauthorized();
}

export interface SubscribeToRunOptions {
  /** The Kindgi API base URL, e.g. `https://kindgi.example.com`. */
  readonly apiUrl: string;
  readonly runId: string;
  /**
   * A public run token (`kgi_pt_…`) for this run, from your backend: the
   * `publicAccessToken` of `POST /v1/runs`, or `POST /v1/tokens/public`.
   */
  readonly accessToken: string;
  /**
   * Called when the token has expired: return a fresh one (ask your
   * backend to mint it). Absent → the subscription ends with the error.
   */
  readonly refreshAccessToken?: () => Promise<string>;
  readonly signal?: AbortSignal;
  /** `fetch` to use; the global one by default. */
  readonly fetch?: typeof fetch;
}

/**
 * Follow a run's progress from a browser with a public run token: yields
 * its events (kind, node, sequence, time; no payloads) through to the
 * terminal one. Needs no client and no secret API token.
 *
 * ```ts
 * for await (const event of subscribeToRun({ apiUrl, runId, accessToken, refreshAccessToken })) {
 *   showProgress(event.kind, event.nodeId);
 * }
 * ```
 */
export function subscribeToRun(options: SubscribeToRunOptions): AsyncIterable<RunProgressEvent> {
  let token = options.accessToken;
  const refresh = options.refreshAccessToken;
  return followRun<RunProgressEvent>({
    url: `${options.apiUrl.replace(/\/+$/, '')}/v1/runs/${encodeURIComponent(options.runId)}/progress/stream`,
    headers: () => ({ Authorization: `Bearer ${token}` }),
    ...(refresh !== undefined && {
      onUnauthorized: async () => {
        token = await refresh();
        return true;
      },
    }),
    ...(options.fetch !== undefined && { fetchImpl: options.fetch }),
    ...(options.signal !== undefined && { signal: options.signal }),
  });
}
