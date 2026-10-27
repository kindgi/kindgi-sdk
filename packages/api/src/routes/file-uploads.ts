// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `POST /v1/file-uploads`: a pack service stores a file for one call of a
 * tool that declares `storesFiles` (pack protocol 2.10.0).
 *
 * Outside the bearer chain (mounted ahead of `/v1`), as a wait token's
 * link is: the token in `Authorization: Bearer kgi_fu_…` is the call's
 * file upload, not an API key, and `/v1`'s chain would answer it `401`.
 * It names one call of one run, stores files for that call only, and
 * reads nothing. The body is the file's bytes; `Content-Type` is the type
 * its source declares, and `Kindgi-File-Name` its name, percent-encoded
 * UTF-8. The runtime checks the bytes, and only they decide the type.
 *
 * The answers:
 *   - `200 { file }`: the stored file, a file value the tool returns in its
 *     result's top-level `files`. The same bytes again in the same call
 *     answer the first file;
 *   - `200 { notStored }`: nothing stored, and why: `type` (not a type a
 *     model is shown, or the bytes aren't the type they claim), `size`
 *     (over its type's limit; a body past {@link FILE_UPLOAD_MAX_BYTES} is
 *     not read to its end), `limit` (the call has stored its most);
 *   - `400 bad-input`: `Kindgi-File-Name` isn't percent-encoded UTF-8;
 *   - `404 file-upload-not-found`: no token, no such token, or a wrong
 *     secret, never told apart; also on a runtime that stores no files;
 *   - `409 file-upload-closed`: the call has answered, its time has passed,
 *     or its run has ended;
 *   - `409 tenant-closing`, `409 tenant-suspended` (`details.state`), `409
 *     project-suspended`: nothing runs where the run is, so nothing is
 *     stored. `503 tenant-state-unavailable` (`Retry-After`) when the
 *     tenant's state can't be read;
 *   - `429 rate-limit-exceeded` (`Retry-After`): past
 *     {@link FILE_UPLOAD_REQUESTS_PER_CLIENT_PER_MINUTE} requests from this
 *     client in a minute, counted before the body is read or the token
 *     looked up. Nothing was stored.
 *
 * The access line writes the route's path, and never a header.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';

import { FILE_LIMITS } from '@kindgi/capabilities';

import { statusFor, toWireError } from '../errors.js';
import type { FileUploadBinding, FileUploadRefusal } from '../file-upload-binding.js';
import { frozenTenantRefusal } from '../middleware/tenant-state.js';
import {
  type RateLimitStore,
  type RateLimitTake,
  createInMemoryRateLimitStore,
  nearestForwardedClient,
} from '../rate-limit-store.js';
import { readCapped } from '../read-capped.js';
import type { AppEnv } from '../types.js';

/** The most of a body that's read: the largest file a model is shown (a PDF's 10 MB). */
export const FILE_UPLOAD_MAX_BYTES = Math.max(
  FILE_LIMITS.imageBytes,
  FILE_LIMITS.documentBytes,
  FILE_LIMITS.textBytes,
);

/**
 * Requests a client may make to the upload route in a minute, counted
 * before the body is read or the token looked up; past them, `429`. As a
 * wait token's link: a guard on the work only, since the token's secret
 * is what keeps an upload from being guessed.
 */
export const FILE_UPLOAD_REQUESTS_PER_CLIENT_PER_MINUTE = 600;

const MINUTE_MS = 60_000;

export interface FileUploadsRouterOptions {
  /** Absent: every token is `404 file-upload-not-found` (this runtime stores no files). */
  readonly binding?: FileUploadBinding;
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

export function fileUploadsRouter(options: FileUploadsRouterOptions): Hono<AppEnv> {
  const clientAddress = options.clientAddress ?? nearestForwardedClient;
  const store = options.rateLimitStore ?? createInMemoryRateLimitStore();
  let lastWarnedAt: number | undefined;

  /** A take from the store; `allowed` when the store fails (logged, at most once a minute). */
  async function take(c: Context<AppEnv>, client: string): Promise<RateLimitTake> {
    try {
      return await store.take({
        key: `file-upload:${client}`,
        limit: FILE_UPLOAD_REQUESTS_PER_CLIENT_PER_MINUTE,
        windowMs: MINUTE_MS,
      });
    } catch (cause) {
      const at = Date.now();
      if (lastWarnedAt === undefined || at - lastWarnedAt >= MINUTE_MS) {
        c.get('log').warn(
          `file uploads: the rate-limit store failed, so requests aren't counted: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        lastWarnedAt = at;
      }
      return { allowed: true };
    }
  }

  const r = new Hono<AppEnv>();

  r.post('/', async (c) => {
    const client = clientAddress(c.req.raw);
    if (client !== undefined) {
      const taken = await take(c, client);
      if (!taken.allowed) {
        c.header('Retry-After', String(Math.max(Math.ceil(taken.retryAfterMs / 1000), 1)));
        return wireError(
          c,
          'rate-limit-exceeded',
          'Too many requests from this client: store the file again shortly',
        );
      }
    }
    const name = fileNameOf(c.req.header('kindgi-file-name'));
    if (name === undefined) {
      return wireError(c, 'bad-input', '`Kindgi-File-Name` is not percent-encoded UTF-8');
    }
    const token = bearerTokenOf(c.req.header('authorization'));
    if (options.binding === undefined || token === undefined) {
      return refusal(c, { code: 'file-upload-not-found' });
    }
    const stored = await options.binding.store({
      token,
      name,
      contentType: c.req.header('content-type') ?? '',
      bytes: await readCapped(c.req.raw, FILE_UPLOAD_MAX_BYTES),
    });
    if (stored.kind === 'err') return refusal(c, stored.error);
    return c.json(stored.value, 200);
  });

  return r;
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
function refusal(c: Context<AppEnv>, refused: FileUploadRefusal): Response {
  switch (refused.code) {
    // As every write of a frozen tenant is refused (`tenantStateGate`).
    case 'tenant-frozen':
      return frozenTenantRefusal(c, refused.state);
    case 'file-upload-not-found':
      return wireError(c, refused.code, 'No file upload matches this token');
    case 'file-upload-closed':
      return wireError(
        c,
        refused.code,
        'The file upload is closed: its call has answered, its time has passed, or its run has ended',
      );
    case 'project-suspended':
      return wireError(
        c,
        refused.code,
        "The run's project is suspended, so nothing runs in it and its runs are cancelled; the file wasn't stored",
      );
  }
}
