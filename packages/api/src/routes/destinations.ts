// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';

import { ref } from '@kindgi/authz';
import type {
  Cursor,
  DestinationDeliveryId,
  DestinationId,
  ProjectId,
  TenantId,
  UserId,
} from '@kindgi/types';

import { isTenantAdmin } from '../caller.js';
import {
  DESTINATION_CONTENTS,
  DESTINATION_DELIVERY_STATUSES,
  DESTINATION_KINDS,
  type Destination,
  type DestinationBinding,
  type DestinationContent,
  type DestinationCreateInput,
  type DestinationDelivery,
  type DestinationDeliveryOutcome,
  type DestinationDeliveryStatus,
  type DestinationKind,
  type DestinationRef,
  type DestinationRefusal,
  type DestinationSecretRef,
  type DestinationUpdateInput,
} from '../destination-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import { type ProviderKeys, refuseSecretNames } from '../provider-keys.js';
import { type ServedEnvRule, refuseUnservedReference } from '../served-env.js';
import type { AppEnv } from '../types.js';
import { deniedBy } from './denied.js';
import { clampLimit } from './pagination.js';
import { parseSecretRef } from './secret-ref.js';
import { tenantAdminAccess } from './tenant-access.js';
import { UUID_RE } from './uuid-param.js';

const MAX_NAME_LENGTH = 100;
const MAX_URL_LENGTH = 2048;
const MAX_PEOPLE = 50;
const MAX_PROJECTS = 100;

const ANSWER_NEEDS_PROJECTS =
  '`content: "answer"` needs `projects`: name the projects whose answers may go to this destination';
const ANSWER_NOT_ON_WEBHOOK =
  '`content: "answer"` is refused on a `webhook` destination: its receiver reads the run with its own key';
const SECRET_REF_WEBHOOK_ONLY = '`secretRef` is for a `webhook` destination only';

interface DestinationsRouterOptions {
  readonly providerKeys?: ProviderKeys;
  /**
   * On a runtime that refuses other envs: a `urlRef` or `secretRef` under
   * another env answers `409 env-not-served` (`refuseUnservedReference`).
   * Absent: any env.
   */
  readonly servedEnv?: ServedEnvRule;
}

/**
 * Destinations (`/v1/destinations`): the named places outside Kindgi a
 * schedule's results go to. A tenant admin makes, changes and removes them,
 * reads their delivery log, redelivers and sends a test. Anyone who may
 * make a schedule in a project lists the ones its schedules may use
 * (`?projectId=`), without where their URLs and secrets are kept or who
 * they mail. See `DestinationBinding`.
 */
