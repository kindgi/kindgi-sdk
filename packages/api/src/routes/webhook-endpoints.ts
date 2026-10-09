// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';
import type { Context } from 'hono';

import { generateWebhookSecret } from '@kindgi/crypto';
import type {
  Cursor,
  ProjectId,
  TenantId,
  WebhookDeliveryId,
  WebhookEndpointId,
} from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import { withholdFromReplay } from '../middleware/idempotency.js';
import type { AppEnv } from '../types.js';
import {
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_EVENT_TYPES,
  type WebhookDelivery,
  type WebhookDeliveryOutcome,
  type WebhookDeliveryStatus,
  type WebhookEndpoint,
  type WebhookEndpointBinding,
  type WebhookEndpointFilter,
  type WebhookEndpointRefusal,
  type WebhookEventType,
  type WebhookSecretRef,
} from '../webhook-endpoint-binding.js';
import { clampLimit } from './pagination.js';
import { parseSecretRef } from './secret-ref.js';
import { tenantAdminAccess } from './tenant-access.js';

const MAX_URL_LENGTH = 2048;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_FLOW_IDS = 100;
const MAX_FLOW_ID_LENGTH = 200;

/**
 * Outbound webhook endpoints (`/v1/webhook-endpoints`): register the URLs
 * the platform sends signed events to, read their delivery log, redeliver
 * and send a test event. See `WebhookEndpointBinding`.
 */
export function webhookEndpointsRouter(
  binding: WebhookEndpointBinding,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // Deliveries carry every project's runs: all of it is an admin's.
  r.use('*', tenantAdminAccess(authorizer));

  // ---------- POST / (create) ----------
  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const body = await readJsonObject(c);
    if (body.kind === 'err') return badInput(c, requestId, body.message);
    const parsed = parseEndpointBody(body.value, 'create');
    if (parsed.kind === 'err') return wireError(c, requestId, parsed.code, parsed.message);
    const { url, events, filter, secretRef, description } = parsed.value;
    if (url === undefined || events === undefined || secretRef === undefined) {
      return badInput(c, requestId, '`url`, `events` and `secretRef` are required');
    }

    const outcome = await binding.create({
      tenantId,
      url,
      events,
      filter: filter ?? {},
      secretRef,
      ...(typeof description === 'string' && { description }),
    });
    if (outcome.kind !== 'ok') return refused(c, requestId, outcome);
    c.status(201);
    return c.json(serializeEndpoint(outcome.endpoint));
  });

  // ---------- POST /generate-secret ----------
  // A strong signing secret to store before registering; nothing is kept,
  // and an Idempotency-Key repeat doesn't get it.
  r.post('/generate-secret', (c) => {
    withholdFromReplay(c);
    return c.json({ secret: generateWebhookSecret() });
  });

  // ---------- GET / (list) ----------
  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const cursor = c.req.query('cursor');
    const page = await binding.list({
      tenantId,
      limit: clampLimit(c.req.query('limit')),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
    });
    return c.json({
      data: page.data.map(serializeEndpoint),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:endpointId ----------
  r.get('/:endpointId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const endpointId = c.req.param('endpointId') as WebhookEndpointId;
    const endpoint = await binding.get({ tenantId, endpointId });
    if (endpoint === null) return endpointNotFound(c, requestId, endpointId);
    return c.json(serializeEndpoint(endpoint));
  });

  // ---------- PATCH /:endpointId ----------
  r.patch('/:endpointId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const endpointId = c.req.param('endpointId') as WebhookEndpointId;
    const body = await readJsonObject(c);
    if (body.kind === 'err') return badInput(c, requestId, body.message);
    const parsed = parseEndpointBody(body.value, 'update');
    if (parsed.kind === 'err') return wireError(c, requestId, parsed.code, parsed.message);
    const { url, events, filter, secretRef, description } = parsed.value;

    const outcome = await binding.update({
      tenantId,
      endpointId,
      ...(url !== undefined && { url }),
      ...(events !== undefined && { events }),
      ...(filter !== undefined && { filter }),
      ...(secretRef !== undefined && { secretRef }),
      ...(description !== undefined && { description }),
    });
    if (outcome.kind === 'ok') return c.json(serializeEndpoint(outcome.endpoint));
    if (outcome.kind === 'not-found') return endpointNotFound(c, requestId, endpointId);
    return refused(c, requestId, outcome);
  });

  // ---------- POST /:endpointId/unregister (soft delete) ----------
  r.post('/:endpointId/unregister', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const endpointId = c.req.param('endpointId') as WebhookEndpointId;
    const outcome = await binding.unregister({ tenantId, endpointId });
    return c.json({
      endpointId: endpointId as unknown as string,
      unregistered: outcome.unregistered,
    });
  });

  // ---------- GET /:endpointId/deliveries ----------
  r.get('/:endpointId/deliveries', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const endpointId = c.req.param('endpointId') as WebhookEndpointId;
    const statusRaw = c.req.query('status');
    if (statusRaw !== undefined && !isDeliveryStatus(statusRaw)) {
      return badInput(
        c,
        requestId,
        `\`status\` must be one of ${WEBHOOK_DELIVERY_STATUSES.join(', ')}`,
      );
    }
    const cursor = c.req.query('cursor');
    const outcome = await binding.listDeliveries({
      tenantId,
      endpointId,
      limit: clampLimit(c.req.query('limit')),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
      ...(statusRaw !== undefined && { status: statusRaw }),
    });
    if (outcome.kind === 'not-found') return endpointNotFound(c, requestId, endpointId);
    return c.json({
      data: outcome.data.map(serializeDelivery),
      hasMore: outcome.nextCursor !== undefined,
      ...(outcome.nextCursor !== undefined && {
        nextCursor: outcome.nextCursor as unknown as string,
      }),
    });
  });

  // ---------- POST /:endpointId/deliveries/:deliveryId/redeliver ----------
  r.post('/:endpointId/deliveries/:deliveryId/redeliver', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const endpointId = c.req.param('endpointId') as WebhookEndpointId;
    const deliveryId = c.req.param('deliveryId') as WebhookDeliveryId;
    const outcome = await binding.redeliver({ tenantId, endpointId, deliveryId });
    return deliveryResponse(c, requestId, outcome, endpointId, deliveryId);
  });

  // ---------- POST /:endpointId/test ----------
  r.post('/:endpointId/test', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const endpointId = c.req.param('endpointId') as WebhookEndpointId;
    const outcome = await binding.sendTest({ tenantId, endpointId });
    return deliveryResponse(c, requestId, outcome, endpointId);
  });

  return r;
}

