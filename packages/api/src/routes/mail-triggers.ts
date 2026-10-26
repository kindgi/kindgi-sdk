// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';
import type { Context } from 'hono';

import type { AuditEventBinding } from '@kindgi/audit-events';
import { type Action, type ResourceRef, ref } from '@kindgi/authz';
import type { ProjectBinding } from '@kindgi/platform';
import type { Cursor, ProjectId, TenantId, TriggerId } from '@kindgi/types';

import { callerRef, isTenantAdmin } from '../caller.js';
import { sameJson } from '../canonical-json.js';
import { statusFor, toWireError } from '../errors.js';
import { type ItemRights, runIn } from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import {
  type ReferenceScopeBinding,
  outOfScopeResponse,
  referencesOutOfScope,
  triggerTargetReference,
} from '../reference-scope.js';
import {
  MAIL_TRIGGER_LIMITS,
  type MailTriggerConfig,
  type MailTriggerMailbox,
  type MailTriggerRecord,
  type MailTriggerTarget,
  type RegisterMailTriggerInput,
  type TriggerFire,
  type TriggerRegistryBinding,
  type UpdateMailTriggerInput,
} from '../trigger-binding.js';
import type { AppEnv } from '../types.js';
import { refused } from './denied.js';
import { clampLimit } from './pagination.js';
import {
  type OwnedTrigger,
  type TriggerOwnerNames,
  type TriggerOwnerNotices,
  callerOwns,
  isTriggerAdmin,
  mayChangePersonalTrigger,
  noteChangeForOwner,
  ownerCannotRunRefusal,
  ownerJson,
  ownerNamesOf,
  ownerOf,
  ownerRuleRefused,
  recordOwnerSet,
  resolveTriggerOwner,
  tellTakenOver,
  triggerOwnerDeps,
} from './trigger-owners.js';
import {
  type TargetToolsDeps,
  parseToolsAllowedUnattended,
  recordToolsAllowedUnattendedSet,
  retargets,
  sameToolList,
  toolsAllowedUnattendedProblem,
} from './trigger-tools.js';
import { UUID_RE } from './uuid-param.js';

export interface MailTriggersRouterOptions {
  readonly authorizer?: Authorizer;
  /** The tenant's Default project: where a mail trigger that names no project goes. */
  readonly projects?: Pick<ProjectBinding, 'getDefault'>;
  /** Where an owner's name is read (`owner.displayName`). */
  readonly names?: TriggerOwnerNames;
  /** Owner changes, list changes and an admin's change to a person's trigger are recorded here. */
  readonly auditEvents?: AuditEventBinding;
  /** What a mail trigger's project may run (`reference-scope.ts`); absent → as named. */
  readonly referenceScope?: ReferenceScopeBinding;
  /** Rights on what a mail trigger runs, when more than one project serves it. Absent: one project each. */
  readonly itemRights?: ItemRights;
  /** Where a target's agents and flows are read, to check `toolsAllowedUnattended`; absent → a list is refused. */
  readonly targetTools?: TargetToolsDeps;
  /** Tells a person what a project admin did to their trigger; absent → only audited. */
  readonly ownerNotices?: TriggerOwnerNotices;
}

/**
 * Mail triggers: each new mail in a mailbox's folder starts a run of an
 * agent or a flow, with the mail as the run's input.
 *
 *   POST /v1/mail-triggers                          register
 *   GET  /v1/mail-triggers[?projectId=&status=]     list (cursor-paginated)
 *   GET  /v1/mail-triggers/:triggerId               get
 *   PATCH /v1/mail-triggers/:triggerId              update
 *   POST /v1/mail-triggers/:triggerId/pause | resume | unregister
 *   GET  /v1/mail-triggers/:triggerId/fires         its mail's fires, newest first
 *   POST /v1/mail-triggers/:triggerId/owner         the caller becomes the owner
 *
 * A mail trigger is shared or personal, by its owner: a service account
 * owns a shared one, on the company's mailbox; a person owns a personal
 * one. No edit moves the owner; only `POST …/owner` does. Its runs act as
 * its owner, with that owner's connections.
 *
 * With an authorizer, reads need `read` on the trigger's project, and
 * registering or retargeting needs `execute` on what it runs. A person
 * mailbox's trigger is a project writer's to register; a company
 * mailbox's, a project admin's. A personal trigger's PATCH, pause, resume
 * and unregister are its owner's or a project admin's; a shared trigger's
 * PATCH is an admin's, and its pause, resume and unregister need `write`.
 * Every admin check here is `isTriggerAdmin`, so without an authorization
 * model it's the token's tenant-admin scope, never everyone. An admin's
 * change to a person's trigger is audited, and its owner told
 * (`ownerNotices`), as for schedules and webhooks.
 * `toolsAllowedUnattended` (`trigger-tools.ts`) is an admin's to set, and
 * a new target or mailbox while it lists any must name it again.
 */