export function destinationsRouter(
  binding: DestinationBinding,
  authorizer?: Authorizer,
  options: DestinationsRouterOptions = {},
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // What they send carries project data out of Kindgi: an admin's.
  const admin = tenantAdminAccess(authorizer);

  // ---------- POST / (create) ----------
  r.post('/', admin, async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const body = await readJsonObject(c);
    if (body.kind === 'err') return badInput(c, requestId, body.message);
    const parsed = parseCreateBody(body.value);
    if (parsed.kind === 'err') return wireError(c, requestId, parsed.code, parsed.message);
    const refusal = await refuseSecrets(options, tenantId, parsed.value);
    if (refusal !== undefined) return secretRefused(c, requestId, refusal);

    const outcome = await binding.create({ tenantId, ...parsed.value });
    if (outcome.kind !== 'ok') return refused(c, requestId, outcome);
    c.status(201);
    return c.json(serializeDestination(outcome.destination, 'admin'));
  });

  // ---------- GET / (list) ----------
  // An admin's, or, for one project, anyone's who may make a schedule there.
  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const view = await listView(c, admin, authorizer);
    if (view.kind === 'refused') return view.response;
    const cursor = c.req.query('cursor');
    const page = await binding.list({
      tenantId,
      limit: clampLimit(c.req.query('limit')),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
      ...(view.projectId !== undefined && { projectId: view.projectId }),
    });
    return c.json({
      data: page.data.map((destination) => serializeDestination(destination, view.view)),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:destinationId ----------
  r.get('/:destinationId', admin, async (c) => {
    const requestId = c.get('requestId');
    const at = destinationRef(c);
    const destination = await binding.get(at);
    if (destination === null) return destinationNotFound(c, requestId, at.destinationId);
    return c.json(serializeDestination(destination, 'admin'));
  });

  // ---------- PATCH /:destinationId ----------
  r.patch('/:destinationId', admin, async (c) => {
    const requestId = c.get('requestId');
    const at = destinationRef(c);
    const body = await readJsonObject(c);
    if (body.kind === 'err') return badInput(c, requestId, body.message);
    const parsed = parseFields(body.value, 'update');
    if (parsed.kind === 'err') return wireError(c, requestId, parsed.code, parsed.message);
    const current = await binding.get(at);
    if (current === null) return destinationNotFound(c, requestId, at.destinationId);
    // The kind's rules hold for what the destination would be.
    const rule = shapeRule(updatedShape(current, parsed.value));
    if (rule !== undefined) return badInput(c, requestId, rule);
    const refusal = await refuseSecrets(options, at.tenantId, parsed.value);
    if (refusal !== undefined) return secretRefused(c, requestId, refusal);

    const outcome = await binding.update(updateInput(at, parsed.value));
    if (outcome.kind === 'ok') return c.json(serializeDestination(outcome.destination, 'admin'));
    if (outcome.kind === 'not-found') return destinationNotFound(c, requestId, at.destinationId);
    return refused(c, requestId, outcome);
  });

  // ---------- DELETE /:destinationId (soft delete) ----------
  r.delete('/:destinationId', admin, async (c) => {
    const at = destinationRef(c);
    const { removed } = await binding.remove(at);
    if (!removed) return destinationNotFound(c, c.get('requestId'), at.destinationId);
    return c.body(null, 204);
  });

  // ---------- GET /:destinationId/deliveries ----------
  r.get('/:destinationId/deliveries', admin, async (c) => {
    const requestId = c.get('requestId');
    const at = destinationRef(c);
    const statusRaw = c.req.query('status');
    if (statusRaw !== undefined && !isDeliveryStatus(statusRaw)) {
      return badInput(
        c,
        requestId,
        `\`status\` must be one of ${DESTINATION_DELIVERY_STATUSES.join(', ')}`,
      );
    }
    const cursor = c.req.query('cursor');
    const outcome = await binding.listDeliveries({
      ...at,
      limit: clampLimit(c.req.query('limit')),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
      ...(statusRaw !== undefined && { status: statusRaw }),
    });
    if (outcome.kind === 'not-found') return destinationNotFound(c, requestId, at.destinationId);
    return c.json({
      data: outcome.data.map(serializeDestinationDelivery),
      hasMore: outcome.nextCursor !== undefined,
      ...(outcome.nextCursor !== undefined && {
        nextCursor: outcome.nextCursor as unknown as string,
      }),
    });
  });

  // ---------- POST /:destinationId/deliveries/:deliveryId/redeliver ----------
  r.post('/:destinationId/deliveries/:deliveryId/redeliver', admin, async (c) => {
    const at = destinationRef(c);
    const deliveryId = c.req.param('deliveryId') as DestinationDeliveryId;
    const outcome = await binding.redeliver({ ...at, deliveryId });
    return deliveryResponse(c, outcome, at.destinationId, deliveryId);
  });

  // ---------- POST /:destinationId/test ----------
  r.post('/:destinationId/test', admin, async (c) => {
    const at = destinationRef(c);
    const outcome = await binding.sendTest(at);
    return deliveryResponse(c, outcome, at.destinationId);
  });

  return r;
}

function destinationRef(c: Context<AppEnv>): DestinationRef {
  return {
    tenantId: c.get('tenantId') as TenantId,
    destinationId: c.req.param('destinationId') as DestinationId,
  };
}

// ---------- access ----------

/**
 * Who sees what a list answers. `admin`: every field. `project`: a member's
 * view of one project's destinations, enough to pick one: without where
 * they send (`host`, `urlRef`), their secrets, who they mail, or which
 * other projects may use them.
 */
type View = 'admin' | 'project';

type ListView =
  | { readonly kind: 'refused'; readonly response: Response }
  | { readonly kind: 'ok'; readonly view: View; readonly projectId?: ProjectId };

/**
 * Without `?projectId=`: the admin gate. With one: an admin sees every
 * field, and anyone else needs what registering a personal schedule in that
 * project needs, `run` on it.
 */
async function listView(
  c: Context<AppEnv>,
  admin: MiddlewareHandler<AppEnv>,
  authorizer: Authorizer | undefined,
): Promise<ListView> {
  const raw = c.req.query('projectId');
  if (raw === undefined) {
    const response = await gate(admin, c);
    return response === undefined ? { kind: 'ok', view: 'admin' } : { kind: 'refused', response };
  }
  if (!UUID_RE.test(raw)) {
    return {
      kind: 'refused',
      response: badInput(c, c.get('requestId'), '`projectId` must be a project id (a UUID)'),
    };
  }
  const projectId = raw as ProjectId;
  if (await isTenantAdmin(c, authorizer)) return { kind: 'ok', view: 'admin', projectId };
  const response = await deniedBy(authorizer, c, 'run', ref('project', raw));
  return response === undefined
    ? { kind: 'ok', view: 'project', projectId }
    : { kind: 'refused', response };
}

/** `middleware`'s refusal, or `undefined` when it lets the request through. */
async function gate(
  middleware: MiddlewareHandler<AppEnv>,
  c: Context<AppEnv>,
): Promise<Response | undefined> {
  let passed = false;
  const answer = await middleware(c, async () => {
    passed = true;
  });
  return passed ? undefined : (answer as Response);
}

/**
 * The first secret named by `urlRef` or `secretRef` that can't be used: one
 * under an env this runtime doesn't serve, a reserved `kindgi.` name, or a
 * model provider's key.
 */
async function refuseSecrets(
  options: DestinationsRouterOptions,
  tenantId: TenantId,
  fields: { readonly urlRef?: DestinationSecretRef; readonly secretRef?: DestinationSecretRef },
): Promise<{ readonly code: string; readonly message: string } | undefined> {
  const named = [
    ['`urlRef`', fields.urlRef],
    ['`secretRef`', fields.secretRef],
  ] as const;
  const names: string[] = [];
  for (const [who, secret] of named) {
    if (secret === undefined) continue;
    const unserved = refuseUnservedReference(options.servedEnv, secret, who);
    if (unserved !== undefined) return unserved;
    names.push(secret.name);
  }
  return refuseSecretNames(options.providerKeys, tenantId, names, 'a destination');
}

// ---------- body parsing ----------

/** A body's fields, each present only when the body has it. */
interface DestinationFields {
  readonly name?: string;
  readonly kind?: DestinationKind;
  readonly people?: readonly UserId[];
  readonly url?: string;
  readonly urlRef?: DestinationSecretRef;
  readonly secretRef?: DestinationSecretRef;
  /** `null` (update only) clears it. */
  readonly projects?: readonly ProjectId[] | null;
  readonly content?: DestinationContent;
}

type Parsed<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | {
      readonly kind: 'err';
      readonly code: 'bad-input' | 'unknown-field';
      readonly message: string;
    };

const BODY_FIELDS = new Set([
  'name',
  'kind',
  'people',
  'url',
  'urlRef',
  'secretRef',
  'projects',
  'content',
]);

function parseCreateBody(
  body: Record<string, unknown>,
): Parsed<Omit<DestinationCreateInput, 'tenantId'>> {
  const parsed = parseFields(body, 'create');
  if (parsed.kind === 'err') return parsed;
  const { name, kind, content = 'link', ...fields } = parsed.value;
  if (name === undefined) return bad('`name` is required');
  if (kind === undefined)
    return bad(`\`kind\` is required: one of ${DESTINATION_KINDS.join(', ')}`);
  const rule = shapeRule(createdShape(kind, content, fields));
  if (rule !== undefined) return bad(rule);
  return { kind: 'ok', value: createInput(name, kind, content, fields) };
}

function createInput(
  name: string,
  kind: DestinationKind,
  content: DestinationContent,
  fields: DestinationFields,
): Omit<DestinationCreateInput, 'tenantId'> {
  return {
    name,
    kind,
    content,
    ...(fields.people !== undefined && { people: fields.people }),
    ...(fields.url !== undefined && { url: fields.url }),
    ...(fields.urlRef !== undefined && { urlRef: fields.urlRef }),
    ...(fields.secretRef !== undefined && { secretRef: fields.secretRef }),
    ...(fields.projects != null && { projects: fields.projects }),
  };
}

function updateInput(at: DestinationRef, fields: DestinationFields): DestinationUpdateInput {
  return {
    ...at,
    ...(fields.name !== undefined && { name: fields.name }),
    ...(fields.people !== undefined && { people: fields.people }),
    ...(fields.url !== undefined && { url: fields.url }),
    ...(fields.urlRef !== undefined && { urlRef: fields.urlRef }),
    ...(fields.secretRef !== undefined && { secretRef: fields.secretRef }),
    ...(fields.projects !== undefined && { projects: fields.projects }),
    ...(fields.content !== undefined && { content: fields.content }),
  };
}

/**
 * The body's fields, each checked on its own; `shapeRule` checks them
 * together. An update never changes `kind`.
 */
function parseFields(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
): Parsed<DestinationFields> {
  const unknown = Object.keys(body).find((key) => !BODY_FIELDS.has(key));
  if (unknown !== undefined) return unknownField(unknown);
  if (mode === 'update' && body.kind !== undefined) {
    return bad("`kind` can't change: make a destination of the other kind");
  }
  const head = parseHead(body);
  if (head.kind === 'err') return head;
  const targets = parseTargets(body, mode);
  if (targets.kind === 'err') return targets;
  return { kind: 'ok', value: { ...head.value, ...targets.value } };
}

/** `name`, `kind` and `content`. */
function parseHead(
  body: Record<string, unknown>,
): Parsed<Pick<DestinationFields, 'name' | 'kind' | 'content'>> {
  const name = optional(body.name, parseName);
  if (name.kind === 'err') return name;
  const kind = optional(body.kind, parseKind);
  if (kind.kind === 'err') return kind;
  const content = optional(body.content, parseContent);
  if (content.kind === 'err') return content;
  return {
    kind: 'ok',
    value: {
      ...(name.value !== undefined && { name: name.value }),
      ...(kind.value !== undefined && { kind: kind.value }),
      ...(content.value !== undefined && { content: content.value }),
    },
  };
}

/** Where it sends (`people`, `url`, `urlRef`), how it signs, and for which projects. */
function parseTargets(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
): Parsed<Omit<DestinationFields, 'name' | 'kind' | 'content'>> {
  const people = optional(body.people, parsePeople);
  if (people.kind === 'err') return people;
  const url = optional(body.url, parseUrl);
  if (url.kind === 'err') return url;
  const urlRef = optional(body.urlRef, (raw) => parseRef(raw, 'urlRef'));
  if (urlRef.kind === 'err') return urlRef;
  const secretRef = optional(body.secretRef, (raw) => parseRef(raw, 'secretRef'));
  if (secretRef.kind === 'err') return secretRef;
  const projects = optional(body.projects, (raw) => parseProjects(raw, mode));
  if (projects.kind === 'err') return projects;
  return {
    kind: 'ok',
    value: {
      ...(people.value !== undefined && { people: people.value }),
      ...(url.value !== undefined && { url: url.value }),
      ...(urlRef.value !== undefined && { urlRef: urlRef.value }),
      ...(secretRef.value !== undefined && { secretRef: secretRef.value }),
      ...(projects.value !== undefined && { projects: projects.value }),
    },
  };
}

/** Parses a field only when present; an absent field parses to `undefined`. */
function optional<T>(raw: unknown, parse: (raw: unknown) => Parsed<T>): Parsed<T | undefined> {
  return raw === undefined ? { kind: 'ok', value: undefined } : parse(raw);
}

function parseName(raw: unknown): Parsed<string> {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > MAX_NAME_LENGTH) {
    return bad(`\`name\` must be a non-empty string of at most ${MAX_NAME_LENGTH} characters`);
  }
  return { kind: 'ok', value: raw };
}

