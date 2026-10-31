// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  Cursor,
  OrgId,
  PinScope,
  PinnedItemKind,
  ProjectId,
  Result,
  Semver,
  TenantId,
  Timestamp,
} from '@kindgi/types';

import type { PinActor } from './agent-pin-binding.js';

/**
 * Pinned versions of flows and tools: which version is in use in a scope
 * (a project, an org, the tenant) when nothing names one. Publishing a new
 * version doesn't change what's in use where a pin covers; without a pin, a
 * new version is in use at once, as before anything is pinned.
 *
 * A flow's pin is read when a run names no flow version: the run takes the
 * version pinned for its project, else the newest the project reaches. A
 * tool's pin is read when an agent or flow version is published: its lock
 * takes the version pinned for the project the version is made in (an
 * agent's only when the pin is within the tool reference's range), else
 * the latest active version, as before. A published version's lock never
 * moves.
 */

/** What a pin is resolved for: a project (and its org), or an org, or the tenant alone. */
export interface PinnedResolveInput {
  readonly tenantId: TenantId;
  readonly kind: PinnedItemKind;
  readonly itemId: string;
  /** Absent → only the org's pin (with `orgId`) and the tenant-wide pin apply. */
  readonly projectId?: ProjectId;
  /** The project's org, when it has one (the binding may look it up from `projectId` itself). */
  readonly orgId?: OrgId;
}

export interface PinnedResolution {
  readonly version: Semver;
  /** The pin that matched. */
  readonly scope: PinScope;
}

export interface PinnedVersion {
  readonly kind: PinnedItemKind;
  readonly itemId: string;
  readonly scope: PinScope;
  readonly version: Semver;
  /** The change that set it. */
  readonly changeId: string;
  readonly setAt: Timestamp;
  readonly setBy: PinActor;
}

export type PinnedVersionChangeAction = 'pin' | 'unpin';

/** One change of a scope's pin, kept for good: what was pinned before, what is after, who asked and why. */
export interface PinnedVersionChange {
  readonly id: string;
  readonly kind: PinnedItemKind;
  readonly itemId: string;
  readonly scope: PinScope;
  readonly action: PinnedVersionChangeAction;
  /** The scope's own pin before; `null` when it had none. */
  readonly fromVersion: Semver | null;
  /** The scope's own pin after; `null` after an unpin. */
  readonly toVersion: Semver | null;
  readonly requestedBy: PinActor;
  readonly reason?: string;
  readonly createdAt: Timestamp;
}

export type PinnedVersionErrorCode =
  /** The version isn't registered for this item, or was unregistered. */
  | 'version-not-found'
  /** The item isn't registered in this tenant. */
  | 'not-found'
  /** The item was deleted. */
  | 'gone'
  /** A tool the runtime ships itself: its version is the runtime's, so it isn't pinned. */
  | 'not-pinnable'
  /** Unpin: the scope has no pin of its own. */
  | 'not-pinned'
  /** The scope names an org or project the tenant doesn't have. */
  | 'scope-invalid'
  | 'persistence-error';

export interface PinnedVersionError {
  readonly code: PinnedVersionErrorCode;
  readonly message: string;
}

export interface PinVersionInput {
  readonly tenantId: TenantId;
  readonly kind: PinnedItemKind;
  readonly itemId: string;
  readonly scope: PinScope;
  readonly version: Semver;
  readonly requestedBy: PinActor;
  readonly reason?: string;
}

export interface UnpinVersionInput {
  readonly tenantId: TenantId;
  readonly kind: PinnedItemKind;
  readonly itemId: string;
  readonly scope: PinScope;
  readonly requestedBy: PinActor;
  readonly reason?: string;
}

export interface ListPinnedVersionChangesInput {
  readonly tenantId: TenantId;
  readonly kind: PinnedItemKind;
  readonly itemId: string;
  readonly limit: number;
  readonly cursor?: Cursor;
}

/**
 * What a pin write answers: the change it recorded, or, for a pin of the
 * version the scope already pins, the change that set it (`unchanged`:
 * nothing written, no history, no audit).
 */
export interface PinVersionOutcome {
  readonly change: PinnedVersionChange;
  readonly unchanged: boolean;
}

export interface PinnedVersionBinding {
  /**
   * The most specific pin covering the input whose version is still
   * registered and active (project, then its org, then the tenant); a
   * covering pin whose version isn't is passed over (and reported once).
   * `null` when none covers.
   */
  resolve(input: PinnedResolveInput): Promise<PinnedResolution | null>;
  /** Every pin of an item. */
  list(input: {
    readonly tenantId: TenantId;
    readonly kind: PinnedItemKind;
    readonly itemId: string;
  }): Promise<readonly PinnedVersion[]>;
  /**
   * Pin `version` for `scope`, or move the scope's pin to it, and record the
   * change. The version must be registered and active. Pinning the version
   * already pinned there writes nothing (`unchanged`).
   */
  pin(input: PinVersionInput): Promise<Result<PinVersionOutcome, PinnedVersionError>>;
  /** Remove the scope's own pin: it falls back to the next scope up. `not-pinned` when it has none. */
  unpin(input: UnpinVersionInput): Promise<Result<PinnedVersionChange, PinnedVersionError>>;
  /** The item's changes, newest first. */
  history(input: ListPinnedVersionChangesInput): Promise<{
    readonly data: readonly PinnedVersionChange[];
    readonly nextCursor?: Cursor;
  }>;
  /**
   * Whether `cursor` is one this binding issued for `history`. Optional:
   * without it, the route passes any cursor on. With it, a cursor the
   * binding didn't issue answers `400 bad-input` before the history is read.
   */
  issuedCursor?(list: 'pin-history', cursor: Cursor): boolean;
}