export function mailTriggersRouter(
  binding: TriggerRegistryBinding,
  options: MailTriggersRouterOptions = {},
): Hono<AppEnv> {
  const {
    authorizer,
    projects,
    names,
    auditEvents,
    referenceScope,
    itemRights,
    targetTools,
    ownerNotices,
  } = options;
  const r = new Hono<AppEnv>();

  /** A mail trigger as the owner rule reads it. */
  const owned = (row: MailTriggerRecord): OwnedTrigger => ({
    tenantId: row.tenantId,
    triggerId: row.triggerId as unknown as string,
    projectId: row.projectId as unknown as string,
    label: row.label ?? null,
    owner: row.owner,
  });

  /** A mail trigger as the wire carries it, its owner named. */
  async function mailTriggerJson(c: Context<AppEnv>, row: MailTriggerRecord): Promise<Response> {
    const named = await ownerNamesOf(names, c.get('tenantId') as TenantId, [row.owner]);
    return c.json(serializeMailTrigger(row, named));
  }

  /** Nothing, when allowed; else the authorizer's own 403. */
  async function denied(
    c: Context<AppEnv>,
    action: Action,
    resource: ResourceRef,
  ): Promise<Response | undefined> {
    if (authorizer === undefined) return undefined;
    let allowed = false;
    const answer = await authorizer.authorize(action, async () => resource)(c, async () => {
      allowed = true;
    });
    return allowed ? undefined : (answer as Response);
  }

  /**
   * Nothing, when the caller is an admin of `project` (`isTriggerAdmin`),
   * or of the tenant when the trigger has no project yet; else a 403 that
   * says what `doing` takes.
   */
  async function notAdmin(
    c: Context<AppEnv>,
    project: string | undefined,
    doing: string,
  ): Promise<Response | undefined> {
    const tenantId = c.get('tenantId') as unknown as string;
    const admin =
      project === undefined
        ? await isTenantAdmin(c, authorizer)
        : await isTriggerAdmin(c, authorizer, project);
    if (admin) return undefined;
    return refused(c, authorizer, {
      action: 'admin',
      resource: project === undefined ? ref('tenant', tenantId) : ref('project', project),
      message: `${doing} takes ${project === undefined ? 'a tenant admin' : 'a project admin'}.`,
      failing: 'actor',
    });
  }

  /**
   * Nothing, when the caller may change `rec`: a personal trigger's owner
   * (a project writer) or a project admin; on a shared trigger, `shared`
   * says what it takes. Else a 403, which names a personal trigger's owner.
   */
  async function changeRefused(
    c: Context<AppEnv>,
    rec: MailTriggerRecord,
    shared: 'admin' | 'write',
  ): Promise<Response | undefined> {
    const project = rec.projectId as unknown as string;
    if (rec.owner.kind === 'service') {
      return shared === 'admin'
        ? notAdmin(c, project, 'Changing a shared mail trigger')
        : denied(c, 'write', ref('project', project));
    }
    if (await mayChangePersonalTrigger(c, authorizer, { projectId: project, owner: rec.owner })) {
      return undefined;
    }
    return ownerRuleRefused(c, authorizer, names, owned(rec), 'mail trigger');
  }

  /**
   * What starting `target` from a trigger in `projectId` needs, as starting
   * it by hand does: `execute` on it, or for a target more than one project
   * serves, that project's right (`runIn`).
   */
  async function targetRefused(
    c: Context<AppEnv>,
    target: MailTriggerTarget,
    projectId: string | undefined,
  ): Promise<Response | undefined> {
    const item =
      target.kind === 'flow'
        ? { kind: 'flow' as const, id: target.flowId as unknown as string }
        : { kind: 'agent' as const, id: target.agentId as unknown as string };
    const served =
      authorizer === undefined ? undefined : await itemRights?.multi(c, item.kind, item.id);
    if (
      itemRights !== undefined &&
      projectId !== undefined &&
      served?.includes(projectId as ProjectId) === true
    ) {
      return runIn(c, itemRights, item, projectId);
    }
    return denied(c, 'execute', ref(item.kind, item.id));
  }

  /** The mail trigger, if it is one (another kind's id is not found here), and the caller may `action` its project. */
  async function mailTriggerFor(
    c: Context<AppEnv>,
    action: Action,
  ): Promise<{ kind: 'ok'; value: MailTriggerRecord } | { kind: 'err'; response: Response }> {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const triggerId = c.req.param('triggerId') as TriggerId;
    const rec = UUID_RE.test(triggerId) ? await binding.get({ tenantId, triggerId }) : null;
    if (rec === null || rec.kind !== 'mail') {
      return { kind: 'err', response: notFound(c, requestId, triggerId) };
    }
    const refusedRead = await denied(c, action, ref('project', rec.projectId as unknown as string));
    if (refusedRead !== undefined) return { kind: 'err', response: refusedRead };
    return { kind: 'ok', value: rec };
  }

  // ---------- POST / (register) ----------
  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    const parsed = await parseJsonObject(c, requestId);
    if (parsed.kind === 'err') return parsed.response;
    const body = parsed.value;

    const target = parseMailTarget(body);
    if (target.kind === 'err') return bad(c, requestId, target.message);
    const config = parseMailConfig(body.config, 'create');
    if (config.kind === 'err') return bad(c, requestId, config.message);
    const mailbox = config.value.mailbox as MailTriggerMailbox;
    const tools = parseToolsAllowedUnattended(body);
    if (tools.kind === 'err') return bad(c, requestId, tools.message);
    const projectId = body.projectId;
    if (projectId !== undefined && (typeof projectId !== 'string' || !UUID_RE.test(projectId))) {
      return bad(c, requestId, '`projectId` must be a project id (a UUID)');
    }
    const runAsRaw = body.runAsServiceAccountId;
    if (runAsRaw !== undefined && (typeof runAsRaw !== 'string' || runAsRaw.length === 0)) {
      return bad(c, requestId, '`runAsServiceAccountId` must be a service-account id');
    }
    const personRefusal = personMailboxOwnerProblem(c, mailbox, runAsRaw);
    if (personRefusal !== undefined) return bad(c, requestId, personRefusal);

    // A trigger that names no project goes in the tenant's Default project:
    // checked and stored as that project. With no Default to find, the
    // registry picks it, and only a tenant admin may.
    const project =
      (projectId as string | undefined) ??
      ((await projects?.getDefault(tenantId))?.id as string | undefined);
    const refusedRole =
      mailbox.as === 'company'
        ? await notAdmin(c, project, "Watching the company's mailbox")
        : project === undefined
          ? await denied(c, 'admin', ref('tenant', tenantId as unknown as string))
          : await denied(c, 'write', ref('project', project));
    if (refusedRole !== undefined) return refusedRole;
    const refusedTarget = await targetRefused(c, target.value, project);
    if (refusedTarget !== undefined) return refusedTarget;
    // What it runs must be its project's to reach (`reference-scope.ts`).
    if (project !== undefined) {
      const outOfScope = await referencesOutOfScope(
        referenceScope,
        tenantId,
        project as ProjectId,
        [{ path: '/target', ...triggerTargetReference(target.value) }],
      );
      if (outOfScope !== undefined) return outOfScopeResponse(c, requestId, outOfScope);
    }
    // What its runs may call without a person's yes: a project admin's to
    // set, and only tools its target calls.
    if (tools.kind === 'ok') {
      const refusedList = await notAdmin(c, project, 'Setting `toolsAllowedUnattended`');
      if (refusedList !== undefined) return refusedList;
      const problem = await toolsAllowedUnattendedProblem(
        targetTools,
        tenantId,
        target.value,
        tools.value,
      );
      if (problem !== undefined) return bad(c, requestId, problem);
    }

    // Who its runs act as: the caller, or on the company's mailbox the
    // service account named with `runAsServiceAccountId` (gated by `act_as`).
    const resolved = await resolveTriggerOwner(
      c,
      runAsRaw as string | undefined,
      target.value,
      triggerOwnerDeps(c, authorizer, names?.serviceAccounts),
    );
    if (resolved.kind === 'refused') return resolved.response;
    const owner = resolved.owner;

    const registerInput: RegisterMailTriggerInput = {
      kind: 'mail',
      tenantId,
      target: target.value,
      ...(project !== undefined && { projectId: project as ProjectId }),
      owner,
      config: config.value as MailTriggerConfig,
      ...(typeof body.label === 'string' && body.label.length > 0 && { label: body.label }),
      ...(tools.kind === 'ok' && tools.value.length > 0 && { toolsAllowedUnattended: tools.value }),
    };
    const result = await binding.register(registerInput);
    if (result.kind === 'err') {
      c.status(statusFor(result.error.code) as never);
      return c.json(
        toWireError({ code: result.error.code, message: result.error.message }, requestId),
      );
    }
    // A named service-account owner is a delegation: audit it. A plain
    // register (owner = caller) is the trigger's creation, not a change.
    if (runAsRaw !== undefined) {
      await recordOwnerSet({
        auditEvents,
        tenantId,
        ...(project !== undefined && { projectId: project as ProjectId }),
        triggerId: result.value.triggerId,
        triggerKind: 'mail',
        to: owner,
        by: callerRef(c),
        correlationId: requestId,
        log: c.get('log'),
      });
    }
    if (tools.kind === 'ok' && tools.value.length > 0) {
      await recordToolsAllowedUnattendedSet({
        auditEvents,
        tenantId,
        ...(project !== undefined && { projectId: project as ProjectId }),
        triggerId: result.value.triggerId,
        triggerKind: 'mail',
        target: target.value,
        to: tools.value,
        by: callerRef(c),
        correlationId: requestId,
        log: c.get('log'),
      });
    }
    c.status(201);
    return mailTriggerJson(c, result.value as MailTriggerRecord);
  });

  // ---------- GET / (list) ----------
  // The tenant's mail triggers, then only those whose project the caller
  // may read. The page and its cursor are the tenant's, so a page can hold
  // fewer than `limit` rows and still have more.
  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');
    const statusRaw = c.req.query('status');
    const projectRaw = c.req.query('projectId');
    if (projectRaw !== undefined && !UUID_RE.test(projectRaw)) {
      return bad(c, c.get('requestId'), '`projectId` must be a project id (a UUID)');
    }
    const projectId = projectRaw as ProjectId | undefined;
    // A project filter needs read on that project: else an empty page
    // would say whether it has mail triggers.
    if (projectId !== undefined) {
      const refusedRead = await denied(c, 'read', ref('project', projectId as unknown as string));
      if (refusedRead !== undefined) return refusedRead;
    }
    const status = statusRaw === 'active' || statusRaw === 'paused' ? statusRaw : undefined;
    const page = await binding.list({
      tenantId,
      kind: 'mail',
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(status !== undefined && { status }),
      ...(projectId !== undefined && { projectId }),
    });
    // The binding narrows to the project; this keeps a page right from one that doesn't.
    const rows = (page.data as MailTriggerRecord[]).filter(
      (row) => projectId === undefined || row.projectId === projectId,
    );
    const visible =
      authorizer === undefined
        ? rows
        : await authorizer.filterByCan(c, 'read', rows, (rec) =>
            ref('project', rec.projectId as unknown as string),
          );
    const named = await ownerNamesOf(
      names,
      tenantId,
      visible.map((row) => row.owner),
    );
    return c.json({
      data: visible.map((row) => serializeMailTrigger(row, named)),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:triggerId (get) ----------
  r.get('/:triggerId', async (c) => {
    const found = await mailTriggerFor(c, 'read');
    if (found.kind === 'err') return found.response;
    return mailTriggerJson(c, found.value);
  });

  // ---------- PATCH /:triggerId (update) ----------
  r.patch('/:triggerId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    const parsed = await parseJsonObject(c, requestId);
    if (parsed.kind === 'err') return parsed.response;
    const body = parsed.value;
    if ('runAsServiceAccountId' in body) {
      return bad(c, requestId, OWNER_MOVES_BY_TAKE_OVER);
    }
    const retarget =
      'flowId' in body || 'agentId' in body || 'flowVersion' in body || 'agentVersion' in body;
    const target = retarget ? parseMailTarget(body) : undefined;
    if (target?.kind === 'err') return bad(c, requestId, target.message);
    const config = parseMailConfig(body.config, 'update');
    if (config.kind === 'err') return bad(c, requestId, config.message);
    const tools = parseToolsAllowedUnattended(body);
    if (tools.kind === 'err') return bad(c, requestId, tools.message);

    const found = await mailTriggerFor(c, 'read');
    if (found.kind === 'err') return found.response;
    const rec = found.value;
    const project = rec.projectId as unknown as string;
    const mailboxBefore = rec.config.mailbox;
    const mailboxAfter = config.value.mailbox ?? mailboxBefore;

    // Who may change it: a personal trigger's owner or an admin; a shared
    // one's admin. The company's mailbox, before or after, takes the admin.
    const refusedChange = await changeRefused(c, rec, 'admin');
    if (refusedChange !== undefined) return refusedChange;
    if (mailboxBefore.as === 'company' || mailboxAfter.as === 'company') {
      const refusedCompany = await notAdmin(
        c,
        project,
        "Changing a trigger on the company's mailbox",
      );
      if (refusedCompany !== undefined) return refusedCompany;
    }
    if (rec.owner.kind === 'service' && mailboxAfter.as === 'person') {
      return bad(c, requestId, PERSON_MAILBOX_IS_A_PERSONS);
    }
    const readsElsewhere =
      mailboxAfter.app !== mailboxBefore.app || mailboxAfter.as !== mailboxBefore.as;
    // What a personal trigger reads from a person's mailbox is its owner's
    // alone to choose: the mailbox, and the folder or label in it. Nobody
    // else, an admin included, points it at mail its owner didn't offer.
    // An admin may still move it to the company's mailbox, or take it over.
    if (rec.owner.kind === 'user' && mailboxAfter.as === 'person' && !callerOwns(c, rec.owner)) {
      const folderChanged =
        config.value.folder !== undefined && config.value.folder !== rec.config.folder;
      if (readsElsewhere || folderChanged) {
        return refused(c, authorizer, {
          action: 'write',
          resource: ref('project', project),
          message: ONLY_THE_OWNER_CHOOSES_WHAT_IT_READS,
          failing: 'actor',
        });
      }
    }
    if (target !== undefined) {
      const refusedTarget = await targetRefused(c, target.value, project);
      if (refusedTarget !== undefined) return refusedTarget;
      // A new target must be the trigger's project's to reach, as at registration.
      const outOfScope = await referencesOutOfScope(referenceScope, tenantId, rec.projectId, [
        { path: '/target', ...triggerTargetReference(target.value) },
      ]);
      if (outOfScope !== undefined) return outOfScopeResponse(c, requestId, outOfScope);
    }
    // Its `toolsAllowedUnattended`: kept unless named. Another target (kind
    // or id, not just a version) or another mailbox while it lists any must
    // name it again, kept or `[]`, so it's an admin's choice for what the
    // trigger now runs and reads, never carried over nor dropped unseen.
    // A personal trigger's owner may clear it with their own new target or
    // mailbox, since that only narrows what runs unattended.
    const kept = rec.toolsAllowedUnattended ?? [];
    const nextTarget = target?.value ?? rec.target;
    const retargeted = target !== undefined && retargets(rec.target, target.value);
    if ((retargeted || readsElsewhere) && kept.length > 0 && tools.kind === 'absent') {
      return bad(
        c,
        requestId,
        `this mail trigger's \`toolsAllowedUnattended\` lists ${kept.map((id) => `"${id}"`).join(', ')}: a new target or mailbox must name it again, \`[]\` to clear it, or a list, which a project admin sets`,
      );
    }
    const ownerClears =
      tools.kind === 'ok' &&
      tools.value.length === 0 &&
      (retargeted || readsElsewhere) &&
      rec.owner.kind === 'user' &&
      callerOwns(c, rec.owner);
    if (tools.kind === 'ok' && !ownerClears) {
      const refusedList = await notAdmin(c, project, 'Setting `toolsAllowedUnattended`');
      if (refusedList !== undefined) return refusedList;
      const problem = await toolsAllowedUnattendedProblem(
        targetTools,
        tenantId,
        nextTarget,
        tools.value,
      );
      if (problem !== undefined) return bad(c, requestId, problem);
    }
    // The owner stays, so a new target must be one it can run, or every fire is refused.
    if (target !== undefined && retargeted) {
      const cannot = await ownerCannotRunRefusal(c, authorizer, names, rec.owner, target.value);
      if (cannot !== undefined) return cannot;
    }

    const triggerId = rec.triggerId;
    const updateInput: UpdateMailTriggerInput = {
      kind: 'mail',
      tenantId,
      triggerId,
      ...(Object.keys(config.value).length > 0 && { config: config.value }),
      ...(target !== undefined && { target: target.value }),
      ...('label' in body && { label: body.label === null ? null : (body.label as string) }),
      ...(tools.kind === 'ok' && { toolsAllowedUnattended: tools.value }),
    };
    const result = await binding.update(updateInput);
    if (result.kind === 'err') return lifecycleError(c, requestId, result.error, triggerId);

    const updated = result.value as MailTriggerRecord;
    const changed = whatChanged(rec, updated);
    // An admin's change to a person's trigger: audited, and its owner told.
    await noteChangeForOwner(c, {
      auditEvents,
      notices: ownerNotices,
      trigger: owned(rec),
      triggerKind: 'mail',
      change: 'updated',
      ...changed,
    });
    // A change of the list is audited; so is a new target or mailbox it names again.
    if (
      tools.kind === 'ok' &&
      (!sameToolList(kept, tools.value) ||
        ((retargeted || readsElsewhere) && tools.value.length > 0))
    ) {
      await recordToolsAllowedUnattendedSet({
        auditEvents,
        tenantId,
        projectId: rec.projectId,
        triggerId,
        triggerKind: 'mail',
        target: nextTarget,
        from: kept,
        to: tools.value,
        by: callerRef(c),
        correlationId: requestId,
        log: c.get('log'),
      });
    }
    return mailTriggerJson(c, updated);
  });

  // ---------- POST /:triggerId/pause | resume ----------
  // A paused trigger doesn't poll. A resume starts fresh: mail that came
  // while it was paused doesn't fire.
  for (const verb of ['pause', 'resume'] as const) {
    r.post(`/:triggerId/${verb}`, async (c) => {
      const requestId = c.get('requestId');
      const found = await mailTriggerFor(c, 'read');
      if (found.kind === 'err') return found.response;
      const refusedChange = await changeRefused(c, found.value, 'write');
      if (refusedChange !== undefined) return refusedChange;
      const { tenantId, triggerId } = found.value;
      const result = await binding[verb]({ tenantId, triggerId });
      if (result.kind === 'err') return lifecycleError(c, requestId, result.error, triggerId);
      await noteChangeForOwner(c, {
        auditEvents,
        notices: ownerNotices,
        trigger: owned(found.value),
        triggerKind: 'mail',
        change: verb === 'pause' ? 'paused' : 'resumed',
      });
      return mailTriggerJson(c, result.value as MailTriggerRecord);
    });
  }

  // ---------- POST /:triggerId/unregister (soft delete) ----------
  r.post('/:triggerId/unregister', async (c) => {
    const found = await mailTriggerFor(c, 'read');
    if (found.kind === 'err') return found.response;
    const refusedChange = await changeRefused(c, found.value, 'write');
    if (refusedChange !== undefined) return refusedChange;
    const { tenantId, triggerId } = found.value;
    const outcome = await binding.unregister({ tenantId, triggerId });
    if (outcome.unregistered) {
      await noteChangeForOwner(c, {
        auditEvents,
        notices: ownerNotices,
        trigger: owned(found.value),
        triggerKind: 'mail',
        change: 'unregistered',
      });
    }
    return c.json({
      triggerId: triggerId as unknown as string,
      unregistered: outcome.unregistered,
    });
  });

  // ---------- GET /:triggerId/fires ----------
  r.get('/:triggerId/fires', async (c) => {
    const requestId = c.get('requestId');
    const found = await mailTriggerFor(c, 'read');
    if (found.kind === 'err') return found.response;
    if (binding.listFires === undefined) return unsupported(c, requestId, 'fire history');
    const cursorRaw = c.req.query('cursor');
    const page = await binding.listFires({
      tenantId: found.value.tenantId,
      triggerId: found.value.triggerId,
      limit: clampLimit(c.req.query('limit')),
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
    });
    return c.json({
      data: page.data.map(serializeFire),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- POST /:triggerId/owner (take ownership) ----------
  r.post('/:triggerId/owner', async (c) => {
    const requestId = c.get('requestId');
    const found = await mailTriggerFor(c, 'read');
    if (found.kind === 'err') return found.response;
    const rec = found.value;
    const refusedAdmin = await notAdmin(
      c,
      rec.projectId as unknown as string,
      'Taking a mail trigger over',
    );
    if (refusedAdmin !== undefined) return refusedAdmin;
    if (binding.setOwner === undefined) return unsupported(c, requestId, 'changing the owner');
    const refusedTarget = await targetRefused(c, rec.target, rec.projectId as unknown as string);
    if (refusedTarget !== undefined) return refusedTarget;
    // The caller takes it over, or on the company's mailbox names a service
    // account with `runAsServiceAccountId` in an optional body (gated by `act_as`).
    const parsed = await parseJsonObject(c, requestId, { allowEmpty: true });
    if (parsed.kind === 'err') return parsed.response;
    if ('toolsAllowedUnattended' in parsed.value) {
      return bad(
        c,
        requestId,
        "a take-over keeps the mail trigger's `toolsAllowedUnattended`: change it with PATCH",
      );
    }
    const runAsRaw = parsed.value.runAsServiceAccountId;
    if (runAsRaw !== undefined && (typeof runAsRaw !== 'string' || runAsRaw.length === 0)) {
      return bad(c, requestId, '`runAsServiceAccountId` must be a service-account id');
    }
    const personRefusal = personMailboxOwnerProblem(c, rec.config.mailbox, runAsRaw);
    if (personRefusal !== undefined) return bad(c, requestId, personRefusal);
    const resolved = await resolveTriggerOwner(
      c,
      runAsRaw as string | undefined,
      rec.target,
      triggerOwnerDeps(c, authorizer, names?.serviceAccounts),
    );
    if (resolved.kind === 'refused') return resolved.response;
    const { tenantId, triggerId } = rec;
    const result = await binding.setOwner({ tenantId, triggerId, owner: resolved.owner });
    if (result.kind === 'err') return lifecycleError(c, requestId, result.error, triggerId);
    // Every owner change is audited, a plain caller take-over included.
    await recordOwnerSet({
      auditEvents,
      tenantId,
      projectId: rec.projectId,
      triggerId,
      triggerKind: 'mail',
      from: rec.owner,
      to: resolved.owner,
      by: callerRef(c),
      correlationId: requestId,
      log: c.get('log'),
      ...(rec.toolsAllowedUnattended !== undefined && {
        toolsAllowedUnattended: rec.toolsAllowedUnattended,
      }),
    });
    tellTakenOver(c, ownerNotices, owned(rec), 'mail');
    return mailTriggerJson(c, result.value as MailTriggerRecord);
  });

  return r;
}

// -----------------------------------------------------------------------
// Shared helpers (co-located to keep each router self-contained).
// -----------------------------------------------------------------------

const OWNER_MOVES_BY_TAKE_OVER =
  "a mail trigger's owner changes only by a take-over (`POST /v1/mail-triggers/{triggerId}/owner`)";

const ONLY_THE_OWNER_CHOOSES_WHAT_IT_READS =
  "Only the trigger's owner may choose which of their mailboxes it reads, and which folder or Gmail label in it: take it over to watch your own.";

const PERSON_MAILBOX_IS_A_PERSONS =
  "a trigger on a person's mailbox reads its owner's own mail, so a person owns it: not a service account (`runAsServiceAccountId` goes with the company's mailbox)";

/**
 * Why the trigger's owner can't be who the request makes it: on a person's
 * mailbox, a person, never a service account, named or calling.
 */
function personMailboxOwnerProblem(
  c: Context<AppEnv>,
  mailbox: MailTriggerMailbox,
  runAsServiceAccountId: unknown,
): string | undefined {
  if (mailbox.as !== 'person') return undefined;
  if (runAsServiceAccountId !== undefined || ownerOf(c).kind !== 'user') {
    return PERSON_MAILBOX_IS_A_PERSONS;
  }
  return undefined;
}

type BeforeAfter = { readonly before: unknown; readonly after: unknown };

/** What a PATCH changed of a mail trigger, for `trigger-changed-for-owner`. */
type MailTriggerChange = {
  /**
   * The names of the fields that changed: what it runs, then what it
   * reads, then its settings, as for schedules and webhooks.
   */
  readonly fields: readonly string[];
  readonly target?: BeforeAfter;
  readonly mailbox?: BeforeAfter;
  readonly folder?: BeforeAfter;
};

/**
 * What a PATCH changed, from the trigger before and after it: the names
 * of the fields, and what it runs (its target) and reads (its mailbox, its
 * folder) before and after. Not the tools on its `toolsAllowedUnattended`,
 * which `trigger-tools-allowed-unattended-set` records.
 */
function whatChanged(before: MailTriggerRecord, after: MailTriggerRecord): MailTriggerChange {
  const fields: string[] = [];
  const out: { target?: BeforeAfter; mailbox?: BeforeAfter; folder?: BeforeAfter } = {};
  if (!sameJson(before.target, after.target)) {
    fields.push('target');
    out.target = { before: targetFields(before.target), after: targetFields(after.target) };
  }
  if (!sameJson(before.toolsAllowedUnattended ?? [], after.toolsAllowedUnattended ?? [])) {
    fields.push('toolsAllowedUnattended');
  }
  if (!sameJson(before.config.mailbox, after.config.mailbox)) {
    fields.push('mailbox');
    out.mailbox = { before: { ...before.config.mailbox }, after: { ...after.config.mailbox } };
  }
  if ((before.config.folder ?? null) !== (after.config.folder ?? null)) {
    fields.push('folder');
    out.folder = { before: before.config.folder ?? null, after: after.config.folder ?? null };
  }
  for (const field of ['pollSeconds', 'runsPerHour'] as const) {
    if (before.config[field] !== after.config[field]) fields.push(field);
  }
  if ((before.label ?? null) !== (after.label ?? null)) fields.push('label');
  return { fields, ...out };
}

/** A target on the wire: `flowId` + `flowVersion`, or `agentId` (+ `agentVersion`). */
function targetFields(target: MailTriggerTarget): Record<string, unknown> {
  return target.kind === 'flow'
    ? { flowId: target.flowId, flowVersion: target.flowVersion }
    : {
        agentId: target.agentId,
        ...(target.agentVersion !== undefined && { agentVersion: target.agentVersion }),
      };
}

function serializeMailTrigger(
  r: MailTriggerRecord,
  names: ReadonlyMap<string, string>,
): Record<string, unknown> {
  return {
    triggerId: r.triggerId as unknown as string,
    ...targetFields(r.target),
    projectId: r.projectId as unknown as string,
    owner: ownerJson(r.owner, names),
    mailbox: { app: r.config.mailbox.app, as: r.config.mailbox.as },
    ...(r.config.folder !== undefined && { folder: r.config.folder }),
    pollSeconds: r.config.pollSeconds,
    runsPerHour: r.config.runsPerHour,
    label: r.label,
    status: r.status,
    ...(r.statusReason !== undefined && { statusReason: r.statusReason }),
    ...(r.account !== undefined && { account: { id: r.account.id, label: r.account.label } }),
    ...(r.lastPolledAt !== undefined && { lastPolledAt: r.lastPolledAt }),
    ...(r.toolsAllowedUnattended !== undefined &&
      r.toolsAllowedUnattended.length > 0 && {
        toolsAllowedUnattended: [...r.toolsAllowedUnattended],
      }),
    lastFiredAt: r.lastFiredAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function serializeFire(f: TriggerFire): Record<string, unknown> {
  return {
    fireId: f.fireId,
    triggerId: f.triggerId as unknown as string,
    firedAt: f.firedAt,
    outcome: f.outcome,
    ...(f.runId !== undefined && { runId: f.runId }),
    ...(f.detail !== undefined && { detail: f.detail }),
    ...(f.countsTowardPause !== undefined && { countsTowardPause: f.countsTowardPause }),
  };
}

/** `flowId` + `flowVersion`, or `agentId` (+ `agentVersion`): exactly one target. */
function parseMailTarget(
  body: Record<string, unknown>,
): { kind: 'ok'; value: MailTriggerTarget } | { kind: 'err'; message: string } {
  const { flowId, flowVersion, agentId, agentVersion } = body;
  const named = (v: unknown) => typeof v === 'string' && v.length > 0;
  if ('improve' in body || named(flowId) === named(agentId)) {
    return {
      kind: 'err',
      message:
        'Name what the mail trigger runs: `flowId` (with `flowVersion`) or `agentId`, one of them',
    };
  }
  if (named(flowId)) {
    if (!named(flowVersion)) {
      return { kind: 'err', message: '`flowVersion` is required with `flowId`' };
    }
    if (agentVersion !== undefined) {
      return { kind: 'err', message: '`agentVersion` goes with `agentId`, not `flowId`' };
    }
    return {
      kind: 'ok',
      value: { kind: 'flow', flowId: flowId as string, flowVersion: flowVersion as string },
    } as { kind: 'ok'; value: MailTriggerTarget };
  }
  if (flowVersion !== undefined) {
    return { kind: 'err', message: '`flowVersion` goes with `flowId`, not `agentId`' };
  }
  if (agentVersion !== undefined && !named(agentVersion)) {
    return { kind: 'err', message: '`agentVersion` must be a version (semver)' };
  }
  return {
    kind: 'ok',
    value: {
      kind: 'agent',
      agentId: agentId as string,
      ...(agentVersion !== undefined && { agentVersion: agentVersion as string }),
    },
  } as { kind: 'ok'; value: MailTriggerTarget };
}

/** The longest folder or label id a trigger may name. */
const MAX_FOLDER_LENGTH = 512;

/**
 * A mail trigger's `config`: `mailbox` (`app`, `as`), required at register
 * and replaced whole on update; `folder`; `pollSeconds` and `runsPerHour`
 * within {@link MAIL_TRIGGER_LIMITS}. Nothing else: its runs' input is the
 * mail.
 */
function parseMailConfig(
  raw: unknown,
  mode: 'create' | 'update',
): { kind: 'ok'; value: Partial<MailTriggerConfig> } | { kind: 'err'; message: string } {
  if (raw === undefined && mode === 'update') return { kind: 'ok', value: {} };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      kind: 'err',
      message:
        '`config` must be an object: `mailbox` ({ app, as }), and optionally `folder`, `pollSeconds` and `runsPerHour`',
    };
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key === 'input' || key === 'message') {
      return {
        kind: 'err',
        message: `\`config.${key}\` isn't a mail trigger's: each run's input is the mail it was started by`,
      };
    }
    if (!['mailbox', 'folder', 'pollSeconds', 'runsPerHour'].includes(key)) {
      return { kind: 'err', message: `\`config.${key}\` isn't a mail trigger setting` };
    }
  }
  const value: { -readonly [K in keyof MailTriggerConfig]?: MailTriggerConfig[K] } = {};
  if (o.mailbox !== undefined || mode === 'create') {
    const mailbox = parseMailbox(o.mailbox);
    if (typeof mailbox === 'string') return { kind: 'err', message: mailbox };
    value.mailbox = mailbox;
  }
  if (o.folder !== undefined) {
    if (
      typeof o.folder !== 'string' ||
      o.folder.length === 0 ||
      o.folder.length > MAX_FOLDER_LENGTH
    ) {
      return {
        kind: 'err',
        message: `\`config.folder\` must be a Gmail label id, or an Outlook folder id or well-known name, of at most ${MAX_FOLDER_LENGTH} characters`,
      };
    }
    value.folder = o.folder;
  }
  for (const key of ['pollSeconds', 'runsPerHour'] as const) {
    const n = o[key];
    if (n === undefined) continue;
    const { min, max, default: fallback } = MAIL_TRIGGER_LIMITS[key];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
      return {
        kind: 'err',
        message: `\`config.${key}\` must be a whole number from ${min} to ${max} (default ${fallback})`,
      };
    }
    value[key] = n;
  }
  return { kind: 'ok', value };
}

/** `{ app: 'google' | 'microsoft', as: 'company' | 'person' }`, else why not. */
function parseMailbox(raw: unknown): MailTriggerMailbox | string {
  const shape =
    "`config.mailbox` must be `{ app, as }`: `app` `google` or `microsoft`, `as` `company` (the company's mailbox) or `person` (the owner's own)";
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return shape;
  const { app, as, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return shape;
  if (app !== 'google' && app !== 'microsoft') return shape;
  if (as !== 'company' && as !== 'person') return shape;
  return { app, as };
}

type ParseOk<T> = { readonly kind: 'ok'; readonly value: T };
type ParseErr = { readonly kind: 'err'; readonly response: Response };

async function parseJsonObject(
  c: Context<AppEnv>,
  requestId: string,
  opts: { readonly allowEmpty?: boolean } = {},
): Promise<ParseOk<Record<string, unknown>> | ParseErr> {
  let body: unknown;
  try {
    if (opts.allowEmpty === true) {
      // An endpoint whose body is optional (take-over): no body, or an empty
      // one, reads as `{}`; anything present must still be a JSON object.
      const text = await c.req.text();
      if (text.trim().length === 0) return { kind: 'ok', value: {} };
      body = JSON.parse(text);
    } else {
      body = await c.req.json();
    }
  } catch {
    c.status(statusFor('bad-input') as never);
    return {
      kind: 'err',
      response: c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      ),
    };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    c.status(statusFor('bad-input') as never);
    return {
      kind: 'err',
      response: c.json(
        toWireError(
          { code: 'bad-input', message: 'Request body must be a JSON object' },
          requestId,
        ),
      ),
    };
  }
  return { kind: 'ok', value: body as Record<string, unknown> };
}

function bad(c: Context<AppEnv>, requestId: string, message: string): Response {
  c.status(statusFor('bad-input') as never);
  return c.json(toWireError({ code: 'bad-input', message }, requestId));
}

function unsupported(c: Context<AppEnv>, requestId: string, what: string): Response {
  c.status(statusFor('trigger-operation-unsupported') as never);
  return c.json(
    toWireError(
      {
        code: 'trigger-operation-unsupported',
        message: `This deployment's mail triggers don't support ${what} yet.`,
      },
      requestId,
    ),
  );
}

function notFound(c: Context<AppEnv>, requestId: string, triggerId: TriggerId): Response {
  c.status(statusFor('trigger-not-found') as never);
  return c.json(
    toWireError(
      {
        code: 'trigger-not-found',
        message: `No mail trigger with id "${triggerId as unknown as string}"`,
        triggerId: triggerId as unknown as string,
      },
      requestId,
    ),
  );
}

function lifecycleError(
  c: Context<AppEnv>,
  requestId: string,
  error: { readonly code: string; readonly message: string },
  triggerId: TriggerId,
): Response {
  c.status(statusFor(error.code) as never);
  return c.json(
    toWireError(
      { code: error.code, message: error.message, triggerId: triggerId as unknown as string },
      requestId,
    ),
  );
}
