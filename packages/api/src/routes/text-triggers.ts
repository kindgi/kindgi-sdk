// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';
import type { Context } from 'hono';

import type { AuditEventBinding } from '@kindgi/audit-events';
import { type Action, type ResourceRef, ref } from '@kindgi/authz';
import type { ProjectBinding } from '@kindgi/platform';
import type { Cursor, EnvName, ProjectId, TenantId, TriggerId } from '@kindgi/types';

import { callerIdentity, callerRef, isTenantAdmin } from '../caller.js';
import { sameJson } from '../canonical-json.js';
import type { ConnectionBinding, ConnectionCandidateRecord } from '../connection-binding.js';
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
  type RegisterTextTriggerInput,
  TEXT_TRIGGER_LIMITS,
  type TextTriggerConfig,
  type TextTriggerRecord,
  type TextTriggerTarget,
  type TextTriggerVersionRecord,
  type TriggerFire,
  type TriggerRegistryBinding,
  type UpdateTextTriggerInput,
} from '../trigger-binding.js';
import type { AppEnv } from '../types.js';
import { refused } from './denied.js';
import { clampLimit } from './pagination.js';
import {
  type OwnedTrigger,
  type OwnerFacts,
  type TriggerOwnerNames,
  type TriggerOwnerNotices,
  isTriggerAdmin,
  mayChangePersonalTrigger,
  namesAnOwner,
  noteChangeForOwner,
  ownerCannotRunRefusal,
  ownerJson,
  ownerNamesOf,
  ownerRequestOf,
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
  triggerScope,
} from './trigger-tools.js';
import { versionField, versionFields, versionOne, versionsPage } from './trigger-versions.js';
import { UUID_RE } from './uuid-param.js';

export interface TextTriggersRouterOptions {
  readonly authorizer?: Authorizer;
  /** The tenant's default project: where a text trigger that names no project goes. */
  readonly projects?: Pick<ProjectBinding, 'getDefault'>;
  /** Where an owner's name is read (`owner.displayName`). */
  readonly names?: TriggerOwnerNames;
  /** Owner changes, list changes and an admin's change to a person's trigger are recorded here. */
  readonly auditEvents?: AuditEventBinding;
  /** What a text trigger's project may run (`reference-scope.ts`); absent: as named. */
  readonly referenceScope?: ReferenceScopeBinding;
  /** Rights on what a text trigger runs, when more than one project serves it. Absent: one project each. */
  readonly itemRights?: ItemRights;
  /** Where a target's agents and flows are read, to check `toolsAllowedUnattended`; absent: a list is refused. */
  readonly targetTools?: TargetToolsDeps;
  /** Tells a person what a project admin did to their trigger; absent: only audited. */
  readonly ownerNotices?: TriggerOwnerNotices;
  /**
   * Where the company connection a text trigger answers is checked, and
   * the env this server serves. Absent: every `connectionId` is
   * `connection-not-found`, so no text trigger registers.
   */
  readonly connections?: {
    readonly binding: Pick<ConnectionBinding, 'get' | 'listCandidates'>;
    readonly envName: EnvName;
  };
}

/**
 * Text triggers: each text (SMS or WhatsApp) that comes in to a business
 * phone number starts a run of an agent or a flow, with the text as the
 * run's input. A flow's input is `{ text, thread }`: `text` is the text
 * that came in, `{ from, channel, body, receivedAt }` (`channel` `sms` or
 * `whatsapp`), and `thread` the conversation it is part of,
 * `{ connectionId, channel, sender }`. The receiver pushes each text in;
 * nothing polls.
 *
 *   POST /v1/text-triggers                          register
 *   GET  /v1/text-triggers[?projectId=&status=]     list (cursor-paginated)
 *   GET  /v1/text-triggers/:triggerId               get
 *   PATCH /v1/text-triggers/:triggerId              update
 *   POST /v1/text-triggers/:triggerId/pause | resume | unregister
 *   GET  /v1/text-triggers/:triggerId/fires         its texts' fires, newest first
 *   POST /v1/text-triggers/:triggerId/owner         the caller becomes the owner
 *
 * The number is a company connection of app `texts`, one of the trigger's
 * project's candidates (`config.connectionId`), and one live text trigger
 * answers it: registering another on it, or moving one onto it, is
 * `409 trigger-connection-taken`, which names the one that does
 * (`heldBy`). A paused trigger keeps its connection; unregistering it
 * frees it.
 *
 * A text trigger is shared or personal, by its owner: a service account
 * (one named by id, or the project's own) owns a shared one; a person owns
 * a personal one. No edit moves the owner; only `POST .../owner` does. Its
 * runs act as its owner, with that owner's connections.
 *
 * With an authorizer, reads need `read` on the trigger's project, and
 * registering or retargeting needs `execute` on what it runs. The number
 * is the company's, so registering a text trigger and every PATCH take a
 * project admin. A personal trigger's pause, resume and unregister are
 * its owner's or a project admin's; a shared trigger's need `write`.
 * Every admin check here is `isTriggerAdmin`, so without an authorization
 * model it's the token's tenant-admin scope, never everyone. An admin's
 * change to a person's trigger is audited, and its owner told
 * (`ownerNotices`), as for schedules and webhooks.
 * `toolsAllowedUnattended` (`trigger-tools.ts`) is an admin's to set, it
 * never lists `texts.send`, and a new target or connection while it lists
 * any must name it again.
 */
