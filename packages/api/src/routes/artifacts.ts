// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import type { ArtifactId, Cursor, RunId, TenantId } from '@kindgi/types';

import type { BlobFilter, BlobMeta, BlobPutInput, BlobStorageBinding } from '@kindgi/blob-binding';
import { statusFor, toWireError } from '../errors.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';

/**
 * Artifacts resource routes over the caller-plugged, tenant-scoped
 * `BlobStorageBinding` (from `@kindgi/blob-binding`). Five routes:
 * multipart upload (POST) / streaming GET / HEAD / LIST / DELETE.
 *
 * Storage implementations (filesystem-backed for dev + tests, object
 * stores in production) plug in through the binding.
 *
 * Multipart is the ONLY upload wire format. JSON-body base64 would blow
 * up memory on large blobs. Presigned upload URLs and chunked /
 * resumable uploads are not supported.
 *
 * Scope filtering — indirect. Artifacts do NOT accept the
 * `?scopeKind + ?scopeId + ?inherit` triplet that content-scoped
 * resources accept. A blob carries its owning run (`ownerRunId`), and
 * that run's project is the authoritative scope anchor, so scope
 * filtering goes through runs rather than a field on the blob metadata.
 * Callers who want scope-narrowed artifacts should first list runs at
 * the desired scope, then list artifacts by `?ownerRunId=`.
 */
export function artifactsRouter(binding: BlobStorageBinding): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // ---------- GET / (list, cursor-paginated metadata) ----------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const filter = decodeListFilter(new URL(c.req.url).searchParams);
    if (filter.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: filter.message }, requestId));
    }
    const cursorRaw = c.req.query('cursor');

    const page = await binding.list(
      tenantId,
      filter.value,
      cursorRaw !== undefined && cursorRaw.length > 0 ? (cursorRaw as Cursor) : undefined,
      limit,
    );
    if (page.kind === 'err') {
      c.status(statusFor(page.error.code) as never);
      return c.json(toWireError(page.error as never, requestId));
    }
    return c.json({
      data: page.value.data.map(serializeMeta),
      hasMore: page.value.nextCursor !== undefined,
      ...(page.value.nextCursor !== undefined && {
        nextCursor: page.value.nextCursor as unknown as string,
      }),
    });
  });

  // ---------- POST / (multipart upload) ----------
  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    const contentType = c.req.header('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: 'POST /v1/artifacts requires `multipart/form-data`',
          },
          requestId,
        ),
      );
    }

    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Malformed multipart body' }, requestId),
      );
    }

    const validated = validateMultipart(form);
    if (validated.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: validated.message }, requestId));
    }
    const input = validated.value;

    const outcome = await binding.put(tenantId, input);
    if (outcome.kind === 'err') {
      c.status(statusFor(outcome.error.code) as never);
      return c.json(toWireError(outcome.error as never, requestId));
    }
    c.status(201);
    return c.json(serializeMeta(outcome.value));
  });

  // ---------- GET /:blobId (stream download) ----------
  r.get('/:blobId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const blobId = c.req.param('blobId') as ArtifactId;

    const outcome = await binding.get(tenantId, blobId);
    if (outcome.kind === 'err') {
      c.status(statusFor(outcome.error.code) as never);
      return c.json(toWireError(outcome.error as never, requestId));
    }
    const { meta, stream } = outcome.value;
    return new Response(stream, {
      status: 200,
      headers: downloadHeaders(meta, requestId),
    });
  });

  // ---------- HEAD /:blobId (metadata-only) ----------
  r.on('HEAD', '/:blobId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const blobId = c.req.param('blobId') as ArtifactId;

    const meta = await binding.head(tenantId, blobId);
    if (meta === null) {
      return new Response(null, {
        status: 404,
        headers: { 'X-Request-Id': requestId },
      });
    }
    return new Response(null, {
      status: 200,
      headers: downloadHeaders(meta, requestId),
    });
  });

  // ---------- DELETE /:blobId ----------
  r.delete('/:blobId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const blobId = c.req.param('blobId') as ArtifactId;

    const outcome = await binding.delete(tenantId, blobId);
    if (outcome.kind === 'err') {
      c.status(statusFor(outcome.error.code) as never);
      return c.json(toWireError(outcome.error as never, requestId));
    }
    return c.json({
      blobId: blobId as unknown as string,
      deleted: outcome.value.deleted,
    });
  });

  return r;
}

// -------------------- serialization --------------------