// ---------- body parsing ----------

interface EndpointBody {
  readonly url?: string;
  readonly events?: readonly WebhookEventType[];
  readonly filter?: WebhookEndpointFilter;
  readonly secretRef?: WebhookSecretRef;
  /** `null` (update only) clears it. */
  readonly description?: string | null;
}

type Parsed<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | {
      readonly kind: 'err';
      readonly code: 'bad-input' | 'unknown-field';
      readonly message: string;
    };

const BODY_FIELDS = new Set(['url', 'events', 'filter', 'secretRef', 'description']);
const FILTER_FIELDS = new Set(['projectId', 'flowIds', 'includeDryRuns']);

function parseEndpointBody(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
): Parsed<EndpointBody> {
  const unknown = Object.keys(body).find((key) => !BODY_FIELDS.has(key));
  if (unknown !== undefined) return unknownField(unknown);

  const url = optional(body.url, parseUrl);
  if (url.kind === 'err') return url;
  const events = optional(body.events, parseEvents);
  if (events.kind === 'err') return events;
  const filter = optional(body.filter, parseFilter);
  if (filter.kind === 'err') return filter;
  const secretRef = optional(body.secretRef, parseWebhookSecretRef);
  if (secretRef.kind === 'err') return secretRef;
  const description = optional(body.description, (raw) => parseDescription(raw, mode));
  if (description.kind === 'err') return description;

  return {
    kind: 'ok',
    value: {
      ...(url.value !== undefined && { url: url.value }),
      ...(events.value !== undefined && { events: events.value }),
      ...(filter.value !== undefined && { filter: filter.value }),
      ...(secretRef.value !== undefined && { secretRef: secretRef.value }),
      ...(description.value !== undefined && { description: description.value }),
    },
  };
}

/** Parses a field only when present; an absent field parses to `undefined`. */
function optional<T>(raw: unknown, parse: (raw: unknown) => Parsed<T>): Parsed<T | undefined> {
  return raw === undefined ? { kind: 'ok', value: undefined } : parse(raw);
}

