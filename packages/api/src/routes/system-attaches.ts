// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A project's attaches, written by the operator's system key holding
 * `system:attaches` itself. An attach sends the runs a person starts with
 * one key of theirs, limited to the project, to the route of their working
 * copy of the project's code, before it's deployed:
 *
 *   - `PUT  /v1/system/tenants/:tenantId/projects/:projectId/attaches/:attachId`
 *     makes the attach, or refreshes its route;
 *   - `PUT  …/attaches/:attachId/index` copies the working copy's
 *     `index.json` in, checked as a deploy checks it (`checkPackIndex`);
 *   - `DELETE …/attaches/:attachId` ends it.
 *
 * The caller is the operator's key, never the person's, so every check of
 * the person names the person the body names: their `admin` on the
 * project through `canFor`, and their key through the token store, in the
 * path's tenant. The binding checks the rest in its write's own step: the
 * project has no production, and a test project is its person's. The
 * runtime implements the binding (`SystemAttachesBinding`); `createApp`
 * mounts these routes only with it.
 */

import { createHash } from 'node:crypto';

import type { Context } from 'hono';
import { Hono } from 'hono';

import { ref, userPrincipal } from '@kindgi/authz';
import type { ApiTokenId, ProjectId, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import { authzUnavailableAnswer } from '../middleware/error-mapper.js';
import {
  type SystemTenantDirectory,
  ownSystemScope,
  withSystemTenantContext,
} from '../middleware/system.js';
import type { ProviderKeys } from '../provider-keys.js';
import type { SystemScope } from '../system.js';
import type { TokenAdmin } from '../token-admin.js';
import type { AppEnv } from '../types.js';
import { checkPackIndex } from './deployments.js';

/** Why an attach ended. */
export type ProjectAttachEndedReason =
  | 'ended'
  | 'replaced'
  | 'production-on'
  | 'not-an-admin'
  | 'key-revoked';

/** An attach as the runtime keeps it, never with its route's token. */
export interface ProjectAttach {
  readonly attachId: string;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  /** The person whose working copy it is. */
  readonly userId: string;
  /** The person's key, limited to the project, whose runs it takes. */
  readonly tokenId: string;
  /** Where the working copy is served: `https://<host>`, then any path. */
  readonly routeUrl: string;
  /** The newest index revision, which a new run takes; absent before the first copy. */
  readonly indexRevision?: number;
  readonly createdAt: Date;
  readonly endedAt?: Date;
  readonly endedReason?: ProjectAttachEndedReason;
}

/** One copy of an attach's index. */
export interface ProjectAttachIndexRevision {
  readonly attachId: string;
  readonly revision: number;
  /** The sha256 of the copy's bytes, in hex. */
  readonly hash: string;
  readonly createdAt: Date;
}

/** The attach a write names, in the path's tenant. */
export interface ProjectAttachRef {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly attachId: string;
}

/**
 * The runtime's attaches. Each write runs in the tenant's own row-level
 * security, and is one step: what it checks is read in it.
 */
export interface SystemAttachesBinding {
  /**
   * Makes the attach, or refreshes its route and its route's token. In
   * the same step: the project is there (`project-not-found`), has no
   * production (`in-production`), and, a person's own test project, is
   * this person's (`test-project-not-theirs`). The key's other live
   * attach ends, `replaced`. An attach's person and key never change
   * (`mismatch`), and one that ended stays ended (`ended`).
   */
  put(
    input: ProjectAttachRef & {
      readonly userId: string;
      readonly tokenId: string;
      readonly routeUrl: string;
      readonly routeToken: string;
    },
  ): Promise<
    | { readonly kind: 'ok'; readonly attach: ProjectAttach }
    | { readonly kind: 'project-not-found' }
    | { readonly kind: 'in-production' }
    | { readonly kind: 'test-project-not-theirs' }
    | { readonly kind: 'mismatch' }
    | { readonly kind: 'ended'; readonly attach: ProjectAttach }
  >;
  /**
   * Copies an index in, as the attach's newest revision. A copy with the
   * newest revision's hash makes none, and answers that revision. A new
   * one less than `minIntervalMs` after the newest is `too-soon`.
   */
  putIndex(
    input: ProjectAttachRef & {
      readonly hash: string;
      readonly index: Readonly<Record<string, unknown>>;
      readonly minIntervalMs: number;
    },
  ): Promise<
    | { readonly kind: 'ok'; readonly revision: ProjectAttachIndexRevision }
    | { readonly kind: 'not-found' }
    | { readonly kind: 'ended'; readonly attach: ProjectAttach }
    | { readonly kind: 'too-soon'; readonly retryAfterMs: number }
  >;
  /** Ends the attach, `ended`. One that ended already answers as it is. */
  end(
    input: ProjectAttachRef,
  ): Promise<
    { readonly kind: 'ok'; readonly attach: ProjectAttach } | { readonly kind: 'not-found' }
  >;
}

export interface SystemAttachesOptions {
  readonly binding: SystemAttachesBinding;
  /**
   * Whether an attach's route host is on the operator's list
   * (`KINDGI_ATTACH_ROUTE_HOSTS`, read with `@kindgi/env-schema`'s
   * `parseAttachRouteHosts` and `packEndpointHostAllowed`). It's given the
   * URL's `hostname`.
   */
  readonly routeHostAllowed: (hostname: string) => boolean;
}

/**
 * The largest index copy, in bytes: past it, `413 attach-index-too-large`, before
 * it's parsed. The app reads every body once first, under `requestMaxBytes` (a
 * copy past it is `413 request-too-large`); this stays below it on both profiles.
 */
export const ATTACH_INDEX_MAX_BYTES = 1.5 * 1024 * 1024;
/** The most primitives an index copy may hold. */
export const ATTACH_INDEX_MAX_PRIMITIVES = 2_000;
/** The shortest time between two copies of an attach's index, a save's own pace. */
export const ATTACH_INDEX_MIN_INTERVAL_MS = 2_000;

const SCOPE: SystemScope = 'system:attaches';
const MAX_ID_LENGTH = 128;
const ONLY_THE_ATTACH_KEY = "A project's attaches are written only by the operator's attach key";
const MAX_TOKEN_LENGTH = 4_096;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type WireError = { readonly code: string; readonly message: string } & Readonly<
  Record<string, unknown>
>;
type Parsed<T> = { kind: 'ok'; value: T } | { kind: 'err'; error: WireError };

interface AttachBody {
  readonly userId: string;
  readonly tokenId: string;
  readonly routeUrl: string;
  readonly routeToken: string;
}

export function systemAttachesRouter(
  options: SystemAttachesOptions & {
    /** The tenants a system route can name, and their states (`systemTenantDirectory`). */
    readonly directory: SystemTenantDirectory;
    readonly authorizer: Authorizer;
    readonly tokenAdmin: TokenAdmin;
    /** The model providers' keys, as a deploy's index check reads them. */
    readonly providerKeys?: ProviderKeys;
    /** As a deploy's: a check run in the pack must be named with the pack's id. */
    readonly requirePrefixedPackChecks: boolean;
  },
): Hono<AppEnv> {
  const { binding, directory: tenants, authorizer } = options;
  const r = new Hono<AppEnv>();
  const onAttach = '/tenants/:tenantId/projects/:projectId/attaches/:attachId';
  const tenantOptions = (refuse: boolean) => ({
    scope: SCOPE,
    ...(refuse && { refuse: ['closing', 'suspended'] as const }),
    authorizer,
  });

  // ---------- PUT …/attaches/:attachId ----------
  r.put(onAttach, async (c) => {
    const denied = ownSystemScope(c, SCOPE, ONLY_THE_ATTACH_KEY, authorizer);
    if (denied instanceof Response) return denied;
    const path = attachRef(c);
    if (path.kind === 'err') return fail(c, path.error);
    const body = await readJsonBody(c);
    if (body.kind === 'err') return fail(c, body.error);
    const parsed = parseAttachBody(body.value);
    if (parsed.kind === 'err') return fail(c, parsed.error);
    return withSystemTenantContext(
      c,
      tenants,
      path.value.tenantId,
      tenantOptions(true),
      async (tenant) => {
        const target = { ...path.value, tenantId: tenant.id };
        const route = await writeChecks(c, options, target, parsed.value);
        if (route instanceof Response) return route;
        const outcome = await binding.put({ ...target, ...parsed.value, routeUrl: route.href });
        return putAnswer(c, target, outcome);
      },
    );
  });

  // ---------- PUT …/attaches/:attachId/index ----------
  r.put(`${onAttach}/index`, async (c) => {
    const denied = ownSystemScope(c, SCOPE, ONLY_THE_ATTACH_KEY, authorizer);
    if (denied instanceof Response) return denied;
    const path = attachRef(c);
    if (path.kind === 'err') return fail(c, path.error);
    // The app read the body once, under its own request limit
    // (`readBodyOnce`): a copy past an attach's is refused before it's parsed.
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > ATTACH_INDEX_MAX_BYTES) {
      return fail(c, {
        code: 'attach-index-too-large',
        message: `An attach's index copy may be at most ${ATTACH_INDEX_MAX_BYTES} bytes.`,
        limit: ATTACH_INDEX_MAX_BYTES,
      });
    }
    return withSystemTenantContext(
      c,
      tenants,
      path.value.tenantId,
      tenantOptions(true),
      async (tenant) => {
        const target = { ...path.value, tenantId: tenant.id };
        // An attach's code is its person's working copy, served at its
        // route, never an image: the index's own artifact version stands,
        // and the image pointers the check builds aren't kept. Data
        // blocks aren't served from a copy.
        const checked = await checkPackIndex(bytes, {
          image: {
            imageRef: `attach:${target.attachId}`,
            artifactVersion: artifactVersionOf(bytes),
          },
          tenantId: tenant.id,
          servesBlocks: false,
          requirePrefixedPackChecks: options.requirePrefixedPackChecks,
          ...(options.providerKeys !== undefined && { providerKeys: options.providerKeys }),
        });
        if (checked.kind !== 'ok') return fail(c, indexRefusal(checked));
        const { tools, guardrails, agents, flows, blocks } = checked.primitives;
        const count =
          tools.length + guardrails.length + agents.length + flows.length + blocks.length;
        if (count > ATTACH_INDEX_MAX_PRIMITIVES) {
          return fail(c, {
            code: 'attach-index-too-large',
            message: `An attach's index copy may hold at most ${ATTACH_INDEX_MAX_PRIMITIVES} primitives; this one holds ${count}.`,
            limit: ATTACH_INDEX_MAX_PRIMITIVES,
          });
        }
        const outcome = await binding.putIndex({
          ...target,
          hash: createHash('sha256').update(bytes).digest('hex'),
          index: checked.index,
          minIntervalMs: ATTACH_INDEX_MIN_INTERVAL_MS,
        });
        switch (outcome.kind) {
          case 'ok':
            return c.json(revisionToWire(outcome.revision));
          case 'not-found':
            return attachNotFound(c, target.attachId);
          case 'ended':
            return attachEnded(c, outcome.attach);
          case 'too-soon': {
            const seconds = Math.max(1, Math.ceil(outcome.retryAfterMs / 1000));
            c.header('Retry-After', String(seconds));
            return fail(c, {
              code: 'attach-index-too-soon',
              message: `An attach's index is copied at most once every ${ATTACH_INDEX_MIN_INTERVAL_MS / 1000} s: try again in ${seconds} s.`,
            });
          }
        }
      },
    );
  });

  // ---------- DELETE …/attaches/:attachId ----------
  // A closing or suspended tenant's attaches end too.
  r.delete(onAttach, async (c) => {
    const denied = ownSystemScope(c, SCOPE, ONLY_THE_ATTACH_KEY, authorizer);
    if (denied instanceof Response) return denied;
    const path = attachRef(c);
    if (path.kind === 'err') return fail(c, path.error);
    return withSystemTenantContext(
      c,
      tenants,
      path.value.tenantId,
      tenantOptions(false),
      async (tenant) => {
        const ended = await binding.end({ ...path.value, tenantId: tenant.id });
        if (ended.kind === 'not-found') return attachNotFound(c, path.value.attachId);
        return c.json(attachToWire(ended.attach));
      },
    );
  });

  return r;
}

