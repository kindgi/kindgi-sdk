// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Scope } from '@kindgi/platform';
import type {
  ArtifactId,
  Cursor,
  ProjectId,
  Result,
  RunId,
  TenantId,
  Timestamp,
} from '@kindgi/types';

/**
 * Caller-plugged surface for artifact (blob) storage. Same pattern as
 * `AgentRegistryBinding` / `MemoryBinding` / `ReviewerRegistryBinding`
 * — the API package does NOT own storage. Deployments plug in a
 * binding implementation: typically a filesystem-backed one for
 * development and tests, and an object-store-backed one in production.
 *
 * Every method is workspace-scoped: callers pass `tenantId` explicitly so
 * multi-tenant deployments can partition storage without exposing the
 * scoping inside the API package. Cursors are opaque — the binding
 * chooses its encoding.
 *
 * ## Two lookup surfaces, one storage
 *
 * Kindgi artifacts have two wire faces: the bespoke
 * `/v1/artifacts/*` surface identifies blobs by `blobId` (UUID minted
 * server-side), while the S3-compat `/s3/*` surface identifies them by
 * `(bucket, key)` tuple. Adapters MUST unify these — every blob has
 * both a `blobId` AND a `(bucket, key)` address, stored in a single
 * meta record. This binding exposes both lookup shapes; adapters
 * choose their own on-disk / on-storage layout so long as
 * `head(blobId)` and `headByKey(bucket, key)` return the same
 * `BlobMeta` for a given blob.
 *
 * Bespoke uploads via `put(...)` MUST allocate a synthetic
 * `(bucket, key)` — conventionally
 * `bucket: 'artifacts', key: <blobId>`, so bespoke uploads are
 * visible to any S3 credential granted access to the `artifacts`
 * bucket (cross-surface interop).
 *
 * ## Hash contract
 *
 * `BlobMeta.hash` is `sha256`, hex-encoded, lowercase. Bindings MUST
 * compute it at boundary from the exact byte stream persisted. Callers
 * MAY assert an expected hash on `BlobPutInput.expectedHash`; when
 * present, the binding compares against the computed hash and returns
 * `blob-hash-mismatch` on divergence (dedup + integrity check in one).
 *
 * ## Delete semantics
 *
 * `delete` is soft-delete at the binding level — the contract only
 * requires idempotence: a second delete returns
 * `{ deleted: false }` (already gone), a first delete returns
 * `{ deleted: true }`. Implementations MAY keep tombstones with
 * retention; a development implementation may remove the data
 * outright.
 */
/** What a tenant's files take (`BlobStorageBinding.storageUsed`). */
export interface BlobStorageUsed {
  /** Bytes, with the uploads under way. It may be past the limit. */
  readonly usedBytes: number;
}

export interface BlobStorageBinding {
  // -------------- bespoke (blobId-addressed) surface --------------

  /**
   * Store bytes for the bespoke `/v1/artifacts` surface. Adapter
   * allocates the `blobId` and a synthetic `(bucket, key)`
   * (conventionally `bucket: 'artifacts', key: <blobId>`) so the object
   * is also reachable via the S3-compat surface. Route validates the
   * multipart body before calling.
   */
  put(tenantId: TenantId, input: BlobPutInput): Promise<Result<BlobMeta, BlobError>>;
  /**
   * Fetch bytes + metadata for download by `blobId`. Body is a
   * `ReadableStream` so large blobs stream without buffering. Returns
   * `blob-not-found` when the id is unknown to this workspace.
   */
  get(tenantId: TenantId, blobId: ArtifactId): Promise<Result<BlobRead, BlobError>>;
  /**
   * Metadata-only lookup by `blobId` — no body. Returns `null` when
   * unknown. The route surfaces `null` as `404 blob-not-found`.
   */
  head(tenantId: TenantId, blobId: ArtifactId): Promise<BlobMeta | null>;
  /**
   * Cursor-paginated metadata list. Filters compose as AND. Sort is
   * binding-defined (for example `createdAt desc, blobId desc`).
   */
  list(
    tenantId: TenantId,
    filter: BlobFilter,
    cursor?: Cursor,
    limit?: number,
  ): Promise<Result<BlobListPage, BlobError>>;
  /**
   * Idempotent soft-delete by `blobId`. Returns `{ deleted: true }` on
   * the first call, `{ deleted: false }` on subsequent calls (already
   * gone). The route surfaces both as `200` per API convention; only
   * structural failures (permission, backing store error) become
   * non-`200`.
   */
  delete(tenantId: TenantId, blobId: ArtifactId): Promise<Result<BlobDeleteOutcome, BlobError>>;
  /**
   * Optional. What the tenant's files take now, with the uploads under
   * way: the number its storage limit is checked against. `GET /v1/tenant`
   * answers it as `storage`. A store that doesn't count leaves it out.
   */
  storageUsed?(tenantId: TenantId): Promise<BlobStorageUsed>;

