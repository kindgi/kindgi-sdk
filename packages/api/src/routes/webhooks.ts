// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import type { Context } from 'hono';

import type { AuditEventBinding } from '@kindgi/audit-events';
import { type Action, type ResourceRef, ref, tuplesForCreate } from '@kindgi/authz';
import type { ProjectBinding, Scope } from '@kindgi/platform';
import type {
  Cursor,
  EnvName,
  ProjectId,
  RecordedSecretScope,
  TenantId,
  TriggerId,
  WebhookSignatureScheme,
} from '@kindgi/types';

import { labelOrNull, patchedField } from '../bounded-text.js';
import { callerIdentity, callerRef } from '../caller.js';
import { sameJson } from '../canonical-json.js';
import { statusFor, toWireError } from '../errors.js';
import { type ItemRights, runIn } from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import { type ProviderKeys, refuseSecretNames } from '../provider-keys.js';
import {
  type ReferenceScopeBinding,
  outOfScopeResponse,
  referencesOutOfScope,
} from '../reference-scope.js';
import { recordedSecretScope, secretScopesFor } from '../secret-scope.js';
import type { SecretBinding } from '../secrets-binding.js';
import { secretNameGrammarRefusal } from '../secrets-binding.js';
import {
  type RegisterWebhookTriggerInput,
  type TriggerFire,
  type TriggerRegistryBinding,
  type UpdateWebhookTriggerInput,
  WEBHOOK_BODY_LIMITS,
  WEBHOOK_RATE_LIMITS,
  type WebhookTriggerRecord,
  type WebhookTriggerVersionRecord,
} from '../trigger-binding.js';
import type { AppEnv } from '../types.js';
import { generateSigningSecret } from '../webhook-signing-secret.js';
import { clampLimit } from './pagination.js';
import {
  type OwnedTrigger,
  type OwnerFacts,
  type TriggerOwnerNames,
  type TriggerOwnerNotices,
  isTriggerAdmin,
  namesAnOwner,
  noteChangeForOwner,
  ownerJson,
  ownerNamesOf,
  ownerRequestOf,
  ownerRuleRefused,
  personalTriggerRefusal,
  recordOwnerSet,
  resolveTriggerOwner,
  tellTakenOver,
  triggerAdminRefusal,
  triggerOwnerDeps,
} from './trigger-owners.js';
import {
  type TargetToolsDeps,
  parseToolsAllowedUnattended,
  recordToolsAllowedUnattendedSet,
  sameToolList,
  toolsAllowedUnattendedProblem,
} from './trigger-tools.js';
import { versionField, versionFields, versionOne, versionsPage } from './trigger-versions.js';
import { UUID_RE } from './uuid-param.js';
import { auditWrite } from './write-audit.js';

export interface WebhooksRouterOptions {
  readonly authorizer?: Authorizer;
  /**
   * The tenant's Default project, where a webhook trigger that names no
   * project goes; and a project's org, where its signing secret may be read.
   */
  readonly projects?: Pick<ProjectBinding, 'getDefault' | 'get'>;
  /**
   * Where a trigger's signing secret is read is recorded at registration
   * (`secret-scope.ts`), and `generateSecret` stores a new one here, under a
   * name it can write (`nameRefusal`). Absent: neither.
   */
  readonly secrets?: Pick<SecretBinding, 'get' | 'set' | 'nameRefusal'>;
  /** The env the receiver reads signing secrets in (`webhookReceiver.envName`). */
  readonly envName?: EnvName;
  /** A generated secret's write is recorded as any secret write is. */
  readonly auditEvents?: AuditEventBinding;
  /** Where an owner's name is read (`owner.displayName`). */
  readonly names?: TriggerOwnerNames;
  /** A model provider's key is never a webhook trigger's secret. */
  readonly providerKeys?: ProviderKeys;
  /**
   * A trigger's receive URL (`POST /v1/hooks/{tenantId}/{webhookId}`), made
   * from the deployment's configured public URL; never from a request's
   * `Host`, which the caller writes. Absent when the deployment has none:
   * records then carry no `receiveUrl`.
   */
  readonly receiveUrl?: (tenantId: TenantId, webhookId: string) => string;
  /** What a webhook trigger's project may run (`reference-scope.ts`); absent → as named. */
  readonly referenceScope?: ReferenceScopeBinding;
  /**
   * Rights on a flow more than one project serves (`item-rights.ts`):
   * from a trigger in one of its projects, running it is that project's
   * `execute`, as for a run naming it. Absent: one project each.
   */
  readonly itemRights?: ItemRights;
  /**
   * Where a trigger's flow and its agents are read, to check
   * `toolsAllowedUnattended` (`trigger-tools.ts`); absent → a list is refused.
   */
  readonly targetTools?: TargetToolsDeps;
  /** Who tells a person what a project admin did to their trigger; absent → only audited. */
  readonly ownerNotices?: TriggerOwnerNotices;
}

/**
 * Webhook triggers: a signed request to the trigger's receive URL starts a
 * run of its flow (the receiver is `hooks.ts`, outside the bearer chain).
 *
 *   POST /v1/webhooks                          register
 *   GET  /v1/webhooks[?projectId=]             list (cursor-paginated)
 *   GET  /v1/webhooks/:triggerId               get
 *   PATCH /v1/webhooks/:triggerId              update
 *   POST /v1/webhooks/:triggerId/pause | resume | unregister
 *   GET  /v1/webhooks/:triggerId/fires         its deliveries, newest first
 *   POST /v1/webhooks/:triggerId/owner         the caller becomes the owner
 *
 * As schedules: a trigger's runs act as its owner (whoever registered it,
 * until an admin takes it over), checked again at every delivery. No
 * change moves the owner; only a take-over does. With an authorizer,
 * reads need `read` on the trigger's project, changes `write`, taking
 * ownership `admin`, and registering or changing the flow version also
 * needs `execute` on the flow, as starting that run does.
 *
 * Personal or shared, as schedules (`trigger-owners.ts`): a trigger a
 * person owns is only theirs (holding `write`) or a project admin's to
 * change, pause, resume or delete. On one a service account owns, its flow
 * version, its input, its tool list and its signing secret take a project
 * admin to change, and the rest is the project's writers'. Without an
 * authorizer, a project admin is a tenant-admin key. A project admin's
 * change to a personal trigger is audited (`trigger-changed-for-owner`),
 * and its owner told (`ownerNotices`).
 *
 * The signing secret is never on the row: the body carries
 * `hmacSecretName`, a secret the caller wrote first (`POST /v1/secrets`).
 * Rotating its value goes through `/v1/secrets`; naming another secret
 * through `PATCH`. A model provider's key is refused.
 */
