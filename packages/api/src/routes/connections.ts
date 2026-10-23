// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';
import type { Context } from 'hono';

import { type PrincipalRef, ref } from '@kindgi/authz';
import { APP_ID_PATTERN, type AppEntry, PERMISSION_KEY_PATTERN } from '@kindgi/connections';
import type { Cursor, EnvName, ProjectId, TenantId, UserId } from '@kindgi/types';

import { callerPrincipal, isTenantAdmin } from '../caller.js';
import type {
  ConnectFinishOutcome,
  ConnectRequestRecord,
  ConnectionAppRecord,
  ConnectionBinding,
  ConnectionError,
  ConnectionOwner,
  ConnectionPage,
  ConnectionRecord,
  ConnectionState,
  SecretRefInput,
} from '../connection-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import { withholdFromReplay } from '../middleware/idempotency.js';
import { type ProviderKeys, refuseProviderKeys } from '../provider-keys.js';
import {
  type RateLimitStore,
  createInMemoryRateLimitStore,
  nearestForwardedClient,
} from '../rate-limit-store.js';
import type { ReviewerBinding } from '../reviewer-binding.js';
import { type ServedEnvRule, refuseUnservedReference } from '../served-env.js';
import { WEBHOOK_BODY_LIMITS } from '../trigger-binding.js';
import type { AppEnv } from '../types.js';
import { refused } from './denied.js';
import { WEBHOOK_REFUSALS_PER_CLIENT_PER_MINUTE, readCapped } from './hooks.js';
import { clampLimit } from './pagination.js';
import { parseSecretRef } from './secret-ref.js';
import { tenantAdminAccess } from './tenant-access.js';
import { UUID_RE, refuseMalformedUuidParam } from './uuid-param.js';

const MAX_LABEL_LENGTH = 200;
const MAX_CLIENT_ID_LENGTH = 512;
const MAX_SLUG_LENGTH = 100;
const MAX_PROJECTS = 500;
const MAX_PERMISSIONS = 64;
const MAX_FINISH_FIELD_LENGTH = 2048;
const MAX_INSTALLATION_ID_LENGTH = 64;
const MINUTE_MS = 60_000;

const CONNECTION_STATES: ReadonlySet<string> = new Set([
  'working',
  'needs-reconnecting',
  'removing',
  'removed',
]);

// ================ /v1/connection-entries ================

/** The apps this server can connect to (`GET /v1/connection-entries`), for any member. */
export function connectionEntriesRouter(binding: ConnectionBinding): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get('/', (c) => c.json({ data: binding.entries().map(serializeEntry) }));
  return r;
}

// ================ /v1/connection-apps ================

/**
 * The tenant's registrations of its own client at an app
 * (`/v1/connection-apps`): its client id, and its secrets by reference.
 * All of it is a tenant admin's.
 */
export function connectionAppsRouter(
  binding: ConnectionBinding,
  authorizer?: Authorizer,
  options: {
    readonly providerKeys?: ProviderKeys;
    /** On a runtime that refuses other envs: a secret named under another env answers `409 env-not-served`. */
    readonly servedEnv?: ServedEnvRule;
  } = {},
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // A tenant admin's: `admin` on the tenant, or without an authorizer the
  // key's `tenant-admin` scope, as the connections routes check it.
  r.use(
    '*',
    authorizer !== undefined
      ? tenantAdminAccess(authorizer)
      : async (c, next) => {
          if (await isTenantAdmin(c, undefined)) return next();
          return refused(c, undefined, {
            action: 'admin',
            resource: ref('tenant', c.get('tenantId') as unknown as string),
            message: "Only a tenant admin reads or changes the company's app registrations",
            failing: 'actor',
          });
        },
  );
  r.use('/:appId', refuseMalformedUuidParam('appId', 'a connection app id'));

  // A model provider's key is never an app's secret, and on a runtime that
  // refuses other envs each secret is named under its env.
  const secretRefusal = async (
    tenantId: TenantId,
    secrets: readonly (readonly [string, SecretRefInput])[],
  ): Promise<{ readonly code: string; readonly message: string } | undefined> => {
    for (const [field, secretRef] of secrets) {
      const refusal = refuseUnservedReference(options.servedEnv, secretRef, `\`${field}\``);
      if (refusal !== undefined) return refusal;
    }
    return refuseProviderKeys(
      options.providerKeys,
      tenantId,
      secrets.map(([, secretRef]) => secretRef.name),
      'a connection app',
    );
  };

  /** A create's or an update's body, checked; an answer when it's refused. */
  const readAppBody = async (
    c: Context<AppEnv>,
    mode: 'create' | 'update',
  ): Promise<AppBody | Response> => {
    const body = await readJsonObject(c);
    if (body.kind === 'err') return badInput(c, body.message);
    const parsed = parseAppBody(body.value, mode);
    if (parsed.kind === 'err') return badInput(c, parsed.message, parsed.field);
    const refusal = await secretRefusal(c.get('tenantId') as TenantId, secretsOf(parsed.value));
    if (refusal !== undefined) return answer(c, refusal.code, refusal.message, refusal);
    return parsed.value;
  };

  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const cursor = c.req.query('cursor');
    const page = await binding.listApps({
      tenantId,
      limit: clampLimit(c.req.query('limit')),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
    });
    return c.json(serializePage(page, serializeApp));
  });

  r.post('/', async (c) => {
    const by = principalRef(c);
    if (by === undefined) return noPrincipal(c, authorizer);
    const body = await readAppBody(c, 'create');
    if (body instanceof Response) return body;
    const { projects } = body;
    const outcome = await binding.createApp({
      tenantId: c.get('tenantId') as TenantId,
      // A create's body always names it (`parseAppBody`).
      app: body.app as string,
      ...appFields(body),
      ...(projects !== undefined && projects !== null && { projects }),
      by,
    });
    if (outcome.kind !== 'ok') return bindingRefused(c, authorizer, outcome.error);
    c.status(201);
    return c.json(serializeApp(outcome.value));
  });

  r.get('/:appId', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const appId = c.req.param('appId');
    const record = await binding.getApp({ tenantId, appId });
    if (record === null) return appNotFound(c, appId);
    return c.json(serializeApp(record));
  });

  r.patch('/:appId', async (c) => {
    const by = principalRef(c);
    if (by === undefined) return noPrincipal(c, authorizer);
    const body = await readAppBody(c, 'update');
    if (body instanceof Response) return body;
    const outcome = await binding.updateApp({
      tenantId: c.get('tenantId') as TenantId,
      appId: c.req.param('appId'),
      ...appFields(body),
      ...(body.projects !== undefined && { projects: body.projects }),
      by,
    });
    if (outcome.kind !== 'ok') return bindingRefused(c, authorizer, outcome.error);
    return c.json(serializeApp(outcome.value));
  });

  r.delete('/:appId', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const appId = c.req.param('appId');
    const by = principalRef(c);
    if (by === undefined) return noPrincipal(c, authorizer);
    const raw = c.req.query('withConnections');
    if (raw !== undefined && raw !== 'true' && raw !== 'false') {
      return badInput(c, '`withConnections` must be `true` or `false`', 'withConnections');
    }
    const outcome = await binding.removeApp({
      tenantId,
      appId,
      withConnections: raw === 'true',
      by,
    });
    if (outcome.kind !== 'ok') return bindingRefused(c, authorizer, outcome.error);
    return c.json({ connectionsRemoved: outcome.value.connectionsRemoved });
  });

  return r;
}

