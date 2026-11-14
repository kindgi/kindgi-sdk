// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { KindgiApiError, fromWire } from './errors.js';
import { type Transport, unwrapErrorEnvelope } from './transport.js';

/** A request outside the JSON transport: a multipart body, or a streamed answer. */
export interface RawRequest {
  readonly method: 'GET' | 'HEAD' | 'POST';
  readonly path: string;
  readonly body?: FormData;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * The refusal a `404` to a `HEAD` stands for: that answer has no body to
   * read the wire error from.
   */
  readonly headNotFound?: { readonly code: string; readonly message: string };
}

/**
 * Send `req` with the transport's auth headers. A non-2xx answer throws the
 * wire error, as the transport does.
 */
export async function rawRequest(transport: Transport, req: RawRequest): Promise<Response> {
  const res = await transport.fetchImpl(`${transport.apiUrl}${req.path}`, {
    method: req.method,
    headers: { ...transport.authHeaders(), ...(req.headers ?? {}) },
    ...(req.body !== undefined && { body: req.body }),
  });
  if (!res.ok) {
    // A HEAD answer has no body: name the refusal from its status.
    const body: unknown =
      req.method === 'HEAD'
        ? {
            error:
              res.status === 404 && req.headNotFound !== undefined
                ? req.headNotFound
                : { code: 'unknown', message: `HTTP ${res.status}` },
          }
        : await res.json().catch(() => null);
    throw new KindgiApiError(fromWire(unwrapErrorEnvelope(body, res.status), res.status));
  }
  return res;
}

/** What a download's headers say about its bytes. */
export function bytesHeaders(res: Response): {
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly hash: string;
} {
  const name = res.headers.get('X-Kindgi-Blob-Name');
  return {
    name: name !== null ? decodeURIComponent(name) : '',
    contentType: res.headers.get('Content-Type') ?? 'application/octet-stream',
    size: Number(res.headers.get('Content-Length') ?? '0'),
    hash: res.headers.get('X-Kindgi-Blob-Hash') ?? '',
  };
}

/** The bytes of an upload, and the fields every upload form has. */
export interface UploadBytes {
  /** The bytes. */
  readonly body: Blob | Uint8Array | string;
  /** Default: `file`. */
  readonly name?: string;
  /** Default: the Blob's type, else `application/octet-stream`. */
  readonly contentType?: string;
  readonly tags?: Readonly<Record<string, string>>;
  /** sha256, hex, lowercase: the upload is refused when the bytes differ. */
  readonly expectedHash?: string;
}

/** The multipart form for `input`, with the route's own `fields` (an absent one isn't sent). */
export function uploadForm(
  input: UploadBytes,
  fields: Readonly<Record<string, string | undefined>> = {},
): FormData {
  const contentType =
    input.contentType ??
    (input.body instanceof Blob && input.body.type !== ''
      ? input.body.type
      : 'application/octet-stream');
  const blob =
    input.body instanceof Blob
      ? input.body
      : new Blob([input.body as ConstructorParameters<typeof Blob>[0][number]], {
          type: contentType,
        });
  const form = new FormData();
  form.set('file', blob, input.name ?? 'file');
  form.set('contentType', contentType);
  if (input.name !== undefined) form.set('name', input.name);
  if (input.tags !== undefined) form.set('tags', JSON.stringify(input.tags));
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.set(key, value);
  }
  if (input.expectedHash !== undefined) form.set('expectedHash', input.expectedHash);
  return form;
}
