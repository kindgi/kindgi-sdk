// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ContentHash } from './hash.js';
import type { TenantId } from './ids.js';
import type { Timestamp } from './temporal.js';

/**
 * Reference to a blob in object storage.
 *
 * BlobRef is a handle to bytes held by an object-storage provider (e.g.
 * MinIO, S3, R2, GCS).
 *
 * The required fields are populated by the storage layer that wrote the
 * bytes. Consumers must NEVER construct a BlobRef by hand; a real one always
 * comes from a provider that has already written the bytes.
 */
export interface BlobRef {
  /** Which provider holds this blob (e.g. 'minio', 's3', 'r2', 'gcs'). */
  readonly provider: string;
  /** Bucket name within the provider. */
  readonly bucket: string;
  /** Object key within the bucket. Never contains a leading slash. */
  readonly key: string;
  /** Size in bytes. */
  readonly size: number;
  /** Content hash of the blob bytes — enables dedup and tamper detection. */
  readonly sha256: ContentHash;
  /** MIME type. */
  readonly contentType: string;
  /** Owning tenant. Cross-tenant access is denied by policy. */
  readonly tenantId: TenantId;
  /** When the blob was written. */
  readonly createdAt: Timestamp;
  /**
   * Optional retention lock — after this timestamp, provider MAY delete;
   * before, provider MUST refuse deletion. Enables legal-hold semantics.
   */
  readonly retentionUntil?: Timestamp;
}

/**
 * Reference to a versioned dataset: a collection of memory Facts (see
 * `@kindgi/memory`) of one declared type — e.g. eval corpora, held-out sets,
 * or examples a pack ships with.
 *
 * The DatasetRef captures which collection and which version.
 */
export interface DatasetRef {
  /** Dataset identifier. */
  readonly datasetId: string;
  /** Owning tenant. */
  readonly tenantId: TenantId;
  /** Version of the dataset (semver). */
  readonly version: string;
  /** Fact type stored in this dataset (matches memory.schema.json Fact.type). */
  readonly factType: string;
  /** Number of items in this version. */
  readonly count: number;
  /** When this version was created. */
  readonly createdAt: Timestamp;
}