function parseUrl(raw: unknown): Parsed<string> {
  if (typeof raw !== 'string' || raw.length === 0) return bad('`url` must be a non-empty string');
  if (raw.length > MAX_URL_LENGTH) return bad(`\`url\` is limited to ${MAX_URL_LENGTH} characters`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return bad('`url` must be an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return bad('`url` must use https (or http where the deployment allows it)');
  }
  if (url.username !== '' || url.password !== '') {
    return bad('`url` must not contain credentials');
  }
  return { kind: 'ok', value: raw };
}

function parseEvents(raw: unknown): Parsed<readonly WebhookEventType[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return bad('`events` must be a non-empty array');
  }
  const known: readonly string[] = WEBHOOK_EVENT_TYPES;
  const events: WebhookEventType[] = [];
  for (const event of raw) {
    if (typeof event !== 'string' || !known.includes(event)) {
      return bad(`\`events\` entries must be one of ${WEBHOOK_EVENT_TYPES.join(', ')}`);
    }
    if (!events.includes(event as WebhookEventType)) events.push(event as WebhookEventType);
  }
  return { kind: 'ok', value: events };
}

function parseWebhookSecretRef(raw: unknown): Parsed<WebhookSecretRef> {
  const parsed = parseSecretRef(raw);
  if (parsed.kind === 'ok') return parsed;
  return parsed.unknownField !== undefined
    ? unknownField(parsed.unknownField)
    : bad(parsed.message);
}

function parseDescription(raw: unknown, mode: 'create' | 'update'): Parsed<string | null> {
  if (raw === null && mode === 'update') return { kind: 'ok', value: null };
  if (typeof raw !== 'string') {
    return bad(
      mode === 'update'
        ? '`description` must be a string or null'
        : '`description` must be a string',
    );
  }
  if (raw.length > MAX_DESCRIPTION_LENGTH) {
    return bad(`\`description\` is limited to ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  return { kind: 'ok', value: raw };
}

function parseFilter(raw: unknown): Parsed<WebhookEndpointFilter> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return bad('`filter` must be an object');
  }
  const filter = raw as Record<string, unknown>;
  const unknown = Object.keys(filter).find((key) => !FILTER_FIELDS.has(key));
  if (unknown !== undefined) return unknownField(`filter.${unknown}`);

  const projectId = optional(filter.projectId, parseProjectId);
  if (projectId.kind === 'err') return projectId;
  const flowIds = optional(filter.flowIds, parseFlowIds);
  if (flowIds.kind === 'err') return flowIds;
  const includeDryRuns = optional(filter.includeDryRuns, parseIncludeDryRuns);
  if (includeDryRuns.kind === 'err') return includeDryRuns;

  return {
    kind: 'ok',
    value: {
      ...(projectId.value !== undefined && { projectId: projectId.value }),
      ...(flowIds.value !== undefined && { flowIds: flowIds.value }),
      ...(includeDryRuns.value !== undefined && { includeDryRuns: includeDryRuns.value }),
    },
  };
}

function parseProjectId(raw: unknown): Parsed<ProjectId> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return bad('`filter.projectId` must be a non-empty string');
  }
  return { kind: 'ok', value: raw as ProjectId };
}

function parseFlowIds(raw: unknown): Parsed<readonly string[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return bad('`filter.flowIds` must be a non-empty array');
  }
  if (raw.length > MAX_FLOW_IDS) {
    return bad(`\`filter.flowIds\` is limited to ${MAX_FLOW_IDS} entries`);
  }
  const flowIds: string[] = [];
  for (const flowId of raw) {
    if (typeof flowId !== 'string' || flowId.length === 0 || flowId.length > MAX_FLOW_ID_LENGTH) {
      return bad(
        `\`filter.flowIds\` entries must be non-empty strings of at most ${MAX_FLOW_ID_LENGTH} characters`,
      );
    }
    if (!flowIds.includes(flowId)) flowIds.push(flowId);
  }
  return { kind: 'ok', value: flowIds };
}

function parseIncludeDryRuns(raw: unknown): Parsed<boolean> {
  if (typeof raw !== 'boolean') return bad('`filter.includeDryRuns` must be a boolean');
  return { kind: 'ok', value: raw };
}

function bad(message: string): Parsed<never> {
  return { kind: 'err', code: 'bad-input', message };
}

function unknownField(field: string): Parsed<never> {
  return { kind: 'err', code: 'unknown-field', message: `Unknown field \`${field}\`` };
}

function isDeliveryStatus(value: string): value is WebhookDeliveryStatus {
  return (WEBHOOK_DELIVERY_STATUSES as readonly string[]).includes(value);
}

async function readJsonObject(
  c: Context<AppEnv>,
): Promise<
  | { readonly kind: 'ok'; readonly value: Record<string, unknown> }
  | { readonly kind: 'err'; readonly message: string }
> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { kind: 'err', message: 'Request body must be valid JSON' };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'err', message: 'Request body must be a JSON object' };
  }
  return { kind: 'ok', value: body as Record<string, unknown> };
}

// ---------- serialization ----------

function serializeEndpoint(endpoint: WebhookEndpoint): Record<string, unknown> {
  return {
    endpointId: endpoint.endpointId as unknown as string,
    url: endpoint.url,
    events: [...endpoint.events],
    filter: serializeFilter(endpoint.filter),
    description: endpoint.description,
    secretRef: {
      envName: endpoint.secretRef.envName as unknown as string,
      name: endpoint.secretRef.name,
    },
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
  };
}

function serializeFilter(filter: WebhookEndpointFilter): Record<string, unknown> {
  return {
    ...(filter.projectId !== undefined && { projectId: filter.projectId as unknown as string }),
    ...(filter.flowIds !== undefined && { flowIds: [...filter.flowIds] }),
    ...(filter.includeDryRuns !== undefined && { includeDryRuns: filter.includeDryRuns }),
  };
}

function serializeDelivery(delivery: WebhookDelivery): Record<string, unknown> {
  return {
    deliveryId: delivery.deliveryId as unknown as string,
    endpointId: delivery.endpointId as unknown as string,
    event: delivery.event,
    status: delivery.status,
    attempts: delivery.attempts,
    nextAttemptAt: delivery.nextAttemptAt,
    lastAttemptAt: delivery.lastAttemptAt,
    lastResponseStatus: delivery.lastResponseStatus,
    lastError: delivery.lastError,
    createdAt: delivery.createdAt,
    deliveredAt: delivery.deliveredAt,
  };
}

// ---------- responses ----------

function deliveryResponse(
  c: Context<AppEnv>,
  requestId: string,
  outcome: WebhookDeliveryOutcome,
  endpointId: WebhookEndpointId,
  deliveryId?: WebhookDeliveryId,
): Response {
  switch (outcome.kind) {
    case 'ok':
      c.status(202);
      return c.json(serializeDelivery(outcome.delivery));
    case 'not-found':
      return endpointNotFound(c, requestId, endpointId);
    case 'delivery-not-found':
      return wireError(
        c,
        requestId,
        'webhook-delivery-not-found',
        `No delivery with id "${String(deliveryId)}" for this endpoint`,
        { deliveryId: String(deliveryId) },
      );
  }
}

function wireError(
  c: Context<AppEnv>,
  requestId: string,
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): Response {
  c.status(statusFor(code) as never);
  return c.json(toWireError({ code, message, ...details }, requestId));
}

function badInput(c: Context<AppEnv>, requestId: string, message: string): Response {
  return wireError(c, requestId, 'bad-input', message);
}

function endpointNotFound(
  c: Context<AppEnv>,
  requestId: string,
  endpointId: WebhookEndpointId,
): Response {
  return wireError(
    c,
    requestId,
    'webhook-endpoint-not-found',
    `No webhook endpoint with id "${endpointId as unknown as string}"`,
    { endpointId: endpointId as unknown as string },
  );
}

/** The binding refused to save the endpoint as asked. */
function refused(c: Context<AppEnv>, requestId: string, refusal: WebhookEndpointRefusal): Response {
  switch (refusal.kind) {
    case 'url-refused':
      return urlRefused(c, requestId, refusal.reason);
    case 'project-not-found':
      return projectNotFound(c, requestId, refusal.projectId);
    case 'secret-not-found':
      return wireError(
        c,
        requestId,
        'webhook-secret-not-found',
        `No secret "${refusal.secretRef.name}" in "${refusal.secretRef.envName as unknown as string}": store it first, then register the endpoint`,
        { secretRef: refusal.secretRef },
      );
    case 'secret-too-weak':
      return wireError(
        c,
        requestId,
        'webhook-secret-too-weak',
        `Secret "${refusal.secretRef.name}" must be \`whsec_\` + base64 of at least 24 random bytes (POST /v1/webhook-endpoints/generate-secret makes one)`,
        { secretRef: refusal.secretRef },
      );
  }
}

function urlRefused(c: Context<AppEnv>, requestId: string, reason: string): Response {
  return wireError(
    c,
    requestId,
    'webhook-url-refused',
    `The deployment refuses this URL: ${reason}`,
    {
      reason,
    },
  );
}

function projectNotFound(c: Context<AppEnv>, requestId: string, projectId: ProjectId): Response {
  return wireError(
    c,
    requestId,
    'project-not-found',
    `No project with id "${projectId as unknown as string}"`,
    { projectId: projectId as unknown as string },
  );
}
