// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { OrgId, ProjectId, TenantId } from '@kindgi/types';

/**
 * An order's identity, for equality only. The binding mints it and the
 * server compares two for sameness; it is opaque — never parsed, never
 * built by a consumer, and never on the wire. A host application's binding
 * returns whatever stable, non-null string distinguishes one order from
 * another; the brand keeps that value from being read as a plain string.
 */
export type EnvironmentOrderKey = string & { readonly __brand: 'EnvironmentOrderKey' };

/**
 * The order a tenant runs a project through on its way to live — its
 * "environments", to the people who set them: an ordered list of the
 * tenant's projects (or one of its orgs' projects), each project in at
 * most one order. The runtime keeps the order; `@kindgi/api` never
 * constructs one itself — the host application supplies the binding.
 *
 * Reads name a project the caller can't see by its position alone, never
 * its id: the route applies that, from the project-read check that
 * `GET /v1/projects` uses. Only a tenant admin writes an order (the route
 * gates it). A write replaces the whole order with the projects given, in
 * the order given; `[]` clears it. The binding serializes the tenant's
 * order writes, so two writes to one order apply one after the other
 * rather than race.
 */
export interface EnvironmentOrderBinding {
  /**
   * The tenant's orders — its own, and each of its orgs' — one page at a
   * time, in a stable order, after `input.after`, at most `input.limit`.
   * Every order is returned whole (every member project, by id and
   * position); the route drops the ones the caller can read no project in,
   * and hides the ids it can't read.
   */
  list(input: EnvironmentOrderListInput): Promise<EnvironmentOrderListPage>;

  /**
   * One order, by its parent — the tenant, or one of its orgs. A parent
   * with no order (never set, or cleared) reads as an empty one. Returned
   * whole; the route applies read visibility.
   */
  get(input: EnvironmentOrderGetInput): Promise<EnvironmentOrder>;

  /**
   * Replace an order with the projects in `input.projectIds`, in that
   * order; `[]` clears it. One transaction, holding the parent's row, so
   * two writes to one order serialize. A write that would leave the order
   * exactly as it is writes nothing and records nothing (`no-op`). The
   * binding checks, in the same transaction, that every project is live in
   * the tenant under the order's parent and belongs to no other order; a
   * caller mistake resolves to an outcome, never a throw.
   */
  set(input: EnvironmentOrderSetInput): Promise<EnvironmentOrderSetOutcome>;

  /**
   * Where a project sits in its order, for the server-side reach and
   * promotion logic — never the wire: the order it belongs to, that order's
   * projects in position order, and the project's own position. `undefined`
   * when the project is in no order. Returned whole, not visibility-filtered
   * (an internal read). `orderId` is the order's opaque equality key
   * (`EnvironmentOrderKey`) — never parsed, never on the wire.
   */
  orderOf(input: EnvironmentOrderOfInput): Promise<EnvironmentOrderLocation | undefined>;

  /**
   * Whether the tenant runs any environment order at all — its own, or one
   * of its orgs'. A cheap existence check for the paths that must change
   * once a tenant has an order (e.g. a model call with no run scope open is
   * refused rather than reading the tenant key). Reads only.
   */
  hasEnvironmentOrder(input: HasEnvironmentOrderInput): Promise<boolean>;
}

/** The tenant itself, or one of its orgs, as an order's parent. */
export type EnvironmentOrderParent =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'org'; readonly orgId: OrgId };

/**
 * A page cursor over a tenant's orders: the parent a page ended on. The
 * route encodes it into, and decodes it from, the opaque wire cursor; a
 * binding neither parses nor builds the wire form, it just carries this.
 */
export interface EnvironmentOrderCursor {
  /** The org the last-returned order belongs to, or `null` for the tenant's own. */
  readonly orgId: string | null;
}

export interface EnvironmentOrderListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  /** Resume after this parent; absent starts at the first page. The route decodes it from the wire cursor. */
  readonly after?: EnvironmentOrderCursor;
}

export interface EnvironmentOrderListPage {
  readonly orders: readonly EnvironmentOrder[];
  /** The parent to resume after when another page follows; the route encodes it into the wire cursor. */
  readonly nextAfter?: EnvironmentOrderCursor;
}

export interface EnvironmentOrderGetInput {
  readonly tenantId: TenantId;
  readonly parent: EnvironmentOrderParent;
}

/** An order and its projects, in position order: 0-based and contiguous. */
export interface EnvironmentOrder {
  readonly parent: EnvironmentOrderParent;
  readonly entries: readonly EnvironmentOrderEntry[];
}

export interface EnvironmentOrderEntry {
  /** 0-based index into the order. Contiguous across the live members. */
  readonly position: number;
  readonly projectId: ProjectId;
}

export interface EnvironmentOrderSetInput {
  readonly tenantId: TenantId;
  readonly parent: EnvironmentOrderParent;
  /** The projects, in order. Empty clears the order. */
  readonly projectIds: readonly ProjectId[];
}

export type EnvironmentOrderSetOutcome =
  | {
      readonly kind: 'ok';
      readonly order: EnvironmentOrder;
      /**
       * The order's projects before and after the write, in order — for the
       * `environment-order-set` audit record. Full, never visibility-hidden.
       */
      readonly before: readonly ProjectId[];
      readonly after: readonly ProjectId[];
    }
  | {
      /** The write would leave the order exactly as it is: nothing written, nothing recorded. */
      readonly kind: 'no-op';
      readonly order: EnvironmentOrder;
    }
  | {
      /**
       * The request can't be accepted: a project that isn't live in the
       * tenant under this parent. `message` names the project and the reason.
       */
      readonly kind: 'bad-input';
      readonly message: string;
    }
  | {
      /** A project in the request already belongs to another order. */
      readonly kind: 'project-in-another-order';
      readonly projectId: ProjectId;
      readonly message: string;
    };

export interface EnvironmentOrderOfInput {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
}

/**
 * A project's place in its order, for server-side logic. `projects` is the
 * whole order in position order (0-based, contiguous); `position` indexes the
 * queried project within it, so `projects[position]` is that project and
 * `projects[position + 1]` is its next environment.
 */
export interface EnvironmentOrderLocation {
  /** The order's opaque equality key. Never parsed, never on the wire. */
  readonly orderId: EnvironmentOrderKey;
  readonly parent: EnvironmentOrderParent;
  readonly projects: readonly ProjectId[];
  readonly position: number;
}

export interface HasEnvironmentOrderInput {
  readonly tenantId: TenantId;
}