// ================ /v1/connections ================

/**
 * The connections (`/v1/connections`): a member's own, or every one for a
 * tenant admin; a connect from outside a run, its start and its finish.
 *
 * A member's connection and its requests are its owner's: anyone else gets
 * the same `404` as for one that doesn't exist (a tenant admin reaches every
 * connection, and the company's requests). Only a tenant admin connects the
 * company's account.
 */
export function connectionsRouter(
  binding: ConnectionBinding,
  authorizer: Authorizer | undefined,
  options: {
    /** The env this server serves: a connect is made under it. */
    readonly envName: EnvName;
    /**
     * On a server with approvals: the finish says whether the member who
     * connected has a reviewer seat (`reviewerSeat`), which approving a
     * send from their own account needs.
     */
    readonly reviewers?: ReviewerBinding;
  },
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('/requests/:requestId', refuseMalformedUuidParam('requestId', 'a connect request id'));
  r.use('/requests/:requestId/*', refuseMalformedUuidParam('requestId', 'a connect request id'));
  // On the two routes, not `use`: `/finish` would match `/:connectionId`.
  const connectionIdChecked = refuseMalformedUuidParam('connectionId', 'a connection id');

  /** A connection's owner, or a tenant admin. */
  const mayReach = async (c: Context<AppEnv>, owner: ConnectionOwner): Promise<boolean> =>
    isOwner(c, owner) || isTenantAdmin(c, authorizer);
  /** A member's request is the member's alone; the company's, a tenant admin's. */
  const mayAct = async (c: Context<AppEnv>, owner: ConnectionOwner): Promise<boolean> =>
    owner.kind === 'member' ? isOwner(c, owner) : isTenantAdmin(c, authorizer);

  /**
   * Whose connections the caller lists: every one's for a tenant admin
   * (unless `owner=me`), else the caller's own; `undefined` when that's none.
   */
  const listedOwner = async (
    c: Context<AppEnv>,
    query: ListQuery,
  ): Promise<{ readonly ownerUserId?: string } | undefined> => {
    if (!query.mine && (await isTenantAdmin(c, authorizer))) return {};
    const caller = callerPrincipal(c);
    if (caller?.kind !== 'user' || query.ownerKind === 'company') return undefined;
    return { ownerUserId: caller.userId };
  };

  /** Whose account a connect is for; an answer when the caller can't ask for it. */
  const connectOwner = async (
    c: Context<AppEnv>,
    by: PrincipalRef,
    wanted: ConnectBody['for'],
  ): Promise<ConnectionOwner | Response> => {
    if (wanted === 'company') {
      if (await isTenantAdmin(c, authorizer)) return { kind: 'company' };
      return refused(c, authorizer, {
        action: 'admin',
        resource: ref('tenant', by.tenantId as unknown as string),
        message: "Only a tenant admin connects the company's account",
        failing: 'actor',
      });
    }
    if (by.kind === 'user') return { kind: 'member', userId: by.id };
    return badInput(
      c,
      "`for: 'me'` connects a person's own account: sign in as the person, or ask for `for: 'company'`",
      'for',
    );
  };

  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const query = parseListQuery(c);
    if (query.kind === 'err') return badInput(c, query.message, query.field);
    const listed = await listedOwner(c, query.value);
    if (listed === undefined) return c.json({ data: [], hasMore: false });
    const { projectId, app, ownerKind, state } = query.value;
    const cursor = c.req.query('cursor');
    const page = await binding.list({
      tenantId,
      ...(projectId !== undefined && { projectId }),
      ...(app !== undefined && { app }),
      ...listed,
      ...(ownerKind !== undefined && { ownerKind }),
      ...(state !== undefined && { state, includeRemoved: state === 'removed' }),
      limit: clampLimit(c.req.query('limit')),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
    });
    return c.json(serializePage(page, serializeConnection));
  });

  r.post('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const by = principalRef(c);
    if (by === undefined) return noPrincipal(c, authorizer);
    const body = await readJsonObject(c);
    if (body.kind === 'err') return badInput(c, body.message);
    const parsed = parseConnectBody(body.value);
    if (parsed.kind === 'err') return badInput(c, parsed.message, parsed.field);
    const { app, appId, projectId, permissions } = parsed.value;
    const owner = await connectOwner(c, by, parsed.value.for);
    if (owner instanceof Response) return owner;
    const outcome = await binding.createRequest({
      tenantId,
      envName: options.envName,
      app,
      ...(appId !== undefined && { appId }),
      ...(projectId !== undefined && { projectId }),
      owner,
      permissions,
      by,
    });
    if (outcome.kind !== 'ok') return bindingRefused(c, authorizer, outcome.error);
    c.status(201);
    return c.json(serializeRequest(outcome.value));
  });

  r.post('/finish', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const caller = principalRef(c);
    if (caller === undefined) return noPrincipal(c, authorizer);
    const body = await readJsonObject(c);
    if (body.kind === 'err') return badInput(c, body.message);
    const parsed = parseFinishBody(body.value);
    if (parsed.kind === 'err') return badInput(c, parsed.message, parsed.field);
    const outcome = await binding.finishRequest({ tenantId, caller, ...parsed.value });
    if (outcome.kind !== 'ok') return bindingRefused(c, authorizer, outcome.error);
    const reviewerSeat = await hasReviewerSeat(c, tenantId, outcome.value);
    return c.json({
      ...serializeFinish(outcome.value),
      ...(reviewerSeat !== undefined && { reviewerSeat }),
    });
  });

  r.get('/requests/:requestId', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const requestId = c.req.param('requestId');
    const request = await binding.getRequest({ tenantId, requestId });
    if (request === null || !(await mayAct(c, request.owner))) {
      return requestNotFound(c, requestId);
    }
    return c.json(serializeRequest(request));
  });

  r.post('/requests/:requestId/start', async (c) => {
    // The consent page's URL carries the sign-in's state: a repeat of the
    // request starts again, and never gets this one back.
    withholdFromReplay(c);
    const tenantId = c.get('tenantId') as TenantId;
    const requestId = c.req.param('requestId');
    const caller = principalRef(c);
    if (caller === undefined) return noPrincipal(c, authorizer);
    const request = await binding.getRequest({ tenantId, requestId });
    if (request === null || !(await mayAct(c, request.owner))) {
      return requestNotFound(c, requestId);
    }
    const body = await readJsonObject(c, { allowEmpty: true });
    if (body.kind === 'err') return badInput(c, body.message);
    const parsed = parseStartBody(body.value);
    if (parsed.kind === 'err') return badInput(c, parsed.message, parsed.field);
    const outcome = await binding.startRequest({ tenantId, requestId, caller, ...parsed.value });
    if (outcome.kind !== 'ok') return bindingRefused(c, authorizer, outcome.error);
    return c.json({ authorizeUrl: outcome.value.authorizeUrl });
  });

  r.get('/:connectionId', connectionIdChecked, async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const connectionId = c.req.param('connectionId');
    const connection = await binding.get({ tenantId, connectionId });
    if (connection === null || !(await mayReach(c, connection.owner))) {
      return connectionNotFound(c, connectionId);
    }
    return c.json(serializeConnection(connection));
  });

  r.delete('/:connectionId', connectionIdChecked, async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const connectionId = c.req.param('connectionId');
    const by = principalRef(c);
    if (by === undefined) return noPrincipal(c, authorizer);
    const connection = await binding.get({ tenantId, connectionId });
    if (connection === null || !(await mayReach(c, connection.owner))) {
      return connectionNotFound(c, connectionId);
    }
    const outcome = await binding.disconnect({ tenantId, connectionId, by });
    if (outcome.kind !== 'ok') return bindingRefused(c, authorizer, outcome.error);
    return c.json(serializeConnection(outcome.value));
  });

  /** Set for a member's new connection on a server with approvals; never fails the finish. */
  async function hasReviewerSeat(
    c: Context<AppEnv>,
    tenantId: TenantId,
    outcome: ConnectFinishOutcome,
  ): Promise<boolean | undefined> {
    if (options.reviewers === undefined || outcome.kind !== 'connected') return undefined;
    const { owner } = outcome.connection;
    if (owner.kind !== 'member') return undefined;
    try {
      const reviewerId = await options.reviewers.resolveReviewer({
        tenantId,
        userId: owner.userId as UserId,
      });
      return reviewerId !== null;
    } catch (cause) {
      c.get('log').warn(
        `connections: couldn't read the reviewer roster after a connect: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return undefined;
    }
  }

  return r;
}

// ================ /v1/connection-notices ================

/**
 * Removals an app reports (`POST /v1/connection-notices/{tenantId}/{appId}`):
 * an uninstall, a revoke at the app. Outside the bearer chain: the app's
 * own signature is what the binding checks, over the body's exact bytes.
 *
 * - `202`, no body: accepted.
 * - `400 connection-notice-invalid`, with the same body whatever was wrong:
 *   anything the binding doesn't accept, an id that isn't one, a body over
 *   the receiver's cap. A client past its refusals this minute gets `429`.
 * - `503 connection-notice-unavailable`: the server couldn't check or apply
 *   it just now; the app may send it again.
 */
export function connectionNoticesRouter(
  binding: ConnectionBinding,
  options: {
    /** Who the client is, for the per-client refusal limit. Default: the nearest `X-Forwarded-For` hop. */
    readonly clientAddress?: (request: Request) => string | undefined;
    /** Where refusals per client are counted. Default: this process's memory. */
    readonly rateLimitStore?: RateLimitStore;
  } = {},
): Hono<AppEnv> {
  const clientAddress = options.clientAddress ?? nearestForwardedClient;
  const store = options.rateLimitStore ?? createInMemoryRateLimitStore();
  const r = new Hono<AppEnv>();

  async function notAccepted(c: Context<AppEnv>, client: string | undefined): Promise<Response> {
    if (client !== undefined) {
      let taken: Awaited<ReturnType<RateLimitStore['take']>> = { allowed: true };
      try {
        taken = await store.take({
          key: `connection-notices-refused:${client}`,
          limit: WEBHOOK_REFUSALS_PER_CLIENT_PER_MINUTE,
          windowMs: MINUTE_MS,
        });
      } catch {
        // The limit is a speed bump, not a lock: a store that fails lets it through.
      }
      if (!taken.allowed) {
        c.header('Retry-After', String(Math.max(Math.ceil(taken.retryAfterMs / 1000), 1)));
        return answer(c, 'rate-limit-exceeded', 'Too many refused notices: try again shortly');
      }
    }
    return answer(c, 'connection-notice-invalid', 'The notice was not accepted');
  }

  r.post('/:tenantId/:appId', async (c) => {
    const request = c.req.raw;
    const client = clientAddress(request);
    const tenantId = c.req.param('tenantId');
    const appId = c.req.param('appId');
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(appId)) return notAccepted(c, client);
    const rawBody = await readCapped(request, WEBHOOK_BODY_LIMITS.maxBytes);
    if (rawBody === 'too-large') return notAccepted(c, client);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const outcome = await binding.receiveNotice({
      tenantId: tenantId as unknown as TenantId,
      appId,
      headers,
      rawBody,
    });
    if (outcome.kind === 'ok') return c.body(null, 202);
    if (outcome.error.code === 'connection-notice-invalid') return notAccepted(c, client);
    return answer(
      c,
      'connection-notice-unavailable',
      "The notice couldn't be handled just now: send it again",
    );
  });
  return r;
}

// ================ parsing ================

type Parsed<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'err'; readonly message: string; readonly field?: string };

function bad(message: string, field?: string): Parsed<never> {
  return { kind: 'err', message, ...(field !== undefined && { field }) };
}

interface AppBody {
  readonly app?: string;
  readonly label?: string;
  readonly oauth2?: NonNullable<ConnectionAppRecord['oauth2']>;
  readonly githubApp?: NonNullable<ConnectionAppRecord['githubApp']>;
  readonly projects?: readonly ProjectId[] | null;
}

const APP_FIELDS: ReadonlySet<string> = new Set([
  'app',
  'label',
  'oauth2',
  'githubApp',
  'projects',
]);
const OAUTH2_FIELDS: ReadonlySet<string> = new Set(['clientId', 'clientSecret']);
const GITHUB_APP_FIELDS: ReadonlySet<string> = new Set([
  'appNumber',
  'slug',
  'clientId',
  'clientSecret',
  'privateKey',
  'webhookSecret',
]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** A registration's body: `create` takes `app`; `update` can't change it, and takes `projects: null` (every project). */
function parseAppBody(body: Record<string, unknown>, mode: 'create' | 'update'): Parsed<AppBody> {
  const head = parseAppHead(body, mode);
  if (head.kind === 'err') return head;
  const oauth2 = body.oauth2 === undefined ? undefined : parseOAuth2(body.oauth2);
  if (oauth2?.kind === 'err') return oauth2;
  const githubApp = body.githubApp === undefined ? undefined : parseGitHubApp(body.githubApp);
  if (githubApp?.kind === 'err') return githubApp;
  const projects = body.projects === undefined ? undefined : parseProjects(body.projects, mode);
  if (projects?.kind === 'err') return projects;
  return {
    kind: 'ok',
    value: {
      ...head.value,
      ...(oauth2 !== undefined && { oauth2: oauth2.value }),
      ...(githubApp !== undefined && { githubApp: githubApp.value }),
      ...(projects !== undefined && { projects: projects.value }),
    },
  };
}

/** A registration's `app` (a create's, required; an update can't change it) and `label`. */
function parseAppHead(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
): Parsed<Pick<AppBody, 'app' | 'label'>> {
  const unknown = unknownField(body, APP_FIELDS, '');
  if (unknown !== undefined) return unknown;
  if (mode === 'update' && body.app !== undefined) {
    return bad("`app` can't change: register the other app as its own", 'app');
  }
  if (mode === 'create' && (typeof body.app !== 'string' || !APP_ID_PATTERN.test(body.app))) {
    return bad(`\`app\` is required: an entry id matching ${APP_ID_PATTERN.source}`, 'app');
  }
  if (
    body.label !== undefined &&
    (typeof body.label !== 'string' || body.label.length > MAX_LABEL_LENGTH)
  ) {
    return bad(`\`label\` must be a string of at most ${MAX_LABEL_LENGTH} characters`, 'label');
  }
  return {
    kind: 'ok',
    value: {
      ...(typeof body.app === 'string' && { app: body.app }),
      ...(typeof body.label === 'string' && { label: body.label }),
    },
  };
}