  // -------------- S3-compat (bucket/key-addressed) surface --------------

  /**
   * Store bytes under an explicit `(bucket, key)` — the S3-compat
   * `PUT /s3/:bucket/*` route. Adapter still allocates a `blobId`
   * internally so the bespoke surface can address the same object.
   * The route verifies the caller's `Content-MD5` (when supplied)
   * BEFORE calling — the binding is not responsible for MD5
   * verification. If the key already exists, the write overwrites
   * silently (S3 semantics without versioning — last write wins).
   */
  putByKey(
    tenantId: TenantId,
    bucket: string,
    key: string,
    input: BlobPutInput,
  ): Promise<Result<BlobMeta, BlobError>>;
  /**
   * Fetch bytes + metadata by `(bucket, key)`. Same shape as `get`
   * but with the S3-native address. Returns `blob-not-found` when the
   * key is unknown under the bucket.
   */
  getByKey(tenantId: TenantId, bucket: string, key: string): Promise<Result<BlobRead, BlobError>>;
  /**
   * Metadata-only lookup by `(bucket, key)`. `null` on unknown. The
   * route surfaces `null` as S3 `NoSuchKey` (HTTP 404).
   */
  headByKey(tenantId: TenantId, bucket: string, key: string): Promise<BlobMeta | null>;
  /**
   * Idempotent soft-delete by `(bucket, key)`. S3 semantics: 204 on
   * success either way — S3 does not distinguish "was there" vs. "was
   * not." `{ deleted: false }` when the key was already gone; `true`
   * otherwise. Route always responds 204 regardless.
   */
  deleteByKey(
    tenantId: TenantId,
    bucket: string,
    key: string,
  ): Promise<Result<BlobDeleteOutcome, BlobError>>;
  /**
   * S3-style prefix + delimiter list under a bucket. `continuationToken`
   * is the opaque S3 pagination marker (adapter-defined encoding);
   * `maxKeys` bounds the page size (1..1000, default 1000). Returns
   * matching blob metadata + `isTruncated` + optional
   * `nextContinuationToken`. Sort order MUST be lexicographic on `key`
   * ascending (S3 spec).
   */
  listByPrefix(
    tenantId: TenantId,
    bucket: string,
    prefix: string,
    continuationToken?: string,
    maxKeys?: number,
  ): Promise<Result<S3ListPage, BlobError>>;

  // -------------- S3-compat multipart upload surface --------------

