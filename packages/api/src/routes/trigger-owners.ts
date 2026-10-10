// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import type { TenantId, UserId } from '@kindgi/types';

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
