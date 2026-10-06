// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Data blocks: versioned prompts and settings an agent version pins.
 *
 * @wire /v1/blocks/*  (packages/api/src/routes/blocks.ts)
 * @generated Wire shapes from `../generated/api.js`.
 *
 * The versioned-registry shape of tools and eval suites: publish a new
 * version (into a project), list, get the latest, list versions, and
 * unregister or reinstate a version. A version never changes.
 */

import type {
  Block,
  BlockCollectionPage,
  BlockKind,
  PublishBlockBody,
  PublishBlockResult,
  ReinstateBlockResult,
  UnregisterBlockResult,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type { Block, BlockKind };
export type BlockPage = BlockCollectionPage;
/**
 * The block fields of `POST /v1/blocks`. The project travels as
 * `PublishBlockOptions.projectId`, so the input stays the block itself.
 */
export type PublishBlockInput = Omit<PublishBlockBody, 'projectId'>;
export type { PublishBlockResult, ReinstateBlockResult, UnregisterBlockResult };

export interface PublishBlockOptions {
  /** The project the block belongs to. Its versions all stay there. */
  readonly projectId: string;
  readonly idempotencyKey?: string;
}

export interface ListBlocksFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly kind?: BlockKind;
  /** Prefix match on the block id. */
  readonly name?: string;
  readonly projectId?: string;
}

export interface ListBlockVersionsFilter {
  readonly limit?: number;
  readonly cursor?: string;
  /** Include unregistered versions, each with `unregisteredAt`. */
  readonly includeTombstoned?: boolean;
}

export interface BlocksClient {
  /**
   * Publish a block version into a project. Needs `write` on it.
   *
   * @wire POST /v1/blocks
   */
  publish(input: PublishBlockInput, options: PublishBlockOptions): Promise<PublishBlockResult>;
  /** @wire GET /v1/blocks */
  list(filter?: ListBlocksFilter): Promise<BlockPage>;
  /** @wire GET /v1/blocks/:blockId */
  get(blockId: string): Promise<Block>;
  readonly versions: BlockVersionsClient;
}

export interface BlockVersionsClient {
  /** @wire GET /v1/blocks/:blockId/versions */
  list(blockId: string, filter?: ListBlockVersionsFilter): Promise<BlockPage>;
  /** @wire GET /v1/blocks/:blockId/versions/:version */
  get(blockId: string, version: string): Promise<Block>;
  /** @wire POST /v1/blocks/:blockId/versions/:version/unregister */
  unregister(
    blockId: string,
    version: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<UnregisterBlockResult>;
  /** @wire POST /v1/blocks/:blockId/versions/:version/reinstate */
  reinstate(
    blockId: string,
    version: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ReinstateBlockResult>;
}

export function makeBlocksClient(transport: Transport): BlocksClient {
  const seg = (s: string): string => encodeURIComponent(s);
  return {
    async publish(input, options) {
      return transport.request<PublishBlockResult>({
        method: 'POST',
        path: '/v1/blocks',
        body: { ...input, projectId: options.projectId },
        ...(options.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async list(filter) {
      return transport.request<BlockPage>({
        method: 'GET',
        path: '/v1/blocks',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.kind !== undefined && { kind: filter.kind }),
          ...(filter?.name !== undefined && { name: filter.name }),
          ...(filter?.projectId !== undefined && { projectId: filter.projectId }),
        },
      });
    },
    async get(blockId) {
      return transport.request<Block>({ method: 'GET', path: `/v1/blocks/${seg(blockId)}` });
    },
    versions: {
      async list(blockId, filter) {
        return transport.request<BlockPage>({
          method: 'GET',
          path: `/v1/blocks/${seg(blockId)}/versions`,
          query: {
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
            ...(filter?.includeTombstoned !== undefined && {
              includeTombstoned: filter.includeTombstoned,
            }),
          },
        });
      },
      async get(blockId, version) {
        return transport.request<Block>({
          method: 'GET',
          path: `/v1/blocks/${seg(blockId)}/versions/${seg(version)}`,
        });
      },
      async unregister(blockId, version, options) {
        return transport.request<UnregisterBlockResult>({
          method: 'POST',
          path: `/v1/blocks/${seg(blockId)}/versions/${seg(version)}/unregister`,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
      async reinstate(blockId, version, options) {
        return transport.request<ReinstateBlockResult>({
          method: 'POST',
          path: `/v1/blocks/${seg(blockId)}/versions/${seg(version)}/reinstate`,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
    },
  };
}
