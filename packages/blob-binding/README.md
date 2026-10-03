# `@kindgi/blob-binding`

Storage contract for Kindgi artifacts (blobs). `BlobStorageBinding` is the interface a storage adapter implements and [`@kindgi/api`](../api/) consumes through its `blobStorage` input; it backs both the `/v1/artifacts/*` surface and the S3-compatible `/s3/*` surface. This package contains types only and has no runtime code.

## Purpose

Keep storage out of the API package while giving both wire surfaces one store. Every blob has two addresses kept in a single metadata record: a `blobId` (used by `/v1/artifacts/*`) and a `(bucket, key)` pair (used by `/s3/*`). Uploads through `put` get a synthetic `(bucket, key)` so they are also reachable over S3, and `head(blobId)` and `headByKey(bucket, key)` return the same `BlobMeta` for the same blob. Every method takes `tenantId` explicitly so adapters can partition storage per tenant. Cursors and continuation tokens are opaque and adapter-defined.

Contract rules adapters follow:

- `BlobMeta.hash` is the lowercase hex SHA-256 of the exact bytes persisted. When `BlobPutInput.expectedHash` is set, a mismatch fails the write with `blob-hash-mismatch`. The one exception is a multipart-assembled object, whose `hash` is the S3 multipart ETag.
- `delete` and `deleteByKey` are idempotent: `{ deleted: true }` on the first call, `{ deleted: false }` afterwards. Adapters may tombstone or remove data.
- `listByPrefix` sorts lexicographically by `key`, as S3 does; `putByKey` overwrites an existing key.

## Exports

- **`BlobStorageBinding`** — the adapter interface, in three groups:
  - **By `blobId`** — `put(tenantId, input)`, `get(tenantId, blobId)` (body as a `ReadableStream`), `head(tenantId, blobId)` (`null` when unknown), `list(tenantId, filter, cursor?, limit?)`, `delete(tenantId, blobId)`.
  - **By `(bucket, key)`** — `putByKey`, `getByKey`, `headByKey`, `deleteByKey`, and `listByPrefix(tenantId, bucket, prefix, continuationToken?, maxKeys?)` (`maxKeys` 1 to 1000, default 1000).
  - **Multipart upload** — `initiateMultipartUpload` (returns `uploadId`), `uploadPart` (returns the part `etag`), `completeMultipartUpload` (parts in ascending `partNumber`), `abortMultipartUpload`, `listParts`.
- **Inputs**
  - **`BlobPutInput`** — `name`, `contentType`, `bytes` (`ReadableStream<Uint8Array>` or `Uint8Array`), `size?`, `tags?`, `ownerRunId?`, `expectedHash?`.
  - **`MultipartInitiateInput`** — `contentType`, `tags?`, `ownerRunId?`.
  - **`BlobFilter`** — `ownerRunId`, `contentType`, `tags` (all must match), `scope` (a `Scope` from [`@kindgi/platform`](../platform/)), and `inherit` (no effect here: blobs always live at project level).
- **Results** — **`BlobMeta`** (`blobId`, `tenantId`, `name`, `contentType`, `size`, `hash`, `tags`, `ownerRunId?`, `createdAt`, `bucket?`, `key?`), **`BlobRead`** (`meta` + `stream`), **`BlobListPage`** (`data`, `nextCursor?`), **`BlobDeleteOutcome`** (`deleted`), **`S3ListPage`** (`contents`, `isTruncated`, `nextContinuationToken?`), **`MultipartListPartsPage`** (`parts` with `partNumber`, `etag`, `size`, `lastModified`).
- **`BlobError`** — union discriminated by `code`: `blob-not-found` (`blobId`), `blob-hash-mismatch` (`expected`, `actual`), `blob-size-mismatch` (`declared`, `actual`), `blob-storage-error` (`cause?`).

## Example

```ts
import { createHash } from 'node:crypto';

import type { BlobMeta, BlobStorageBinding } from '@kindgi/blob-binding';
import type { RunId, TenantId } from '@kindgi/types';

async function storeReport(
  blobs: BlobStorageBinding,
  tenantId: TenantId,
  runId: RunId,
  report: string,
): Promise<BlobMeta> {
  const bytes = new TextEncoder().encode(report);
  const stored = await blobs.put(tenantId, {
    name: 'q3-report.txt',
    contentType: 'text/plain',
    bytes,
    size: bytes.byteLength,
    tags: { kind: 'report' },
    ownerRunId: runId,
    // Optional integrity check: the binding rejects the write if its own sha256 differs.
    expectedHash: createHash('sha256').update(bytes).digest('hex'),
  });
  if (stored.kind === 'err') throw new Error(`${stored.error.code}: ${stored.error.message}`);
  const meta = stored.value;

  // The same object is addressable by (bucket, key) on the S3-compatible surface.
  if (meta.bucket !== undefined && meta.key !== undefined) {
    const viaKey = await blobs.headByKey(tenantId, meta.bucket, meta.key);
    console.log(viaKey?.blobId === meta.blobId); // true
  }

  // Everything this run has produced with the same tag, first page.
  const page = await blobs.list(tenantId, { ownerRunId: runId, tags: { kind: 'report' } }, undefined, 20);
  if (page.kind === 'ok') console.log(page.value.data.map((b) => `${b.name} ${b.size}B`));

  return meta;
}
```

## Non-goals

- **No storage implementation.** Filesystem, object-store, and other adapters implement `BlobStorageBinding` in their own packages.
- **No `Content-MD5` verification.** The S3-compatible route verifies it before calling the binding.
- **No object versioning.** Writing an existing `(bucket, key)` replaces the object (last write wins).
- **No scope inheritance for blobs.** Blobs are project-level content; `BlobFilter.inherit` exists only to keep one filter shape across scope-aware bindings.

## Related

- [`@kindgi/api`](../api/) — mounts `/v1/artifacts/*` over a `BlobStorageBinding`, and `/s3/*` when an S3 credential binding is also supplied.
- [`@kindgi/platform`](../platform/) — `Scope`.
- [`@kindgi/types`](../types/) — `ArtifactId`, `Cursor`, `RunId`, `TenantId`, `Timestamp`, `Result`.