export function textTriggersRouter(
  binding: TriggerRegistryBinding,
  options: TextTriggersRouterOptions = {},
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
    connections,
  } = options;
  const r = new Hono<AppEnv>();

  /** A text trigger as the owner rule reads it. */
  const owned = (row: TextTriggerRecord): OwnedTrigger => ({
    tenantId: row.tenantId,
    triggerId: row.triggerId as unknown as string,
    projectId: row.projectId as unknown as string,
    label: row.label ?? null,
    owner: row.owner,
  });

  /** A text trigger as the wire carries it, its owner named. */
  async function textTriggerJson(c: Context<AppEnv>, row: TextTriggerRecord): Promise<Response> {
    const named = await ownerNamesOf(names, c.get('tenantId') as TenantId, [row.owner]);
    return c.json(serializeTextTrigger(row, named));
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
   * Nothing, when the caller may pause, resume or unregister `rec`: a
   * personal trigger's owner (a project writer) or a project admin; a
   * shared trigger's project writer. Else a 403, which names a personal
   * trigger's owner.
   */
  async function changeRefused(
    c: Context<AppEnv>,
    rec: TextTriggerRecord,
  ): Promise<Response | undefined> {
    const project = rec.projectId as unknown as string;
    if (rec.owner.kind === 'service') return denied(c, 'write', ref('project', project));
    if (
      await mayChangePersonalTrigger(
        c,
        authorizer,
        { projectId: project, owner: rec.owner },
        'write',
      )
    ) {
      return undefined;
    }
    return ownerRuleRefused(c, authorizer, names, owned(rec), 'text trigger');
  }

  /**
   * What starting `target` from a trigger in `projectId` needs, as starting
   * it by hand does: `execute` on it, or for a target more than one project
   * serves, that project's right (`runIn`).
   */
  async function targetRefused(
    c: Context<AppEnv>,
    target: TextTriggerTarget,
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

  /** The text trigger, if it is one (another kind's id is not found here), and the caller may `action` its project. */
  async function textTriggerFor(
    c: Context<AppEnv>,
    action: Action,
  ): Promise<{ kind: 'ok'; value: TextTriggerRecord } | { kind: 'err'; response: Response }> {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const triggerId = c.req.param('triggerId') as TriggerId;
    const rec = UUID_RE.test(triggerId) ? await binding.get({ tenantId, triggerId }) : null;
    if (rec === null || rec.kind !== 'text') {
      return { kind: 'err', response: notFound(c, requestId, triggerId) };
    }
    const refusedRead = await denied(c, action, ref('project', rec.projectId as unknown as string));
    if (refusedRead !== undefined) return { kind: 'err', response: refusedRead };
    return { kind: 'ok', value: rec };
  }

  /**
   * Why `named` can't be the connection a text trigger in `project`
   * answers, else nothing. It must be one of the project's company
   * candidates of app `texts`: a person's is a 400, and anything else a
   * 404, the same answer as for an id that doesn't exist.
   */
  async function connectionRefused(
    c: Context<AppEnv>,
    named: string,
    project: string | undefined,
  ): Promise<Response | undefined> {
    if (connections === undefined) return notACandidate(c, named);
    // With no project to check against (none named, and no Default found),
    // the connection must be the tenant's live company connection of the
    // app in this env.
    const candidates =
      project === undefined
        ? undefined
        : await candidatesOf(connections.binding, {
            tenantId: c.get('tenantId') as TenantId,
            projectId: project as ProjectId,
            envName: connections.envName,
            app: TEXTS_APP,
          });
    return namedRefusal(c, connections, named, candidates);
  }

  // ---------- POST / (register) ----------
  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    const parsed = await parseJsonObject(c, requestId);
    if (parsed.kind === 'err') return parsed.response;
    const body = parsed.value;

    const target = parseTextTarget(body);
    if (target.kind === 'err') return bad(c, requestId, target.message);
    const config = parseTextConfig(body.config, 'create');
    if (config.kind === 'err') return bad(c, requestId, config.message);
    const connectionId = config.value.connectionId as string;
    const tools = parseToolsAllowedUnattended(body);
    if (tools.kind === 'err') return bad(c, requestId, tools.message);
    if (tools.kind === 'ok' && tools.value.includes(SEND_TOOL)) {
      return bad(c, requestId, SEND_NEVER_UNATTENDED);
    }
    const projectId = body.projectId;
    if (projectId !== undefined && (typeof projectId !== 'string' || !UUID_RE.test(projectId))) {
      return bad(c, requestId, '`projectId` must be a project id (a UUID)');
    }
    // A trigger that names no project goes in the tenant's default project:
    // checked and stored as that project. With no default to find, the
    // registry picks it, and only a tenant admin may.
    const project =
      (projectId as string | undefined) ??
      ((await projects?.getDefault(tenantId))?.id as string | undefined);
    const ownerRequest = ownerRequestOf(body, project);
    if (typeof ownerRequest === 'string') return bad(c, requestId, ownerRequest);
    const refusedRole = await notAdmin(c, project, "Answering the company's texts");
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
    // set (the caller is one, above), and only tools its target calls.
    if (tools.kind === 'ok') {
      const problem = await toolsAllowedUnattendedProblem(
        targetTools,
        triggerScope(tenantId, project),
        target.value,
        tools.value,
        'text',
      );
      if (problem !== undefined) return bad(c, requestId, problem);
    }
    // The number it answers: one of the project's company connections of
    // app `texts`.
    const refusedConnection = await connectionRefused(c, connectionId, project);
    if (refusedConnection !== undefined) return refusedConnection;

    // Who its runs act as: the caller, or the service account named with
    // `runAsServiceAccountId` (gated by `act_as`) or the project's own
    // account with `runAsProject` (a project admin's).
    const resolved = await resolveTriggerOwner(
      c,
      ownerRequest,
      target.value,
      triggerOwnerDeps(c, authorizer, names?.serviceAccounts),
    );
    if (resolved.kind === 'refused') return resolved.response;
    const owner = resolved.owner;

    const registerInput: RegisterTextTriggerInput = {
      kind: 'text',
      tenantId,
      by: callerIdentity(c),
      target: target.value,
      ...(project !== undefined && { projectId: project as ProjectId }),
      owner,
      config: { ...config.value, connectionId },
      ...(typeof body.label === 'string' && body.label.length > 0 && { label: body.label }),
      ...(tools.kind === 'ok' && tools.value.length > 0 && { toolsAllowedUnattended: tools.value }),
    };
    const result = await binding.register(registerInput);
    if (result.kind === 'err') return registryError(c, requestId, result.error, connectionId);
    // A named service-account owner, or the project's own account, is a
    // delegation: audit it. A plain register (owner = caller) is the
    // trigger's creation, not a change.
    if (namesAnOwner(ownerRequest)) {
      await recordOwnerSet({
        auditEvents,
        tenantId,
        ...(project !== undefined && { projectId: project as ProjectId }),
        triggerId: result.value.triggerId,
        triggerKind: 'text',
        to: owner,
        ...(resolved.projectAccount === true && { projectAccount: true }),
        by: callerRef(c),
        correlationId: requestId,
        log: c.get('log'),
        ...versionField(result.value),
      });
    }
    if (tools.kind === 'ok' && tools.value.length > 0) {
      await recordToolsAllowedUnattendedSet({
        auditEvents,
        tenantId,
        ...(project !== undefined && { projectId: project as ProjectId }),
        triggerId: result.value.triggerId,
        triggerKind: 'text',
        target: target.value,
        to: tools.value,
        by: callerRef(c),
        correlationId: requestId,
        log: c.get('log'),
        ...versionField(result.value),
      });
    }
    c.status(201);
    return textTriggerJson(c, result.value as TextTriggerRecord);
  });

  // ---------- GET / (list) ----------
  // The tenant's text triggers, then only those whose project the caller
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
    // would say whether it has text triggers.
    if (projectId !== undefined) {
      const refusedRead = await denied(c, 'read', ref('project', projectId as unknown as string));
      if (refusedRead !== undefined) return refusedRead;
    }
    const status = statusRaw === 'active' || statusRaw === 'paused' ? statusRaw : undefined;
    const page = await binding.list({
      tenantId,
      kind: 'text',
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(status !== undefined && { status }),
      ...(projectId !== undefined && { projectId }),
    });
    // The binding narrows to the project; this keeps a page right from one that doesn't.
    const rows = (page.data as TextTriggerRecord[]).filter(
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
      data: visible.map((row) => serializeTextTrigger(row, named)),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:triggerId (get) ----------
  r.get('/:triggerId', async (c) => {
    const found = await textTriggerFor(c, 'read');
    if (found.kind === 'err') return found.response;
    return textTriggerJson(c, found.value);
  });

  // ---------- PATCH /:triggerId (update) ----------
  r.patch('/:triggerId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    const parsed = await parseJsonObject(c, requestId);
    if (parsed.kind === 'err') return parsed.response;
    const body = parsed.value;
    if ('runAsServiceAccountId' in body || 'runAsProject' in body) {
      return bad(c, requestId, OWNER_MOVES_BY_TAKE_OVER);
    }
    const retarget =
      'flowId' in body || 'agentId' in body || 'flowVersion' in body || 'agentVersion' in body;
    const target = retarget ? parseTextTarget(body) : undefined;
    if (target?.kind === 'err') return bad(c, requestId, target.message);
    const config = parseTextConfig(body.config, 'update');
    if (config.kind === 'err') return bad(c, requestId, config.message);
    const tools = parseToolsAllowedUnattended(body);
    if (tools.kind === 'err') return bad(c, requestId, tools.message);
    if (tools.kind === 'ok' && tools.value.includes(SEND_TOOL)) {
      return bad(c, requestId, SEND_NEVER_UNATTENDED);
    }

    const found = await textTriggerFor(c, 'read');
    if (found.kind === 'err') return found.response;
    const rec = found.value;
    const project = rec.projectId as unknown as string;

    // The number is the company's, so every change takes a project admin,
    // its owner's own included.
    const refusedCompany = await notAdmin(c, project, 'Changing a text trigger');
    if (refusedCompany !== undefined) return refusedCompany;
    // Another connection is checked as at registration. The one it answers
    // now, sent again, stays as it is.
    const connectionBefore = rec.config.connectionId;
    const connectionAfter = config.value.connectionId ?? connectionBefore;
    const answersElsewhere = connectionAfter !== connectionBefore;
    if (answersElsewhere) {
      const refusedConnection = await connectionRefused(c, connectionAfter, project);
      if (refusedConnection !== undefined) return refusedConnection;
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
    // or id, not just a version) or another connection while it lists any
    // must name it again, kept or `[]`, so it's an admin's choice for what
    // the trigger now runs and answers, never carried over nor dropped unseen.
    const kept = rec.toolsAllowedUnattended ?? [];
    const nextTarget = target?.value ?? rec.target;
    const retargeted = target !== undefined && retargets(rec.target, target.value);
    if ((retargeted || answersElsewhere) && kept.length > 0 && tools.kind === 'absent') {
      return bad(
        c,
        requestId,
        `this text trigger's \`toolsAllowedUnattended\` lists ${kept.map((id) => `"${id}"`).join(', ')}: a new target or connection must name it again, \`[]\` to clear it, or a list, which a project admin sets`,
      );
    }
    if (tools.kind === 'ok') {
      const problem = await toolsAllowedUnattendedProblem(
        targetTools,
        triggerScope(tenantId, project),
        nextTarget,
        tools.value,
        'text',
      );
      if (problem !== undefined) return bad(c, requestId, problem);
    }
    // The owner stays, so a new target must be one it can run, or every fire is refused.
    if (target !== undefined && retargeted) {
      const cannot = await ownerCannotRunRefusal(c, authorizer, names, rec.owner, target.value);
      if (cannot !== undefined) return cannot;
    }

    const triggerId = rec.triggerId;
    const updateInput: UpdateTextTriggerInput = {
      kind: 'text',
      tenantId,
      triggerId,
      by: callerIdentity(c),
      ...(Object.keys(config.value).length > 0 && { config: config.value }),
      ...(target !== undefined && { target: target.value }),
      ...('label' in body && { label: body.label === null ? null : (body.label as string) }),
      // The same tools in another order change nothing: no version, as no audit entry.
      ...(tools.kind === 'ok' &&
        !sameToolList(kept, tools.value) && { toolsAllowedUnattended: tools.value }),
    };
    const result = await binding.update(updateInput);
    if (result.kind === 'err') {
      return registryError(c, requestId, result.error, connectionAfter, triggerId);
    }

    const updated = result.value as TextTriggerRecord;
    const changed = whatChanged(rec, updated);
    // An admin's change to a person's trigger: audited, and its owner told.
    await noteChangeForOwner(c, {
      auditEvents,
      notices: ownerNotices,
      trigger: owned(rec),
      triggerKind: 'text',
      change: 'updated',
      ...changed,
      ...versionField(result.value),
    });
    // A change of the list is audited; so is a new target or connection it names again.
    if (
      tools.kind === 'ok' &&
      (!sameToolList(kept, tools.value) ||
        ((retargeted || answersElsewhere) && tools.value.length > 0))
    ) {
      await recordToolsAllowedUnattendedSet({
        auditEvents,
        tenantId,
        projectId: rec.projectId,
        triggerId,
        triggerKind: 'text',
        target: nextTarget,
        from: kept,
        to: tools.value,
        by: callerRef(c),
        correlationId: requestId,
        log: c.get('log'),
        ...versionField(result.value),
      });
    }
    return textTriggerJson(c, updated);
  });

  // ---------- POST /:triggerId/pause | resume ----------
  // A paused trigger answers no texts: one that comes in while it's paused
  // never starts a run. It keeps its connection, so a resume answers the
  // same number.
  for (const verb of ['pause', 'resume'] as const) {
    r.post(`/:triggerId/${verb}`, async (c) => {
      const requestId = c.get('requestId');
      const found = await textTriggerFor(c, 'read');
      if (found.kind === 'err') return found.response;
      const refusedChange = await changeRefused(c, found.value);
      if (refusedChange !== undefined) return refusedChange;
      const { tenantId, triggerId } = found.value;
      const result = await binding[verb]({ tenantId, triggerId });
      if (result.kind === 'err') {
        return registryError(c, requestId, result.error, undefined, triggerId);
      }
      await noteChangeForOwner(c, {
        auditEvents,
        notices: ownerNotices,
        trigger: owned(found.value),
        triggerKind: 'text',
        change: verb === 'pause' ? 'paused' : 'resumed',
      });
      return textTriggerJson(c, result.value as TextTriggerRecord);
    });
  }

  // ---------- POST /:triggerId/unregister (soft delete) ----------
  r.post('/:triggerId/unregister', async (c) => {
    const found = await textTriggerFor(c, 'read');
    if (found.kind === 'err') return found.response;
    const refusedChange = await changeRefused(c, found.value);
    if (refusedChange !== undefined) return refusedChange;
    const { tenantId, triggerId } = found.value;
    const outcome = await binding.unregister({ tenantId, triggerId });
    if (outcome.unregistered) {
      await noteChangeForOwner(c, {
        auditEvents,
        notices: ownerNotices,
        trigger: owned(found.value),
        triggerKind: 'text',
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
    const found = await textTriggerFor(c, 'read');
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

  /** Versions, their owners named as a trigger's is. */
  const versionsJson = async (
    c: Context<AppEnv>,
    versions: readonly TextTriggerVersionRecord[],
  ) => {
    const named = await ownerNamesOf(
      names,
      c.get('tenantId') as TenantId,
      versions.map((v) => v.definition.owner),
    );
    return versions.map((v) => serializeTextTriggerVersion(v, named));
  };

  // ---------- GET /:triggerId/versions (newest first) ----------
  r.get('/:triggerId/versions', async (c) => {
    const found = await textTriggerFor(c, 'read');
    if (found.kind === 'err') return found.response;
    return versionsPage(c, binding, found.value.triggerId, 'text', (v) => versionsJson(c, v));
  });

  // ---------- GET /:triggerId/versions/:version ----------
  r.get('/:triggerId/versions/:version', async (c) => {
    const found = await textTriggerFor(c, 'read');
    if (found.kind === 'err') return found.response;
    return versionOne(c, binding, found.value.triggerId, 'text', (v) => versionsJson(c, v));
  });

  // ---------- POST /:triggerId/owner (take ownership) ----------
  r.post('/:triggerId/owner', async (c) => {
    const requestId = c.get('requestId');
    const found = await textTriggerFor(c, 'read');
    if (found.kind === 'err') return found.response;
    const rec = found.value;
    const refusedAdmin = await notAdmin(
      c,
      rec.projectId as unknown as string,
      'Taking a text trigger over',
    );
    if (refusedAdmin !== undefined) return refusedAdmin;
    if (binding.setOwner === undefined) return unsupported(c, requestId, 'changing the owner');
    const refusedTarget = await targetRefused(c, rec.target, rec.projectId as unknown as string);
    if (refusedTarget !== undefined) return refusedTarget;
    // The caller takes it over, or names a service account with
    // `runAsServiceAccountId` in an optional body (gated by `act_as`), or
    // the project's own account with `runAsProject`.
    const parsed = await parseJsonObject(c, requestId, { allowEmpty: true });
    if (parsed.kind === 'err') return parsed.response;
    if ('toolsAllowedUnattended' in parsed.value) {
      return bad(
        c,
        requestId,
        "a take-over keeps the text trigger's `toolsAllowedUnattended`: change it with PATCH",
      );
    }
    const ownerRequest = ownerRequestOf(parsed.value, rec.projectId as unknown as string);
    if (typeof ownerRequest === 'string') return bad(c, requestId, ownerRequest);
    const resolved = await resolveTriggerOwner(
      c,
      ownerRequest,
      rec.target,
      triggerOwnerDeps(c, authorizer, names?.serviceAccounts),
    );
    if (resolved.kind === 'refused') return resolved.response;
    const { tenantId, triggerId } = rec;
    const result = await binding.setOwner({
      tenantId,
      triggerId,
      owner: resolved.owner,
      by: callerIdentity(c),
    });
    if (result.kind === 'err')
      return registryError(c, requestId, result.error, undefined, triggerId);
    // Every owner change is audited, a plain caller take-over included.
    await recordOwnerSet({
      auditEvents,
      tenantId,
      projectId: rec.projectId,
      triggerId,
      triggerKind: 'text',
      from: rec.owner,
      to: resolved.owner,
      ...(resolved.projectAccount === true && { projectAccount: true }),
      by: callerRef(c),
      correlationId: requestId,
      log: c.get('log'),
      ...(rec.toolsAllowedUnattended !== undefined && {
        toolsAllowedUnattended: rec.toolsAllowedUnattended,
      }),
      ...versionField(result.value),
    });
    tellTakenOver(c, ownerNotices, owned(rec), 'text');
    return textTriggerJson(c, result.value as TextTriggerRecord);
  });

  return r;
}

// -----------------------------------------------------------------------
// Shared helpers (co-located to keep each router self-contained).
// -----------------------------------------------------------------------

const OWNER_MOVES_BY_TAKE_OVER =
  "a text trigger's owner changes only by a take-over (`POST /v1/text-triggers/{triggerId}/owner`)";

/** The app of the company connection a text trigger answers: one connection per number. */
const TEXTS_APP = 'texts';

/** The tool that sends a text: its calls always wait for a person's yes in a text trigger's runs. */
const SEND_TOOL = 'texts.send';

const SEND_NEVER_UNATTENDED =
  "`toolsAllowedUnattended` can't list `texts.send`: sending a text is never allowed unattended, so each one waits for a person's yes";

/** Where a text trigger names its connection, as a refusal's `details.field` says. */
const CONNECTION_FIELD = 'config.connectionId';

/** A text trigger answers a company connection: a person's is theirs. */
const PERSON_CONNECTION_IS_THEIRS =
  "A person's own connection is used for them; a text trigger answers the number of a company connection.";

/** A connection that may be answered with: working, or needing a reconnect. */
const LIVE_CONNECTION_STATES: ReadonlySet<string> = new Set(['working', 'needs-reconnecting']);

/** Every page of the project's candidates of the app (`listCandidates`). */
async function candidatesOf(
  binding: Pick<ConnectionBinding, 'listCandidates'>,
  input: {
    tenantId: TenantId;
    projectId: ProjectId;
    envName: EnvName;
    app: string;
  },
): Promise<ConnectionCandidateRecord[]> {
  const out: ConnectionCandidateRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await binding.listCandidates({
      ...input,
      limit: 100,
      ...(cursor !== undefined && { cursor }),
    });
    out.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return out;
}

/**
 * Why a named connection can't be a text trigger's, else nothing: one of
 * the project's candidates is taken; a person's live connection of the
 * app in this env is a 400; with no project to check against, the
 * tenant's live company connection of the app in this env is taken;
 * anything else is a 404, the same as an id that isn't there.
 */
async function namedRefusal(
  c: Context<AppEnv>,
  connections: NonNullable<TextTriggersRouterOptions['connections']>,
  named: string,
  candidates: readonly ConnectionCandidateRecord[] | undefined,
): Promise<Response | undefined> {
  if (candidates?.some((x) => x.connectionId === named)) return undefined;
  const tenantId = c.get('tenantId') as TenantId;
  const connection = await connections.binding.get({ tenantId, connectionId: named });
  const here =
    connection !== null &&
    LIVE_CONNECTION_STATES.has(connection.state) &&
    connection.envName === connections.envName &&
    connection.app === TEXTS_APP;
  if (here && connection.owner.kind === 'member') {
    return answer(c, c.get('requestId'), 'bad-input', PERSON_CONNECTION_IS_THEIRS, {
      field: CONNECTION_FIELD,
    });
  }
  const tenantsOwn = candidates === undefined && here && connection.owner.kind === 'company';
  return tenantsOwn ? undefined : notACandidate(c, named);
}

/** A named connection that isn't a candidate: the same 404 as for one that doesn't exist. */
function notACandidate(c: Context<AppEnv>, named: string): Response {
  return answer(c, c.get('requestId'), 'connection-not-found', `No connection with id "${named}"`, {
    connectionId: named,
    field: CONNECTION_FIELD,
  });
}

type BeforeAfter = { readonly before: unknown; readonly after: unknown };

/** What a PATCH changed of a text trigger, for `trigger-changed-for-owner`. */
type TextTriggerChange = {
  /**
   * The names of the fields that changed: what it runs, then what it
   * answers, then its settings, as for schedules and webhooks.
   */
  readonly fields: readonly string[];
  readonly target?: BeforeAfter;
  readonly connectionId?: { readonly before: string; readonly after: string };
};

/**
 * What a PATCH changed, from the trigger before and after it: the names
 * of the fields, and what it runs (its target) and answers (its
 * connection) before and after. Not the tools on its
 * `toolsAllowedUnattended`, which `trigger-tools-allowed-unattended-set`
 * records.
 */
function whatChanged(before: TextTriggerRecord, after: TextTriggerRecord): TextTriggerChange {
  const fields: string[] = [];
  const out: { target?: BeforeAfter; connectionId?: { before: string; after: string } } = {};
  if (!sameJson(before.target, after.target)) {
    fields.push('target');
    out.target = { before: targetFields(before.target), after: targetFields(after.target) };
  }
  if (!sameJson(before.toolsAllowedUnattended ?? [], after.toolsAllowedUnattended ?? [])) {
    fields.push('toolsAllowedUnattended');
  }
  if (before.config.connectionId !== after.config.connectionId) {
    fields.push('connectionId');
    out.connectionId = { before: before.config.connectionId, after: after.config.connectionId };
  }
  for (const field of ['runsPerHour', 'perSenderPerHour'] as const) {
    if (before.config[field] !== after.config[field]) fields.push(field);
  }
  if ((before.label ?? null) !== (after.label ?? null)) fields.push('label');
  return { fields, ...out };
}

/** A target on the wire: `flowId` + `flowVersion`, or `agentId` (+ `agentVersion`). */
function targetFields(target: TextTriggerTarget): Record<string, unknown> {
  return target.kind === 'flow'
    ? { flowId: target.flowId, flowVersion: target.flowVersion }
    : {
        agentId: target.agentId,
        ...(target.agentVersion !== undefined && { agentVersion: target.agentVersion }),
      };
}

function serializeTextTrigger(
  r: TextTriggerRecord,
  names: ReadonlyMap<string, OwnerFacts>,
): Record<string, unknown> {
  return {
    triggerId: r.triggerId as unknown as string,
    ...targetFields(r.target),
    projectId: r.projectId as unknown as string,
    owner: ownerJson(r.owner, names),
    connectionId: r.config.connectionId,
    runsPerHour: r.config.runsPerHour,
    perSenderPerHour: r.config.perSenderPerHour,
    label: r.label,
    status: r.status,
    ...(r.statusReason !== undefined && { statusReason: r.statusReason }),
    ...(r.version !== undefined && { version: r.version }),
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
    ...(f.version !== undefined && { version: f.version }),
    ...(f.detail !== undefined && { detail: f.detail }),
    ...(f.countsTowardPause !== undefined && { countsTowardPause: f.countsTowardPause }),
  };
}

/** A version, its definition named as a text trigger's own fields are. */
function serializeTextTriggerVersion(
  v: TextTriggerVersionRecord,
  names: ReadonlyMap<string, OwnerFacts>,
): Record<string, unknown> {
  const d = v.definition;
  return {
    triggerId: v.triggerId as unknown as string,
    ...versionFields(v),
    definition: {
      ...targetFields(d.target),
      projectId: d.projectId as unknown as string,
      owner: ownerJson(d.owner, names),
      connectionId: d.config.connectionId,
      runsPerHour: d.config.runsPerHour,
      perSenderPerHour: d.config.perSenderPerHour,
      label: d.label,
      ...(d.toolsAllowedUnattended !== undefined &&
        d.toolsAllowedUnattended.length > 0 && {
          toolsAllowedUnattended: [...d.toolsAllowedUnattended],
        }),
    },
  };
}

/** `flowId` + `flowVersion`, or `agentId` (+ `agentVersion`): exactly one target. */
function parseTextTarget(
  body: Record<string, unknown>,
): { kind: 'ok'; value: TextTriggerTarget } | { kind: 'err'; message: string } {
  const { flowId, flowVersion, agentId, agentVersion } = body;
  const named = (v: unknown) => typeof v === 'string' && v.length > 0;
  if ('improve' in body || named(flowId) === named(agentId)) {
    return {
      kind: 'err',
      message:
        'Name what the text trigger runs: `flowId` (with `flowVersion`) or `agentId`, one of them',
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
    } as { kind: 'ok'; value: TextTriggerTarget };
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
  } as { kind: 'ok'; value: TextTriggerTarget };
}

/**
 * A text trigger's `config`: `connectionId`, required at register;
 * `runsPerHour` and `perSenderPerHour` within {@link TEXT_TRIGGER_LIMITS}.
 * Nothing else: its runs' input is the text.
 */
function parseTextConfig(
  raw: unknown,
  mode: 'create' | 'update',
): { kind: 'ok'; value: Partial<TextTriggerConfig> } | { kind: 'err'; message: string } {
  if (raw === undefined && mode === 'update') return { kind: 'ok', value: {} };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      kind: 'err',
      message:
        '`config` must be an object: `connectionId`, and optionally `runsPerHour` and `perSenderPerHour`',
    };
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key === 'input' || key === 'message') {
      return {
        kind: 'err',
        message: `\`config.${key}\` isn't a text trigger's: each run's input is the text it was started by`,
      };
    }
    if (!['connectionId', 'runsPerHour', 'perSenderPerHour'].includes(key)) {
      return { kind: 'err', message: `\`config.${key}\` isn't a text trigger setting` };
    }
  }
  const value: { -readonly [K in keyof TextTriggerConfig]?: TextTriggerConfig[K] } = {};
  if (o.connectionId === undefined && mode === 'create') {
    return {
      kind: 'err',
      message:
        "`config.connectionId` is required: the company's connection of app `texts` for the number",
    };
  }
  if (o.connectionId !== undefined) {
    if (typeof o.connectionId !== 'string' || !UUID_RE.test(o.connectionId)) {
      return { kind: 'err', message: '`config.connectionId` must be a connection id (a UUID)' };
    }
    value.connectionId = o.connectionId;
  }
  for (const key of ['runsPerHour', 'perSenderPerHour'] as const) {
    const n = o[key];
    if (n === undefined) continue;
    const { min, max, default: fallback } = TEXT_TRIGGER_LIMITS[key];
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

/** An error with its code's status, and `details`. */
function answer(
  c: Context<AppEnv>,
  requestId: string,
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
): Response {
  c.status(statusFor(code) as never);
  return c.json(toWireError({ code, message, ...details }, requestId));
}

function unsupported(c: Context<AppEnv>, requestId: string, what: string): Response {
  c.status(statusFor('trigger-operation-unsupported') as never);
  return c.json(
    toWireError(
      {
        code: 'trigger-operation-unsupported',
        message: `This deployment's text triggers don't support ${what} yet.`,
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
        message: `No text trigger with id "${triggerId as unknown as string}"`,
        triggerId: triggerId as unknown as string,
      },
      requestId,
    ),
  );
}

/**
 * The registry's refusal, with its code's status: on a trigger, its id.
 * `trigger-connection-taken` names the connection and the live text
 * trigger that answers it (`heldBy`).
 */
function registryError(
  c: Context<AppEnv>,
  requestId: string,
  error: {
    readonly code: string;
    readonly message: string;
    readonly heldBy?: TriggerId;
  },
  connectionId: string | undefined,
  triggerId?: TriggerId,
): Response {
  c.status(statusFor(error.code) as never);
  return c.json(
    toWireError(
      {
        code: error.code,
        message: error.message,
        ...(triggerId !== undefined && { triggerId: triggerId as unknown as string }),
        ...(error.heldBy !== undefined && {
          heldBy: error.heldBy as unknown as string,
          ...(connectionId !== undefined && { connectionId }),
        }),
      },
      requestId,
    ),
  );
}
