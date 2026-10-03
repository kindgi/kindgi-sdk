// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import { Hono } from 'hono';

import type { TenantId } from '@kindgi/types';

import type { BlobMeta, BlobStorageBinding } from '@kindgi/blob-binding';
import type { AppEnv } from '../types.js';
import {
  completeMultipartUploadResultXml,
  errorXml,
  initiateMultipartUploadResultXml,
  listBucketResultXml,
  listPartsResultXml,
  parseCompleteMultipartUploadXml,
} from '../xml.js';

/**
 * AWS S3-compat wire surface (core). Mounted at `/s3` OUTSIDE
 * the `/v1/*` Bearer chain — S3 auth is SigV4, wired in the
 * `sigv4Middleware` that gates this router.
 *
 * Storage flows through the same `BlobStorageBinding` as the bespoke
 * `/v1/artifacts/*` surface — cross-surface interop is a first-class
 * guardrail.
 *
 * ## Routes in this router
 *
 *   HEAD   /:bucket                      — bucket existence probe
 *   GET    /:bucket                      — ListObjectsV2 (?list-type=2)
 *   PUT    /:bucket/*                    — put object (raw body)
 *   GET    /:bucket/*                    — get object (stream, Range)
 *   HEAD   /:bucket/*                    — head object (headers only)
 *   DELETE /:bucket/*                    — delete object (204)
 *
 * Multipart upload shares those paths, selected by query parameters:
 *
 *   POST   /:bucket/*?uploads            — InitiateMultipartUpload
 *   PUT    /:bucket/*?partNumber=&uploadId= — UploadPart
 *   GET    /:bucket/*?uploadId=          — ListParts
 *   POST   /:bucket/*?uploadId=          — CompleteMultipartUpload
 *   DELETE /:bucket/*?uploadId=          — AbortMultipartUpload
 */