function parseKind(raw: unknown): Parsed<DestinationKind> {
  if (typeof raw !== 'string' || !(DESTINATION_KINDS as readonly string[]).includes(raw)) {
    return bad(`\`kind\` must be one of ${DESTINATION_KINDS.join(', ')}`);
  }
  return { kind: 'ok', value: raw as DestinationKind };
}

function parseContent(raw: unknown): Parsed<DestinationContent> {
  if (typeof raw !== 'string' || !(DESTINATION_CONTENTS as readonly string[]).includes(raw)) {
    return bad(`\`content\` must be one of ${DESTINATION_CONTENTS.join(', ')}`);
  }
  return { kind: 'ok', value: raw as DestinationContent };
}

function parsePeople(raw: unknown): Parsed<readonly UserId[]> {
  const ids = parseIds(raw, 'people', 'user ids', MAX_PEOPLE);
  return ids.kind === 'ok' ? { kind: 'ok', value: ids.value as readonly UserId[] } : ids;
}

function parseProjects(
  raw: unknown,
  mode: 'create' | 'update',
): Parsed<readonly ProjectId[] | null> {
  if (raw === null && mode === 'update') return { kind: 'ok', value: null };
  const ids = parseIds(raw, 'projects', 'project ids', MAX_PROJECTS);
  return ids.kind === 'ok' ? { kind: 'ok', value: ids.value as readonly ProjectId[] } : ids;
}