type AttachTarget = ProjectAttachRef;
type PutOutcome = Awaited<ReturnType<SystemAttachesBinding['put']>>;

/**
 * The route's checks of a write, cheapest first: the route's host on the
 * operator's list, then the body's key, then the body's person's `admin`
 * on the project. The route's URL when each passes, else the refusal.
 */
async function writeChecks(
  c: Context<AppEnv>,
  options: SystemAttachesOptions & {
    readonly authorizer: Authorizer;
    readonly tokenAdmin: TokenAdmin;
  },
  target: AttachTarget,
  body: AttachBody,
): Promise<URL | Response> {
  const route = parseRouteUrl(body.routeUrl);
  if (route.kind === 'err') return fail(c, route.error);
  if (!options.routeHostAllowed(route.value.hostname.toLowerCase())) {
    return fail(c, {
      code: 'attach-route-host-not-allowed',
      message: `${route.value.hostname} isn't on the operator's list of attach route hosts (KINDGI_ATTACH_ROUTE_HOSTS).`,
    });
  }
  const key = await keyRefusal(options.tokenAdmin, target, body);
  if (key !== undefined) return fail(c, key);
  let admin: boolean;
  try {
    admin = await options.authorizer.canFor(
      c,
      userPrincipal(body.userId, target.tenantId),
      'admin',
      ref('project', target.projectId),
    );
  } catch (err) {
    // Nothing is written yet: a store that couldn't be reached is a 503.
    const unavailable = authzUnavailableAnswer(err, c);
    if (unavailable !== undefined) return unavailable;
    throw err;
  }
  if (!admin) {
    return fail(c, {
      code: 'attach-needs-project-admin',
      message: `User ${body.userId} isn't an admin of project ${target.projectId}: only a project's admins attach to it.`,
    });
  }
  return route.value;
}

