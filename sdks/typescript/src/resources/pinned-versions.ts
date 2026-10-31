// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  PinScope,
  PinnedVersionChange,
  PinnedVersionChangePage,
  PinnedVersionList,
  PinnedVersionResolution,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

/**
 * Pinned versions of a flow or a tool: which version is in use in a scope
 * (a project, an org, the tenant) when nothing names one. A new version is
 * published without going into use where a pin covers; without a pin, it's
 * in use at once.
 */
export interface PinnedVersionsClient {
  /**
   * The version in use for a project (or an org), and why: `via: 'pinned'`
   * with the pin's scope (`pinnedScope`), or `via: 'latest'`.
   *
   * @wire GET /v1/{flows|tools}/:id/pinned
   */
  resolve(id: string, where?: PinnedWhere): Promise<PinnedVersionResolution>;
  /** @wire GET /v1/{flows|tools}/:id/pinned-versions — every scope with a pin */
  list(id: string): Promise<PinnedVersionList>;
  /**
   * Pin `version` for `scope`, or move the scope's pin to it. Pinning the
   * version the scope already pins changes nothing and answers the change
   * that set it. `404` when the version isn't registered and active; `409
   * pin-scope-spans-environments` for a tenant- or org-wide pin of an item
   * in an environment order.
   *
   * @wire POST /v1/{flows|tools}/:id/pinned/pin
   */
  pin(
    id: string,
    input: PinVersionInput,
    options?: PinMutationOptions,
  ): Promise<PinnedVersionChange>;
  /**
   * Remove the scope's own pin: it follows the next scope up. `409
   * not-pinned` when it has none.
   *
   * @wire POST /v1/{flows|tools}/:id/pinned/unpin
   */
  unpin(
    id: string,
    input: UnpinVersionInput,
    options?: PinMutationOptions,
  ): Promise<PinnedVersionChange>;
  /** @wire GET /v1/{flows|tools}/:id/pin-history — every pin and unpin, newest first */
  history(id: string, page?: PinHistoryPage): Promise<PinnedVersionChangePage>;
}

/** What `resolve` looks up for: a project (and its org), or an org; neither → the tenant's pin. */
export interface PinnedWhere {
  readonly projectId?: string;
  readonly orgId?: string;
}

export interface PinVersionInput {
  readonly version: string;
  readonly scope: PinScope;
  readonly reason?: string;
}

export interface UnpinVersionInput {
  readonly scope: PinScope;
  readonly reason?: string;
}

export interface PinHistoryPage {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface PinMutationOptions {
  readonly idempotencyKey?: string;
}

/**
 * The five pin routes of one item, written out by the resource that has
 * them (`flows.ts`, `tools.ts`), so each route's path reads in its file.
 */
export interface PinnedVersionRoutes {
  readonly resolve: { readonly path: string };
  readonly list: { readonly path: string };
  readonly pin: { readonly path: string };
  readonly unpin: { readonly path: string };
  readonly history: { readonly path: string };
}

/** The pin client over an item's routes (`routes(id)`). */
export function makePinnedVersionsClient(
  transport: Transport,
  routes: (id: string) => PinnedVersionRoutes,
): PinnedVersionsClient {
  return {
    async resolve(id, where) {
      return transport.request<PinnedVersionResolution>({
        method: 'GET',
        path: routes(id).resolve.path,
        query: {
          ...(where?.projectId !== undefined && { projectId: where.projectId }),
          ...(where?.orgId !== undefined && { orgId: where.orgId }),
        },
      });
    },
    async list(id) {
      return transport.request<PinnedVersionList>({
        method: 'GET',
        path: routes(id).list.path,
      });
    },
    async pin(id, input, options) {
      return transport.request<PinnedVersionChange>({
        method: 'POST',
        path: routes(id).pin.path,
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async unpin(id, input, options) {
      return transport.request<PinnedVersionChange>({
        method: 'POST',
        path: routes(id).unpin.path,
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async history(id, page) {
      return transport.request<PinnedVersionChangePage>({
        method: 'GET',
        path: routes(id).history.path,
        query: {
          ...(page?.limit !== undefined && { limit: page.limit }),
          ...(page?.cursor !== undefined && { cursor: page.cursor }),
        },
      });
    },
  };
}
