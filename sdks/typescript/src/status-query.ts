// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Query value for list routes that filter by a single status
 * (`GET /v1/approvals`, `GET /v1/conversations`: `?status=<one value>`).
 *
 * The public filter types take one status. A caller that still passes
 * an array (plain JavaScript, or through a cast) gets an empty array
 * treated as no filter and a one-element array sent as that element;
 * several statuses are rejected here with `invalid-request` and no
 * request is sent — the API answers a comma-joined value with
 * `400 bad-input`.
 */

import { type InvalidRequestError, KindgiApiError } from './errors.js';

export function singleStatusQuery<S extends string>(
  method: string,
  status: S | readonly S[] | undefined,
): S | undefined {
  if (status === undefined) return undefined;
  if (!Array.isArray(status)) return status as S;
  const statuses = status as readonly S[];
  if (statuses.length <= 1) return statuses[0];
  const error: InvalidRequestError = {
    code: 'invalid-request',
    message: `${method}: filter by one status at a time; the API accepts a single \`status\` value`,
    issues: [{ path: '/status', message: 'expected a single status' }],
  };
  throw new KindgiApiError(error);
}
