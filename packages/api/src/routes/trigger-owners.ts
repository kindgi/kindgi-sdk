// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import type { TenantId, UserId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { IdentityDirectoryBinding } from '../identity-directory-binding.js';
import type { ServiceAccountBinding } from '../service-account-binding.js';
import type { TriggerOwner } from '../trigger-binding.js';
import type { AppEnv } from '../types.js';

/**
 * Where a trigger owner's name is read (`owner.displayName`): the person's
 * from the directory, the service account's from its binding. Without
 * one, that kind of owner has no name, and its id stands.
 */
export interface TriggerOwnerNames {
  readonly directory?: Pick<IdentityDirectoryBinding, 'getUser'>;
  readonly serviceAccounts?: Pick<ServiceAccountBinding, 'get'>;
}

/** Who a trigger's runs act as: the request's principal. */
export function ownerOf(c: Context<AppEnv>): TriggerOwner {
  const actor = c.get('principal')?.actor;
  if (actor === undefined) return { kind: 'service', id: 'unknown' };
  return { kind: actor.kind === 'user' ? 'user' : 'service', id: actor.id };
}

/** The outcome of resolving the owner a register or take-over sets. */
export type TriggerOwnerResolution =
  | { readonly kind: 'owner'; readonly owner: TriggerOwner }
  | { readonly kind: 'refused'; readonly response: Response };

/** What {@link resolveTriggerOwner} needs from the route to run its checks. */
export interface ResolveTriggerOwnerDeps {
  /** Reads a service account in the caller's tenant (`null` when there's none). */
  readonly serviceAccounts: Pick<ServiceAccountBinding, 'get'> | undefined;
  /**
   * Whether the caller may read service accounts (a tenant admin). It gates
   * what a refusal discloses: a reader learns whether the account exists; a
   * non-reader can't tell a missing account from one it may not name.
   */
  readonly canReadServiceAccounts: () => Promise<boolean>;
  /** The route's 403 when the caller may not `act_as` the account, else nothing. */
  readonly actAsDenied: (serviceAccountId: string) => Promise<Response | undefined>;
}

/**
 * The owner a register or take-over sets. Absent `runAsServiceAccountId`,
 * it's the caller — exactly {@link ownerOf}, today's rule. Named, it's that
 * service account, after two checks:
 *   1. A **reader-ordered** existence check. Only a caller who may read
 *      service accounts learns whether the named one exists: a missing or
 *      another tenant's → 404, an unregistered one → 409. Everyone else gets
 *      the same 403 whether or not it exists, so a non-reader can't probe
 *      the tenant's accounts by naming ids.
 *   2. The **delegation gate** — `act_as` on the account, which tenant
 *      admins hold.
 * The named value is a service-account id only — never a user id — so a
 * caller can't name a person as the owner (no impersonation).
 */
export async function resolveTriggerOwner(
  c: Context<AppEnv>,
  runAsServiceAccountId: string | undefined,
  deps: ResolveTriggerOwnerDeps,
): Promise<TriggerOwnerResolution> {
  if (runAsServiceAccountId === undefined) return { kind: 'owner', owner: ownerOf(c) };

  const serviceAccountId = runAsServiceAccountId;
  const requestId = c.get('requestId');
  const tenantId = c.get('tenantId') as TenantId;
  // One 403 for every reason a non-reader is refused, so a missing account
  // and one the caller may not name are indistinguishable to them.
  const forbidden = (): Response =>
    ownerError(
      c,
      requestId,
      'permission-denied',
      "You can't name that service account as the trigger's owner.",
    );

  const canRead = await deps.canReadServiceAccounts();
  const account = await deps.serviceAccounts?.get({ tenantId, serviceAccountId });
  if (account === undefined || account === null) {
    return {
      kind: 'refused',
      response: canRead
        ? ownerError(
            c,
            requestId,
            'service-account-not-found',
            `No service account with id "${serviceAccountId}" in this tenant`,
          )
        : forbidden(),
    };
  }
  if (account.unregisteredAt !== undefined) {
    return {
      kind: 'refused',
      response: canRead
        ? ownerError(
            c,
            requestId,
            'service-account-unregistered',
            `Service account "${serviceAccountId}" is no longer registered; name an active one.`,
          )
        : forbidden(),
    };
  }
  if ((await deps.actAsDenied(serviceAccountId)) !== undefined) {
    return { kind: 'refused', response: forbidden() };
  }
  return { kind: 'owner', owner: { kind: 'service', id: serviceAccountId } };
}

function ownerError(
  c: Context<AppEnv>,
  requestId: string,
  code: string,
  message: string,
): Response {
  c.status(statusFor(code) as never);
  return c.json(toWireError({ code, message }, requestId));
}

/** An owner's key in the names {@link ownerNamesOf} returns. */
export function ownerKey(owner: TriggerOwner): string {
  return `${owner.kind}:${owner.id}`;
}

/**
 * Each owner's name at the time of the response, by `kind:id`, read once
 * per owner: the person's display name, or the service account's name.
 * One that can't be read (no binding, a removed account, a failed read)
 * has none.
 */
export async function ownerNamesOf(
  names: TriggerOwnerNames | undefined,
  tenantId: TenantId,
  owners: readonly TriggerOwner[],
): Promise<ReadonlyMap<string, string>> {
  const unique = new Map(owners.map((owner) => [ownerKey(owner), owner]));
  const found = new Map<string, string>();
  await Promise.all(
    [...unique].map(async ([key, owner]) => {
      try {
        const name =
          owner.kind === 'user'
            ? (await names?.directory?.getUser({ tenantId, userId: owner.id as UserId }))
                ?.displayName
            : (await names?.serviceAccounts?.get({ tenantId, serviceAccountId: owner.id }))?.name;
        if (name !== undefined && name.length > 0) found.set(key, name);
      } catch {
        // A name that can't be read: the owner's id stands.
      }
    }),
  );
  return found;
}

/** An owner as the wire carries it, named when its name was read. */
export function ownerJson(
  owner: TriggerOwner,
  names: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const displayName = names.get(ownerKey(owner));
  return { kind: owner.kind, id: owner.id, ...(displayName !== undefined && { displayName }) };
}
