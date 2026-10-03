// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * SSE (Server-Sent Events) streaming primitive.
 *
 * Streaming is pull-model: a streaming resource method (for example
 * `client.runs.stream(runId)`) returns an `AsyncIterable` over SSE
 * events. No closure is passed by the client; the closure is on the
 * server. SSE serves browsers and non-bidirectional consumers
 * (universal support, simpler than WebSocket); the reader retries with
 * backoff and resumes via `Last-Event-Id`.
 *
 * Parser + resumable reader.
 *
 * Usage from a resource client:
 *   ```ts
 *   function streamRun(runId: RunId): AsyncIterable<SseEvent<RunEvent>> {
 *     const url = `${transport.apiUrl}/v1/runs/${runId}/stream`;
 *     return readSse<RunEvent>({
 *       url,
 *       headers: transport.authHeaders(),
 *       fetchImpl: transport.fetchImpl,
 *     });
 *   }
 *   ```
 *
 * The reader is disconnection-transparent: on network drop it
 * reconnects with `Last-Event-Id` set to the last-observed `id` field,
 * so the server resumes from where the caller left off. Backoff is
 * exponential capped at `maxBackoffMs`; by default it gives up after
 * 10 consecutive failed attempts (`shouldRetry`).
 */

export interface SseReadOptions {
  readonly url: string;
  /** Request headers, or a function evaluated before each connection attempt. */
  readonly headers?:
    | Readonly<Record<string, string>>
    | (() => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>);
  /** Resume after this event id (sent as `Last-Event-Id` on the first connection too). */
  readonly lastEventId?: string;
  readonly fetchImpl?: typeof fetch;
  /** Called on each reconnect attempt. Return `false` to give up. */
  readonly shouldRetry?: (attempt: number, error: unknown) => boolean;
  /** Initial backoff in ms; doubles per attempt. Default 500. */
  readonly initialBackoffMs?: number;
  /** Cap on backoff between reconnects. Default 30_000. */
  readonly maxBackoffMs?: number;
  /** AbortSignal for consumer-side cancellation. */
  readonly signal?: AbortSignal;
}

/**
 * Read an SSE stream as an async iterable of typed events.
 *
 * Yielded events include the raw event `id` when present so callers
 * can persist it for their own resume beyond the SDK's built-in
 * transparent reconnect.
 *
 * Server events are expected to have `event: <event-name>` and a JSON
 * `data:` payload; the payload is `JSON.parse`'d into `T`. Comment
 * lines (starting with `:`) and other SSE bookkeeping are dropped.
 */
export async function* readSse<T>(options: SseReadOptions): AsyncIterable<SseEvent<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const initialBackoff = options.initialBackoffMs ?? 500;
  const maxBackoff = options.maxBackoffMs ?? 30_000;
  const shouldRetry = options.shouldRetry ?? ((attempt) => attempt < 10);

  let lastEventId: string | undefined = options.lastEventId;
  let attempt = 0;

  while (!options.signal?.aborted) {
    try {
      const extra =
        typeof options.headers === 'function' ? await options.headers() : (options.headers ?? {});
      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
        ...extra,
      };
      if (lastEventId !== undefined) headers['Last-Event-Id'] = lastEventId;

      const response = await fetchImpl(options.url, {
        method: 'GET',
        headers,
        ...(options.signal ? { signal: options.signal } : {}),
      });

      if (!response.ok || response.body === null) {
        throw new SseHttpError(response.status);
      }

      attempt = 0; // Successful connection resets backoff.

      for await (const event of parseSseStream<T>(response.body)) {
        if (event.id !== undefined) lastEventId = event.id;
        yield event;
      }

      // Server closed the stream cleanly — treat as end of stream unless
      // caller wants to keep polling. Break here; if the caller wants
      // continuous reconnect, they call `readSse` again.
      return;
    } catch (err) {
      if (options.signal?.aborted) return;
      attempt += 1;
      if (!shouldRetry(attempt, err)) throw err;
      const backoff = Math.min(initialBackoff * 2 ** (attempt - 1), maxBackoff);
      await sleep(backoff, options.signal);
    }
  }
}