  /**
   * Initiate a multipart upload. Returns an opaque `uploadId` that
   * subsequent `uploadPart` / `completeMultipartUpload` /
   * `abortMultipartUpload` calls use. `contentType` + `tags` are
   * pinned at initiate time (S3 semantics — the client sends them on
   * `POST ?uploads` and they apply to the finalized object).
   */
  initiateMultipartUpload(
    tenantId: TenantId,
    bucket: string,
    key: string,
    input: MultipartInitiateInput,
  ): Promise<Result<{ uploadId: string }, BlobError>>;
  /**
   * Upload a single part (bytes). Returns the part's ETag
   * (`md5(part_bytes)`, hex, un-quoted — the route wraps in quotes
   * per S3 wire spec). `partNumber` is 1..10,000. When a part number is
   * uploaded again, adapters MAY either replace the earlier part (last
   * write wins, as in S3) or reject the upload.
   */
  uploadPart(
    tenantId: TenantId,
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<Result<{ etag: string }, BlobError>>;
  /**
   * Atomically assemble the declared parts into the final object.
   * `parts` MUST be in ascending `partNumber` order (S3 spec). The
   * adapter verifies each part's declared ETag matches its stored
   * ETag, concatenates the parts in order, writes the final blob
   * (`putByKey`-equivalent), and cleans the staging area. Returns
   * the finalized `BlobMeta`; the S3 wire spec's `ETag` for a
   * multipart object is `md5(concat(md5(part_i)))-<N>` — the adapter
   * writes this into `BlobMeta.hash` too (deviates from the
   * single-shot `sha256` semantic — the S3 spec's ETag is the only
   * stable value clients rely on for multipart).
   */
  completeMultipartUpload(
    tenantId: TenantId,
    bucket: string,
    key: string,
    uploadId: string,
    parts: readonly { readonly partNumber: number; readonly etag: string }[],
  ): Promise<Result<BlobMeta, BlobError>>;
  /**
   * Discard all staged parts + metadata for an in-progress upload.
   * Returns `blob-not-found` when the `uploadId` is unknown — including
   * one that was already aborted — which the S3-compat route answers
   * with `404 NoSuchUpload`.
   */
  abortMultipartUpload(
    tenantId: TenantId,
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<Result<void, BlobError>>;
  /**
   * Read the parts staged so far for a given uploadId. Sorted by
   * `partNumber` ascending. Returns `blob-not-found` when the
   * uploadId is unknown.
   */
  listParts(
    tenantId: TenantId,
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<Result<MultipartListPartsPage, BlobError>>;
}

export interface MultipartInitiateInput {
  readonly contentType: string;
  readonly tags?: Readonly<Record<string, string>>;
  readonly ownerRunId?: RunId;
}

export interface MultipartListPartsPage {
  readonly parts: readonly {
    readonly partNumber: number;
    readonly etag: string;
    readonly size: number;
    readonly lastModified: Timestamp;
  }[];
}

export interface BlobPutInput {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: ReadableStream<Uint8Array> | Uint8Array;
  /** If known ahead of streaming. Bindings MAY reject when the actual byte count diverges. */
  readonly size?: number;
  readonly tags?: Readonly<Record<string, string>>;
  /** Optional back-ref to the run that produced this blob. Filter target on `list`. */
  readonly ownerRunId?: RunId;
  /**
   * The project the blob belongs to, which decides who may read and
   * delete it. The API resolves it before calling `put`: the owner run's
   * project, else the upload's `projectId`, the caller key's project, or
   * the workspace's default project. Bindings store it and return it on
   * `BlobMeta`.
   */
  readonly projectId?: ProjectId;
  /** Who uploaded it: `user:<id>` or `service_account:<id>`. */
  readonly createdBy?: string;
  /**
   * Caller-computed hash for dedup + integrity. `sha256`, hex-encoded,
   * lowercase. When set, bindings MUST reject on mismatch with
   * `blob-hash-mismatch`; when omitted, the binding computes and returns
   * the hash in `BlobMeta.hash`.
   */
  readonly expectedHash?: string;
  /**
   * Uploaded for a run that hasn't started yet. The blob is deleted once
   * the deployment's unused-upload time has passed (24 hours by default),
   * unless a run that names it in its input has started by then. From
   * that start on, it stays until it's deleted, as any other blob.
   * Bindings store its `expiresAt` and return it on `BlobMeta`. The API
   * sets it on every upload by someone who may run but not write.
   */
  readonly forRun?: boolean;
}

export interface BlobMeta {
  readonly blobId: ArtifactId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  /** `sha256`, hex-encoded, lowercase. */
  readonly hash: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly ownerRunId?: RunId;
  /** The project it belongs to. Absent on blobs stored before projects were recorded. */
  readonly projectId?: ProjectId;
  /** Who uploaded it: `user:<id>` or `service_account:<id>`. */
  readonly createdBy?: string;
  readonly createdAt: Timestamp;
  /**
   * When an upload made for a run (`BlobPutInput.forRun`) is deleted if
   * no run that names it has started. Absent once such a run has started,
   * and on every other blob.
   */
  readonly expiresAt?: Timestamp;
  /**
   * S3-compat address. Every persisted blob carries a `(bucket, key)`
   * pair — bespoke uploads default to `bucket: 'artifacts', key:
   * <blobId>` so they're visible via the S3-compat surface too. When
   * absent, the S3-compat surface treats the blob as unaddressable via
   * S3 (still reachable via bespoke `blobId`).
   */
  readonly bucket?: string;
  readonly key?: string;
}

export interface BlobRead {
  readonly meta: BlobMeta;
  readonly stream: ReadableStream<Uint8Array>;
}

export interface BlobFilter {
  readonly ownerRunId?: RunId;
  readonly contentType?: string;
  /** Every entry matches as `tags[key] === value`. All must match. */
  readonly tags?: Readonly<Record<string, string>>;
  /**
   * Narrow the list to a specific scope. Absent = no scope narrow
   * (return every row in the workspace the caller can see — admin/audit
   * default).
   *
   * Content-scoped semantics (this binding):
   * - `{ kind: 'project', projectId }` — rows in that project.
   * - `{ kind: 'org', orgId }` — rows in every project belonging to
   *   that org.
   * - `{ kind: 'tenant', tenantId }` — every row in the workspace.
   *
   * Blobs are content: every blob belongs to a project, so `inherit`
   * has no effect here.
   */
  readonly scope?: Scope;
  /**
   * `false` = literal-at-this-scope only (admin/audit view).
   * `true` (default) = inheritance walk (user-facing view).
   * No-op for content-scoped bindings (rows only exist at
   * project-level — there is no upward hierarchy to walk). Kept for
   * uniformity: scope-aware bindings share one filter shape across the
   * SDK and OpenAPI schemas.
   */
  readonly inherit?: boolean;
}

export interface BlobListPage {
  readonly data: readonly BlobMeta[];
  readonly nextCursor?: Cursor;
}

export interface BlobDeleteOutcome {
  readonly deleted: boolean;
}

/** S3 `ListObjectsV2` result shape (normalized). */
export interface S3ListPage {
  readonly contents: readonly BlobMeta[];
  readonly isTruncated: boolean;
  /** Present only when `isTruncated: true`. */
  readonly nextContinuationToken?: string;
}

/**
 * Discriminated error union. `@kindgi/api` maps each `code` to an HTTP
 * status.
 */
export type BlobError =
  | { readonly code: 'blob-not-found'; readonly message: string; readonly blobId: string }
  | {
      readonly code: 'blob-hash-mismatch';
      readonly message: string;
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly code: 'blob-size-mismatch';
      readonly message: string;
      /** The size the put declared, or, for bytes sent with no size, the most an upload may be. */
      readonly declared: number;
      /** The size of the bytes received, or, past that most, how many came in before the upload stopped. */
      readonly actual: number;
    }
  | { readonly code: 'blob-storage-error'; readonly message: string; readonly cause?: unknown }
  | {
      /** The tenant's storage limit has no room for the put. Nothing was stored. */
      readonly code: 'storage-limit-reached';
      readonly message: string;
      readonly limit: 'storage';
      /** The tenant's limit, in MiB. */
      readonly storageMiB: number;
      /** What the tenant's files take, with the uploads under way, before this put. It may be past the limit already. */
      readonly usedBytes: number;
      /** What this put needs: its declared size, else the most an upload may be. */
      readonly neededBytes: number;
    };
