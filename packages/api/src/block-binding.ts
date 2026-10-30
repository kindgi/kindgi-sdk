// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { BlockDefinition, BlockKind } from '@kindgi/agents';
import type { Scope } from '@kindgi/platform';
import type { AgentId, Cursor, ProjectId, TenantId } from '@kindgi/types';

import type { PinActor } from './agent-pin-binding.js';
import type { RegistryReadOnly } from './registry-read-only.js';

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
  /**
   * Set when this registry takes no writes (under `kindgi dev`, the
   * pack's files are the source of its blocks): every write is refused
   * with `409 registry-read-only` and this reason, before the binding is
   * called. See `RegistryReadOnly`.
   */
  readonly readOnly?: RegistryReadOnly;
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
  /**
   * The project the block belongs to: its authorization comes from there.
   * In a tenant with environment orders, a version may be made in another
   * project of that project's order (`madeInProjectId`).
   */
  readonly projectId: ProjectId;
  /**
   * The project this version was published in, when the store records it.
   * The same as `projectId`, except in a tenant with environment orders,
   * where a block's versions are made in the order's first environment.
   */
  readonly madeInProjectId?: ProjectId;
  /** ISO-8601. */
  readonly publishedAt: string;
  /** ISO-8601; present only on an unregistered version. */
  readonly unregisteredAt?: string;
  /** Who published it. Absent on a version published before it was recorded. */
  readonly publishedBy?: PinActor;
  /** Where it came from. Absent on a version published before it was recorded. */
  readonly source?: BlockVersionSource;
};

/**
 * Where a block version came from:
 * - `api`: `POST /v1/blocks` (the CLI's `kindgi blocks publish` among its callers);
 * - `deploy`: a deploy's pack, with the deployment's id;
 * - `suggested-change`: a suggested change, with its id.
 */
export type BlockVersionSource =
  | { readonly kind: 'api' }
  | { readonly kind: 'deploy' | 'suggested-change'; readonly id: string };

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
  /**
   * A prior page's `nextCursor`, which the route checks before asking the
   * binding: url-safe base64 of `{ "p": <the last version's publish time as
   * stored>, "i": <its row id> }`, or (a cursor from before) of a bare ISO
   * time. Anything else is `400 bad-input`.
   */
  readonly cursor?: Cursor;
  /** Include unregistered versions (each with `unregisteredAt`). Default `false`. */
  readonly includeTombstoned?: boolean;
}

export interface BlockPublishInput {
  readonly tenantId: TenantId;
  /** The project to publish into. REQUIRED; the store never falls back to Default. */
  readonly projectId: ProjectId;
  readonly block: BlockDefinition;
  /** Who publishes it: the request's principal. Stored with the version. */
  readonly publishedBy: PinActor;
  /** Where it comes from. Stored with the version. */
  readonly source: BlockVersionSource;
}

/**
 * Which agent versions use a block: what `POST /v1/blocks` checks a new
 * settings version against. A separate surface, so a registry fake
 * needn't answer it; a deployment's agent registry implements it.
 */
export interface BlockUseBinding {
  /**
   * The agent versions, unregistered ones left out, that pin a version of
   * the block: as a prompt, a settings block, or their model settings
   * (`modelSettings`, which is a settings block too, listed once as
   * `model-settings`). Read from each version's `pins` and
   * `modelSettings`; a version published before pins existed is left
   * out. Tenant-scoped.
   */
  pinningBlock(input: BlockUseInput): Promise<readonly BlockUse[]>;
}

export interface BlockUseInput {
  readonly tenantId: TenantId;
  readonly blockId: string;
}

/** One agent version that pins a block. */
export interface BlockUse {
  readonly agentId: AgentId;
  readonly version: string;
  /** How the version uses the block. */
  readonly as: 'prompt' | 'settings' | 'model-settings';
  /** The block version it pins. */
  readonly blockVersion: string;
  /** What the version says about the model, for `modelNamedTwice`. */
  readonly preferredProvider?: string;
  readonly preferredModel?: string;
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
