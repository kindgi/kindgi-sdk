// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Transport } from '../transport.js';
import type { RetentionDomain, RetentionScheduledPage, RetentionSweepResult } from '../types.js';

/**
 * Retention resource — what happens to deleted rows. Deleting most
 * things is a tombstone; a `retention` policy per domain (published with
 * `policies.author`) sets how long a tombstone stays before a sweep
 * purges it for good. Nothing sweeps on its own: call `sweep` from a
 * schedule. Both need `admin` on the tenant.
 */
export interface RetentionClient {
  /**
   * The tombstoned rows in every domain a retention policy covers, each
   * with when it is purged (`purgeAt`) and the policy that decides it.
   * The page also names the covered domains this deployment can't purge
   * (`domainsMissingAdapter`), the ones no policy covers
   * (`unpolicedDomains`), and any domain two policies cover
   * (`conflicts`).
   *
   * @wire `GET /v1/retention/scheduled` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1retention~1scheduled/get`.
   */
  scheduled(filter?: RetentionScheduledFilter): Promise<RetentionScheduledPage>;

  /**
   * Purge, for good, the tombstoned rows past their policy's grace: in
   * every domain, or only `domain`. At most `maxPerDomain` per domain
   * per call (default 500); `remaining` counts the rest. Idempotent.
   *
   * @wire `POST /v1/retention/sweep`, or with `domain`
   *   `POST /v1/retention/sweep/{domain}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1retention~1sweep/post`.
   */
  sweep(input?: RetentionSweepInput): Promise<RetentionSweepResult>;
}

export interface RetentionScheduledFilter {
  readonly domain?: RetentionDomain;
  /** Only the rows a sweep would purge now. */
  readonly pastGraceOnly?: boolean;
  /** 1..100, default 25. */
  readonly limit?: number;
}

export interface RetentionSweepInput {
  /** One domain (not `*`). Absent: every domain. */
  readonly domain?: Exclude<RetentionDomain, '*'>;
  /** 1..10000, default 500. */
  readonly maxPerDomain?: number;
}

export function makeRetentionClient(transport: Transport): RetentionClient {
  return {
    async scheduled(filter) {
      return transport.request<RetentionScheduledPage>({
        method: 'GET',
        path: '/v1/retention/scheduled',
        query: {
          ...(filter?.domain !== undefined && { domain: filter.domain }),
          ...(filter?.pastGraceOnly === true && { pastGraceOnly: 'true' }),
          ...(filter?.limit !== undefined && { limit: filter.limit }),
        },
      });
    },

    async sweep(input) {
      const body = input?.maxPerDomain !== undefined ? { maxPerDomain: input.maxPerDomain } : {};
      if (input?.domain !== undefined) {
        return transport.request<RetentionSweepResult>({
          method: 'POST',
          path: `/v1/retention/sweep/${encodeURIComponent(input.domain)}`,
          body,
        });
      }
      return transport.request<RetentionSweepResult>({
        method: 'POST',
        path: '/v1/retention/sweep',
        body,
      });
    },
  };
}
