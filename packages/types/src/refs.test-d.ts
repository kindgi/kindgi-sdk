// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expectTypeOf, test } from 'vitest';
import type { ContentHash, KeyId } from './hash.js';
import type { TenantId } from './ids.js';
import type { BlobRef, DatasetRef } from './refs.js';
import type { Timestamp } from './temporal.js';

describe('BlobRef', () => {
  test('all required fields present and typed correctly', () => {
    const ref: BlobRef = {
      provider: 'minio',
      bucket: 'kindgi-blobs',
      key: 'tenants/abc/uploads/doc-42',
      size: 1024,
      sha256: 'sha256:abc' as ContentHash,
      contentType: 'application/pdf',
      tenantId: 'abc' as TenantId,
      createdAt: '2026-09-16T14:00:00Z' as Timestamp,
    };
    expectTypeOf(ref.provider).toEqualTypeOf<string>();
    expectTypeOf(ref.sha256).toEqualTypeOf<ContentHash>();
    expectTypeOf(ref.tenantId).toEqualTypeOf<TenantId>();
  });

  test('retentionUntil is optional', () => {
    const withoutRetention: BlobRef = {
      provider: 'minio',
      bucket: 'b',
      key: 'k',
      size: 0,
      sha256: 'sha256:0' as ContentHash,
      contentType: 'application/octet-stream',
      tenantId: 'abc' as TenantId,
      createdAt: '2026-09-16T14:00:00Z' as Timestamp,
    };
    expectTypeOf(withoutRetention.retentionUntil).toEqualTypeOf<Timestamp | undefined>();
  });

  test('missing required fields fail at compile time', () => {
    // @ts-expect-error — 'bucket' is required.
    const _bad: BlobRef = {
      provider: 'minio',
      key: 'k',
      size: 0,
      sha256: 'sha256:0' as ContentHash,
      contentType: 'application/octet-stream',
      tenantId: 'abc' as TenantId,
      createdAt: '2026-09-16T14:00:00Z' as Timestamp,
    };
  });

  test('fields are readonly', () => {
    const ref: BlobRef = {
      provider: 'minio',
      bucket: 'b',
      key: 'k',
      size: 0,
      sha256: 'sha256:0' as ContentHash,
      contentType: 'application/octet-stream',
      tenantId: 'abc' as TenantId,
      createdAt: '2026-09-16T14:00:00Z' as Timestamp,
    };
    // @ts-expect-error — bucket is readonly.
    ref.bucket = 'other';
  });
});

describe('DatasetRef', () => {
  test('has the expected shape', () => {
    const ref: DatasetRef = {
      datasetId: 'acme.contract-eval',
      tenantId: 'abc' as TenantId,
      version: '1.0.0',
      factType: 'acme.contract',
      count: 128,
      createdAt: '2026-09-16T14:00:00Z' as Timestamp,
    };
    expectTypeOf(ref.count).toEqualTypeOf<number>();
    expectTypeOf(ref.factType).toEqualTypeOf<string>();
  });
});

describe('KeyId is opaque', () => {
  test('constructed via cast', () => {
    const k = 'ed25519-local:tenant-abc-v1' as KeyId;
    expectTypeOf(k).toEqualTypeOf<KeyId>();
    // KeyId is not string-assignable without cast.
    // @ts-expect-error — bare string is not a KeyId.
    const _bad: KeyId = 'foo';
  });
});
