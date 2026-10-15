// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The reads `kindgi exports create` makes, straight over HTTP: each answer
 * is written as the route gives it, so there's nothing for a typed client
 * to add (as `deploy/post.ts` sends its `POST` itself).
 *
 * - A `429` with a `Retry-After` is waited out and sent again, as the
 *   commands that publish do (`rate-limit-wait.ts`).
 * - A `5xx`, or no answer at all, is sent again `SERVER_ERROR_RETRIES`
 *   times, after 1s, 2s, then 4s.
 * - Anything else that isn't a `200` is a `ReadError`, with the status and
 *   the code the server named.
 */

import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { sendWaitingOutRateLimits } from '../rate-limit-wait.js';
import type { RateLimitRefusal, RateLimitWaitContext } from '../rate-limit-wait.js';

/** How many records a page asks for. */
export const PAGE_SIZE = 100;

/** How many times a `5xx`, or no answer, is sent again. */
export const SERVER_ERROR_RETRIES = 3;

/** A read the server refused, or that never got an answer (`status` absent). */
export class ReadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ReadError';
  }
}

export interface ReaderOptions extends RateLimitWaitContext {
  readonly fetch: typeof fetch;
  readonly apiUrl: string;
  readonly token: string;
  /** The pause before sending a `5xx` again. Default: a timer that Ctrl+C ends. */
  readonly pause?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type Query = Readonly<Record<string, string>>;

/** A page of a list: `{ data, nextCursor, hasMore }`. */
interface Page {
  readonly data?: unknown;
  readonly nextCursor?: unknown;
  readonly hasMore?: unknown;
}

export interface Reader {
  /** One record. */
  one(path: string, query?: Query): Promise<unknown>;
  /** A list answered whole: `{ data }`. */
  whole(path: string, query?: Query): Promise<readonly unknown[]>;
  /** A list read page by page, to its last page. */
  pages(path: string, query?: Query): AsyncGenerator<unknown>;
  /** A record's bytes. */
  bytes(path: string): Promise<Readable>;
  /** A `POST` with a JSON body; its JSON answer. */
  post(path: string, body: unknown, idempotencyKey: string): Promise<unknown>;
}

/** A route with its path parameters filled in, each one encoded. */
export function fillRoute(route: string, values: Readonly<Record<string, string>>): string {
  return route.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`${route}: no value for {${name}}`);
    return encodeURIComponent(value);
  });
}

export function createReader(options: ReaderOptions): Reader {
  const base = options.apiUrl.replace(/\/+$/, '');
  const pause = options.pause ?? pauseFor;

  const url = (path: string, query?: Query): string => {
    const search = new URLSearchParams(query ?? {}).toString();
    return `${base}${path}${search === '' ? '' : `?${search}`}`;
  };

  /** Send, waiting out rate limits and sending a `5xx` again; the answer, or what went wrong. */
  async function send(method: Method, target: string, extra: Extra = {}): Promise<Response> {
    const once = () => fetchOnce(options, method, target, extra);
    for (let retry = 0; ; retry++) {
      const answer = await sendWaitingOutRateLimits(options, once, rateLimitRefusal);
      if (!(answer instanceof Error) && answer.status < 500) return answer;
      if (retry >= SERVER_ERROR_RETRIES || options.stopSignal?.aborted === true) {
        throw await unanswered(method, target, answer);
      }
      if (!(answer instanceof Error)) await answer.body?.cancel().catch(() => undefined);
      await pause(1000 * 2 ** retry, options.stopSignal);
    }
  }

  async function json(method: Method, target: string, init?: Extra): Promise<unknown> {
    const res = await send(method, target, init);
    if (res.status !== 200) throw await refusal(method, target, res);
    try {
      return await res.json();
    } catch (err) {
      throw new ReadError(
        `${method} ${target} answered 200 with a body that isn't JSON: ${(err as Error).message}`,
        200,
      );
    }
  }

  return {
    one: (path, query) => json('GET', url(path, query)),

    async whole(path, query) {
      const target = url(path, query);
      const page = (await json('GET', target)) as Page;
      if (!Array.isArray(page.data)) {
        throw new ReadError(`GET ${target} answered no \`data\` list`, 200);
      }
      if (page.hasMore === true) {
        throw new ReadError(
          `GET ${target} says it has more, and the route takes no cursor to read it by`,
          200,
        );
      }
      return page.data;
    },

    async *pages(path, query) {
      let cursor: string | undefined;
      for (;;) {
        const target = url(path, {
          ...query,
          limit: String(PAGE_SIZE),
          ...(cursor !== undefined && { cursor }),
        });
        const page = (await json('GET', target)) as Page;
        if (!Array.isArray(page.data)) {
          throw new ReadError(`GET ${target} answered no \`data\` list`, 200);
        }
        yield* page.data;
        if (page.hasMore !== true) return;
        if (typeof page.nextCursor !== 'string' || page.nextCursor === cursor) {
          throw new ReadError(
            `GET ${target} says it has more, with no new cursor to read it by`,
            200,
          );
        }
        cursor = page.nextCursor;
      }
    },

    async bytes(path) {
      const target = url(path);
      const res = await send('GET', target);
      if (res.status !== 200) throw await refusal('GET', target, res);
      if (res.body === null) return Readable.from([]);
      return Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
    },

    post: (path, body, idempotencyKey) =>
      json('POST', url(path), {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      }),
  };
}

type Method = 'GET' | 'POST';
type Extra = { readonly body?: string; readonly headers?: Record<string, string> };

/** One send: the answer, or the error that stopped it (no answer, or Ctrl+C). */
async function fetchOnce(
  options: ReaderOptions,
  method: Method,
  target: string,
  extra: Extra,
): Promise<Response | Error> {
  try {
    return await options.fetch(target, {
      method,
      headers: { Authorization: `Bearer ${options.token}`, ...extra.headers },
      ...(extra.body !== undefined && { body: extra.body }),
      ...(options.stopSignal !== undefined && { signal: options.stopSignal }),
    });
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** The last `5xx`, or no answer, as a `ReadError`. */
async function unanswered(
  method: Method,
  target: string,
  answer: Response | Error,
): Promise<ReadError> {
  if (answer instanceof Error)
    return new ReadError(`${method} ${target} got no answer: ${answer.message}`);
  return refusal(method, target, answer);
}

/** A `429` the server says to wait out. */
function rateLimitRefusal(answer: Response | Error): RateLimitRefusal | undefined {
  if (answer instanceof Error || answer.status !== 429) return undefined;
  const after = answer.headers.get('retry-after')?.trim();
  // The server sends whole seconds.
  if (after === undefined || !/^\d+$/.test(after)) return undefined;
  return { retryAfterSeconds: Number(after) };
}

/** A refusal as a `ReadError`: the status, and the server's code and message when it sent them. */
async function refusal(method: string, target: string, res: Response): Promise<ReadError> {
  let code: string | undefined;
  let message: string | undefined;
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } } | null;
    if (typeof body?.error?.code === 'string') code = body.error.code;
    if (typeof body?.error?.message === 'string') message = body.error.message;
  } catch {
    // Not JSON: the status says it.
  }
  const said = code === undefined ? '' : ` ${code}${message === undefined ? '' : `: ${message}`}`;
  return new ReadError(`${method} ${target} answered ${res.status}${said}`, res.status, code);
}

function pauseFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
