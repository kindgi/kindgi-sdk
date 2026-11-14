// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TenantId } from '@kindgi/types';

/**
 * A deployment's limit on what one person uploads on `run` alone: a file
 * of their own that names no run, for a run they start, in a project they
 * may run but not write (`POST /v1/artifacts`). An upload that passes on
 * `write` never asks it. The deployment counts; the routes only ask, and
 * past the limit answer `429 upload-limit-reached`.
 */
export interface RunUploadLimiter {
  /** Whether one more file of `size` bytes fits what `createdBy` may upload this way in the tenant. */
  check(input: RunUploadCheckInput): Promise<RunUploadCheck>;
}

export interface RunUploadCheckInput {
  readonly tenantId: TenantId;
  /** `user:<id>`: the person uploading. */
  readonly createdBy: string;
  /** The file's bytes. */
  readonly size: number;
}

export type RunUploadCheck =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'over';
      /** The bytes one person may upload this way in the window; absent when bytes aren't limited. */
      readonly maxBytes?: number;
      /** The files one person may upload this way in the window; absent when files aren't limited. */
      readonly maxFiles?: number;
      /** What the person uploaded in the window so far. */
      readonly usedBytes: number;
      readonly usedFiles: number;
      readonly windowMs: number;
      /** How long until this upload fits. */
      readonly retryAfterMs: number;
    };