/** 1..`max` UUIDs, each kept once, in the order given. */
function parseIds(
  raw: unknown,
  field: string,
  what: string,
  max: number,
): Parsed<readonly string[]> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) {
    return bad(`\`${field}\` must be a list of 1 to ${max} ${what}`);
  }
  const ids: string[] = [];
  for (const id of raw) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      return bad(`\`${field}\` entries must be ${what} (UUIDs)`);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return { kind: 'ok', value: ids };
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
  if (url.protocol !== 'https:') return bad('`url` must use https');
  if (url.username !== '' || url.password !== '') {
    return bad('`url` must not contain credentials');
  }
  return { kind: 'ok', value: raw };
}

function parseRef(raw: unknown, field: 'urlRef' | 'secretRef'): Parsed<DestinationSecretRef> {
  const parsed = parseSecretRef(raw, field);
  if (parsed.kind === 'ok') return parsed;
  return parsed.unknownField !== undefined
    ? unknownField(parsed.unknownField)
    : bad(parsed.message);
}

// ---------- the kind's rules ----------

/** What a destination would hold, for the rules that tie its fields together. */
interface Shape {
  readonly kind: DestinationKind;
  readonly people: boolean;
  readonly url: boolean;
  readonly urlRef: boolean;
  readonly secretRef: boolean;
  readonly projects: boolean;
  readonly content: DestinationContent;
}