/** The binding's answer to a write, on the wire. */
function putAnswer(c: Context<AppEnv>, target: AttachTarget, outcome: PutOutcome): Response {
  switch (outcome.kind) {
    case 'ok':
      return c.json(attachToWire(outcome.attach));
    case 'project-not-found':
      return fail(c, {
        code: 'project-not-found',
        message: `No project "${target.projectId}" in this tenant.`,
      });
    case 'in-production':
      return fail(c, {
        code: 'attach-project-in-production',
        message: `Project ${target.projectId} is in production: its runs are its deployments', and nothing attaches to it.`,
      });
    case 'test-project-not-theirs':
      return fail(c, {
        code: 'attach-test-project-not-theirs',
        message: `Project ${target.projectId} is someone else's own test project: only its person attaches to it.`,
      });
    case 'mismatch':
      return fail(c, {
        code: 'attach-mismatch',
        message: `Attach ${target.attachId} is another person's or key's: an attach's person and key never change, so write a new one.`,
      });
    case 'ended':
      return attachEnded(c, outcome.attach);
  }
}

/**
 * Why the body's key can't carry the attach, or `undefined`: read in the
 * path's tenant, it's found, live, the body's person's, and limited to
 * the path's project.
 */
async function keyRefusal(
  tokenAdmin: TokenAdmin,
  target: { readonly tenantId: TenantId; readonly projectId: ProjectId },
  body: AttachBody,
): Promise<WireError | undefined> {
  const key = await tokenAdmin.get({
    tenantId: target.tenantId,
    tokenId: body.tokenId as ApiTokenId,
  });
  const unusable = (why: string): WireError => ({
    code: 'attach-key-not-usable',
    message: `Key ${body.tokenId} ${why}: an attach takes a live key of its person's.`,
  });
  if (key === undefined) return unusable("isn't a key of this tenant's");
  if (key.revokedAt !== undefined) return unusable('is revoked');
  if (key.expiresAt !== undefined && key.expiresAt.getTime() <= Date.now()) {
    return unusable('has expired');
  }
  const notLimited = (why: string): WireError => ({
    code: 'attach-key-not-limited-to-project',
    message: `Key ${body.tokenId} ${why}: an attach takes its person's own key, limited to project ${target.projectId}.`,
  });
  if (key.principal?.kind !== 'user' || key.principal.userId !== body.userId) {
    return notLimited(`doesn't act for user ${body.userId}`);
  }
  if (key.projectId !== target.projectId) {
    return notLimited(
      key.projectId === undefined ? "isn't limited to a project" : 'is limited to another project',
    );
  }
  return undefined;
}