/** The stream request was answered with an HTTP error status. */
export class SseHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`SSE upstream returned HTTP ${status}`);
    this.name = 'SseHttpError';
    this.status = status;
  }
}

export interface SseEvent<T> {
  /** SSE `event:` field. `message` by default when the server omits it. */
  readonly event: string;
  /** JSON-parsed `data:` payload. */
  readonly data: T;
  /** SSE `id:` field, if the server set one. Used for `Last-Event-Id` resume. */
  readonly id?: string;
}

/**
 * Adapt a `readSse` iterable (frames with SSE envelope) into a bare
 * data-only iterable. Callers that don't need the SSE `event:` name or
 * `id:` field use this to expose a clean typed data stream — the SDK's
 * streaming resource methods (`runs.stream`, `evalRuns.events`,
 * `adapters.prepare`, the secrets rotation event stream) all go through
 * this shim.
 *
 * Errors from the underlying reader propagate through. Cancellation via
 * `AbortSignal` on the source options is transparent (the source
 * completes cleanly on abort — the wrapper follows).
 */
export async function* unwrapSseData<T>(source: AsyncIterable<SseEvent<T>>): AsyncIterable<T> {
  for await (const event of source) {
    yield event.data;
  }
}

/**
 * Parse a byte stream (from `Response.body`) into SSE events per the
 * spec (https://html.spec.whatwg.org/multipage/server-sent-events.html).
 *
 * The `retry: <ms>` field is ignored; reconnect timing comes from the
 * reader's own backoff settings.
 */
async function* parseSseStream<T>(body: ReadableStream<Uint8Array>): AsyncIterable<SseEvent<T>> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];
  let eventId: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
        buffer = buffer.slice(newlineIdx + 1);
        newlineIdx = buffer.indexOf('\n');

        if (line === '') {
          // Blank line = event dispatch.
          if (dataLines.length > 0) {
            const raw = dataLines.join('\n');
            try {
              const data = JSON.parse(raw) as T;
              yield { event: eventName, data, ...(eventId !== undefined ? { id: eventId } : {}) };
            } catch {
              // Malformed JSON payload — drop the event. Server bug; do
              // not throw so a bad event doesn't kill the whole stream.
            }
          }
          eventName = 'message';
          dataLines = [];
          eventId = undefined;
          continue;
        }
        if (line.startsWith(':')) continue; // comment
        const colonIdx = line.indexOf(':');
        const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
        const rawVal = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
        const val = rawVal.startsWith(' ') ? rawVal.slice(1) : rawVal;

        switch (field) {
          case 'event':
            eventName = val;
            break;
          case 'data':
            dataLines.push(val);
            break;
          case 'id':
            eventId = val;
            break;
          default:
            // Unknown field — spec says drop.
            break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * One-shot POST SSE reader. Distinct from `readSse` because:
 *   - The transport is POST with a JSON body (not GET).
 *   - No Last-Event-Id reconnect — the server semantics for
 *     `/v1/adapters/:id/prepare` don't support resume (a reconnect
 *     restarts the underlying pipeline load from scratch), so a
 *     transparent retry would silently duplicate work.
 *
 * Yields typed events until the stream ends or the caller aborts. Throws
 * on non-2xx response or a fetch failure; per-event JSON parse errors
 * are dropped (matches `parseSseStream` policy).
 */
export interface PostSseOptions {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

export async function* postSse<T>(options: PostSseOptions): AsyncIterable<SseEvent<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
    ...(options.headers ?? {}),
  };
  const response = await fetchImpl(options.url, {
    method: 'POST',
    headers,
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`SSE upstream returned HTTP ${response.status}`);
  }
  for await (const event of parseSseStream<T>(response.body)) {
    yield event;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
