// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Filter, Timestamp } from '@kindgi/types';

import { KindgiApiError, fromWire, notYetWired } from '../errors.js';
import { type ListPage, type WirePage, listPage } from '../list-page.js';
import { type Transport, unwrapErrorEnvelope } from '../transport.js';
import type {
  ArtifactHead,
  BlobMeta,
  BlobRef,
  DownloadedArtifact,
  GetArtifactResult,
  PresignInput,
  PresignedUrl,
  PutArtifactInput,
  UploadArtifactInput,
} from '../types.js';

/**
 * Artifacts resource — object storage via `BlobProvider`.
 *
 * Content-addressed (sha256), streaming semantics (never
 * load-in-memory), policy-checked at every operation.
 *
 * The SDK wires `upload` (`POST /v1/artifacts`, multipart),
 * `download` (`GET /v1/artifacts/{blobId}`, streamed bytes), `list` and
 * `delete`. Every artifact belongs to a project (its owner run's, else
 * `projectId`, else the tenant's default): reading it needs `read`
 * there, uploading and deleting `write`.
 *
 * `put` and `get` (content-addressed `BlobRef`s), `presign` and
 * `setRetentionLock` have no API route: use `upload` and `download`.
 */
export interface ArtifactsClient {
  /**
   * Upload bytes as an artifact. Over the runtime's cap (default 100 MB)
   * is `413 artifact-too-large`; no `write` on its project is `403`.
   *
   * @wire `POST /v1/artifacts` (multipart) — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1artifacts/post`.
   */
  upload(
    input: UploadArtifactInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<BlobMeta>;

  /**
   * Download an artifact's bytes, streamed. One in a project the caller
   * can't read is `404`, as if absent.
   *
   * @wire `GET /v1/artifacts/{blobId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1artifacts~1{blobId}/get`.
   */
  download(blobId: import('@kindgi/types').ArtifactId): Promise<DownloadedArtifact>;

  /**
   * An artifact's name, type, size and hash, from its headers (no bytes).
   * One in a project the caller can't read is `404`, as if absent.
   *
   * @wire `HEAD /v1/artifacts/{blobId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1artifacts~1{blobId}/head`.
   */
  head(blobId: import('@kindgi/types').ArtifactId): Promise<ArtifactHead>;

  /**
   * @unwired No API route takes a content-addressed `BlobRef`: use
   *   `upload`, which returns the artifact's `BlobMeta`.
   */
  put(input: PutArtifactInput): Promise<BlobRef>;

  /**
   * @unwired No API route takes a content-addressed `BlobRef`: use
   *   `download(blobId)`.
   */
  get(ref: BlobRef): Promise<GetArtifactResult>;

  /**
   * Paginated list of artifact metadata (`BlobMeta`, the wire's
   * artifact-metadata shape): those in projects the caller can read.
   * Only `contentType`, `ownerRunId` and `projectId` from the filter are
   * sent.
   *
   * @wire `GET /v1/artifacts` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1artifacts/get`.
   */
  list(filter?: ArtifactFilter): Promise<ListPage<BlobMeta>>;

  /**
   * Delete an artifact. First delete returns `deleted: true`; a repeat
   * against an already-gone id returns `deleted: false` (idempotent —
   * 404 only fires when the id was never known).
   *
   * @wire `DELETE /v1/artifacts/{blobId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1artifacts~1{blobId}/delete`.
   */
  delete(
    blobId: import('@kindgi/types').ArtifactId,
    options?: { readonly idempotencyKey?: string },
  ): Promise<{ readonly blobId: string; readonly deleted: boolean }>;

  /**
   * @unwired The API has no `POST /v1/artifacts/presign` route —
   *   presigned upload URLs are a per-backend concern (S3/GCS/R2
   *   native).
   */
  presign(input: PresignInput): Promise<PresignedUrl>;

  /**
   * @unwired The API has no `POST /v1/artifacts/{blobId}/retention-lock`
   *   route — retention locks are a per-backend concern (S3 Object
   *   Lock, MinIO retention).
   */
  setRetentionLock(ref: BlobRef, until: Timestamp): Promise<void>;
}

export interface ArtifactFilter extends Filter {
  readonly contentType?: string;
  readonly ownerRunId?: import('@kindgi/types').RunId;
  /** One project's artifacts. */
  readonly projectId?: string;
  readonly hasRetentionLock?: boolean;
  readonly sha256?: string;
}

/**
 * A request outside the JSON transport (a multipart body, or a streamed
 * response), with its auth headers; a non-2xx answer throws the wire
 * error, as the transport does.
 */
async function raw(
  transport: Transport,
  req: {
    readonly method: 'GET' | 'HEAD' | 'POST';
    readonly path: string;
    readonly body?: FormData;
    readonly headers?: Readonly<Record<string, string>>;
  },
): Promise<Response> {
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
            error: {
              code: res.status === 404 ? 'blob-not-found' : 'unknown',
              message:
                res.status === 404
                  ? "No such artifact, or it's in a project you can't read"
                  : `HTTP ${res.status}`,
            },
          }
        : await res.json().catch(() => null);
    throw new KindgiApiError(fromWire(unwrapErrorEnvelope(body, res.status), res.status));
  }
  return res;
}

