// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Test-only SSE `fetch` shim — sibling of `recording-fetch.ts` for
 * streaming endpoints. Constructs `Response` objects whose `body` is a
 * `ReadableStream<Uint8Array>` yielding SSE-formatted frames.
 *
 * Every call captures the raw request (URL, method, headers) so tests
 * can pin the wire contract — `Authorization`, `Accept: text/event-stream`,
 * `Last-Event-Id` on reconnect — without any dependency on `msw`.
 *
 * @wire mirrors `packages/api/src/routes/sse.ts#formatSseFrame` — the
 *   server-side frame formatter used by `/v1/runs/{runId}/stream`.
 */

export interface RecordedSseRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

export interface SseFrameInit {
  /** SSE `id:` field — used by the reader for `Last-Event-Id` resume. */
  readonly id?: string;
  /** SSE `event:` field. Defaults to `message` (SSE spec default). */
  readonly event?: string;
  /** Payload — stringified with `JSON.stringify` before the `data:` line. */
  readonly data: unknown;
}

export interface SseFetchStub {
  readonly fetch: typeof fetch;
  readonly calls: readonly RecordedSseRequest[];
}

/**
 * Encode one SSE frame per the wire format used by the server:
 *   ```
 *   id: <id>
 *   event: <event>
 *   data: <json>
 *
 *   ```
 * (blank line terminates the frame). Multi-line data payloads get one
 * `data:` prefix per line, matching `formatSseFrame` in `sse.ts`.
 */
export function encodeSseFrame(frame: SseFrameInit): string {
  const jsonPayload = JSON.stringify(frame.data);
  const dataLines = jsonPayload
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n');
  const idLine = frame.id !== undefined ? `id: ${frame.id}\n` : '';
  const eventLine = frame.event !== undefined ? `event: ${frame.event}\n` : '';
  return `${idLine}${eventLine}${dataLines}\n\n`;
}

/**
 * Build a `ReadableStream<Uint8Array>` that yields the given chunks
 * one at a time. Each chunk should be a complete SSE frame (or several
 * frames concatenated) to exercise the reader's incremental buffer
 * handling.
 *
 * If `abortAfterChunk` is set, the stream errors out after emitting
 * that chunk index — used to simulate mid-stream network drops for
 * `Last-Event-Id` resume tests.
 */
export function sseReadableStream(
  chunks: readonly string[],
  options?: { readonly abortAfterChunk?: number },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cursor = 0;
  let errorPending = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      // If a previous pull scheduled an error (post-enqueue), fire it
      // now on the next pull so the consumer has already consumed the
      // last emitted chunk before the reader rejects.
      if (errorPending) {
        controller.error(new Error('simulated network drop'));
        return;
      }
      if (cursor >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[cursor];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunk));
      const emitted = cursor;
      cursor += 1;
      if (options?.abortAfterChunk !== undefined && emitted === options.abortAfterChunk) {
        errorPending = true;
      }
    },
  });
}

/**
 * SSE fetch stub. Each entry in `responses` becomes one connection
 * attempt: happy-path responses use `frames` to seed the body;
 * `abortAfterChunk` seeds a mid-stream drop; `status` !== 200 seeds an
 * HTTP-level failure (auth error, 404, etc).
 */
export function sseFetch(
  responses: readonly {
    readonly status?: number;
    readonly frames?: readonly SseFrameInit[];
    readonly rawChunks?: readonly string[];
    readonly abortAfterChunk?: number;
    readonly headers?: Record<string, string>;
    /** If set, the body is an error JSON envelope, not an SSE stream. */
    readonly errorBody?: string;
  }[],
): SseFetchStub {
  const calls: RecordedSseRequest[] = [];
  let cursor = 0;
  const stub: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const headers = normalizeHeaders(init?.headers);
    calls.push({ url, method, headers });

    if (cursor >= responses.length) {
      throw new Error(`No mock SSE response queued for ${method} ${url}`);
    }
    const next = responses[cursor];
    if (next === undefined) {
      throw new Error(`No mock SSE response queued for ${method} ${url}`);
    }
    cursor += 1;

    const status = next.status ?? 200;
    if (next.errorBody !== undefined) {
      return new Response(next.errorBody, {
        status,
        headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
      });
    }
    const chunks = next.rawChunks ?? (next.frames ?? []).map((frame) => encodeSseFrame(frame));
    const streamOptions =
      next.abortAfterChunk !== undefined ? { abortAfterChunk: next.abortAfterChunk } : {};
    const body = sseReadableStream(chunks, streamOptions);
    return new Response(body, {
      status,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        ...(next.headers ?? {}),
      },
    });
  };
  return { fetch: stub, calls };
}

function normalizeHeaders(input: HeadersInit | undefined): Record<string, string> {
  if (input === undefined) return {};
  const out: Record<string, string> = {};
  if (input instanceof Headers) {
    input.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(input)) {
    for (const [key, value] of input) out[key.toLowerCase()] = value;
    return out;
  }
  for (const key of Object.keys(input)) {
    out[key.toLowerCase()] = (input as Record<string, string>)[key] as string;
  }
  return out;
}
