// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TenantId } from '@kindgi/types';

/**
 * Caller-plugged surface for AWS-style credentials that authenticate
 * against the S3-compat `/s3/*` wire surface. Mirrors the
 * `TokenResolver` shape (auth.ts): resolve an `accessKeyId` to a
 * `S3Credential`, or `null` for missing / expired / revoked.
 *
 * Every deployment owns credential issuance out-of-band (an admin
 * route or an operator console). This binding only resolves; it
 * does not mint. Deployments typically issue credentials paired 1-to-1
 * with a bucket + tenant.
 *
 * The SigV4 middleware calls `resolve(accessKeyId)` on every request,
 * uses `secretKey` to recompute the expected signature, and if the
 * comparison passes, sets `c.set('tenantId', credential.tenantId)` +
 * `c.set('bucket', credential.bucket)` for downstream routes. The
 * caller-supplied bucket in the URL is compared to `credential.bucket`
 * — mismatch → `403 AccessDenied` (bucket-scoped credentials).
 *
 * ## Scope classification
 *
 * S3 credentials are a policy/config-scoped resource. This binding
 * does not carry the uniform `{ scope?: Scope, inherit?: boolean }`
 * filter fields because it exposes only a runtime-bound
 * `resolve(accessKeyId)` entry-point — no `list()` / `*ListInput` /
 * filter surface. The Scope discipline still applies to stored
 * credentials (each carries a tenant / org / project scope, like MCP
 * endpoints), and a `list()` method — if added for an admin plane —
 * must gain the same `{ scope?: Scope, inherit?: boolean }` shape
 * (policy/config semantics: `inherit` load-bearing). There is no admin
 * list surface.
 */
export type S3CredentialBinding = {
  resolve(accessKeyId: string): Promise<S3Credential | null>;
};

export interface S3Credential {
  /** Long-form secret paired with `accessKeyId`; used to recompute SigV4. */
  readonly secretKey: string;
  /** Which tenant this credential belongs to. */
  readonly tenantId: TenantId;
  /**
   * Which bucket this credential is authorized for. One bucket per
   * credential. Requests for other buckets return `403 AccessDenied`.
   * The `artifacts` bucket is where bespoke uploads conventionally land
   * — credentials granted this bucket see bespoke uploads too.
   */
  readonly bucket: string;
  /**
   * Optional expiration. If set and past, the middleware treats the
   * credential as expired even if this resolver returned it.
   */
  readonly expiresAt?: Date;
}