/** A registration's fields both a create and an update take as they come. */
function appFields(body: AppBody): Pick<AppBody, 'label' | 'oauth2' | 'githubApp'> {
  return {
    ...(body.label !== undefined && { label: body.label }),
    ...(body.oauth2 !== undefined && { oauth2: body.oauth2 }),
    ...(body.githubApp !== undefined && { githubApp: body.githubApp }),
  };
}

function parseOAuth2(raw: unknown): Parsed<NonNullable<ConnectionAppRecord['oauth2']>> {
  if (!isObject(raw))
    return bad('`oauth2` must be an object `{ clientId, clientSecret }`', 'oauth2');
  const unknown = unknownField(raw, OAUTH2_FIELDS, 'oauth2.');
  if (unknown !== undefined) return unknown;
  const clientId = parseText(raw.clientId, 'oauth2.clientId', MAX_CLIENT_ID_LENGTH);
  if (clientId.kind === 'err') return clientId;
  const clientSecret = parseRef(raw.clientSecret, 'oauth2.clientSecret');
  if (clientSecret.kind === 'err') return clientSecret;
  return { kind: 'ok', value: { clientId: clientId.value, clientSecret: clientSecret.value } };
}

function parseGitHubApp(raw: unknown): Parsed<NonNullable<ConnectionAppRecord['githubApp']>> {
  if (!isObject(raw)) {
    return bad(
      '`githubApp` must be an object `{ appNumber, slug, clientId, clientSecret, privateKey, webhookSecret }`',
      'githubApp',
    );
  }
  const unknown = unknownField(raw, GITHUB_APP_FIELDS, 'githubApp.');
  if (unknown !== undefined) return unknown;
  if (
    typeof raw.appNumber !== 'number' ||
    !Number.isSafeInteger(raw.appNumber) ||
    raw.appNumber < 1
  ) {
    return bad('`githubApp.appNumber` must be a positive whole number', 'githubApp.appNumber');
  }
  if (
    typeof raw.slug !== 'string' ||
    raw.slug.length > MAX_SLUG_LENGTH ||
    !SLUG_RE.test(raw.slug)
  ) {
    return bad(
      `\`githubApp.slug\` must be the app's slug: lowercase letters, digits and hyphens, at most ${MAX_SLUG_LENGTH}`,
      'githubApp.slug',
    );
  }
  const clientId = parseText(raw.clientId, 'githubApp.clientId', MAX_CLIENT_ID_LENGTH);
  if (clientId.kind === 'err') return clientId;
  const refs: Record<string, SecretRefInput> = {};
  for (const field of ['clientSecret', 'privateKey', 'webhookSecret'] as const) {
    const parsed = parseRef(raw[field], `githubApp.${field}`);
    if (parsed.kind === 'err') return parsed;
    refs[field] = parsed.value;
  }
  return {
    kind: 'ok',
    value: {
      appNumber: raw.appNumber,
      slug: raw.slug,
      clientId: clientId.value,
      clientSecret: refs.clientSecret as SecretRefInput,
      privateKey: refs.privateKey as SecretRefInput,
      webhookSecret: refs.webhookSecret as SecretRefInput,
    },
  };
}

