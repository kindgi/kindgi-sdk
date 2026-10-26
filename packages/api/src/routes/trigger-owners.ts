// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import { ref } from '@kindgi/authz';
import { emitAuditEvent } from '@kindgi/compliance';
import type { ProjectId, TenantId, UserId } from '@kindgi/types';

import { callerRef, isTenantAdmin } from '../caller.js';
import { statusFor, toWireError } from '../errors.js';
import type { IdentityDirectoryBinding } from '../identity-directory-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { ServiceAccountBinding } from '../service-account-binding.js';
import type { TriggerOwner } from '../trigger-binding.js';
import type { AppEnv } from '../types.js';
import { deniedBy, refused } from './denied.js';

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

/**
 * Whether the caller is an admin of a trigger's project, for the checks
 * every trigger kind's routes make: `admin` on the project with an
 * authorization model. WITHOUT one the model can grant nothing, and a
 * check of the model would let every caller through; so the decision
 * falls back to the tenant-admin check, read from the token's scopes, as
 * {@link mayNotActAs} does. Otherwise any member would count as an admin,
 * and could retarget a colleague's trigger, which would go on reading that
 * colleague's mail.
 */
export async function isTriggerAdmin(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  projectId: string,
): Promise<boolean> {
  if (authorizer === undefined) return isTenantAdmin(c, undefined);
  return authorizer.can(c, 'admin', ref('project', projectId));
}

/**
 * Whether the caller may change a personal trigger, one a person owns:
 * its owner, while they hold `write` on its project, or an admin of the
 * project ({@link isTriggerAdmin}). Its owner stays either way: only a
 * take-over moves it.
 */
export async function mayChangePersonalTrigger(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  trigger: { readonly projectId: string; readonly owner: TriggerOwner },
): Promise<boolean> {
  const caller = ownerOf(c);
  if (caller.kind === trigger.owner.kind && caller.id === trigger.owner.id) {
    if (authorizer === undefined) return true;
    if (await authorizer.can(c, 'write', ref('project', trigger.projectId))) return true;
  }
  return isTriggerAdmin(c, authorizer, trigger.projectId);
}