export function s3Router(binding: BlobStorageBinding): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // ---------- HEAD /:bucket (bucket existence probe) ----------
  r.on('HEAD', '/:bucket', async () => {
    // Middleware has already verified the caller's credential is
    // authorized for this exact bucket, so we just 200 with empty
    // body. AWS returns 200 + no body for existing buckets.
    return new Response(null, { status: 200 });
  });

  // ---------- GET /:bucket (ListObjectsV2) ----------
  r.get('/:bucket', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const bucket = c.req.param('bucket');
    if (bucket === undefined) return xml(c, errorXml('InvalidRequest', 'bucket missing'), 400);

    // HEAD /:bucket dispatches through this handler per Hono's built-in
    // HEAD→GET translation. For a bare `HEAD` (no query params), return
    // an empty 200 body — the "bucket exists" probe. Hono strips the
    // body from the outbound Response automatically.
    if (c.req.method === 'HEAD') {
      return new Response(null, { status: 200 });
    }

    // S3 spec: ?list-type=2 is required for the v2 listing. Anything
    // else is treated as v1 which we don't implement — reject.
    const listType = c.req.query('list-type');
    if (listType !== '2') {
      return xml(
        c,
        errorXml(
          'NotImplemented',
          'Only ListObjectsV2 (?list-type=2) is supported in this deployment',
        ),
        501,
      );
    }

    const prefix = c.req.query('prefix') ?? '';
    const continuationToken = c.req.query('continuation-token');
    const maxKeysRaw = c.req.query('max-keys');
    const maxKeys = maxKeysRaw !== undefined ? Number.parseInt(maxKeysRaw, 10) : 1000;
    if (Number.isNaN(maxKeys) || maxKeys < 1) {
      return xml(c, errorXml('InvalidArgument', 'max-keys must be a positive integer'), 400);
    }

    const outcome = await binding.listByPrefix(
      tenantId,
      bucket,
      prefix,
      continuationToken,
      Math.min(maxKeys, 1000),
    );
    if (outcome.kind === 'err') {
      return xml(c, errorXml('InternalError', outcome.error.message), 500);
    }
    const body = listBucketResultXml({
      bucket,
      prefix,
      maxKeys: Math.min(maxKeys, 1000),
      isTruncated: outcome.value.isTruncated,
      ...(continuationToken !== undefined && { continuationToken }),
      ...(outcome.value.nextContinuationToken !== undefined && {
        nextContinuationToken: outcome.value.nextContinuationToken,
      }),
      contents: outcome.value.contents.map((m) => ({
        key: m.key ?? (m.blobId as unknown as string),
        lastModified: m.createdAt as unknown as string,
        etag: m.hash,
        size: m.size,
      })),
    });
    return xml(c, body, 200);
  });

  // ---------- POST /:bucket/*?uploads (InitiateMultipartUpload) ----------
  //           OR POST /:bucket/*?uploadId= (CompleteMultipartUpload)
  r.post('/:bucket/*', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const bucket = c.req.param('bucket');
    if (bucket === undefined) return xml(c, errorXml('InvalidRequest', 'bucket missing'), 400);
    const key = extractKey(c.req.path, bucket);
    if (key === null || key.length === 0) {
      return xml(c, errorXml('InvalidRequest', 'key missing'), 400);
    }

    // `?uploads` (empty value) → initiate. `?uploadId=X` → complete.
    const uploadsFlag = c.req.query('uploads');
    const uploadId = c.req.query('uploadId');

    if (uploadsFlag !== undefined) {
      const contentType = c.req.header('content-type') ?? 'application/octet-stream';
      const tagging = c.req.header('x-amz-tagging');
      const tags = tagging !== undefined ? parseTagging(tagging) : undefined;
      const outcome = await binding.initiateMultipartUpload(tenantId, bucket, key, {
        contentType,
        ...(tags !== undefined && { tags }),
      });
      if (outcome.kind === 'err') {
        return xml(c, errorXml('InternalError', outcome.error.message), 500);
      }
      return xml(
        c,
        initiateMultipartUploadResultXml({
          bucket,
          key,
          uploadId: outcome.value.uploadId,
        }),
        200,
      );
    }

    if (uploadId !== undefined) {
      const body = await c.req.raw.text();
      const parsed = parseCompleteMultipartUploadXml(body);
      if (parsed === null) {
        return xml(
          c,
          errorXml('MalformedXML', 'CompleteMultipartUpload body must contain ≥1 <Part>'),
          400,
        );
      }
      const outcome = await binding.completeMultipartUpload(
        tenantId,
        bucket,
        key,
        uploadId,
        parsed,
      );
      if (outcome.kind === 'err') {
        if (outcome.error.code === 'blob-not-found') {
          return xml(c, errorXml('NoSuchUpload', outcome.error.message), 404);
        }
        if (outcome.error.code === 'blob-hash-mismatch') {
          return xml(c, errorXml('InvalidPart', outcome.error.message), 400);
        }
        if (outcome.error.code === 'blob-storage-error') {
          return xml(c, errorXml('InvalidRequest', outcome.error.message), 400);
        }
        return xml(c, errorXml('InternalError', outcome.error.message), 500);
      }
      return xml(
        c,
        completeMultipartUploadResultXml({
          bucket,
          key,
          etag: outcome.value.hash,
          location: `/s3/${bucket}/${key}`,
        }),
        200,
      );
    }

    // POST with neither ?uploads nor ?uploadId is unsupported.
    return xml(c, errorXml('NotImplemented', 'POST requires ?uploads or ?uploadId'), 501);
  });

  // ---------- PUT /:bucket/* (put object OR UploadPart) ----------
  r.put('/:bucket/*', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const bucket = c.req.param('bucket');
    if (bucket === undefined) return xml(c, errorXml('InvalidRequest', 'bucket missing'), 400);
    const key = extractKey(c.req.path, bucket);
    if (key === null || key.length === 0) {
      return xml(c, errorXml('InvalidRequest', 'key missing'), 400);
    }

    // Multipart part upload: ?partNumber=N&uploadId=U.
    const uploadId = c.req.query('uploadId');
    const partNumberRaw = c.req.query('partNumber');
    if (uploadId !== undefined && partNumberRaw !== undefined) {
      const partNumber = Number.parseInt(partNumberRaw, 10);
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
        return xml(
          c,
          errorXml('InvalidArgument', 'partNumber must be an integer in [1, 10000]'),
          400,
        );
      }
      const partBytes = new Uint8Array(await c.req.raw.arrayBuffer());
      const md5Header = c.req.header('content-md5');
      if (md5Header !== undefined && md5Header.length > 0) {
        const computed = createHash('md5').update(partBytes).digest('base64');
        if (computed !== md5Header) {
          return xml(
            c,
            errorXml('BadDigest', 'The Content-MD5 you specified did not match what we received.'),
            400,
          );
        }
      }
      const outcome = await binding.uploadPart(
        tenantId,
        bucket,
        key,
        uploadId,
        partNumber,
        partBytes,
      );
      if (outcome.kind === 'err') {
        if (outcome.error.code === 'blob-not-found') {
          return xml(c, errorXml('NoSuchUpload', outcome.error.message), 404);
        }
        return xml(c, errorXml('InternalError', outcome.error.message), 500);
      }
      return new Response(null, {
        status: 200,
        headers: { ETag: `"${outcome.value.etag}"` },
      });
    }

    const bytes = new Uint8Array(await c.req.raw.arrayBuffer());

    // Content-MD5 verification (optional per S3 spec).
    const md5Header = c.req.header('content-md5');
    if (md5Header !== undefined && md5Header.length > 0) {
      const computed = createHash('md5').update(bytes).digest('base64');
      if (computed !== md5Header) {
        return xml(
          c,
          errorXml('BadDigest', 'The Content-MD5 you specified did not match what we received.'),
          400,
        );
      }
    }

    const contentType = c.req.header('content-type') ?? 'application/octet-stream';

    // S3 x-amz-tagging: key1=val1&key2=val2 (URL-encoded).
    const tagging = c.req.header('x-amz-tagging');
    const tags = tagging !== undefined ? parseTagging(tagging) : undefined;

    const outcome = await binding.putByKey(tenantId, bucket, key, {
      name: key,
      contentType,
      bytes,
      size: bytes.byteLength,
      ...(tags !== undefined && { tags }),
    });
    if (outcome.kind === 'err') {
      if (outcome.error.code === 'blob-hash-mismatch') {
        return xml(c, errorXml('BadDigest', 'Content hash mismatch'), 400);
      }
      return xml(c, errorXml('InternalError', outcome.error.message), 500);
    }
    return new Response(null, {
      status: 200,
      headers: {
        ETag: `"${outcome.value.hash}"`,
      },
    });
  });

  // ---------- GET /:bucket/* (get object OR ListParts, with optional Range) ----------
  r.get('/:bucket/*', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const bucket = c.req.param('bucket');
    if (bucket === undefined) return xml(c, errorXml('InvalidRequest', 'bucket missing'), 400);
    const key = extractKey(c.req.path, bucket);
    if (key === null || key.length === 0) {
      return xml(c, errorXml('InvalidRequest', 'key missing'), 400);
    }

    // Multipart ListParts: ?uploadId=<id>.
    const uploadId = c.req.query('uploadId');
    if (uploadId !== undefined) {
      const outcome = await binding.listParts(tenantId, bucket, key, uploadId);
      if (outcome.kind === 'err') {
        if (outcome.error.code === 'blob-not-found') {
          return xml(c, errorXml('NoSuchUpload', outcome.error.message), 404);
        }
        return xml(c, errorXml('InternalError', outcome.error.message), 500);
      }
      return xml(
        c,
        listPartsResultXml({
          bucket,
          key,
          uploadId,
          parts: outcome.value.parts.map((p) => ({
            partNumber: p.partNumber,
            etag: p.etag,
            size: p.size,
            lastModified: p.lastModified as unknown as string,
          })),
        }),
        200,
      );
    }

    const outcome = await binding.getByKey(tenantId, bucket, key);
    if (outcome.kind === 'err') {
      if (outcome.error.code === 'blob-not-found') {
        return xml(c, errorXml('NoSuchKey', `The specified key does not exist: ${key}`), 404);
      }
      return xml(c, errorXml('InternalError', outcome.error.message), 500);
    }
    const { meta, stream } = outcome.value;

    const rangeHeader = c.req.header('range');
    if (rangeHeader !== undefined) {
      const range = parseRange(rangeHeader, meta.size);
      if (range === null) {
        return xml(c, errorXml('InvalidRange', 'Malformed Range header'), 416);
      }
      // Buffer the stream + slice in memory. The binding has no Range
      // parameter, so the whole object is read; multi-range GET and
      // streaming Range are not supported.
      const buf = await drainStream(stream);
      const sliced = buf.subarray(range.start, range.end + 1);
      return new Response(sliced, {
        status: 206,
        headers: {
          ...objectResponseHeaders(meta),
          'Content-Length': String(sliced.byteLength),
          'Content-Range': `bytes ${range.start}-${range.end}/${meta.size}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }
    return new Response(stream, {
      status: 200,
      headers: {
        ...objectResponseHeaders(meta),
        'Accept-Ranges': 'bytes',
      },
    });
  });

  // ---------- HEAD /:bucket/* (metadata only) ----------
  r.on('HEAD', '/:bucket/*', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const bucket = c.req.param('bucket');
    if (bucket === undefined) return new Response(null, { status: 400 });
    const key = extractKey(c.req.path, bucket);
    if (key === null || key.length === 0) return new Response(null, { status: 400 });

    const meta = await binding.headByKey(tenantId, bucket, key);
    if (meta === null) {
      return new Response(null, { status: 404 });
    }
    return new Response(null, {
      status: 200,
      headers: {
        ...objectResponseHeaders(meta),
        'Accept-Ranges': 'bytes',
      },
    });
  });

  // ---------- DELETE /:bucket/* (delete object OR AbortMultipartUpload) ----------
  r.delete('/:bucket/*', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const bucket = c.req.param('bucket');
    if (bucket === undefined) return new Response(null, { status: 400 });
    const key = extractKey(c.req.path, bucket);
    if (key === null || key.length === 0) return new Response(null, { status: 400 });

    const uploadId = c.req.query('uploadId');
    if (uploadId !== undefined) {
      const outcome = await binding.abortMultipartUpload(tenantId, bucket, key, uploadId);
      if (outcome.kind === 'err') {
        // S3 spec: abort on nonexistent uploadId is 404 NoSuchUpload.
        if (outcome.error.code === 'blob-not-found') {
          return xml(c, errorXml('NoSuchUpload', outcome.error.message), 404);
        }
        return xml(c, errorXml('InternalError', outcome.error.message), 500);
      }
      return new Response(null, { status: 204 });
    }

    const outcome = await binding.deleteByKey(tenantId, bucket, key);
    if (outcome.kind === 'err') {
      return xml(c, errorXml('InternalError', outcome.error.message), 500);
    }
    // S3 semantics: 204 whether the key existed or not.
    return new Response(null, { status: 204 });
  });

  return r;
}

// -------------------- helpers --------------------

function extractKey(path: string, bucket: string): string | null {
  // path is `/s3/<bucket>/<key/with/possibly/slashes>` (or without leading `/s3`
  // when Hono strips the mount prefix inside the router — Hono keeps the full
  // path here since the router is mounted with `app.route('/s3', router)`).
  // Handle both mounted and stripped paths defensively.
  const prefixWithMount = `/s3/${bucket}/`;
  const prefixWithoutMount = `/${bucket}/`;
  if (path.startsWith(prefixWithMount))
    return decodeURIComponent(path.slice(prefixWithMount.length));
  if (path.startsWith(prefixWithoutMount))
    return decodeURIComponent(path.slice(prefixWithoutMount.length));
  return null;
}

function objectResponseHeaders(meta: BlobMeta): Record<string, string> {
  return {
    'Content-Type': meta.contentType,
    'Content-Length': String(meta.size),
    ETag: `"${meta.hash}"`,
    'Last-Modified': new Date(meta.createdAt as unknown as string).toUTCString(),
    'x-amz-meta-blob-id': meta.blobId as unknown as string,
    ...(meta.ownerRunId !== undefined && {
      'x-amz-meta-owner-run-id': meta.ownerRunId as unknown as string,
    }),
  };
}

function parseRange(header: string, size: number): { start: number; end: number } | null {
  // Only single-range `bytes=N-M` (or `bytes=N-`, `bytes=-M`). Multi-range
  // is not supported.
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (match === null) return null;
  const rawStart = match[1] as string;
  const rawEnd = match[2] as string;
  if (rawStart.length === 0 && rawEnd.length === 0) return null;

  let start: number;
  let end: number;
  if (rawStart.length === 0) {
    // Suffix range: bytes=-M → last M bytes.
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd.length === 0 ? size - 1 : Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (end >= size) end = size - 1;
  }
  if (start < 0 || end < start || start >= size) return null;
  return { start, end };
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let total = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    chunks.push(step.value);
    total += step.value.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function parseTagging(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const k = decodeURIComponent(pair.slice(0, eq));
    const v = decodeURIComponent(pair.slice(eq + 1));
    if (k.length > 0) out[k] = v;
  }
  return out;
}

function xml(c: import('hono').Context, body: string, status: number): Response {
  return c.body(body, status as never, { 'Content-Type': 'application/xml' });
}