function parseProjects(
  raw: unknown,
  mode: 'create' | 'update',
): Parsed<readonly ProjectId[] | null> {
  if (raw === null && mode === 'update') return { kind: 'ok', value: null };
  const every =
    mode === 'update' ? '; `null` for every project' : '; leave it out for every project';
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PROJECTS) {
    return bad(`\`projects\` must list 1 to ${MAX_PROJECTS} project ids${every}`, 'projects');
  }
  if (raw.some((id) => typeof id !== 'string' || id.length === 0)) {
    return bad('`projects` must list project ids', 'projects');
  }
  if (new Set(raw).size !== raw.length) return bad('`projects` lists a project twice', 'projects');
  return { kind: 'ok', value: raw as ProjectId[] };
}

interface ConnectBody {
  readonly app: string;
  readonly appId?: string;
  readonly projectId?: ProjectId;
  readonly permissions: readonly string[];
  readonly for: 'me' | 'company';
}

const CONNECT_FIELDS: ReadonlySet<string> = new Set([
  'app',
  'appId',
  'projectId',
  'permissions',
  'for',
]);

function parseConnectBody(body: Record<string, unknown>): Parsed<ConnectBody> {
  const unknown = unknownField(body, CONNECT_FIELDS, '');
  if (unknown !== undefined) return unknown;
  if (typeof body.app !== 'string' || !APP_ID_PATTERN.test(body.app)) {
    return bad(`\`app\` is required: an entry id matching ${APP_ID_PATTERN.source}`, 'app');
  }
  if (body.appId !== undefined && (typeof body.appId !== 'string' || !UUID_RE.test(body.appId))) {
    return bad('`appId` must be a connection app id (a UUID)', 'appId');
  }
  if (
    body.projectId !== undefined &&
    (typeof body.projectId !== 'string' || body.projectId.length === 0)
  ) {
    return bad('`projectId` must be a project id', 'projectId');
  }
  const permissions = parsePermissions(body.permissions);
  if (permissions.kind === 'err') return permissions;
  if (body.for !== undefined && body.for !== 'me' && body.for !== 'company') {
    return bad("`for` must be `'me'` or `'company'`", 'for');
  }
  return {
    kind: 'ok',
    value: {
      app: body.app,
      ...(typeof body.appId === 'string' && { appId: body.appId }),
      ...(typeof body.projectId === 'string' && { projectId: body.projectId as ProjectId }),
      permissions: permissions.value,
      for: body.for ?? 'me',
    },
  };
}