export function webhooksRouter(
  binding: TriggerRegistryBinding,
  options: WebhooksRouterOptions = {},
): Hono<AppEnv> {
  const {
    authorizer,
    projects,
    names,
    providerKeys,
    receiveUrl,
    secrets,
    envName,
    auditEvents,
    referenceScope,
    itemRights,
    targetTools,
    ownerNotices,
  } = options;
  const r = new Hono<AppEnv>();

  /** A webhook trigger as the owner rule reads it. */
  const owned = (row: WebhookTriggerRecord): OwnedTrigger => ({
    tenantId: row.tenantId,
    triggerId: row.triggerId as unknown as string,
    projectId: row.projectId as unknown as string,
    label: row.label,
    owner: row.owner,
  });

  /** Running `flowId` from a trigger in `projectId`: `execute` on it, or for a flow more than one project serves, there (`runIn`). */
  async function flowRefused(
    c: Context<AppEnv>,
    flowId: string,
    projectId: string | undefined,
  ): Promise<Response | undefined> {
    const served =
      authorizer === undefined ? undefined : await itemRights?.multi(c, 'flow', flowId);
    return itemRights !== undefined &&
      projectId !== undefined &&
      served?.includes(projectId as ProjectId) === true
      ? runIn(c, itemRights, { kind: 'flow', id: flowId }, projectId)
      : denied(c, 'execute', ref('flow', flowId));
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

  /** The webhook trigger, if it is one (another kind's id is not found here), and the caller may `action` it. */
  async function webhookFor(
    c: Context<AppEnv>,
    action: Action,
  ): Promise<{ kind: 'ok'; value: WebhookTriggerRecord } | { kind: 'err'; response: Response }> {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const triggerId = c.req.param('triggerId') as TriggerId;
    const rec = UUID_RE.test(triggerId) ? await binding.get({ tenantId, triggerId }) : null;
    if (rec === null || rec.kind !== 'webhook') {
      return { kind: 'err', response: notFound(c, requestId, triggerId) };
    }
    const refused = await denied(c, action, ref('project', rec.projectId as unknown as string));
    if (refused !== undefined) return { kind: 'err', response: refused };
    return { kind: 'ok', value: rec };
  }

  /** Records as the wire carries them, their owners named. */
  async function serialized(
    tenantId: TenantId,
    rows: readonly WebhookTriggerRecord[],
  ): Promise<Record<string, unknown>[]> {
    const named = await ownerNamesOf(
      names,
      tenantId,
      rows.map((row) => row.owner),
    );
    return rows.map((row) => serializeWebhook(row, named, receiveUrl));
  }

  async function webhookJson(
    c: Context<AppEnv>,
    row: WebhookTriggerRecord,
    signingSecret?: string,
  ): Promise<Response> {
    const [json] = await serialized(c.get('tenantId') as TenantId, [row]);
    return c.json({ ...json, ...(signingSecret !== undefined && { signingSecret }) });
  }

  /**
   * Where a signing secret named by a trigger at `item` is read, as the
   * caller may read it (`secret-scope.ts`); `undefined` when not recorded.
   */
  async function hmacScopeFor(
    c: Context<AppEnv>,
    item: Scope,
    name: string,
  ): Promise<RecordedSecretScope | null | undefined> {
    // Without the receiver's env, nothing is looked up: the broadest scope
    // the caller administers is recorded (`secret-scope.ts`).
    const scopes = await secretScopesFor(c, { secrets, projects, authorizer }, item, [
      { envName, name },
    ]);
    return scopes?.[name];
  }

  /**
   * A name `generateSecret` can't store the signing secret under: the shared
   * name grammar ({@link secretNameGrammarRefusal}) first, then the store's
   * own rule (`nameRefusal`), as a typed `400`. Naming a secret that's already
   * stored never asks: the dev store reads names it can't write (a key typed
   * into `.env` by hand).
   */
  function nameRefused(c: Context<AppEnv>, name: string): Response | undefined {
    const refusal = secretNameGrammarRefusal(name) ?? secrets?.nameRefusal?.(name);
    if (refusal === undefined) return undefined;
    c.status(statusFor(refusal.code) as never);
    // A reserved name says which, as when the trigger names an existing secret.
    const named = refusal.code === 'reserved-name-prefix' ? { secret: name } : {};
    return c.json(
      toWireError({ code: refusal.code, message: refusal.message, ...named }, c.get('requestId')),
    );
  }

  /** A reserved `kindgi.` name or a model provider's key named as the signing secret: the refusal. */
  async function signingSecretRefused(
    c: Context<AppEnv>,
    name: string,
  ): Promise<Response | undefined> {
    const refusal = await refuseSecretNames(
      providerKeys,
      c.get('tenantId') as TenantId,
      [name],
      'a webhook trigger',
    );
    if (refusal === undefined) return undefined;
    c.status(statusFor(refusal.code) as never);
    return c.json(toWireError(refusal, c.get('requestId')));
  }

  // ---------- POST / (register) ----------
  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    const parsed = await parseJsonObject(c, requestId);
    if (parsed.kind === 'err') return parsed.response;
    const body = parsed.value;

    const flowId = requireString(body, 'flowId');
    const flowVersion = requireString(body, 'flowVersion');
    const hmacSecretName = requireString(body, 'hmacSecretName');
    if (body.generateSecret !== undefined && typeof body.generateSecret !== 'boolean') {
      return bad(c, requestId, '`generateSecret` must be a boolean');
    }
    const generate = body.generateSecret === true;
    if (flowId.kind === 'err') return bad(c, requestId, flowId.message);
    if (flowVersion.kind === 'err') return bad(c, requestId, flowVersion.message);
    if (hmacSecretName.kind === 'err') return bad(c, requestId, hmacSecretName.message);
    const projectId = body.projectId;
    if (projectId !== undefined && (typeof projectId !== 'string' || !UUID_RE.test(projectId))) {
      return bad(c, requestId, '`projectId` must be a project id (a UUID)');
    }
    const delivery = parseDelivery(body, false);
    if (delivery.kind === 'err') return bad(c, requestId, delivery.message);
    const tools = parseToolsAllowedUnattended(body);
    if (tools.kind === 'err') return bad(c, requestId, tools.message);
    const label = labelOrNull(body.label ?? null);
    if (label.problem !== undefined) return bad(c, requestId, label.problem);
    // A name the store can't write, refused before anything is stored: the
    // trigger goes in before the secret it generates.
    const unwritable = generate ? nameRefused(c, hmacSecretName.value) : undefined;
    if (unwritable !== undefined) return unwritable;

    // A trigger that names no project goes in the tenant's Default
    // project: checked and stored as that project. With no Default to
    // find, the registry picks it, and only a tenant admin may.
    const project =
      (projectId as string | undefined) ??
      ((await projects?.getDefault(tenantId))?.id as string | undefined);
    const refused =
      (project === undefined
        ? await denied(c, 'admin', ref('tenant', tenantId as unknown as string))
        : await denied(c, 'write', ref('project', project))) ??
      (await flowRefused(c, flowId.value, project));
    if (refused !== undefined) return refused;
    // The flow it runs, at its version, must be its project's to reach
    // (`reference-scope.ts`).
    if (project !== undefined) {
      const outOfScope = await referencesOutOfScope(
        referenceScope,
        tenantId,
        project as ProjectId,
        [{ path: '/flowId', kind: 'flow', id: flowId.value, version: flowVersion.value }],
      );
      if (outOfScope !== undefined) return outOfScopeResponse(c, requestId, outOfScope);
    }
    // What its runs may call without a person's yes: a project admin's to
    // set, and only tools its flow calls (`trigger-tools.ts`).
    if (tools.kind === 'ok') {
      const notAdmin = await triggerAdminRefusal(c, authorizer, project, TOOLS_TAKE_ADMIN);
      if (notAdmin !== undefined) return notAdmin;
      const problem = await toolsAllowedUnattendedProblem(
        targetTools,
        tenantId,
        { kind: 'flow', flowId: flowId.value, flowVersion: flowVersion.value },
        tools.value,
      );
      if (problem !== undefined) return bad(c, requestId, problem);
    }
    const secretRefused = await signingSecretRefused(c, hmacSecretName.value);
    if (secretRefused !== undefined) return secretRefused;

    // The signing secret: made here (`generateSecret`), in the trigger's own
    // scope, where it's then read; or named, and read where its registrant
    // may read it (`secret-scope.ts`).
    const item: Scope =
      project !== undefined
        ? { kind: 'project', tenantId, projectId: project as ProjectId }
        : { kind: 'tenant', tenantId };
    let generated: string | undefined;
    let hmacSecretScope: RecordedSecretScope | null | undefined;
    if (generate) {
      if (secrets === undefined || envName === undefined) {
        return bad(
          c,
          requestId,
          "This deployment can't make a signing secret (it has no secrets store, or no webhook receiver): store one and name it in `hmacSecretName`, without `generateSecret`.",
        );
      }
      const existing = await secrets.get({ scope: item, envName, name: hmacSecretName.value });
      if (existing !== null) return secretTaken(c, requestId, hmacSecretName.value, envName);
      generated = generateSigningSecret(delivery.value.signature ?? undefined);
      hmacSecretScope = recordedSecretScope(item);
    } else {
      hmacSecretScope = await hmacScopeFor(c, item, hmacSecretName.value);
    }

    // Who its runs act as: the caller, the service account named with
    // `runAsServiceAccountId` (gated by `act_as`), or the project's own
    // account with `runAsProject` (a project admin's; see `resolveTriggerOwner`).
    const ownerRequest = ownerRequestOf(body, project);
    if (typeof ownerRequest === 'string') return bad(c, requestId, ownerRequest);
    const resolved = await resolveTriggerOwner(
      c,
      ownerRequest,
      { kind: 'flow', flowId: flowId.value },
      triggerOwnerDeps(c, authorizer, names?.serviceAccounts),
    );
    if (resolved.kind === 'refused') return resolved.response;
    const owner = resolved.owner;

    const rawConfig = (body.config ?? {}) as Record<string, unknown>;
    const registerInput: RegisterWebhookTriggerInput = {
      kind: 'webhook',
      tenantId,
      by: callerIdentity(c),
      flowId: flowId.value,
      flowVersion: flowVersion.value,
      ...(project !== undefined && { projectId: project as ProjectId }),
      owner,
      config: { ...('input' in rawConfig && { input: rawConfig.input }) },
      // The route mints the routable id: a random UUID, so the receive URL
      // can't be guessed. The signature is still what authorises a request.
      webhookId: randomUUID(),
      hmacSecretName: hmacSecretName.value,
      ...(hmacSecretScope !== undefined && { hmacSecretScope }),
      ...withoutNulls(delivery.value),
      ...(label.value !== null && { label: label.value }),
      ...(tools.kind === 'ok' && tools.value.length > 0 && { toolsAllowedUnattended: tools.value }),
    };

    const result = await binding.register(registerInput);
    if (result.kind === 'err') {
      c.status(statusFor(result.error.code) as never);
      return c.json(
        toWireError({ code: result.error.code, message: result.error.message }, requestId),
      );
    }
    // The secret once the trigger exists, so a refused register leaves none
    // behind; a secret that can't be stored takes the trigger back.
    if (generated !== undefined && secrets !== undefined && envName !== undefined) {
      const stored = await secrets.set({
        scope: item,
        envName,
        name: hmacSecretName.value,
        value: generated,
        writeMode: 'create-new',
        enqueueTuples: (secretRowId) =>
          tuplesForCreate({ kind: 'secret', id: secretRowId, tenantId, scope: item }),
      });
      await auditWrite(c, auditEvents, {
        kind: 'secret-set',
        scope: item,
        envName,
        name: hmacSecretName.value,
        writeMode: 'create-new',
        ...(stored.kind === 'ok'
          ? { outcome: 'succeeded' as const, version: stored.versionId }
          : {
              outcome: 'failed' as const,
              errorCode: stored.kind === 'error' ? stored.code : 'secret-write-conflict',
            }),
      });
      if (stored.kind !== 'ok') {
        await binding.unregister({ tenantId, triggerId: result.value.triggerId });
        if (stored.kind !== 'error') {
          return secretTaken(c, requestId, hmacSecretName.value, envName);
        }
        c.status(statusFor(stored.code) as never);
        return c.json(toWireError({ code: stored.code, message: stored.message }, requestId));
      }
    }
    // A named service-account owner is a delegation: audit it. A plain
    // register (owner = caller) is the trigger's creation, not a change.
    if (namesAnOwner(ownerRequest)) {
      await recordOwnerSet({
        auditEvents,
        tenantId,
        ...(project !== undefined && { projectId: project as ProjectId }),
        triggerId: result.value.triggerId,
        triggerKind: 'webhook',
        to: owner,
        by: callerRef(c),
        correlationId: requestId,
        log: c.get('log'),
        ...(resolved.projectAccount === true && { projectAccount: true }),
        ...versionField(result.value),
      });
    }
    if (tools.kind === 'ok' && tools.value.length > 0) {
      await recordToolsAllowedUnattendedSet({
        auditEvents,
        tenantId,
        ...(project !== undefined && { projectId: project as ProjectId }),
        triggerId: result.value.triggerId,
        triggerKind: 'webhook',
        target: { kind: 'flow', flowId: flowId.value, flowVersion: flowVersion.value },
        to: tools.value,
        by: callerRef(c),
        correlationId: requestId,
        log: c.get('log'),
        ...versionField(result.value),
      });
    }
    c.status(201);
    return webhookJson(c, result.value as WebhookTriggerRecord, generated);
  });

  // ---------- GET / (list) ----------
  // The tenant's webhook triggers, then only those whose project the
  // caller may read. The page and its cursor are the tenant's, so a page
  // can hold fewer than `limit` rows and still have more.
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
    // would say whether it has webhook triggers.
    if (projectId !== undefined) {
      const refused = await denied(c, 'read', ref('project', projectId as unknown as string));
      if (refused !== undefined) return refused;
    }

    let statusFilter: 'active' | 'paused' | undefined;
    if (statusRaw === 'active' || statusRaw === 'paused') statusFilter = statusRaw;

    const page = await binding.list({
      tenantId,
      kind: 'webhook',
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(statusFilter !== undefined && { status: statusFilter }),
      ...(projectId !== undefined && { projectId }),
    });
    // The binding narrows to the project; this keeps a page right from one that doesn't.
    const rows = (page.data as WebhookTriggerRecord[]).filter(
      (row) => projectId === undefined || row.projectId === projectId,
    );
    const visible =
      authorizer === undefined
        ? rows
        : await authorizer.filterByCan(c, 'read', rows, (rec) =>
            ref('project', rec.projectId as unknown as string),
          );
    return c.json({
      data: await serialized(tenantId, visible),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:triggerId (get) ----------
  r.get('/:triggerId', async (c) => {
    const found = await webhookFor(c, 'read');
    if (found.kind === 'err') return found.response;
    return webhookJson(c, found.value);
  });

  // ---------- PATCH /:triggerId (update) ----------
  r.patch('/:triggerId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    const parsed = await parseJsonObject(c, requestId);
    if (parsed.kind === 'err') return parsed.response;
    const body = parsed.value;
    if ('flowId' in body) {
      return bad(
        c,
        requestId,
        'A webhook trigger keeps its flow: change `flowVersion`, or register another trigger',
      );
    }
    if (
      'flowVersion' in body &&
      (typeof body.flowVersion !== 'string' || body.flowVersion.length === 0)
    ) {
      return bad(c, requestId, '`flowVersion` must be a version (semver)');
    }
    if (
      'hmacSecretName' in body &&
      (typeof body.hmacSecretName !== 'string' || body.hmacSecretName.length === 0)
    ) {
      return bad(c, requestId, '`hmacSecretName` must be a secret name');
    }
    const delivery = parseDelivery(body, true);
    if (delivery.kind === 'err') return bad(c, requestId, delivery.message);
    const tools = parseToolsAllowedUnattended(body);
    if (tools.kind === 'err') return bad(c, requestId, tools.message);

    const found = await webhookFor(c, 'write');
    if (found.kind === 'err') return found.response;
    // As create checks it, against the webhook just read.
    const label = await patchedField(body.label, labelOrNull, async () => found.value.label);
    if (label.kind === 'refused') return bad(c, requestId, label.problem);
    const notOwners = await personalTriggerRefusal(
      c,
      authorizer,
      names,
      owned(found.value),
      'webhook trigger',
    );
    if (notOwners !== undefined) return notOwners;
    const signature = delivery.value.signature ?? found.value.signature;
    const deliveryIdHeader =
      delivery.value.deliveryIdHeader === undefined
        ? found.value.deliveryIdHeader
        : (delivery.value.deliveryIdHeader ?? undefined);
    if (signature.kind === 'standard-webhooks' && deliveryIdHeader !== undefined) {
      return bad(c, requestId, STANDARD_WEBHOOKS_DEDUPES);
    }
    if (typeof body.flowVersion === 'string') {
      const refused = await flowRefused(
        c,
        found.value.flowId,
        found.value.projectId as unknown as string,
      );
      if (refused !== undefined) return refused;
      // The version it moves to must be its project's to reach, as at registration.
      const outOfScope = await referencesOutOfScope(
        referenceScope,
        tenantId,
        found.value.projectId,
        [
          {
            path: '/flowVersion',
            kind: 'flow',
            id: found.value.flowId as unknown as string,
            version: body.flowVersion,
          },
        ],
      );
      if (outOfScope !== undefined) return outOfScopeResponse(c, requestId, outOfScope);
    }
    if (typeof body.hmacSecretName === 'string') {
      const secretRefused = await signingSecretRefused(c, body.hmacSecretName);
      if (secretRefused !== undefined) return secretRefused;
    }
    // Its `toolsAllowedUnattended`: kept unless named (a trigger keeps its
    // flow, so a new version keeps it too); naming it takes `admin`, and
    // it's checked against the flow at the version it will run.
    const kept = found.value.toolsAllowedUnattended ?? [];
    const flowAfter = {
      kind: 'flow' as const,
      flowId: found.value.flowId,
      flowVersion:
        typeof body.flowVersion === 'string' ? body.flowVersion : found.value.flowVersion,
    };
    if (tools.kind === 'ok') {
      const notAdmin = await triggerAdminRefusal(
        c,
        authorizer,
        found.value.projectId as unknown as string,
        TOOLS_TAKE_ADMIN,
      );
      if (notAdmin !== undefined) return notAdmin;
      const problem = await toolsAllowedUnattendedProblem(
        targetTools,
        tenantId,
        flowAfter,
        tools.value,
      );
      if (problem !== undefined) return bad(c, requestId, problem);
    }

    const patchConfig = body.config as Record<string, unknown> | undefined;
    const cfg: Partial<{ input: unknown }> = {};
    if (patchConfig !== undefined && 'input' in patchConfig) cfg.input = patchConfig.input;

    const triggerId = found.value.triggerId;
    // Another secret's name: where it's read, recorded again as the caller
    // may read it (`secret-scope.ts`).
    const hmacSecretScope =
      typeof body.hmacSecretName === 'string'
        ? await hmacScopeFor(
            c,
            { kind: 'project', tenantId, projectId: found.value.projectId },
            body.hmacSecretName,
          )
        : undefined;
    const updateInput: UpdateWebhookTriggerInput = {
      kind: 'webhook',
      tenantId,
      triggerId,
      by: callerIdentity(c),
      ...(hmacSecretScope !== undefined && { hmacSecretScope }),
      ...(Object.keys(cfg).length > 0 && { config: cfg }),
      ...(label.kind === 'write' && { label: label.value }),
      ...(typeof body.flowVersion === 'string' && { flowVersion: body.flowVersion }),
      ...(typeof body.hmacSecretName === 'string' && { hmacSecretName: body.hmacSecretName }),
      ...delivery.value,
      // The same tools in another order change nothing: no version, as no audit entry.
      ...(tools.kind === 'ok' &&
        !sameToolList(kept, tools.value) && { toolsAllowedUnattended: tools.value }),
    };

    // What it runs: its flow version, its input, its tool list, its signing
    // secret. On a shared trigger (or one with no owner) a project admin's
    // to change; the label and the delivery settings stay the writers'.
    const runs: string[] = [];
    if (typeof body.flowVersion === 'string' && body.flowVersion !== found.value.flowVersion) {
      runs.push('target');
    }
    if ('input' in cfg && !sameJson(cfg.input, found.value.config.input)) runs.push('input');
    if (tools.kind === 'ok' && !sameToolList(kept, tools.value)) {
      runs.push('toolsAllowedUnattended');
    }
    if (
      typeof body.hmacSecretName === 'string' &&
      body.hmacSecretName !== found.value.hmacSecretName
    ) {
      runs.push('hmacSecretName');
    }
    if (
      found.value.owner.kind !== 'user' &&
      runs.length > 0 &&
      !(await isTriggerAdmin(c, authorizer, found.value.projectId as unknown as string))
    ) {
      return ownerRuleRefused(c, authorizer, names, owned(found.value), 'webhook trigger');
    }
    const result = await binding.update(updateInput);
    if (result.kind === 'err') return lifecycleError(c, requestId, result.error, triggerId);
    if (tools.kind === 'ok' && !sameToolList(kept, tools.value)) {
      await recordToolsAllowedUnattendedSet({
        auditEvents,
        tenantId,
        projectId: found.value.projectId,
        triggerId,
        triggerKind: 'webhook',
        target: flowAfter,
        from: kept,
        to: tools.value,
        by: callerRef(c),
        correlationId: requestId,
        log: c.get('log'),
        ...versionField(result.value),
      });
    }
    const after = result.value as WebhookTriggerRecord;
    await noteChangeForOwner(c, {
      auditEvents,
      notices: ownerNotices,
      trigger: owned(found.value),
      triggerKind: 'webhook',
      change: 'updated',
      fields: [...runs, ...settingsChanged(found.value, after)],
      ...(runs.includes('target') && {
        target: {
          before: { flowId: found.value.flowId, flowVersion: found.value.flowVersion },
          after: { flowId: flowAfter.flowId, flowVersion: flowAfter.flowVersion },
        },
      }),
      ...(runs.includes('hmacSecretName') && {
        hmacSecretName: { before: found.value.hmacSecretName, after: after.hmacSecretName },
      }),
      ...versionField(result.value),
    });
    return webhookJson(c, after);
  });

  // ---------- POST /:triggerId/pause | resume ----------
  // A paused trigger takes deliveries without starting runs: each is a
  // `skipped` fire, and its event is dropped (senders such as WooCommerce
  // never resend).
  for (const verb of ['pause', 'resume'] as const) {
    r.post(`/:triggerId/${verb}`, async (c) => {
      const requestId = c.get('requestId');
      const found = await webhookFor(c, 'write');
      if (found.kind === 'err') return found.response;
      const notOwners = await personalTriggerRefusal(
        c,
        authorizer,
        names,
        owned(found.value),
        'webhook trigger',
      );
      if (notOwners !== undefined) return notOwners;
      const { tenantId, triggerId } = found.value;
      const result = await binding[verb]({ tenantId, triggerId });
      if (result.kind === 'err') return lifecycleError(c, requestId, result.error, triggerId);
      await noteChangeForOwner(c, {
        auditEvents,
        notices: ownerNotices,
        trigger: owned(found.value),
        triggerKind: 'webhook',
        change: verb === 'pause' ? 'paused' : 'resumed',
      });
      return webhookJson(c, result.value as WebhookTriggerRecord);
    });
  }

  // ---------- POST /:triggerId/unregister (soft delete) ----------
  r.post('/:triggerId/unregister', async (c) => {
    const found = await webhookFor(c, 'write');
    if (found.kind === 'err') return found.response;
    const notOwners = await personalTriggerRefusal(
      c,
      authorizer,
      names,
      owned(found.value),
      'webhook trigger',
    );
    if (notOwners !== undefined) return notOwners;
    const { tenantId, triggerId } = found.value;
    const outcome = await binding.unregister({ tenantId, triggerId });
    if (outcome.unregistered) {
      await noteChangeForOwner(c, {
        auditEvents,
        notices: ownerNotices,
        trigger: owned(found.value),
        triggerKind: 'webhook',
        change: 'unregistered',
      });
    }
    return c.json({
      triggerId: triggerId as unknown as string,
      unregistered: outcome.unregistered,
    });
  });

  // ---------- GET /:triggerId/fires (deliveries) ----------
  r.get('/:triggerId/fires', async (c) => {
    const requestId = c.get('requestId');
    const found = await webhookFor(c, 'read');
    if (found.kind === 'err') return found.response;
    if (binding.listFires === undefined) return unsupported(c, requestId, 'delivery history');
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
    versions: readonly WebhookTriggerVersionRecord[],
  ) => {
    const named = await ownerNamesOf(
      names,
      c.get('tenantId') as TenantId,
      versions.map((v) => v.definition.owner),
    );
    return versions.map((v) => serializeWebhookVersion(v, named));
  };

  // ---------- GET /:triggerId/versions (newest first) ----------
  r.get('/:triggerId/versions', async (c) => {
    const found = await webhookFor(c, 'read');
    if (found.kind === 'err') return found.response;
    return versionsPage(c, binding, found.value.triggerId, 'webhook', (v) => versionsJson(c, v));
  });

  // ---------- GET /:triggerId/versions/:version ----------
  r.get('/:triggerId/versions/:version', async (c) => {
    const found = await webhookFor(c, 'read');
    if (found.kind === 'err') return found.response;
    return versionOne(c, binding, found.value.triggerId, 'webhook', (v) => versionsJson(c, v));
  });

  // ---------- POST /:triggerId/owner (take ownership) ----------
  r.post('/:triggerId/owner', async (c) => {
    const requestId = c.get('requestId');
    const found = await webhookFor(c, 'write');
    if (found.kind === 'err') return found.response;
    const notAdmin = await triggerAdminRefusal(
      c,
      authorizer,
      found.value.projectId as unknown as string,
      'Taking a webhook trigger over takes a project admin.',
    );
    if (notAdmin !== undefined) return notAdmin;
    if (binding.setOwner === undefined) return unsupported(c, requestId, 'changing the owner');
    const refused = await flowRefused(
      c,
      found.value.flowId,
      found.value.projectId as unknown as string,
    );
    if (refused !== undefined) return refused;
    // The caller takes it over, or names a service account with
    // `runAsServiceAccountId` in an optional body (gated by `act_as`), or
    // the project's own account with `runAsProject`.
    const parsed = await parseJsonObject(c, requestId, { allowEmpty: true });
    if (parsed.kind === 'err') return parsed.response;
    if ('toolsAllowedUnattended' in parsed.value) {
      return bad(
        c,
        requestId,
        "a take-over keeps the trigger's `toolsAllowedUnattended`: change it with PATCH",
      );
    }
    const ownerRequest = ownerRequestOf(
      parsed.value,
      found.value.projectId as unknown as string | undefined,
    );
    if (typeof ownerRequest === 'string') return bad(c, requestId, ownerRequest);
    const resolved = await resolveTriggerOwner(
      c,
      ownerRequest,
      { kind: 'flow', flowId: found.value.flowId },
      triggerOwnerDeps(c, authorizer, names?.serviceAccounts),
    );
    if (resolved.kind === 'refused') return resolved.response;
    const { tenantId, triggerId } = found.value;
    const previousOwner = found.value.owner;
    const result = await binding.setOwner({
      tenantId,
      triggerId,
      owner: resolved.owner,
      by: callerIdentity(c),
    });
    if (result.kind === 'err') return lifecycleError(c, requestId, result.error, triggerId);
    // Every owner change is audited, a plain caller take-over included.
    await recordOwnerSet({
      auditEvents,
      tenantId,
      ...(found.value.projectId !== undefined && { projectId: found.value.projectId as ProjectId }),
      triggerId,
      triggerKind: 'webhook',
      from: previousOwner,
      to: resolved.owner,
      by: callerRef(c),
      correlationId: requestId,
      log: c.get('log'),
      ...(found.value.toolsAllowedUnattended !== undefined && {
        toolsAllowedUnattended: found.value.toolsAllowedUnattended,
      }),
      ...(resolved.projectAccount === true && { projectAccount: true }),
      ...versionField(result.value),
    });
    tellTakenOver(c, ownerNotices, owned(found.value), 'webhook');
    return webhookJson(c, result.value as WebhookTriggerRecord);
  });

  return r;
}

/** The 403 message for a tool list set by anyone but a project admin. */
const TOOLS_TAKE_ADMIN =
  "Setting a webhook trigger's tools allowed unattended takes a project admin.";

/**
 * The names of the settings an update changed, beside what it runs: its
 * label and its delivery settings, read off the trigger before and after.
 * Names only, never their values.
 */
function settingsChanged(before: WebhookTriggerRecord, after: WebhookTriggerRecord): string[] {
  return (
    ['label', 'signature', 'deliveryIdHeader', 'bodyLimitBytes', 'rateLimitPerMinute'] as const
  ).filter((key) => !sameJson(before[key] ?? null, after[key] ?? null));
}

// -----------------------------------------------------------------------
// The wire: what a trigger's sender signs, and how its deliveries are kept.
// -----------------------------------------------------------------------

const STANDARD_WEBHOOKS_DEDUPES =
  "`standard-webhooks` dedupes on its own `webhook-id`: don't set `deliveryIdHeader` with it";

/** An HTTP header name (RFC 9110 token), at most 100 characters. */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;

/** The longest `standard-webhooks` tolerance a trigger may set: a wider window is a wider replay. */
const MAX_TOLERANCE_SECONDS = 3600;

interface DeliveryFields {
  readonly signature?: WebhookSignatureScheme;
  readonly deliveryIdHeader?: string | null;
  readonly bodyLimitBytes?: number | null;
  readonly rateLimitPerMinute?: number | null;
}

/** Drop the fields an update clears (`null`): a register has nothing to clear. */
function withoutNulls(fields: DeliveryFields): {
  readonly signature?: WebhookSignatureScheme;
  readonly deliveryIdHeader?: string;
  readonly bodyLimitBytes?: number;
  readonly rateLimitPerMinute?: number;
} {
  return {
    ...(fields.signature !== undefined && { signature: fields.signature }),
    ...(typeof fields.deliveryIdHeader === 'string' && {
      deliveryIdHeader: fields.deliveryIdHeader,
    }),
    ...(typeof fields.bodyLimitBytes === 'number' && { bodyLimitBytes: fields.bodyLimitBytes }),
    ...(typeof fields.rateLimitPerMinute === 'number' && {
      rateLimitPerMinute: fields.rateLimitPerMinute,
    }),
  };
}

/**
 * `signature`, `deliveryIdHeader`, `bodyLimitBytes` and
 * `rateLimitPerMinute`, each optional; on an update (`clearable`), `null`
 * clears the last three.
 */
function parseDelivery(
  body: Record<string, unknown>,
  clearable: boolean,
): { kind: 'ok'; value: DeliveryFields } | { kind: 'err'; message: string } {
  const out: {
    signature?: WebhookSignatureScheme;
    deliveryIdHeader?: string | null;
    bodyLimitBytes?: number | null;
    rateLimitPerMinute?: number | null;
  } = {};
  if (body.signature !== undefined) {
    const signature = parseSignature(body.signature);
    if (signature.kind === 'err') return signature;
    out.signature = signature.value;
  }
  const { deliveryIdHeader, bodyLimitBytes, rateLimitPerMinute } = body;
  if (deliveryIdHeader !== undefined) {
    if (deliveryIdHeader === null && clearable) out.deliveryIdHeader = null;
    else if (typeof deliveryIdHeader === 'string' && HEADER_NAME_RE.test(deliveryIdHeader)) {
      out.deliveryIdHeader = deliveryIdHeader;
    } else {
      return { kind: 'err', message: '`deliveryIdHeader` must be an HTTP header name' };
    }
  }
  if (out.signature?.kind === 'standard-webhooks' && typeof out.deliveryIdHeader === 'string') {
    return { kind: 'err', message: STANDARD_WEBHOOKS_DEDUPES };
  }
  if (bodyLimitBytes !== undefined) {
    if (bodyLimitBytes === null && clearable) out.bodyLimitBytes = null;
    else if (
      typeof bodyLimitBytes === 'number' &&
      Number.isInteger(bodyLimitBytes) &&
      bodyLimitBytes >= 1024 &&
      bodyLimitBytes <= WEBHOOK_BODY_LIMITS.maxBytes
    ) {
      out.bodyLimitBytes = bodyLimitBytes;
    } else {
      return {
        kind: 'err',
        message: `\`bodyLimitBytes\` must be a whole number from 1024 to ${WEBHOOK_BODY_LIMITS.maxBytes} (default ${WEBHOOK_BODY_LIMITS.defaultBytes})`,
      };
    }
  }
  if (rateLimitPerMinute !== undefined) {
    if (rateLimitPerMinute === null && clearable) out.rateLimitPerMinute = null;
    else if (
      typeof rateLimitPerMinute === 'number' &&
      Number.isInteger(rateLimitPerMinute) &&
      rateLimitPerMinute >= 1 &&
      rateLimitPerMinute <= WEBHOOK_RATE_LIMITS.maxPerMinute
    ) {
      out.rateLimitPerMinute = rateLimitPerMinute;
    } else {
      return {
        kind: 'err',
        message: `\`rateLimitPerMinute\` must be a whole number from 1 to ${WEBHOOK_RATE_LIMITS.maxPerMinute} (default ${WEBHOOK_RATE_LIMITS.defaultPerMinute})`,
      };
    }
  }
  return { kind: 'ok', value: out };
}

function parseSignature(
  raw: unknown,
): { kind: 'ok'; value: WebhookSignatureScheme } | { kind: 'err'; message: string } {
  const shape =
    "`signature` is `{ kind: 'hmac-sha256', encoding: 'hex' | 'base64', header, prefix? }` or `{ kind: 'standard-webhooks', toleranceSeconds? }`";
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { kind: 'err', message: shape };
  }
  const o = raw as Record<string, unknown>;
  if (o.kind === 'standard-webhooks') {
    if (Object.keys(o).some((k) => k !== 'kind' && k !== 'toleranceSeconds')) {
      return { kind: 'err', message: shape };
    }
    const { toleranceSeconds } = o;
    if (toleranceSeconds === undefined) return { kind: 'ok', value: { kind: 'standard-webhooks' } };
    if (
      typeof toleranceSeconds !== 'number' ||
      !Number.isInteger(toleranceSeconds) ||
      toleranceSeconds < 1 ||
      toleranceSeconds > MAX_TOLERANCE_SECONDS
    ) {
      return {
        kind: 'err',
        message: `\`signature.toleranceSeconds\` must be a whole number of seconds from 1 to ${MAX_TOLERANCE_SECONDS} (default 300)`,
      };
    }
    return { kind: 'ok', value: { kind: 'standard-webhooks', toleranceSeconds } };
  }
  if (o.kind !== 'hmac-sha256') return { kind: 'err', message: shape };
  if (Object.keys(o).some((k) => !['kind', 'encoding', 'header', 'prefix'].includes(k))) {
    return { kind: 'err', message: shape };
  }
  if (o.encoding !== 'hex' && o.encoding !== 'base64') {
    return { kind: 'err', message: "`signature.encoding` must be 'hex' or 'base64'" };
  }
  if (typeof o.header !== 'string' || !HEADER_NAME_RE.test(o.header)) {
    return { kind: 'err', message: '`signature.header` must be an HTTP header name' };
  }
  if (o.prefix !== undefined && (typeof o.prefix !== 'string' || !/^[!-~]{1,32}$/.test(o.prefix))) {
    return {
      kind: 'err',
      message: '`signature.prefix` must be 1 to 32 visible characters (e.g. `sha256=`)',
    };
  }
  return {
    kind: 'ok',
    value: {
      kind: 'hmac-sha256',
      encoding: o.encoding,
      header: o.header,
      ...(typeof o.prefix === 'string' && { prefix: o.prefix }),
    },
  };
}