/** The index's own `artifactVersion`, or `''` when it names none, which the check then refuses. */
function artifactVersionOf(bytes: Uint8Array): string {
  try {
    const v = (
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as {
        artifactVersion?: unknown;
      }
    )?.artifactVersion;
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

function indexRefusal(
  checked: Exclude<Awaited<ReturnType<typeof checkPackIndex>>, { kind: 'ok' }>,
): WireError {
  switch (checked.kind) {
    case 'not-an-object':
      return {
        code: 'attach-index-invalid',
        message: "The copy isn't a JSON object in UTF-8.",
      };
    case 'env-malformed':
      return {
        code: 'attach-index-invalid',
        message: `The copy's \`env\` isn't one a build writes: ${checked.message}`,
      };
    case 'artifact-version-mismatch':
      return {
        code: 'attach-index-invalid',
        message: 'The copy names no `artifactVersion`.',
      };
    case 'invalid':
      return {
        code: 'attach-index-invalid',
        message: 'A deploy would refuse the copy: see `details.issues`.',
        issues: checked.issues,
      };
  }
}

/** The path's attach: the tenant id is checked by `withSystemTenantContext`. */
function attachRef(
  c: Context<AppEnv>,
): Parsed<{ readonly tenantId: string; readonly projectId: ProjectId; readonly attachId: string }> {
  const tenantId = c.req.param('tenantId') ?? '';
  const projectId = c.req.param('projectId') ?? '';
  const attachId = c.req.param('attachId') ?? '';
  if (projectId === '' || projectId.length > MAX_ID_LENGTH) {
    return badInput(`\`projectId\` must be 1 to ${MAX_ID_LENGTH} characters`);
  }
  if (!UUID_RE.test(attachId)) return badInput('`attachId` must be a UUID');
  return { kind: 'ok', value: { tenantId, projectId: projectId as ProjectId, attachId } };
}

function parseAttachBody(body: unknown): Parsed<AttachBody> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return badInput('Request body must be an object');
  }
  const b = body as Record<string, unknown>;
  for (const field of ['userId', 'tokenId'] as const) {
    const v = b[field];
    if (typeof v !== 'string' || v === '' || v.length > MAX_ID_LENGTH) {
      return badInput(`\`${field}\` must be 1 to ${MAX_ID_LENGTH} characters`);
    }
  }
  if (typeof b.routeUrl !== 'string') return badInput('`routeUrl` must be a string');
  if (
    typeof b.routeToken !== 'string' ||
    b.routeToken === '' ||
    b.routeToken.length > MAX_TOKEN_LENGTH
  ) {
    return badInput(`\`routeToken\` must be 1 to ${MAX_TOKEN_LENGTH} characters`);
  }
  return {
    kind: 'ok',
    value: {
      userId: b.userId as string,
      tokenId: b.tokenId as string,
      routeUrl: b.routeUrl,
      routeToken: b.routeToken,
    },
  };
}