function createdShape(
  kind: DestinationKind,
  content: DestinationContent,
  fields: DestinationFields,
): Shape {
  return {
    kind,
    content,
    people: fields.people !== undefined,
    url: fields.url !== undefined,
    urlRef: fields.urlRef !== undefined,
    secretRef: fields.secretRef !== undefined,
    projects: fields.projects != null,
  };
}

/** `current` with `patch` applied. A stored URL stays unless the patch gives a new one. */
function updatedShape(current: Destination, patch: DestinationFields): Shape {
  const newUrl = patch.url !== undefined || patch.urlRef !== undefined;
  return {
    kind: current.kind,
    content: patch.content ?? current.content,
    people: patch.people !== undefined || (current.people?.length ?? 0) > 0,
    url: patch.url !== undefined,
    urlRef: patch.urlRef !== undefined || (!newUrl && current.kind !== 'email'),
    secretRef: patch.secretRef !== undefined || current.secretRef !== undefined,
    projects:
      patch.projects === undefined ? (current.projects?.length ?? 0) > 0 : patch.projects !== null,
  };
}

/** Why `shape` isn't a destination of its kind, or `undefined` when it is. */
function shapeRule(shape: Shape): string | undefined {
  return (shape.kind === 'email' ? emailRule(shape) : urlRule(shape)) ?? contentRule(shape);
}