/** Whether the caller is `owner`: the same kind and id. */
export function callerOwns(c: Context<AppEnv>, owner: TriggerOwner): boolean {
  const caller = ownerOf(c);
  return caller.kind === owner.kind && caller.id === owner.id;
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
  readonly triggerKind: 'webhook' | 'cron' | 'mail';
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

/** What was done to a person's trigger by someone else. */
export type TriggerOwnerChange =
  | 'updated'
  | 'paused'
  | 'resumed'
  | 'unregistered'
  | 'fired'
  | 'taken-over';

/**
 * Records a change to a personal trigger by anyone but its owner (a
 * project admin), as `trigger-changed-for-owner`: what was done, and on an
 * update the names of the fields changed, the target before and after, a
 * webhook's signing secret's name before and after, and a mail trigger's
 * mailbox and folder before and after. Never an input's
 * value, and never what a run did. The owner stays, so its runs keep
 * acting as them; the entry is the durable record of who changed it. A
 * take-over is `trigger-owner-set` instead ({@link recordOwnerSet}).
 */
export async function recordChangeForOwner(args: {
  readonly auditEvents: EmitAuditEventArgs['auditEvents'];
  readonly tenantId: TenantId;
  readonly projectId?: ProjectId;
  readonly triggerId: string;
  readonly triggerKind: 'webhook' | 'cron' | 'mail';
  readonly owner: TriggerOwner;
  readonly by: string | undefined;
  readonly change: Exclude<TriggerOwnerChange, 'taken-over'>;
  readonly fields?: readonly string[];
  readonly target?: { readonly before: unknown; readonly after: unknown };
  readonly hmacSecretName?: { readonly before: string; readonly after: string };
  readonly mailbox?: { readonly before: unknown; readonly after: unknown };
  readonly folder?: { readonly before: unknown; readonly after: unknown };
  readonly correlationId: string;
  readonly log: EmitAuditEventArgs['log'];
}): Promise<void> {
  const { auditEvents, tenantId, projectId, by, correlationId, log } = args;
  await emitAuditEvent({
    auditEvents,
    tenantId,
    ...(projectId !== undefined && { projectId }),
    kind: 'trigger-changed-for-owner',
    ...(by !== undefined && { actor: by }),
    correlationId,
    doc: {
      triggerId: args.triggerId,
      triggerKind: args.triggerKind,
      owner: ownerKey(args.owner),
      ...(by !== undefined && { by }),
      change: args.change,
      ...(args.fields !== undefined && args.fields.length > 0 && { fields: [...args.fields] }),
      ...(args.target !== undefined && { target: args.target }),
      ...(args.hmacSecretName !== undefined && { hmacSecretName: args.hmacSecretName }),
      ...(args.mailbox !== undefined && { mailbox: args.mailbox }),
      ...(args.folder !== undefined && { folder: args.folder }),
    },
    ...(log !== undefined && { log }),
  });
}

/**
 * A change a person didn't make to a trigger they own: a project admin's
 * edit, pause, resume, fire or delete, or a take-over from them. It names
 * fields, never their values.
 */
export interface TriggerOwnerNotice {
  readonly tenantId: TenantId;
  readonly projectId?: ProjectId;
  readonly triggerId: string;
  readonly triggerKind: 'cron' | 'webhook' | 'mail';
  /** The trigger's label, when it has one. */
  readonly label?: string;
  /** The person told: the owner, or the former owner after a take-over. */
  readonly owner: TriggerOwner;
  /** Who did it: `user:<id>` or `service_account:<id>`. */
  readonly by: string | undefined;
  /** When, as an ISO 8601 instant. */
  readonly at: string;
  readonly change: TriggerOwnerChange;
  /**
   * On `updated`: the wire names of the fields changed. What it runs:
   * `target` (its flow or agent, or their version), `input`,
   * `toolsAllowedUnattended`, a webhook's `hmacSecretName`; else `label`, a
   * schedule's `cronExpression`, `timezone`, `catchUp`, `overlap` and
   * `startingDeadlineSeconds`, a webhook's `signature`, `deliveryIdHeader`,
   * `bodyLimitBytes` and `rateLimitPerMinute`, a mail trigger's `mailbox`,
   * `folder`, `pollSeconds` and `runsPerHour`. Never their values.
   */
  readonly fields?: readonly string[];
}

/**
 * Tells a person what someone else did to a trigger they own (the runtime
 * emails them). Called once the change has been made, and never awaited:
 * a slow or failing `tell` neither holds up nor fails the request.
 */
export interface TriggerOwnerNotices {
  tell(notice: TriggerOwnerNotice): void | Promise<void>;
}

/**
 * Hands `notice` to `notices` without waiting for it, when it's for a
 * person. A throw or a rejection is logged with the request id and goes no
 * further.
 */
export function tellOwner(
  c: Context<AppEnv>,
  notices: TriggerOwnerNotices | undefined,
  notice: TriggerOwnerNotice,
): void {
  if (notices === undefined || notice.owner.kind !== 'user') return;
  const requestId = c.get('requestId');
  const log = c.get('log');
  const failed = (err: unknown) => {
    log.warn(
      `trigger ${notice.triggerId}: telling its owner it was ${notice.change} failed (request ${requestId}): ${err instanceof Error ? err.message : String(err)}`,
    );
  };
  try {
    Promise.resolve(notices.tell(notice)).catch(failed);
  } catch (err) {
    failed(err);
  }
}

/**
 * The 403 for a change a trigger's owner rule refuses, recorded with the
 * authorizer as its own refusals are. On a personal trigger it names the
 * owner (their name, else their id); on a shared one, or one with no
 * owner, it says what takes an admin.
 */
export async function ownerRuleRefused(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  names: TriggerOwnerNames | undefined,
  trigger: { readonly projectId: string; readonly owner: TriggerOwner },
  word: TriggerWord,
): Promise<Response> {
  const { projectId, owner } = trigger;
  let message = `Changing what a shared ${word} runs takes a project admin.`;
  if (owner.kind === 'user') {
    const found = await ownerNamesOf(names, c.get('tenantId') as TenantId, [owner]);
    const who = found.get(ownerKey(owner)) ?? owner.id;
    message = `This ${word} is personal: only ${who} or a project admin can change it.`;
  }
  return refused(c, authorizer, {
    action: 'admin',
    resource: ref('project', projectId),
    message,
    failing: 'actor',
  });
}

/** How a 403 names a trigger's kind. */
type TriggerWord = 'schedule' | 'webhook trigger' | 'mail trigger';

/** A schedule, webhook or mail trigger, as the owner rule reads it. */
export interface OwnedTrigger {
  readonly tenantId: TenantId;
  readonly triggerId: string;
  readonly projectId: string;
  readonly label: string | null;
  readonly owner: TriggerOwner;
}

/**
 * Nothing when the caller may change `trigger`; else the 403. A personal
 * trigger is its owner's (holding `write`) or a project admin's to change
 * ({@link mayChangePersonalTrigger}), for every change: an edit, a pause, a
 * resume, a fire, a delete. A shared one is the project's writers', but
 * for what it runs (the route checks that, {@link triggerAdminRefusal}).
 * Asked after the route's own `write` check, so a caller without it gets
 * the authorizer's 403 first, which never names the owner.
 */
export async function personalTriggerRefusal(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  names: TriggerOwnerNames | undefined,
  trigger: OwnedTrigger,
  word: TriggerWord,
): Promise<Response | undefined> {
  if (trigger.owner.kind !== 'user') return undefined;
  if (await mayChangePersonalTrigger(c, authorizer, trigger)) return undefined;
  return ownerRuleRefused(c, authorizer, names, trigger, word);
}

/**
 * Nothing when the caller is an admin of `projectId` (the tenant, when
 * there's none); else the 403. With an authorizer it asks `admin` there,
 * as {@link isTriggerAdmin} does, and answers its own 403; without one,
 * only a tenant-admin key is, and `message` says what takes one.
 */
export async function triggerAdminRefusal(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  projectId: string | undefined,
  message: string,
): Promise<Response | undefined> {
  const resource =
    projectId === undefined
      ? ref('tenant', c.get('tenantId') as unknown as string)
      : ref('project', projectId);
  if (authorizer !== undefined) return deniedBy(authorizer, c, 'admin', resource);
  if (await isTenantAdmin(c, authorizer)) return undefined;
  return refused(c, authorizer, { action: 'admin', resource, message, failing: 'actor' });
}

/**
 * After a change to a personal trigger by anyone but its owner (a project
 * admin): records it ({@link recordChangeForOwner}), then tells the owner
 * ({@link tellOwner}) without waiting. Nothing for a shared trigger, for
 * the owner's own change, or for an update that changed no field. The
 * routes call it; the runtime's own writes (an auto-pause, its fires)
 * never do.
 */
export async function noteChangeForOwner(
  c: Context<AppEnv>,
  args: {
    readonly auditEvents: EmitAuditEventArgs['auditEvents'];
    readonly notices: TriggerOwnerNotices | undefined;
    readonly trigger: OwnedTrigger;
    readonly triggerKind: 'webhook' | 'cron' | 'mail';
    readonly change: Exclude<TriggerOwnerChange, 'taken-over'>;
    readonly fields?: readonly string[];
    readonly target?: { readonly before: unknown; readonly after: unknown };
    readonly hmacSecretName?: { readonly before: string; readonly after: string };
    readonly mailbox?: { readonly before: unknown; readonly after: unknown };
    readonly folder?: { readonly before: unknown; readonly after: unknown };
  },
): Promise<void> {
  const { auditEvents, notices, trigger, triggerKind, change, fields } = args;
  if (trigger.owner.kind !== 'user' || callerOwns(c, trigger.owner)) return;
  if (change === 'updated' && (fields === undefined || fields.length === 0)) return;
  const by = callerRef(c);
  const projectId = trigger.projectId as ProjectId;
  await recordChangeForOwner({
    auditEvents,
    tenantId: trigger.tenantId,
    projectId,
    triggerId: trigger.triggerId,
    triggerKind,
    owner: trigger.owner,
    by,
    change,
    ...(fields !== undefined && { fields }),
    ...(args.target !== undefined && { target: args.target }),
    ...(args.hmacSecretName !== undefined && { hmacSecretName: args.hmacSecretName }),
    ...(args.mailbox !== undefined && { mailbox: args.mailbox }),
    ...(args.folder !== undefined && { folder: args.folder }),
    correlationId: c.get('requestId'),
    log: c.get('log'),
  });
  tellOwner(c, notices, {
    tenantId: trigger.tenantId,
    projectId,
    triggerId: trigger.triggerId,
    triggerKind,
    ...(trigger.label !== null && { label: trigger.label }),
    owner: trigger.owner,
    by,
    at: new Date().toISOString(),
    change,
    ...(fields !== undefined && { fields }),
  });
}

/**
 * After a take-over of a personal trigger by anyone but its owner: tells
 * the former owner its runs no longer act as them. The take-over itself is
 * audited as `trigger-owner-set` ({@link recordOwnerSet}).
 */
export function tellTakenOver(
  c: Context<AppEnv>,
  notices: TriggerOwnerNotices | undefined,
  trigger: OwnedTrigger,
  triggerKind: 'webhook' | 'cron' | 'mail',
): void {
  if (trigger.owner.kind !== 'user' || callerOwns(c, trigger.owner)) return;
  tellOwner(c, notices, {
    tenantId: trigger.tenantId,
    projectId: trigger.projectId as ProjectId,
    triggerId: trigger.triggerId,
    triggerKind,
    ...(trigger.label !== null && { label: trigger.label }),
    owner: trigger.owner,
    by: callerRef(c),
    at: new Date().toISOString(),
    change: 'taken-over',
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
