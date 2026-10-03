// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, Filter, Page, Timestamp } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import type { Transport } from '../transport.js';
import type {
  BlobMeta,
  BlobRef,
  GetArtifactResult,
  PresignInput,
  PresignedUrl,
  PutArtifactInput,
} from '../types.js';

/**
 * Artifacts resource — object storage via `BlobProvider`.
 *
 * Content-addressed (sha256), streaming semantics (never
 * load-in-memory), policy-checked at every operation.
 *
 * The SDK wires `list` (`GET /v1/artifacts`) + `delete`
 * (`DELETE /v1/artifacts/{blobId}`), which are JSON round-trips. The
 * API also has `POST /v1/artifacts` (multipart upload) and
 * `GET /v1/artifacts/{blobId}` (binary download), but the SDK's
 * `Transport` is JSON-only, so `put` and `get` throw `not-yet-wired`.
 *
 * `presign` and `setRetentionLock` have no API route.
 */
export interface ArtifactsClient {
  /**
   * @unwired `POST /v1/artifacts` is a multipart-form upload; the SDK
   *   transport is JSON-only, so the SDK does not call it.
   */
  put(input: PutArtifactInput): Promise<BlobRef>;

  /**
   * @unwired `GET /v1/artifacts/{blobId}` streams binary bytes; the SDK
   *   transport hydrates JSON only, so the SDK does not call it.
   */
  get(ref: BlobRef): Promise<GetArtifactResult>;

  /**
   * Paginated list of artifact metadata (`BlobMeta`, the wire's
   * artifact-metadata shape). Only `contentType` and `ownerRunId` from
   * the filter are sent.
   *
   * @wire `GET /v1/artifacts` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1artifacts/get`.
   */
  list(filter?: ArtifactFilter): Promise<Page<BlobMeta>>;

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
  readonly hasRetentionLock?: boolean;
  readonly sha256?: string;
}

interface WirePage<T> {
  readonly data: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export function makeArtifactsClient(transport: Transport): ArtifactsClient {
  return {
    async put(_input) {
      throw new KindgiApiError(
        notYetWired(
          'artifacts.put',
          'POST /v1/artifacts is a multipart-form upload; the SDK transport is JSON-only. Multipart / raw-stream body support is a planned follow-up',
        ),
      );
    },

    async get(_ref) {
      throw new KindgiApiError(
        notYetWired(
          'artifacts.get',
          'GET /v1/artifacts/{blobId} streams binary bytes; the SDK transport hydrates JSON only. Raw-stream response support is a planned follow-up',
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
        },
      });
      return {
        items: page.data,
        ...(page.nextCursor !== undefined && {
          nextCursor: page.nextCursor as unknown as Cursor,
        }),
      };
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
