// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import { ref } from '@kindgi/authz';
import { emitAuditEvent } from '@kindgi/compliance';
import type { ProjectId, TenantId, UserId } from '@kindgi/types';

import { isTenantAdmin } from '../caller.js';
import { statusFor, toWireError } from '../errors.js';
import type { IdentityDirectoryBinding } from '../identity-directory-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { ServiceAccountBinding } from '../service-account-binding.js';
import type { TriggerOwner } from '../trigger-binding.js';
import type { AppEnv } from '../types.js';
import { deniedBy } from './denied.js';

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
  /** Whether the caller may not `act_as` the account (`true` → refused). */
  readonly actAsDenied: (serviceAccountId: string) => Promise<boolean>;
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
  if (await deps.actAsDenied(serviceAccountId)) {
    return { kind: 'refused', response: forbidden() };
  }
  return { kind: 'owner', owner: { kind: 'service', id: serviceAccountId } };
}

/**
 * Whether the caller may not `act_as` the named service account. With an
 * authorization model, the model decides — `act_as` on the account, which
 * tenant admins hold. WITHOUT one (the default single-tenant self-host) the
 * model can grant nothing, so the decision falls back to the tenant-admin
 * check, read from the token's scopes: a non-admin is refused. Otherwise a
 * model-off deployment would let any caller name any account as a trigger's
 * owner, and naming an id would probe which accounts the tenant has.
 */
async function mayNotActAs(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  serviceAccountId: string,
): Promise<boolean> {
  if (authorizer === undefined) return !(await isTenantAdmin(c, authorizer));
  return (
    (await deniedBy(authorizer, c, 'act_as', ref('service_account', serviceAccountId))) !==
    undefined
  );
}

/**
 * The checks {@link resolveTriggerOwner} runs, built from the route's
 * authorizer. The one place the `act_as` decision and its model-off fallback
 * live, so the webhook and schedule routers can't drift on who may name a
 * service account.
 */
export function triggerOwnerDeps(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  serviceAccounts: Pick<ServiceAccountBinding, 'get'> | undefined,
): ResolveTriggerOwnerDeps {
  return {
    serviceAccounts,
    canReadServiceAccounts: () => isTenantAdmin(c, authorizer),
    actAsDenied: (serviceAccountId) => mayNotActAs(c, authorizer, serviceAccountId),
  };
}

type EmitAuditEventArgs = Parameters<typeof emitAuditEvent>[0];

/**
 * Records a trigger's owner being set: a schedule or webhook created to run
 * as a service account, and every take-over. `from` is absent on a register
 * (no prior owner), present on a take-over (a plain caller one included).
 * A take-over keeps the trigger's `toolsAllowedUnattended`, so the entry
 * names it when it lists any: what the new owner's runs may call without
 * a person's yes. The one place the `trigger-owner-set` evidence is shaped.
 */
export async function recordOwnerSet(args: {
  readonly auditEvents: EmitAuditEventArgs['auditEvents'];
  readonly tenantId: TenantId;
  readonly projectId?: ProjectId;
  readonly triggerId: string;
  readonly triggerKind: 'webhook' | 'cron';
  readonly from?: TriggerOwner;
  readonly to: TriggerOwner;
  readonly by: string | undefined;
  readonly correlationId: string;
  readonly log: EmitAuditEventArgs['log'];
  /** The trigger's `toolsAllowedUnattended`, kept through the change. */
  readonly toolsAllowedUnattended?: readonly string[];
}): Promise<void> {
  const {
    auditEvents,
    tenantId,
    projectId,
    triggerId,
    triggerKind,
    from,
    to,
    by,
    correlationId,
    log,
    toolsAllowedUnattended,
  } = args;
  await emitAuditEvent({
    auditEvents,
    tenantId,
    ...(projectId !== undefined && { projectId }),
    kind: 'trigger-owner-set',
    ...(by !== undefined && { actor: by }),
    correlationId,
    doc: {
      triggerId,
      triggerKind,
      ...(from !== undefined && { from: ownerKey(from) }),
      to: ownerKey(to),
      ...(by !== undefined && { by }),
      ...(toolsAllowedUnattended !== undefined &&
        toolsAllowedUnattended.length > 0 && {
          toolsAllowedUnattended: [...toolsAllowedUnattended],
        }),
    },
    ...(log !== undefined && { log }),
  });
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
