// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectId, TenantId } from '@kindgi/types';

/** The kinds of item an environment order carries from project to project. */
export type OrderItemKind = 'agent' | 'flow' | 'test_set' | 'tool' | 'guardrail' | 'block';

export interface ItemProjectsInput {
  readonly tenantId: TenantId;
  readonly kind: OrderItemKind;
  readonly id: string;
}

export interface ItemProjectsOfManyInput {
  readonly tenantId: TenantId;
  readonly kind: OrderItemKind;
  readonly ids: readonly string[];
}

export interface ServesInInput extends ItemProjectsInput {
  readonly projectId: ProjectId;
}

/** Whether a project serves an item, and the item's own project. */
export interface ItemServesIn {
  /** The project the item was first published in: `projectsOf`'s first. */
  readonly own: ProjectId;
  /** Whether the project asked about is one of `projectsOf`'s. */
  readonly serves: boolean;
}

/** Whether a project besides its own serves an item, and the item's own project. */
export interface ItemServedElsewhere {
  /** The project the item was first published in: `projectsOf`'s first. */
  readonly own: ProjectId;
  /** Whether `projectsOf` has more than one project. */
  readonly elsewhere: boolean;
}

export interface VersionProjectsInput extends ItemProjectsInput {
  readonly version: string;
}

export interface VersionProjectsOfManyInput extends ItemProjectsInput {
  readonly versions: readonly string[];
}

export interface VersionProjectsOfItemsInput {
  readonly tenantId: TenantId;
  readonly kind: OrderItemKind;
  /** Per item id, the versions asked about. */
  readonly versions: ReadonlyMap<string, readonly string[]>;
}

export interface NewestVisibleOfManyInput {
  readonly tenantId: TenantId;
  readonly kind: OrderItemKind;
  /**
   * Per item id, the projects the caller reads among the item's: a version
   * is visible when its projects (`versionProjectsOf`) include one of them.
   */
  readonly readable: ReadonlyMap<string, readonly ProjectId[]>;
  /**
   * Ids of retired items (no active version, listed with retired ones):
   * their newest version the caller can see counts unregistered ones.
   */
  readonly retired?: ReadonlySet<string>;
}

/**
 * Which projects serve an item: the project it was first published in,
 * and every other project where a version of it can run. Rights on an
 * item that more than one project serves are rights on those projects
 * (`item-rights.ts`): what a project serves is governed by rights on that
 * project, whichever project the item was first published in.
 *
 * Without environment orders, an item has one project and every check is
 * today's. The runtime supplies the binding; `@kindgi/api` never
 * constructs one. Absent: every item has one project.
 *
 * Where a version can run, by kind:
 * - an agent or a flow version: the project it was made in, and each
 *   project with a deployment that ships it and isn't retired;
 * - a test set version: the project it was made in, and every later
 *   environment of that project's order;
 * - a tool, guardrail or block, which agents pin: every project of the
 *   order of the project that owns it, and each version's own project.
 */
export interface ItemProjectsBinding {
  /**
   * The item's projects: the project it was first published in, then every
   * other project where a version of it can run, unregistered versions
   * included (so reinstating one is checked where it would serve), each
   * once. `undefined`: no such item.
   */
  projectsOf(input: ItemProjectsInput): Promise<readonly ProjectId[] | undefined>;
  /**
   * `projectsOf` for a list page of one kind, in one query. An id missing
   * from the map names no item.
   */
  projectsOfMany(
    input: ItemProjectsOfManyInput,
  ): Promise<ReadonlyMap<string, readonly ProjectId[]>>;
  /**
   * `projectsOf` asked of one project: whether it's one of the item's, and
   * the item's own. Exactly what `projectsOf` answers, reading only what
   * serves the item there, so a run start needn't read everywhere else it
   * runs. `projectId` is whatever the caller named, so it may name no
   * project: then it isn't one of the item's. `undefined`: no such item.
   */
  servesIn(input: ServesInInput): Promise<ItemServesIn | undefined>;
  /**
   * Whether `projectsOf` has more than one project, and the item's own,
   * stopping at the first other project found. `undefined`: no such item.
   */
  servedElsewhere(input: ItemProjectsInput): Promise<ItemServedElsewhere | undefined>;
  /**
   * A version's projects: the project it was made in first (the item's
   * own, for a version from before environments), then every other
   * project where that version can run. Never empty. `undefined`: no such
   * version. Not asked for guardrails, which have no versions.
   */
  versionProjectsOf(input: VersionProjectsInput): Promise<readonly ProjectId[] | undefined>;
  /**
   * `versionProjectsOf` for some of one item's versions (a page of its
   * versions, its pinned entries, its pin history), in one query. A version
   * missing from the map is no version of the item.
   */
  versionProjectsOfMany(
    input: VersionProjectsOfManyInput,
  ): Promise<ReadonlyMap<string, readonly ProjectId[]>>;
  /**
   * `versionProjectsOfMany` for a page of one kind's items, in one query:
   * each item's asked versions, with where each can run. A version missing
   * from an item's map is no version of it. Not asked for guardrails.
   */
  versionProjectsOfItems(
    input: VersionProjectsOfItemsInput,
  ): Promise<ReadonlyMap<string, ReadonlyMap<string, readonly ProjectId[]>>>;
  /**
   * For a page of one kind's items, each item's newest version (the
   * highest active one; for a `retired` item, the highest) that the caller
   * can see: one whose projects include one of `readable`'s for that item.
   * In one query. An id missing from the map has no such version. Not
   * asked for guardrails.
   */
  newestVisibleOfMany(input: NewestVisibleOfManyInput): Promise<ReadonlyMap<string, string>>;
}
