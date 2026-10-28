// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectRole } from '@kindgi/platform';
import type { Cursor, Result, TenantId, Timestamp } from '@kindgi/types';

/**
 * Service accounts: named, non-human principals (`service_account:<id>`)
 * for an app, a pipeline or a schedule's runs. A service account holds
 * its own grants, set when it's created and changed by a tenant admin,
 * and acts through API keys minted for it (`POST /v1/tokens` with `for`),
 * several at once for rotation. Every route needs a tenant admin.
 *
 * Grants are written before a call answers, so a key minted for a new
 * account works on its first request. Unregistering an account is a
 * tombstone: its grants go, its keys stop working, and it stays readable.
 *
 * A project may have one account of its own (`projectId` set), made the
 * first time a trigger runs as the project (`projectAccounts`). It runs
 * only the triggers with `runAsProject`, not the project's other shared
 * triggers. It has no keys, and its one grant, `editor` on the project, is
 * fixed.
 */

/**
 * What a service account may do: tenant admin, tenant member (read the
 * tenant's settings), or a role on one project. Unlike a person, an
 * account isn't a tenant member unless it's granted that.
 */
export type ServiceAccountGrant =
  | { readonly kind: 'tenant-admin' }
  | { readonly kind: 'tenant-member' }
  | { readonly kind: 'project'; readonly projectId: string; readonly role: ProjectRole };

/** A grant to remove: tenant admin, tenant member, or whatever role the account has on a project. */
export type ServiceAccountGrantTarget =
  | { readonly kind: 'tenant-admin' }
  | { readonly kind: 'tenant-member' }
  | { readonly kind: 'project'; readonly projectId: string };

export interface ServiceAccount {
  readonly serviceAccountId: string;
  readonly tenantId: TenantId;
  /** Unique among the tenant's active accounts, e.g. `acme-ci`. */
  readonly name: string;
  readonly description?: string;
  /** Its grants, at the time of the read. */
  readonly grants: readonly ServiceAccountGrant[];
  /** Who created it: `user:<id>` or `service_account:<id>`. */
  readonly createdBy?: string;
  readonly createdAt: Timestamp;
  /** Set once unregistered: no grants, and its keys no longer work. */
  readonly unregisteredAt?: Timestamp;
  /**
   * Set on a project's own account. It runs only the triggers with
   * `runAsProject`. It has no keys, and its grant is fixed.
   */
  readonly projectId?: string;
}

export interface ServiceAccountCreateInput {
  readonly tenantId: TenantId;
  readonly name: string;
  readonly description?: string;
  /** Written with the account, before `create` returns. */
  readonly grants: readonly ServiceAccountGrant[];
  readonly createdBy?: string;
}

export interface ServiceAccountRef {
  readonly tenantId: TenantId;
  readonly serviceAccountId: string;
}

/** A change to an account, and who made it: `user:<id>` or `service_account:<id>`. */
export interface ServiceAccountChange extends ServiceAccountRef {
  readonly by?: string;
}

export interface ServiceAccountListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  /** Unregistered accounts too (default: active only). */
  readonly includeUnregistered?: boolean;
}

export type ServiceAccountErrorCode =
  /** An active account of the tenant already has this name. */
  | 'service-account-name-taken'
  | 'service-account-not-found'
  /** A grant for an unregistered account. */
  | 'service-account-unregistered'
  /** A grant names a project the tenant doesn't have. */
  | 'project-not-found'
  /** A grant or ungrant on a project's own account, whose grant is fixed. */
  | 'service-account-project-owned';

export interface ServiceAccountError {
  readonly code: ServiceAccountErrorCode;
  readonly message: string;
}

/**
 * A project's own account: one per project, made the first time a trigger
 * runs as the project. Both methods come together or not at all.
 */
export interface ServiceAccountProjectAccounts {
  /** The project's active own account, or `null`. */
  get(input: {
    readonly tenantId: TenantId;
    readonly projectId: string;
  }): Promise<ServiceAccount | null>;
  /**
   * The project's active own account, made with its grant (`editor` on the
   * project) the first time. Returns only once the grant is written, on
   * both paths: a second caller writes the held grant again, a no-op, so a
   * racer can't return an account whose grant the first caller hasn't
   * written yet. When that write fails, the account stays and the error is
   * thrown: the next call writes the grant again. Refused with
   * `project-not-found`, or `service-account-name-taken` when an active
   * account someone made already has its name.
   */
  ensure(input: {
    readonly tenantId: TenantId;
    readonly projectId: string;
    /** Who first named it: `user:<id>` or `service_account:<id>`. */
    readonly by?: string;
  }): Promise<Result<ServiceAccount, ServiceAccountError>>;
}

export interface ServiceAccountBinding {
  create(input: ServiceAccountCreateInput): Promise<Result<ServiceAccount, ServiceAccountError>>;
  /** Unregistered accounts too, or `null`. */
  get(input: ServiceAccountRef): Promise<ServiceAccount | null>;
  /** Oldest first. */
  list(input: ServiceAccountListInput): Promise<{
    readonly data: readonly ServiceAccount[];
    readonly nextCursor?: Cursor;
  }>;
  /**
   * Add a grant (a no-op when held). A project role replaces the
   * account's role on that project. Not for an unregistered account, nor
   * a project's own account (`service-account-project-owned`).
   */
  grant(
    input: ServiceAccountChange & { readonly grant: ServiceAccountGrant },
  ): Promise<Result<ServiceAccount, ServiceAccountError>>;
  /** Remove a grant (a no-op when not held). Not on a project's own account. */
  ungrant(
    input: ServiceAccountChange & { readonly grant: ServiceAccountGrantTarget },
  ): Promise<Result<ServiceAccount, ServiceAccountError>>;
  /** Tombstone the account: its grants go and its keys stop working. Idempotent. */
  unregister(input: ServiceAccountChange): Promise<Result<ServiceAccount, ServiceAccountError>>;
  /**
   * A project's own account. Absent: this deployment can't make one, and a
   * trigger can't run as its project.
   */
  readonly projectAccounts?: ServiceAccountProjectAccounts;
}