function parsePermissions(raw: unknown): Parsed<readonly string[]> {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_PERMISSIONS ||
    raw.some((p) => typeof p !== 'string' || !PERMISSION_KEY_PATTERN.test(p))
  ) {
    return bad(
      `\`permissions\` must list 1 to ${MAX_PERMISSIONS} of the entry's permission keys`,
      'permissions',
    );
  }
  if (new Set(raw).size !== raw.length) {
    return bad('`permissions` lists a permission twice', 'permissions');
  }
  return { kind: 'ok', value: raw as string[] };
}

/** A GitHub App's pick: an installation to attach, or a new one. The body is optional. */
function parseStartBody(
  body: Record<string, unknown>,
): Parsed<{ readonly installationId?: string; readonly newInstallation?: true }> {
  const unknown = unknownField(body, new Set(['installationId', 'newInstallation']), '');
  if (unknown !== undefined) return unknown;
  const { installationId, newInstallation } = body;
  if (
    installationId !== undefined &&
    (typeof installationId !== 'string' ||
      installationId.length === 0 ||
      installationId.length > MAX_INSTALLATION_ID_LENGTH)
  ) {
    return bad(
      `\`installationId\` must be a non-empty string of at most ${MAX_INSTALLATION_ID_LENGTH} characters`,
      'installationId',
    );
  }
  if (newInstallation !== undefined && typeof newInstallation !== 'boolean') {
    return bad('`newInstallation` must be `true` or `false`', 'newInstallation');
  }
  if (newInstallation === true && installationId !== undefined) {
    return bad(
      '`newInstallation` installs the app on another account: leave out `installationId`',
      'newInstallation',
    );
  }
  return {
    kind: 'ok',
    value: {
      ...(installationId !== undefined && { installationId }),
      ...(newInstallation === true && { newInstallation }),
    },
  };
}