function serializeMeta(m: BlobMeta): Record<string, unknown> {
  return {
    blobId: m.blobId as unknown as string,
    tenantId: m.tenantId as unknown as string,
    name: m.name,
    contentType: m.contentType,
    size: m.size,
    hash: m.hash,
    tags: m.tags,
    ...(m.ownerRunId !== undefined && { ownerRunId: m.ownerRunId as unknown as string }),
    createdAt: m.createdAt as unknown as string,
    ...(m.bucket !== undefined && { bucket: m.bucket }),
    ...(m.key !== undefined && { key: m.key }),
  };
}

function downloadHeaders(meta: BlobMeta, requestId: string): Record<string, string> {
  return {
    'Content-Type': meta.contentType,
    'Content-Length': String(meta.size),
    'X-Kindgi-Blob-Hash': meta.hash,
    'X-Kindgi-Blob-Name': encodeURIComponent(meta.name),
    'X-Request-Id': requestId,
  };
}

// -------------------- request parsing --------------------

type ValidationResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'err'; readonly message: string };

/**
 * Parse the multipart form into a `BlobPutInput`. `file` is required —
 * every other field is optional metadata. `tags` is a JSON-encoded
 * object; `ownerRunId` is a plain string; `expectedHash` is
 * `sha256`-hex; `contentType` overrides the file part's own MIME.
 * `name` defaults to the file part's filename.
 */
function validateMultipart(form: FormData): ValidationResult<BlobPutInput> {
  const file = form.get('file');
  if (file === null) {
    return { kind: 'err', message: 'Multipart form must include a `file` part' };
  }
  if (typeof file === 'string') {
    return { kind: 'err', message: '`file` part must be a file, not a string field' };
  }

  const nameField = form.get('name');
  const name =
    typeof nameField === 'string' && nameField.length > 0
      ? nameField
      : file.name !== undefined && file.name.length > 0
        ? file.name
        : 'unnamed';

  const contentTypeField = form.get('contentType');
  const contentType =
    typeof contentTypeField === 'string' && contentTypeField.length > 0
      ? contentTypeField
      : file.type.length > 0
        ? file.type
        : 'application/octet-stream';

  let tags: Record<string, string> | undefined;
  const tagsField = form.get('tags');
  if (typeof tagsField === 'string' && tagsField.length > 0) {
    try {
      const parsed = JSON.parse(tagsField) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { kind: 'err', message: 'Field `tags` must be a JSON object' };
      }
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          return { kind: 'err', message: `Field \`tags["${k}"]\` must be a string` };
        }
        flat[k] = v;
      }
      tags = flat;
    } catch {
      return { kind: 'err', message: 'Field `tags` must be valid JSON' };
    }
  }

  let ownerRunId: RunId | undefined;
  const ownerField = form.get('ownerRunId');
  if (typeof ownerField === 'string' && ownerField.length > 0) {
    ownerRunId = ownerField as RunId;
  }

  let expectedHash: string | undefined;
  const hashField = form.get('expectedHash');
  if (typeof hashField === 'string' && hashField.length > 0) {
    if (!/^[0-9a-f]{64}$/.test(hashField)) {
      return {
        kind: 'err',
        message: 'Field `expectedHash` must be sha256, hex-encoded, lowercase (64 chars)',
      };
    }
    expectedHash = hashField;
  }

  return {
    kind: 'ok',
    value: {
      name,
      contentType,
      bytes: file.stream(),
      size: file.size,
      ...(tags !== undefined && { tags }),
      ...(ownerRunId !== undefined && { ownerRunId }),
      ...(expectedHash !== undefined && { expectedHash }),
    },
  };
}

function decodeListFilter(params: URLSearchParams): ValidationResult<BlobFilter> {
  const filter: {
    ownerRunId?: RunId;
    contentType?: string;
    tags?: Record<string, string>;
  } = {};
  const rawTags: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (value.length === 0) continue;
    if (key === 'ownerRunId') {
      filter.ownerRunId = value as RunId;
      continue;
    }
    if (key === 'contentType') {
      filter.contentType = value;
      continue;
    }
    if (key.startsWith('tag.')) {
      const tagKey = key.slice('tag.'.length);
      if (tagKey.length === 0) {
        return { kind: 'err', message: 'Empty `tag.` filter key' };
      }
      rawTags[tagKey] = value;
    }
    // Ignore unrelated keys (limit, cursor, etc.).
  }
  if (Object.keys(rawTags).length > 0) filter.tags = rawTags;
  return { kind: 'ok', value: filter };
}
