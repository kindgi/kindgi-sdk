// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/v1/tool-files`: a pack service stores and reads files for one call of
 * a tool that declares `storesFiles` or `readsFiles` (pack protocol
 * 2.10.0).
 *
 * Outside the bearer chain (mounted ahead of `/v1`), as a wait token's
 * link is: the token in `Authorization: Bearer kgi_tf_…` is the call's
 * tool files, not an API key, and `/v1`'s chain would answer it `401`. It
 * names one call of one run and what it may do: store files for that call,
 * read files its run may be shown, or both.
 *
 * `POST /v1/tool-files` stores one. The body is the file's bytes;
 * `Content-Type` is the type its source declares, and `Kindgi-File-Name`
 * its name, percent-encoded UTF-8. The runtime checks the bytes, and only
 * they decide the type. It answers:
 *   - `200 { file }`: the stored file, a file value the tool returns in its
 *     result's top-level `files`. The same bytes again in the same call
 *     answer the first file;
 *   - `200 { notStored }`: nothing stored, and why: `type` (not a type a
 *     model is shown, or the bytes aren't the type they claim), `size`
 *     (over its type's limit; a body past {@link TOOL_FILE_MAX_BYTES} is
 *     not read to its end), `limit` (the call has stored its most),
 *     `storage` (the tenant's storage is full);
 *   - `400 bad-input`: `Kindgi-File-Name` isn't percent-encoded UTF-8;
 *   - `409 tenant-closing`, `409 tenant-suspended` (`details.state`), `409
 *     project-suspended`: nothing runs where the run is, so nothing is
 *     stored. `503 tenant-state-unavailable` (`Retry-After`) when the
 *     tenant's state can't be read.
 *
 * `GET /v1/tool-files/{artifactId}` reads one, by its file value's
 * `artifactId`. It answers:
 *   - `200` with the bytes it was stored with (`application/octet-stream`,
 *     as an attachment, never sniffed);
 *   - `200 { notRead }` as JSON: no bytes, and why: `rule` (no file of that
 *     id the run may be shown), `gone` (deleted, or its bytes are
 *     missing), `changed` (not the bytes that were checked), `size` (over
 *     its type's limit).
 *
 * Both answer:
 *   - `404 tool-file-token-not-found`: no token, no such token, a wrong
 *     secret, or a call that may not do this, never told apart; also on a
 *     runtime that stores no files;
 *   - `409 tool-file-token-closed`: the call has answered, its time has
 *     passed, or its run has ended;
 *   - `503 tool-files-busy` (`Retry-After`): the runtime's memory for
 *     files has no room for the bytes now. Nothing was stored or read;
 *   - `429 rate-limit-exceeded` (`Retry-After`): past
 *     {@link TOOL_FILES_REQUESTS_PER_CLIENT_PER_MINUTE} requests from this
 *     client in a minute, both kinds counted together, before the body is
 *     read or the token looked up. Nothing was stored or read.
 *
 * The access line writes the route's path, and never a header.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';

import { MAX_STORED_FILE_BYTES } from '@kindgi/tools';

import { statusFor, toWireError } from '../errors.js';
import { frozenTenantRefusal } from '../middleware/tenant-state.js';
import {
  type RateLimitStore,
  type RateLimitTake,
  createInMemoryRateLimitStore,
  nearestForwardedClient,
} from '../rate-limit-store.js';
import { readCapped } from '../read-capped.js';
import type { ToolFilesBinding, ToolFilesRefusal } from '../tool-files-binding.js';
import type { AppEnv } from '../types.js';

/**
 * The most of a body that's read: the largest file a model is shown (a
 * PDF's 10 MB). A pack's store of more never sends it.
 */
export const TOOL_FILE_MAX_BYTES = MAX_STORED_FILE_BYTES;

/**
 * Requests a client may make to the tool files routes in a minute, stores
 * and reads together, counted before the body is read or the token looked
 * up; past them, `429`. As a wait token's link: a guard on the work only,
 * since the token's secret is what keeps a call's files from being reached.
 */
export const TOOL_FILES_REQUESTS_PER_CLIENT_PER_MINUTE = 600;

/** The `Retry-After` of a `503 tool-files-busy`, in seconds. */
export const TOOL_FILES_BUSY_RETRY_AFTER_SECONDS = 5;

const MINUTE_MS = 60_000;

export interface ToolFilesRouterOptions {
  /** Absent: every token is `404 tool-file-token-not-found` (this runtime stores no files). */
  readonly binding?: ToolFilesBinding;
  /**
   * Who the client is, the key of the per-client limit; `undefined` when
   * clients can't be told apart, which turns the limit off. Default: the
   * nearest `X-Forwarded-For` hop, else one shared bucket.
   */
  readonly clientAddress?: (request: Request) => string | undefined;
  /**
   * Where the counts live. Default: this process's memory, so each
   * instance counts on its own. If it fails, the request is let through
   * (the limit is a speed bump, not a lock) and the failure logged, at
   * most once a minute.
   */
  readonly rateLimitStore?: RateLimitStore;
}

export function toolFilesRouter(options: ToolFilesRouterOptions): Hono<AppEnv> {
  const clientAddress = options.clientAddress ?? nearestForwardedClient;
  const store = options.rateLimitStore ?? createInMemoryRateLimitStore();
  let lastWarnedAt: number | undefined;

  /** A take from the store; `allowed` when the store fails (logged, at most once a minute). */
  async function take(c: Context<AppEnv>, client: string): Promise<RateLimitTake> {
    try {
      return await store.take({
        key: `tool-files:${client}`,
        limit: TOOL_FILES_REQUESTS_PER_CLIENT_PER_MINUTE,
        windowMs: MINUTE_MS,
      });
    } catch (cause) {
      const at = Date.now();
      if (lastWarnedAt === undefined || at - lastWarnedAt >= MINUTE_MS) {
        c.get('log').warn(
          `tool files: the rate-limit store failed, so requests aren't counted: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        lastWarnedAt = at;
      }
      return { allowed: true };
    }
  }

  /** `429` past the client's requests this minute; `undefined` to go on. */
  async function limited(c: Context<AppEnv>): Promise<Response | undefined> {
    const client = clientAddress(c.req.raw);
    if (client === undefined) return undefined;
    const taken = await take(c, client);
    if (taken.allowed) return undefined;
    c.header('Retry-After', String(Math.max(Math.ceil(taken.retryAfterMs / 1000), 1)));
    return wireError(
      c,
      'rate-limit-exceeded',
      'Too many requests from this client: try again shortly',
    );
  }

  const r = new Hono<AppEnv>();

  r.post('/', async (c) => {
    const tooMany = await limited(c);
    if (tooMany !== undefined) return tooMany;
    const name = fileNameOf(c.req.header('kindgi-file-name'));
    if (name === undefined) {
      return wireError(c, 'bad-input', '`Kindgi-File-Name` is not percent-encoded UTF-8');
    }
    const token = bearerTokenOf(c.req.header('authorization'));
    if (options.binding === undefined || token === undefined) {
      return refusal(c, { code: 'tool-file-token-not-found' });
    }
    const declaredBytes = lengthOf(c.req.header('content-length'));
    const stored = await options.binding.store({
      token,
      name,
      contentType: c.req.header('content-type') ?? '',
      ...(declaredBytes !== undefined && { declaredBytes }),
      body: (maxBytes) => readCapped(c.req.raw, Math.min(maxBytes, TOOL_FILE_MAX_BYTES)),
    });
    if (stored.kind === 'err') return refusal(c, stored.error);
    return c.json(stored.value, 200);
  });

  r.get('/:artifactId', async (c) => {
    const tooMany = await limited(c);
    if (tooMany !== undefined) return tooMany;
    const token = bearerTokenOf(c.req.header('authorization'));
    if (options.binding === undefined || token === undefined) {
      return refusal(c, { code: 'tool-file-token-not-found' });
    }
    const read = await options.binding.read({ token, artifactId: c.req.param('artifactId') });
    if (read.kind === 'err') return refusal(c, read.error);
    if ('notRead' in read.value) return c.json(read.value, 200);
    return c.body(sentInSlices(read.value.bytes, read.value.release), 200, {
      'content-type': 'application/octet-stream',
      'content-length': String(read.value.bytes.byteLength),
      'content-disposition': 'attachment',
      'x-content-type-options': 'nosniff',
    });
  });

  return r;
}

/** The most bytes the response takes at once: a view of the bytes, never a copy. */
const SLICE_BYTES = 64 * 1024;

/**
 * The bytes as a body the response takes a slice at a time, as fast as the
 * client reads. Their room (`release`) is held until the response has taken
 * the last slice, so bytes waiting on a slow client still count, and given
 * back then, or once the client goes away first.
 */
function sentInSlices(
  bytes: Uint8Array,
  release: (() => void) | undefined,
): ReadableStream<Uint8Array> {
  let sent = 0;
  let released = false;
  const done = () => {
    if (released) return;
    released = true;
    release?.();
  };
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === bytes.byteLength) {
        controller.close();
        done();
        return;
      }
      const end = Math.min(sent + SLICE_BYTES, bytes.byteLength);
      controller.enqueue(bytes.subarray(sent, end));
      sent = end;
    },
    cancel: done,
  });
}

/** `Content-Length` as a whole number of bytes; `undefined` when it's absent or isn't one. */
function lengthOf(header: string | undefined): number | undefined {
  if (header === undefined || !/^[0-9]+$/.test(header)) return undefined;
  const bytes = Number(header);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

/** The token after `Bearer ` (the scheme in any case); `undefined` when there's none. */
function bearerTokenOf(header: string | undefined): string | undefined {
  const match = /^bearer +(\S+) *$/i.exec(header ?? '');
  return match?.[1];
}

/** The decoded name: empty when there's none, `undefined` when it doesn't decode. */
function fileNameOf(header: string | undefined): string | undefined {
  try {
    return decodeURIComponent(header ?? '');
  } catch {
    return undefined;
  }
}

function wireError(c: Context<AppEnv>, code: string, message: string): Response {
  c.status(statusFor(code) as never);
  return c.json(toWireError({ code, message }, c.get('requestId')));
}

/** A refusal on the wire; the messages never echo the token. */
function refusal(c: Context<AppEnv>, refused: ToolFilesRefusal): Response {
  switch (refused.code) {
    // As every write of a frozen tenant is refused (`tenantStateGate`).
    case 'tenant-frozen':
      return frozenTenantRefusal(c, refused.state);
    case 'tool-file-token-not-found':
      return wireError(c, refused.code, "No tool call's files match this token");
    case 'tool-file-token-closed':
      return wireError(
        c,
        refused.code,
        "The tool call's files are closed: its call has answered, its time has passed, or its run has ended",
      );
    case 'tool-files-busy':
      c.header('Retry-After', String(TOOL_FILES_BUSY_RETRY_AFTER_SECONDS));
      return wireError(
        c,
        refused.code,
        "The runtime has no room for the file's bytes now: nothing was stored or read; try again shortly",
      );
    case 'project-suspended':
      return wireError(
        c,
        refused.code,
        "The run's project is suspended, so nothing runs in it and its runs are cancelled; the file wasn't stored",
      );
  }
}