function emailRule(shape: Shape): string | undefined {
  if (shape.url) return '`url` is refused on an `email` destination: it goes to `people`';
  if (shape.urlRef) return '`urlRef` is refused on an `email` destination: it goes to `people`';
  if (shape.secretRef) return SECRET_REF_WEBHOOK_ONLY;
  if (!shape.people) {
    return 'An `email` destination needs `people`: the workspace members it goes to';
  }
  return undefined;
}

function urlRule(shape: Shape): string | undefined {
  if (shape.people) return '`people` is for an `email` destination only';
  if (shape.url && shape.urlRef) return 'Give `url` or `urlRef`, not both';
  if (!shape.url && !shape.urlRef) {
    return `A \`${shape.kind}\` destination needs \`url\` or \`urlRef\``;
  }
  if (shape.kind !== 'webhook') return shape.secretRef ? SECRET_REF_WEBHOOK_ONLY : undefined;
  if (!shape.secretRef) {
    return 'A `webhook` destination needs `secretRef`: its signing secret, by reference';
  }
  return undefined;
}

function contentRule(shape: Shape): string | undefined {
  if (shape.content !== 'answer') return undefined;
  if (shape.kind === 'webhook') return ANSWER_NOT_ON_WEBHOOK;
  return shape.projects ? undefined : ANSWER_NEEDS_PROJECTS;
}

function bad(message: string): Parsed<never> {
  return { kind: 'err', code: 'bad-input', message };
}

function unknownField(field: string): Parsed<never> {
  return { kind: 'err', code: 'unknown-field', message: `Unknown field \`${field}\`` };
}