/** `https://<host>`, then any path: no user info, query or fragment. */
function parseRouteUrl(raw: string): Parsed<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return badInput('`routeUrl` must be an absolute URL');
  }
  if (url.protocol !== 'https:') return badInput('`routeUrl` must be https');
  if (url.username !== '' || url.password !== '')
    return badInput('`routeUrl` must carry no user info');
  if (url.search !== '' || url.hash !== '' || /[?#]/.test(raw)) {
    return badInput('`routeUrl` must have no query or fragment');
  }
  return { kind: 'ok', value: url };
}

function attachToWire(a: ProjectAttach): Record<string, unknown> {
  return {
    attachId: a.attachId,
    projectId: a.projectId,
    userId: a.userId,
    tokenId: a.tokenId,
    routeUrl: a.routeUrl,
    ...(a.indexRevision !== undefined && { indexRevision: a.indexRevision }),
    createdAt: a.createdAt.toISOString(),
    ...(a.endedAt !== undefined && { endedAt: a.endedAt.toISOString() }),
    ...(a.endedReason !== undefined && { endedReason: a.endedReason }),
  };
}

function revisionToWire(r: ProjectAttachIndexRevision): Record<string, unknown> {
  return {
    attachId: r.attachId,
    revision: r.revision,
    hash: r.hash,
    createdAt: r.createdAt.toISOString(),
  };
}

function attachEnded(c: Context<AppEnv>, attach: ProjectAttach): Response {
  return fail(c, {
    code: 'attach-ended',
    message: `Attach ${attach.attachId} ended${attach.endedReason !== undefined ? ` (${attach.endedReason})` : ''}: write a new one.`,
    ...(attach.endedReason !== undefined && { endedReason: attach.endedReason }),
  });
}

function attachNotFound(c: Context<AppEnv>, attachId: string): Response {
  return fail(c, { code: 'attach-not-found', message: `No attach "${attachId}" on this project.` });
}

async function readJsonBody(c: Context<AppEnv>): Promise<Parsed<unknown>> {
  try {
    return { kind: 'ok', value: JSON.parse(await c.req.text()) as unknown };
  } catch {
    return badInput('Request body must be JSON');
  }
}

function badInput(message: string): { kind: 'err'; error: WireError } {
  return { kind: 'err', error: { code: 'bad-input', message } };
}

function fail(c: Context<AppEnv>, error: WireError): Response {
  c.status(statusFor(error.code) as never);
  // `toWireError` puts every field besides code and message under `details`.
  return c.json(toWireError(error, c.get('requestId')));
}