/** What an artifact's download headers say. */
function headOf(blobId: string, res: Response): ArtifactHead {
  const name = res.headers.get('X-Kindgi-Blob-Name');
  return {
    blobId,
    name: name !== null ? decodeURIComponent(name) : '',
    contentType: res.headers.get('Content-Type') ?? 'application/octet-stream',
    size: Number(res.headers.get('Content-Length') ?? '0'),
    hash: res.headers.get('X-Kindgi-Blob-Hash') ?? '',
  };
}

function uploadForm(input: UploadArtifactInput): FormData {
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
  if (input.ownerRunId !== undefined) form.set('ownerRunId', input.ownerRunId as string);
  if (input.projectId !== undefined) form.set('projectId', input.projectId);
  if (input.expectedHash !== undefined) form.set('expectedHash', input.expectedHash);
  return form;
}

export function makeArtifactsClient(transport: Transport): ArtifactsClient {
  return {
    async upload(input, options) {
      const res = await raw(transport, {
        method: 'POST',
        path: '/v1/artifacts',
        body: uploadForm(input),
        ...(options?.idempotencyKey !== undefined && {
          headers: { 'Idempotency-Key': options.idempotencyKey },
        }),
      });
      return (await res.json()) as BlobMeta;
    },

    async download(blobId) {
      const res = await raw(transport, {
        method: 'GET',
        path: `/v1/artifacts/${encodeURIComponent(blobId as unknown as string)}`,
      });
      return {
        ...headOf(blobId as unknown as string, res),
        body: res.body ?? new Response('').body!,
      };
    },

    async head(blobId) {
      const res = await raw(transport, {
        method: 'HEAD',
        path: `/v1/artifacts/${encodeURIComponent(blobId as unknown as string)}`,
      });
      return headOf(blobId as unknown as string, res);
    },

    async put(_input) {
      throw new KindgiApiError(
        notYetWired(
          'artifacts.put',
          'no route takes a content-addressed BlobRef: use artifacts.upload, which returns the artifact metadata',
        ),
      );
    },

    async get(_ref) {
      throw new KindgiApiError(
        notYetWired(
          'artifacts.get',
          'no route takes a content-addressed BlobRef: use artifacts.download(blobId)',
        ),
      );
    },

    async list(filter) {
      const page = await transport.request<WirePage<BlobMeta>>({
        method: 'GET',
        path: '/v1/artifacts',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
          ...(filter?.ownerRunId !== undefined && {
            ownerRunId: filter.ownerRunId as unknown as string,
          }),
          ...(filter?.contentType !== undefined && { contentType: filter.contentType }),
          ...(filter?.projectId !== undefined && { projectId: filter.projectId }),
        },
      });
      return listPage(page);
    },

    async delete(blobId, options) {
      return transport.request<{ readonly blobId: string; readonly deleted: boolean }>({
        method: 'DELETE',
        path: `/v1/artifacts/${encodeURIComponent(blobId as unknown as string)}`,
        ...(options?.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
    },

    async presign(_input) {
      throw new KindgiApiError(
        notYetWired(
          'artifacts.presign',
          'no POST /v1/artifacts/presign route on the API — presigned URLs are a per-backend concern (S3/GCS/R2 native)',
        ),
      );
    },

    async setRetentionLock(_ref, _until) {
      throw new KindgiApiError(
        notYetWired(
          'artifacts.setRetentionLock',
          'no POST /v1/artifacts/{blobId}/retention-lock route on the API — retention locks are a per-backend concern (S3 Object Lock, MinIO retention)',
        ),
      );
    },
  };
}