const FINISH_FIELDS = [
  'state',
  'code',
  'installationId',
  'setupAction',
  'error',
  'errorDescription',
] as const;
type FinishField = (typeof FINISH_FIELDS)[number];

/** What the app sent to the callback page, as the console passes it on: each a string. */
function parseFinishBody(
  body: Record<string, unknown>,
): Parsed<{ readonly state: string } & Partial<Record<Exclude<FinishField, 'state'>, string>>> {
  const unknown = unknownField(body, new Set<string>(FINISH_FIELDS), '');
  if (unknown !== undefined) return unknown;
  const value: Partial<Record<FinishField, string>> = {};
  for (const field of FINISH_FIELDS) {
    const raw = body[field];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_FINISH_FIELD_LENGTH) {
      return bad(
        `\`${field}\` must be a non-empty string of at most ${MAX_FINISH_FIELD_LENGTH} characters`,
        field,
      );
    }
    value[field] = raw;
  }
  const { state, ...rest } = value;
  if (state === undefined) return bad('`state` is required: the one the app sent back', 'state');
  return { kind: 'ok', value: { state, ...rest } };
}

interface ListQuery {
  readonly projectId?: ProjectId;
  readonly app?: string;
  readonly mine: boolean;
  readonly ownerKind?: 'member' | 'company';
  readonly state?: ConnectionState;
}