function isDeliveryStatus(value: string): value is DestinationDeliveryStatus {
  return (DESTINATION_DELIVERY_STATUSES as readonly string[]).includes(value);
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

/**
 * A destination as the API shows it, field by field, so nothing else a
 * binding's record holds (its URL) is ever sent. `project`: without
 * `people`, `urlRef` and `secretRef`.
 */
function serializeDestination(destination: Destination, view: View): Record<string, unknown> {
  const admin = view === 'admin';
  return {
    destinationId: destination.destinationId as unknown as string,
    name: destination.name,
    kind: destination.kind,
    ...(admin && destination.people !== undefined && { people: [...destination.people] }),
    ...(admin && destination.host !== undefined && { host: destination.host }),
    ...(admin &&
      destination.urlRef !== undefined && { urlRef: serializeSecretRef(destination.urlRef) }),
    ...(admin &&
      destination.secretRef !== undefined && {
        secretRef: serializeSecretRef(destination.secretRef),
      }),
    ...(admin && destination.projects !== undefined && { projects: [...destination.projects] }),
    content: destination.content,
    status: destination.status,
    lastError: destination.lastError,
    createdAt: destination.createdAt,
    updatedAt: destination.updatedAt,
  };
}

function serializeSecretRef(secret: DestinationSecretRef): Record<string, unknown> {
  return { envName: secret.envName as unknown as string, name: secret.name };
}

/**
 * A destination's delivery as the API shows it (`DestinationDelivery`),
 * field by field. A schedule's delivery log answers the same shape.
 */
export function serializeDestinationDelivery(d: DestinationDelivery): Record<string, unknown> {
  return {
    deliveryId: d.deliveryId as unknown as string,
    to: d.to as unknown as string,
    event: d.event,
    scheduleId: d.scheduleId as unknown as string | null,
    runId: d.runId as unknown as string | null,
    approvalId: d.approvalId as unknown as string | null,
    status: d.status,
    reason: d.reason,
    attempts: d.attempts,
    nextAttemptAt: d.nextAttemptAt,
    lastAttemptAt: d.lastAttemptAt,
    lastResponseStatus: d.lastResponseStatus,
    lastError: d.lastError,
    createdAt: d.createdAt,
    deliveredAt: d.deliveredAt,
  };
}

// ---------- responses ----------

function deliveryResponse(
  c: Context<AppEnv>,
  outcome: DestinationDeliveryOutcome,
  destinationId: DestinationId,
  deliveryId?: DestinationDeliveryId,
): Response {
  const requestId = c.get('requestId');
  switch (outcome.kind) {
    case 'ok':
      c.status(202);
      return c.json(serializeDestinationDelivery(outcome.delivery));
    case 'not-found':
      return destinationNotFound(c, requestId, destinationId);
    case 'delivery-not-found':
      return wireError(
        c,
        requestId,
        'destination-delivery-not-found',
        `No delivery with id "${String(deliveryId)}" for this destination`,
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

function badInput(
  c: Context<AppEnv>,
  requestId: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): Response {
  return wireError(c, requestId, 'bad-input', message, details);
}

/** A secret named by `urlRef` or `secretRef` that can't be used (`refuseSecrets`). */
function secretRefused(
  c: Context<AppEnv>,
  requestId: string,
  refusal: { readonly code: string; readonly message: string },
): Response {
  c.status(statusFor(refusal.code) as never);
  return c.json(toWireError(refusal, requestId));
}

function destinationNotFound(
  c: Context<AppEnv>,
  requestId: string,
  destinationId: DestinationId,
): Response {
  return wireError(
    c,
    requestId,
    'destination-not-found',
    `No destination with id "${destinationId as unknown as string}"`,
    { destinationId: destinationId as unknown as string },
  );
}

/** The binding refused to save the destination as asked. */
function refused(c: Context<AppEnv>, requestId: string, refusal: DestinationRefusal): Response {
  switch (refusal.kind) {
    case 'url-refused':
      return wireError(
        c,
        requestId,
        'destination-url-refused',
        `The URL is refused: ${refusal.reason}`,
        { reason: refusal.reason },
      );
    case 'kind-off':
      return badInput(
        c,
        requestId,
        `\`${refusal.destinationKind}\` destinations need \`${refusal.setting}\``,
        { destinationKind: refusal.destinationKind, setting: refusal.setting },
      );
    case 'project-not-found':
      return wireError(
        c,
        requestId,
        'project-not-found',
        `No project with id "${refusal.projectId as unknown as string}"`,
        { projectId: refusal.projectId as unknown as string },
      );
    case 'person-not-found':
      return badInput(
        c,
        requestId,
        `No member of this workspace with id "${refusal.userId as unknown as string}"`,
        { userId: refusal.userId as unknown as string },
      );
    case 'secret-not-found':
    case 'secret-too-weak':
      return secretRefusal(c, requestId, refusal);
  }
}

function secretRefusal(
  c: Context<AppEnv>,
  requestId: string,
  refusal: Extract<DestinationRefusal, { kind: 'secret-not-found' | 'secret-too-weak' }>,
): Response {
  const { name, envName } = refusal.secretRef;
  const secretRef = serializeSecretRef(refusal.secretRef);
  if (refusal.kind === 'secret-not-found') {
    return wireError(
      c,
      requestId,
      'destination-secret-not-found',
      `No secret "${name}" in "${envName as unknown as string}": store it first, then save the destination`,
      { secretRef },
    );
  }
  return wireError(
    c,
    requestId,
    'destination-secret-too-weak',
    `Secret "${name}" must be \`whsec_\` + base64 of at least 24 random bytes (POST /v1/webhook-endpoints/generate-secret makes one)`,
    { secretRef },
  );
}