function serializeWebhook(
  r: WebhookTriggerRecord,
  names: ReadonlyMap<string, OwnerFacts>,
  receiveUrl: WebhooksRouterOptions['receiveUrl'],
): Record<string, unknown> {
  return {
    triggerId: r.triggerId as unknown as string,
    webhookId: r.webhookId,
    ...(receiveUrl !== undefined && { receiveUrl: receiveUrl(r.tenantId, r.webhookId) }),
    flowId: r.flowId,
    flowVersion: r.flowVersion,
    projectId: r.projectId as unknown as string,
    owner: ownerJson(r.owner, names),
    ...(r.config.input !== undefined && { input: r.config.input }),
    hmacSecretName: r.hmacSecretName,
    ...(r.hmacSecretScope !== undefined && { hmacSecretScope: r.hmacSecretScope }),
    signature: r.signature,
    ...(r.deliveryIdHeader !== undefined && { deliveryIdHeader: r.deliveryIdHeader }),
    bodyLimitBytes: r.bodyLimitBytes,
    rateLimitPerMinute: r.rateLimitPerMinute,
    label: r.label,
    status: r.status,
    ...(r.statusReason !== undefined && { statusReason: r.statusReason }),
    ...(r.version !== undefined && { version: r.version }),
    ...(r.suppressedRefusals !== undefined && { suppressedRefusals: r.suppressedRefusals }),
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
    ...(f.duplicates !== undefined && f.duplicates > 0 && { duplicates: f.duplicates }),
    ...(f.lastDuplicateAt !== undefined && { lastDuplicateAt: f.lastDuplicateAt }),
  };
}

