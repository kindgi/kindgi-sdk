// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import type { Context } from 'hono';

import { type Action, type ResourceRef, ref } from '@kindgi/authz';
import type { ProjectBinding } from '@kindgi/platform';
import type { Cursor, ProjectId, TenantId, TriggerId, WebhookSignatureScheme } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import { type ProviderKeys, refuseProviderKeys } from '../provider-keys.js';
import {
  type RegisterWebhookTriggerInput,
  type TriggerFire,
  type TriggerRegistryBinding,
  type UpdateWebhookTriggerInput,
  WEBHOOK_BODY_LIMITS,
  WEBHOOK_RATE_LIMITS,
  type WebhookTriggerRecord,
} from '../trigger-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { type TriggerOwnerNames, ownerJson, ownerNamesOf, ownerOf } from './trigger-owners.js';
import { UUID_RE } from './uuid-param.js';

export interface WebhooksRouterOptions {
  readonly authorizer?: Authorizer;
  /** The tenant's Default project: where a webhook trigger that names no project goes. */
  readonly projects?: Pick<ProjectBinding, 'getDefault'>;
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
 * until an admin takes it over), checked again at every delivery. With an
 * authorizer, reads need `read` on the trigger's project, changes
 * `write`, taking ownership `admin`, and registering or changing the flow
 * version also needs `execute` on the flow, as starting that run does.
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
  const { authorizer, projects, names, providerKeys, receiveUrl } = options;
  const r = new Hono<AppEnv>();

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

  async function webhookJson(c: Context<AppEnv>, row: WebhookTriggerRecord): Promise<Response> {
    const [json] = await serialized(c.get('tenantId') as TenantId, [row]);
    return c.json(json);
  }

  /** A model provider's key named as the signing secret: the refusal. */
  async function providerKeyRefused(
    c: Context<AppEnv>,
    name: string,
  ): Promise<Response | undefined> {
    const refusal = await refuseProviderKeys(
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
    if (flowId.kind === 'err') return bad(c, requestId, flowId.message);
    if (flowVersion.kind === 'err') return bad(c, requestId, flowVersion.message);
    if (hmacSecretName.kind === 'err') return bad(c, requestId, hmacSecretName.message);
    const projectId = body.projectId;
    if (projectId !== undefined && (typeof projectId !== 'string' || !UUID_RE.test(projectId))) {
      return bad(c, requestId, '`projectId` must be a project id (a UUID)');
    }
    const delivery = parseDelivery(body, false);
    if (delivery.kind === 'err') return bad(c, requestId, delivery.message);

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
      (await denied(c, 'execute', ref('flow', flowId.value)));
    if (refused !== undefined) return refused;
    const keyRefused = await providerKeyRefused(c, hmacSecretName.value);
    if (keyRefused !== undefined) return keyRefused;

    const rawConfig = (body.config ?? {}) as Record<string, unknown>;
    const registerInput: RegisterWebhookTriggerInput = {
      kind: 'webhook',
      tenantId,
      flowId: flowId.value,
      flowVersion: flowVersion.value,
      ...(project !== undefined && { projectId: project as ProjectId }),
      owner: ownerOf(c),
      config: { ...('input' in rawConfig && { input: rawConfig.input }) },
      // The route mints the routable id: a random UUID, so the receive URL
      // can't be guessed. The signature is still what authorises a request.
      webhookId: randomUUID(),
      hmacSecretName: hmacSecretName.value,
      ...withoutNulls(delivery.value),
      ...(typeof body.label === 'string' && body.label.length > 0 && { label: body.label }),
    };

    const result = await binding.register(registerInput);
    if (result.kind === 'err') {
      c.status(statusFor(result.error.code) as never);
      return c.json(
        toWireError({ code: result.error.code, message: result.error.message }, requestId),
      );
    }
    c.status(201);
    return webhookJson(c, result.value as WebhookTriggerRecord);
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

    const found = await webhookFor(c, 'write');
    if (found.kind === 'err') return found.response;
    const signature = delivery.value.signature ?? found.value.signature;
    const deliveryIdHeader =
      delivery.value.deliveryIdHeader === undefined
        ? found.value.deliveryIdHeader
        : (delivery.value.deliveryIdHeader ?? undefined);
    if (signature.kind === 'standard-webhooks' && deliveryIdHeader !== undefined) {
      return bad(c, requestId, STANDARD_WEBHOOKS_DEDUPES);
    }
    if (typeof body.flowVersion === 'string') {
      const refused = await denied(c, 'execute', ref('flow', found.value.flowId));
      if (refused !== undefined) return refused;
    }
    if (typeof body.hmacSecretName === 'string') {
      const keyRefused = await providerKeyRefused(c, body.hmacSecretName);
      if (keyRefused !== undefined) return keyRefused;
    }

    const patchConfig = body.config as Record<string, unknown> | undefined;
    const cfg: Partial<{ input: unknown }> = {};
    if (patchConfig !== undefined && 'input' in patchConfig) cfg.input = patchConfig.input;

    const triggerId = found.value.triggerId;
    const updateInput: UpdateWebhookTriggerInput = {
      kind: 'webhook',
      tenantId,
      triggerId,
      ...(Object.keys(cfg).length > 0 && { config: cfg }),
      ...('label' in body && { label: body.label === null ? null : (body.label as string) }),
      ...(typeof body.flowVersion === 'string' && { flowVersion: body.flowVersion }),
      ...(typeof body.hmacSecretName === 'string' && { hmacSecretName: body.hmacSecretName }),
      ...delivery.value,
    };

    const result = await binding.update(updateInput);
    if (result.kind === 'err') {
      c.status(statusFor(result.error.code) as never);
      return c.json(
        toWireError(
          {
            code: result.error.code,
            message: result.error.message,
            triggerId: triggerId as unknown as string,
          },
          requestId,
        ),
      );
    }
    return webhookJson(c, result.value as WebhookTriggerRecord);
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
      const { tenantId, triggerId } = found.value;
      const result = await binding[verb]({ tenantId, triggerId });
      if (result.kind === 'err') return lifecycleError(c, requestId, result.error, triggerId);
      return webhookJson(c, result.value as WebhookTriggerRecord);
    });
  }

  // ---------- POST /:triggerId/unregister (soft delete) ----------
  r.post('/:triggerId/unregister', async (c) => {
    const found = await webhookFor(c, 'write');
    if (found.kind === 'err') return found.response;
    const { tenantId, triggerId } = found.value;
    const outcome = await binding.unregister({ tenantId, triggerId });
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

  // ---------- POST /:triggerId/owner (take ownership) ----------
  r.post('/:triggerId/owner', async (c) => {
    const requestId = c.get('requestId');
    const found = await webhookFor(c, 'admin');
    if (found.kind === 'err') return found.response;
    if (binding.setOwner === undefined) return unsupported(c, requestId, 'changing the owner');
    const refused = await denied(c, 'execute', ref('flow', found.value.flowId));
    if (refused !== undefined) return refused;
    const { tenantId, triggerId } = found.value;
    const result = await binding.setOwner({ tenantId, triggerId, owner: ownerOf(c) });
    if (result.kind === 'err') return lifecycleError(c, requestId, result.error, triggerId);
    return webhookJson(c, result.value as WebhookTriggerRecord);
  });

  return r;
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
  names: ReadonlyMap<string, string>,
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
    signature: r.signature,
    ...(r.deliveryIdHeader !== undefined && { deliveryIdHeader: r.deliveryIdHeader }),
    bodyLimitBytes: r.bodyLimitBytes,
    rateLimitPerMinute: r.rateLimitPerMinute,
    label: r.label,
    status: r.status,
    ...(r.statusReason !== undefined && { statusReason: r.statusReason }),
    ...(r.suppressedRefusals !== undefined && { suppressedRefusals: r.suppressedRefusals }),
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
    ...(f.duplicates !== undefined && f.duplicates > 0 && { duplicates: f.duplicates }),
    ...(f.lastDuplicateAt !== undefined && { lastDuplicateAt: f.lastDuplicateAt }),
  };
}

type ParseOk<T> = { readonly kind: 'ok'; readonly value: T };
type ParseErr = { readonly kind: 'err'; readonly response: Response };

async function parseJsonObject(
  c: Context<AppEnv>,
  requestId: string,
): Promise<ParseOk<Record<string, unknown>> | ParseErr> {
  let body: unknown;
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