function parseListQuery(c: Context<AppEnv>): Parsed<ListQuery> {
  const projectId = c.req.query('projectId');
  const app = c.req.query('app');
  const owner = c.req.query('owner');
  const ownerKind = c.req.query('ownerKind');
  const state = c.req.query('state');
  if (app !== undefined && !APP_ID_PATTERN.test(app)) {
    return bad('`app` must be an entry id', 'app');
  }
  if (owner !== undefined && owner !== 'me') return bad("`owner` takes only `'me'`", 'owner');
  if (ownerKind !== undefined && ownerKind !== 'member' && ownerKind !== 'company') {
    return bad("`ownerKind` must be `'member'` or `'company'`", 'ownerKind');
  }
  if (state !== undefined && !CONNECTION_STATES.has(state)) {
    return bad(`\`state\` must be one of ${[...CONNECTION_STATES].join(', ')}`, 'state');
  }
  return {
    kind: 'ok',
    value: {
      ...(projectId !== undefined && projectId.length > 0 && { projectId: projectId as ProjectId }),
      ...(app !== undefined && { app }),
      mine: owner === 'me',
      ...(ownerKind !== undefined && { ownerKind }),
      ...(state !== undefined && { state: state as ConnectionState }),
    },
  };
}

function parseText(raw: unknown, field: string, max: number): Parsed<string> {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > max) {
    return bad(`\`${field}\` must be a non-empty string of at most ${max} characters`, field);
  }
  return { kind: 'ok', value: raw };
}

function parseRef(raw: unknown, field: string): Parsed<SecretRefInput> {
  const parsed = parseSecretRef(raw, field);
  if (parsed.kind === 'err') return bad(parsed.message, parsed.unknownField ?? field);
  return parsed;
}

function unknownField(
  body: Record<string, unknown>,
  known: ReadonlySet<string>,
  prefix: string,
): Parsed<never> | undefined {
  const unknown = Object.keys(body).find((key) => !known.has(key));
  return unknown === undefined
    ? undefined
    : bad(`Unknown field \`${prefix}${unknown}\``, `${prefix}${unknown}`);
}