/** A version, its definition named as a webhook trigger's own fields are (the secret by name). */
function serializeWebhookVersion(
  v: WebhookTriggerVersionRecord,
  names: ReadonlyMap<string, OwnerFacts>,
): Record<string, unknown> {
  const d = v.definition;
  return {
    triggerId: v.triggerId as unknown as string,
    ...versionFields(v),
    definition: {
      flowId: d.flowId,
      flowVersion: d.flowVersion,
      projectId: d.projectId as unknown as string,
      owner: ownerJson(d.owner, names),
      ...(d.config.input !== undefined && { input: d.config.input }),
      hmacSecretName: d.hmacSecretName,
      ...(d.hmacSecretScope !== undefined && { hmacSecretScope: d.hmacSecretScope }),
      signature: d.signature,
      ...(d.deliveryIdHeader !== undefined && { deliveryIdHeader: d.deliveryIdHeader }),
      bodyLimitBytes: d.bodyLimitBytes,
      rateLimitPerMinute: d.rateLimitPerMinute,
      label: d.label,
      ...(d.toolsAllowedUnattended !== undefined &&
        d.toolsAllowedUnattended.length > 0 && {
          toolsAllowedUnattended: [...d.toolsAllowedUnattended],
        }),
    },
  };
}

type ParseOk<T> = { readonly kind: 'ok'; readonly value: T };
type ParseErr = { readonly kind: 'err'; readonly response: Response };

