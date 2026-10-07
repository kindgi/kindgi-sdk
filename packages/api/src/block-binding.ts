// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { BlockDefinition, BlockKind } from '@kindgi/agents';
import type { Scope } from '@kindgi/platform';
import type { Cursor, ProjectId, TenantId } from '@kindgi/types';

/**
 * Caller-plugged surface for the data-block registry: prompts and
 * settings, versioned like tools (a head plus immutable versions, with
 * unregister and reinstate). The API package does not own persistence;
 * a deployment wires a store (a database, or in-memory in tests).
 *
 * A block belongs to one project, and is authorized through it: reading
 * one is `read` on its project, publishing, unregistering or
 * reinstating is `write` on it. There are no per-block grants, so the
 * binding writes no authorization tuples.
 *
 * Every method is tenant-scoped.
 */
export interface BlockRegistryBinding {
  /** Each block's latest active version, by id, cursor-paginated. */
  list(input: BlockListInput): Promise<BlockPage>;
  /** A block's latest active version, or `null` (never published, or every version unregistered). */
  get(input: BlockGetInput): Promise<BlockRecord | null>;
  /**
   * A specific version, or `null` if it was never published. An
   * unregistered version is returned too, with `unregisteredAt`: the
   * agent versions that pin it still read it.
   */
  getVersion(input: BlockGetVersionInput): Promise<BlockRecord | null>;
  /** A block's versions, newest published first; unregistered ones only with `includeTombstoned`. */
  listVersions(input: BlockListVersionsInput): Promise<BlockPage>;
  /**
   * Publish a validated block version into a project. A version that's
   * taken is `already-registered` (versions never change); a block's
   * versions all live in its first version's project
   * (`project-mismatch` otherwise).
   */
  publish(input: BlockPublishInput): Promise<BlockPublishOutcome>;
  /** Soft-unregister a version: `{ unregistered: false }` when unknown or already unregistered. */
  unregister(input: BlockVersionInput): Promise<{ readonly unregistered: boolean }>;
  /** Reinstate an unregistered version, unchanged; idempotent. */
  reinstateVersion(input: BlockVersionInput): Promise<BlockReinstateOutcome>;
}

/** A block version as the registry holds it. */
export type BlockRecord = BlockDefinition & {
  /** The project the block belongs to: its authorization comes from there. */
  readonly projectId: ProjectId;
  /** ISO-8601. */
  readonly publishedAt: string;
  /** ISO-8601; present only on an unregistered version. */
  readonly unregisteredAt?: string;
};

export interface BlockListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  /** Exact match on `kind`. */
  readonly blockKind?: BlockKind;
  /** Prefix match on the block id. */
  readonly nameFilter?: string;
  /**
   * Narrow to a scope, as the other registries' lists do. Absent: every
   * block in the tenant. A block always belongs to one project:
   * - `{ kind: 'project', projectId }`: that project's blocks;
   * - `{ kind: 'org', orgId }`: the blocks of every project in that org;
   * - `{ kind: 'tenant' }`: every block in the tenant.
   */
  readonly scope?: Scope;
}

export interface BlockGetInput {
  readonly tenantId: TenantId;
  readonly blockId: string;
}

export interface BlockGetVersionInput {
  readonly tenantId: TenantId;
  readonly blockId: string;
  readonly version: string;
}

export interface BlockListVersionsInput {
  readonly tenantId: TenantId;
  readonly blockId: string;
  readonly limit: number;
  readonly cursor?: Cursor;
  /** Include unregistered versions (each with `unregisteredAt`). Default `false`. */
  readonly includeTombstoned?: boolean;
}

export interface BlockPublishInput {
  readonly tenantId: TenantId;
  /** The project to publish into. REQUIRED; the store never falls back to Default. */
  readonly projectId: ProjectId;
  readonly block: BlockDefinition;
}

export interface BlockVersionInput {
  readonly tenantId: TenantId;
  readonly blockId: string;
  readonly version: string;
}

export interface BlockPage {
  readonly data: readonly BlockRecord[];
  readonly nextCursor?: Cursor;
}

export type BlockPublishOutcome =
  | { readonly kind: 'ok'; readonly blockId: string; readonly version: string }
  | { readonly kind: 'already-registered'; readonly blockId: string; readonly version: string }
  | {
      /** The `projectId` isn't a project in this tenant. */
      readonly kind: 'project-not-found';
      readonly blockId: string;
      readonly projectId: ProjectId;
    }
  | {
      /** The block's earlier versions live in another project: a block belongs to one project. */
      readonly kind: 'project-mismatch';
      readonly blockId: string;
      /** The project the block belongs to. */
      readonly projectId: ProjectId;
    };

export type BlockReinstateOutcome =
  | {
      readonly kind: 'ok';
      readonly blockId: string;
      readonly version: string;
      readonly wasTombstoned: boolean;
    }
  | { readonly kind: 'not-found'; readonly blockId: string; readonly version: string };
