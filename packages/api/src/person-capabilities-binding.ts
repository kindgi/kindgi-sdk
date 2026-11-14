// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Result, TenantId, UserId } from '@kindgi/types';

/**
 * The capabilities a person holds (`env:write`, `secrets:write`,
 * `signing-keys:write`, …): what the writes that need one check, on top of
 * the caller's role. An API key carries those it was minted with. A
 * sign-in session carries its person's, read here on each request, so one
 * taken away stops at once.
 *
 * The runtime decides who holds what first, for example the first admin a
 * tenant is created with. A person puts what they hold on the keys they
 * mint: `POST /v1/tokens` grants only capabilities the minter holds.
 *
 * Tenant admins give and take back the rest
 * (`POST /v1/identity/users/:userId/capabilities`, `DELETE
 * …/capabilities/:capability`): an admin gives another tenant admin only
 * what their own person holds now, and takes back only what they hold.
 * A key's list never counts, so a service account or a system key gives
 * and takes back nothing. A person may drop their own, the last holder's
 * included. The binding checks all of this under the tenant's admins
 * lock, after the route has checked the caller's role.
 *
 * A system capability (`kindgi:system` or `system:*`) is never a person's:
 * one this returns is dropped, and none is given.
 */
export interface PersonCapabilitiesBinding {
  /** What `userId` holds in `tenantId`: an empty list when nothing. */
  held(person: {
    readonly tenantId: TenantId;
    readonly userId: UserId;
  }): Promise<readonly string[]>;
  /**
   * Gives `capabilities` to `userId`, as the person `by` names. Answers with
   * what `userId` holds after. Optional: without it, the give route answers
   * `501 person-capabilities-unsupported`.
   */
  give?(
    input: PersonCapabilityChange & { readonly capabilities: readonly string[] },
  ): Promise<Result<readonly string[], PersonCapabilityError>>;
  /**
   * Takes `capability` back from `userId`, as the person `by` names (or
   * `userId` drops their own). One they don't hold is left as it is.
   * Answers with what `userId` holds after. Optional: without it, the take
   * back route answers `501 person-capabilities-unsupported`.
   */
  takeBack?(
    input: PersonCapabilityChange & { readonly capability: string },
  ): Promise<Result<readonly string[], PersonCapabilityError>>;
}

/** A change to what a person holds, and who asks for it. */
export interface PersonCapabilityChange {
  readonly tenantId: TenantId;
  /** The person given to, or taken from. */
  readonly userId: UserId;
  /** Who asks, as the routes name a caller: `user:<id>` or `service_account:<id>`; absent for a system key. */
  readonly by?: string;
}

export type PersonCapabilityErrorCode =
  /** A service account or a system key asked: only a person's own rows bound what is given. */
  | 'caller-not-a-person'
  /** The caller's person isn't a tenant admin now. */
  | 'permission-denied'
  /** No such person in the tenant. */
  | 'identity-user-not-found'
  /** The person was removed from the tenant. */
  | 'identity-user-unregistered'
  /** The person given to isn't a tenant admin now: only a tenant admin is given capabilities. */
  | 'receiver-not-tenant-admin'
  /** `secrets:reveal` or a system capability: no person gives it. */
  | 'capability-not-givable'
  /** The caller's person doesn't hold it (or one of them) now. */
  | 'capability-not-held';

export interface PersonCapabilityError {
  readonly code: PersonCapabilityErrorCode;
  readonly message: string;
}