async function parseJsonObject(
  c: Context<AppEnv>,
  requestId: string,
  opts: { readonly allowEmpty?: boolean } = {},
): Promise<ParseOk<Record<string, unknown>> | ParseErr> {
  let body: unknown;
  if (opts.allowEmpty === true) {
    // An endpoint whose body is optional (take-over): no body, or an empty
    // one, reads as `{}`; anything present must still be a JSON object.
    const text = await c.req.text();
    if (text.trim().length === 0) return { kind: 'ok', value: {} };
    try {
      body = JSON.parse(text);
    } catch {
      c.status(statusFor('bad-input') as never);
      return {
        kind: 'err',
        response: c.json(
          toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
        ),
      };
    }
  } else {
    try {
      body = await c.req.json();
    } catch {
      c.status(statusFor('bad-input') as never);
      return {
        kind: 'err',
        response: c.json(
          toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
        ),
      };
    }
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

function requireString(
  obj: Record<string, unknown>,
  key: string,
):
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'err'; readonly message: string } {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    return { kind: 'err', message: `\`${key}\` is required` };
  }
  return { kind: 'ok', value };
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
        message: `This deployment's webhook triggers don't support ${what} yet.`,
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
        message: `No webhook trigger with id "${triggerId as unknown as string}"`,
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

/** A signing secret `generateSecret` would make, whose name the scope already has: never overwritten. */
function secretTaken(c: Context<AppEnv>, requestId: string, name: string, env: EnvName): Response {
  c.status(statusFor('secret-write-conflict') as never);
  return c.json(
    toWireError(
      {
        code: 'secret-write-conflict',
        message: `A secret named ${name} already exists in ${env as unknown as string}: name another, or name this one without \`generateSecret\`.`,
      },
      requestId,
    ),
  );
}