function secretsOf(body: AppBody): readonly (readonly [string, SecretRefInput])[] {
  return [
    ...(body.oauth2 !== undefined
      ? [['oauth2.clientSecret', body.oauth2.clientSecret] as const]
      : []),
    ...(body.githubApp !== undefined
      ? ([
          ['githubApp.clientSecret', body.githubApp.clientSecret],
          ['githubApp.privateKey', body.githubApp.privateKey],
          ['githubApp.webhookSecret', body.githubApp.webhookSecret],
        ] as const)
      : []),
  ];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonObject(
  c: Context<AppEnv>,
  opts: { readonly allowEmpty?: boolean } = {},
): Promise<Parsed<Record<string, unknown>>> {
  let body: unknown;
  try {
    if (opts.allowEmpty === true) {
      // An optional body: none, or an empty one, reads as `{}`.
      const text = await c.req.text();
      if (text.trim().length === 0) return { kind: 'ok', value: {} };
      body = JSON.parse(text);
    } else {
      body = await c.req.json();
    }
  } catch {
    return bad('Request body must be valid JSON');
  }
  if (!isObject(body)) return bad('Request body must be a JSON object');
  return { kind: 'ok', value: body };
}

// ================ the caller ================

/** The caller as the binding records it. */
function principalRef(c: Context<AppEnv>): PrincipalRef | undefined {
  const caller = callerPrincipal(c);
  if (caller === undefined) return undefined;
  const tenantId = c.get('tenantId') as TenantId;
  return caller.kind === 'user'
    ? { kind: 'user', id: caller.userId, tenantId }
    : { kind: 'service_account', id: caller.serviceAccountId, tenantId };
}

function isOwner(c: Context<AppEnv>, owner: ConnectionOwner): boolean {
  const caller = callerPrincipal(c);
  return owner.kind === 'member' && caller?.kind === 'user' && caller.userId === owner.userId;
}

function noPrincipal(c: Context<AppEnv>, authorizer: Authorizer | undefined): Response {
  return refused(c, authorizer, {
    action: 'write',
    resource: ref('tenant', c.get('tenantId') as unknown as string),
    message: 'Connections are changed by a person or a service account; this credential is neither',
    failing: 'actor',
  });
}

// ================ serialization ================

function serializePage<T>(
  page: ConnectionPage<T>,
  serialize: (record: T) => Record<string, unknown>,
): Record<string, unknown> {
  return {
    data: page.data.map(serialize),
    hasMore: page.nextCursor !== undefined,
    ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
  };
}

function serializeEntry(entry: AppEntry): Record<string, unknown> {
  return {
    id: entry.id,
    name: entry.name,
    owners: [...entry.owners],
    signIn: { kind: entry.signIn.kind },
    permissions: Object.fromEntries(
      Object.entries(entry.permissions).map(([key, p]) => [
        key,
        { says: p.says, changes: p.changes },
      ]),
    ),
    setupGuide: entry.setupGuide,
  };
}

function serializeRef(secretRef: SecretRefInput): Record<string, unknown> {
  return { envName: secretRef.envName as unknown as string, name: secretRef.name };
}

function serializeApp(app: ConnectionAppRecord): Record<string, unknown> {
  return {
    appId: app.appId,
    app: app.app,
    ...(app.label !== undefined && { label: app.label }),
    ...(app.oauth2 !== undefined && {
      oauth2: {
        clientId: app.oauth2.clientId,
        clientSecret: serializeRef(app.oauth2.clientSecret),
      },
    }),
    ...(app.githubApp !== undefined && {
      githubApp: {
        appNumber: app.githubApp.appNumber,
        slug: app.githubApp.slug,
        clientId: app.githubApp.clientId,
        clientSecret: serializeRef(app.githubApp.clientSecret),
        privateKey: serializeRef(app.githubApp.privateKey),
        webhookSecret: serializeRef(app.githubApp.webhookSecret),
      },
    }),
    ...(app.projects !== undefined && {
      projects: app.projects.map((id) => id as unknown as string),
    }),
    redirectUrl: app.redirectUrl,
    noticesUrl: app.noticesUrl,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    ...(app.removedAt !== undefined && { removedAt: app.removedAt }),
  };
}

function serializeOwner(owner: ConnectionOwner): Record<string, unknown> {
  return owner.kind === 'member' ? { kind: 'member', userId: owner.userId } : { kind: 'company' };
}

/** A connection: never its token. */
function serializeConnection(connection: ConnectionRecord): Record<string, unknown> {
  return {
    connectionId: connection.connectionId,
    envName: connection.envName as unknown as string,
    appId: connection.appId,
    app: connection.app,
    owner: serializeOwner(connection.owner),
    account: { id: connection.account.id, label: connection.account.label },
    permissions: [...connection.permissions],
    state: connection.state,
    ...(connection.stateReason !== undefined && { stateReason: connection.stateReason }),
    ...(connection.installationId !== undefined && {
      installationId: connection.installationId,
    }),
    ...(connection.accessEndsAt !== undefined && { accessEndsAt: connection.accessEndsAt }),
    connectedAt: connection.connectedAt,
    ...(connection.lastUsedAt !== undefined && { lastUsedAt: connection.lastUsedAt }),
    createdAt: connection.createdAt,
    createdBy: connection.createdBy,
    updatedAt: connection.updatedAt,
    ...(connection.removedAt !== undefined && { removedAt: connection.removedAt }),
    ...(connection.removedBy !== undefined && { removedBy: connection.removedBy }),
    ...(connection.removedReason !== undefined && { removedReason: connection.removedReason }),
    ...(connection.withdrawn !== undefined && { withdrawn: connection.withdrawn }),
  };
}

function serializeRequest(request: ConnectRequestRecord): Record<string, unknown> {
  return {
    requestId: request.requestId,
    envName: request.envName as unknown as string,
    appId: request.appId,
    app: request.app,
    owner: serializeOwner(request.owner),
    permissions: [...request.permissions],
    says: [...request.says],
    ...(request.reconnects !== undefined && { reconnects: request.reconnects }),
    ...(request.runId !== undefined && { runId: request.runId }),
    ...(request.name !== undefined && { name: request.name }),
    ...(request.startedBy !== undefined && { startedBy: request.startedBy }),
    state: request.state,
    ...(request.failure !== undefined && { failure: request.failure }),
    ...(request.missing !== undefined && { missing: [...request.missing] }),
    ...(request.installations !== undefined && {
      installations: request.installations.map(({ installationId, account }) => ({
        installationId,
        account: { id: account.id, label: account.label },
      })),
    }),
    ...(request.connectionId !== undefined && { connectionId: request.connectionId }),
    connectUrl: request.connectUrl,
    expiresAt: request.expiresAt,
    createdAt: request.createdAt,
    createdBy: request.createdBy,
  };
}

function serializeFinish(outcome: ConnectFinishOutcome): Record<string, unknown> {
  return outcome.kind === 'connected'
    ? {
        kind: 'connected',
        request: serializeRequest(outcome.request),
        connection: serializeConnection(outcome.connection),
      }
    : { kind: outcome.kind, request: serializeRequest(outcome.request) };
}

// ================ answers ================

function answer(
  c: Context<AppEnv>,
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): Response {
  const { code: _code, message: _message, ...rest } = details;
  c.status(statusFor(code) as never);
  return c.json(toWireError({ code, message, ...rest }, c.get('requestId')));
}

function badInput(c: Context<AppEnv>, message: string, field?: string): Response {
  return answer(c, 'bad-input', message, field === undefined ? {} : { field });
}

/**
 * The binding's refusal, answered with its own code. One that refuses the
 * caller (a 403: someone else's sign-in, or a GitHub installation their
 * account doesn't reach) is recorded in the access audit, as the route's
 * own refusals are.
 */
function bindingRefused(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  error: ConnectionError,
): Response {
  const details = {
    ...(error.field !== undefined && { field: error.field }),
    ...(error.connectRequestId !== undefined && { connectRequestId: error.connectRequestId }),
  };
  if (statusFor(error.code) === 403) {
    return refused(c, authorizer, {
      action: 'write',
      resource: ref('tenant', c.get('tenantId') as unknown as string),
      message: error.message,
      failing: 'actor',
      code: error.code,
      ...(Object.keys(details).length > 0 && { details }),
    });
  }
  return answer(c, error.code, error.message, details);
}

function appNotFound(c: Context<AppEnv>, appId: string): Response {
  return answer(c, 'connection-app-not-found', `No connection app with id "${appId}"`, { appId });
}

function connectionNotFound(c: Context<AppEnv>, connectionId: string): Response {
  return answer(c, 'connection-not-found', `No connection with id "${connectionId}"`, {
    connectionId,
  });
}

function requestNotFound(c: Context<AppEnv>, requestId: string): Response {
  return answer(c, 'connection-request-not-found', `No connect request with id "${requestId}"`, {
    requestId,
  });
}
