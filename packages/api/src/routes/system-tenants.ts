// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import type { TenantHierarchyBinding } from '@kindgi/platform';
import type { TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import { type ImagePrefix, parseImagePrefix } from '../image-ref.js';
import type { Authorizer } from '../middleware/authorize.js';
import { withholdFromReplay } from '../middleware/idempotency.js';
import {
  type SystemTenantDirectory,
  requireSystemScope,
  systemReadAcrossTenants,
  systemScopeExtraRefusal,
  withSystemTenantContext,
} from '../middleware/system.js';
import { FULL_SYSTEM_CAPABILITY, type SystemScope } from '../system.js';
import type { AppEnv } from '../types.js';
import { TENANT_NAME_MAX, readTenantPatch, renameAnswer, tenantSlugOf } from './tenant-rename.js';
import { refuseMalformedUuidParam } from './uuid-param.js';

/** A tenant, as the operator sees it. Never its content. */
export interface SystemTenant {
  readonly id: TenantId;
  readonly name: string;
  readonly slug: string;
  /** `closing` wins over `suspended`. A purged tenant isn't listed or read. */
  readonly state: 'active' | 'suspended' | 'closing';
  readonly createdAt: string;
  /** A test tenant (the adversarial suite's): left out of usage, invoices and counts. */
  readonly test: boolean;
  /** Whether it may put projects in production: absent `production_blocked_at`. */
  readonly productionAllowed: boolean;
  /** The repository its deployments' images must sit in; absent while unset. */
  readonly imagePrefix?: string;
  readonly closingAt?: string;
  readonly suspendedAt?: string;
  /** Why it's suspended, as the operator gave it. */
  readonly suspendedReason?: string;
}

export interface SystemTenantCreateInput {
  readonly name: string;
  readonly slug?: string;
  /** Created through the system API, a tenant is blocked unless asked otherwise. */
  readonly productionAllowed: boolean;
  readonly test?: boolean;
  readonly imagePrefix?: ImagePrefix;
  /** The person made the tenant's admin and member, by email. Absent: an admin key instead. */
  readonly firstAdmin?: { readonly email: string; readonly name: string };
  /** The system key creating it, or `boot`. */
  readonly createdBy: string;
}

export type SystemTenantCreateOutcome =
  | {
      readonly kind: 'ok';
      readonly tenant: SystemTenant;
      /** With `firstAdmin`: the person it made admin. */
      readonly firstAdmin?: { readonly personId: string };
      /**
       * Without `firstAdmin` only: the new tenant's first admin key, shown
       * once. Never minted when `firstAdmin` is given.
       */
      readonly adminKey?: { readonly tokenId: string; readonly token: string };
    }
  | { readonly kind: 'slug-taken' }
  /** The image prefix equals, holds or sits inside another tenant's (`imagePrefixesOverlap`). */
  | { readonly kind: 'image-prefix-taken' };

/** A tenant's rows in one table. */
export interface SystemTenantTableRows {
  readonly table: string;
  readonly rows: number;
}

/** What a purge did, as the operator sees it: tables and counts, never content. */
export interface SystemTenantPurged {
  /**
   * It was marked purged before this run: what this run deleted was
   * written after its mark. Its mark and its record stay as they were.
   */
  readonly alreadyPurged: boolean;
  /** When it was marked purged; absent while something of it from before the mark is left. */
  readonly purgedAt?: string;
  /** Rows this run deleted, per table, both passes together. */
  readonly deleted: readonly SystemTenantTableRows[];
  /** Objects this run deleted from the artifacts' store. */
  readonly objectsDeleted: number;
  /** Whether this run deleted its authorization store. */
  readonly authzStoreDeleted: boolean;
  /** Rows of it still there afterwards, per table; empty when nothing is. */
  readonly left: readonly SystemTenantTableRows[];
  /** Objects still under its prefix in the artifacts' store. */
  readonly objectsLeft: number;
  /** Why what's left wasn't deleted, when it's a setting the runtime lacks. */
  readonly leftBecause?: string;
}

export type SystemTenantPurgeOutcome =
  | ({ readonly kind: 'ok' } & SystemTenantPurged)
  /** `confirm` isn't the tenant's slug. */
  | { readonly kind: 'slug-mismatch' }
  | { readonly kind: 'not-closing'; readonly state: 'active' | 'suspended' }
  | { readonly kind: 'window-open'; readonly windowEndsAt: string }
  /** The runtime has nowhere set to keep purge records. */
  | { readonly kind: 'record-unset' }
  /** What the tenant holds needs a setting the runtime lacks (`reason` says which). */
  | { readonly kind: 'setting-missing'; readonly reason: string }
  /**
   * Deleting its authorization store failed: `reason` says how, and what
   * that left. Before any of its rows went, none are deleted, though its
   * artifacts' bytes may be.
   */
  | { readonly kind: 'authz-store-refused'; readonly reason: string };

/**
 * The runtime's tenants, for the operator: creating one runs the tenant's
 * setup (its default project, its authorization store, adapter sync); a
 * create whose setup didn't finish leaves the tenant frozen until the same
 * request finishes it. Closing, suspending and the image prefix are writes
 * on the `tenants` row; the runtime enforces what each state means.
 */
export interface SystemTenantsBinding {
  /**
   * Safe to retry with the same slug: a tenant whose setup didn't finish
   * waits, frozen, until the same request (the same name, slug, settings
   * and first admin, under any Idempotency-Key) finishes it and answers as
   * the first would have; another request naming that slug is
   * `slug-taken`. A repeat of a create that finished is `slug-taken` too,
   * unless it carries the first request's Idempotency-Key, which the route
   * answers from the first answer (or withholds, when that held an admin
   * key).
   */
  create(input: SystemTenantCreateInput): Promise<SystemTenantCreateOutcome>;
  /** Newest first; purged tenants are left out. */
  list(input: {
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<
    | {
        readonly kind: 'ok';
        readonly data: readonly SystemTenant[];
        readonly nextCursor?: string;
      }
    | { readonly kind: 'cursor-unreadable' }
  >;
  read(tenantId: TenantId): Promise<SystemTenant | null>;
  /**
   * Sets `closing` (idempotent: a second close keeps the first time),
   * cancelling its unfinished runs, waiting ones included.
   */
  close(tenantId: TenantId): Promise<SystemTenant>;
  /**
   * Sets or clears `suspended`: setting cancels its unfinished runs,
   * waiting ones included (a second suspend keeps the first time and
   * reason); clearing clears both and resumes what was on.
   */
  setSuspended(tenantId: TenantId, suspended: boolean, reason?: string): Promise<SystemTenant>;
  /**
   * Refused when the prefix equals, holds or sits inside another tenant's
   * (`imagePrefixesOverlap`), checked in the same change as the write.
   */
  setImagePrefix(
    tenantId: TenantId,
    prefix: ImagePrefix,
  ): Promise<
    { readonly kind: 'ok'; readonly tenant: SystemTenant } | { readonly kind: 'image-prefix-taken' }
  >;
  /**
   * Suspends one of its projects (`true`) or restores it (`false`): nothing
   * new runs or deploys in it, its unfinished runs, waiting ones included,
   * are cancelled, and its deployments are retired; the rest of the tenant is untouched. A second
   * suspend keeps the first time and reason; restoring clears both.
   */
  setProjectSuspended(
    tenantId: TenantId,
    projectId: string,
    suspended: boolean,
    reason?: string,
  ): Promise<
    | {
        readonly kind: 'ok';
        readonly project: {
          readonly projectId: string;
          readonly suspended: boolean;
          readonly suspendedAt?: string;
          readonly suspendedReason?: string;
        };
      }
    | { readonly kind: 'project-not-found' }
  >;
  /** Its active admins with a primary email, at most 100. */
  admins(
    tenantId: TenantId,
  ): Promise<
    readonly { readonly userId: string; readonly email: string; readonly displayName?: string }[]
  >;
  /**
   * Purges the tenant for good, once `confirm` matches its slug: only a
   * `closing` one past its export window, with the runtime's purge record
   * set. Every row of it, its artifacts' bytes and its authorization store
   * go, its record is written, and it's marked purged; then, once each
   * server has seen the mark, what work in flight wrote meanwhile goes too.
   * Safe to run again: a run that stopped part-way is finished by the next,
   * and on a tenant already purged it deletes what was written after its
   * mark, leaving the mark and the record as they were. Absent: the route
   * answers `501 tenant-purge-unsupported`.
   */
  purge?(
    tenantId: TenantId,
    input: { readonly confirm: string },
  ): Promise<SystemTenantPurgeOutcome>;
}

const MAX_REASON = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

type Problem = string;

/**
 * `/v1/system/tenants`: create, list, read and rename tenants, close and
 * suspend them, set their image prefix, read their admins' contact
 * addresses for service notices, and purge a closed one. Each takes its
 * system scope, and acts in one tenant through `withSystemTenantContext`.
 */
export function systemTenantsRouter(options: {
  readonly tenants: SystemTenantsBinding;
  /** The same directory the other `/v1/system/tenants` routes use (`createApp`'s `systemTenantDirectory`). */
  readonly directory: SystemTenantDirectory;
  readonly authorizer?: Authorizer;
  /** The tenant-hierarchy binding's `renameTenant`: `PATCH /:tenantId` mounts only with it. */
  readonly renameTenant?: TenantHierarchyBinding['renameTenant'];
}): Hono<AppEnv> {
  const { tenants, directory, authorizer, renameTenant } = options;
  const r = new Hono<AppEnv>();
  const ctx = (scope: SystemScope) => ({
    scope,
    ...(authorizer !== undefined && { authorizer }),
  });

  // ---------- POST / (create) ----------
  r.post(
    '/',
    requireSystemScope(['system:tenants:create', 'system:tenants'], authorizer),
    async (c) => {
      const body = await readJsonObject(c);
      if (typeof body === 'string') return badInput(c, body);
      const parsed = parseCreateBody(body);
      if (typeof parsed === 'string') return badInput(c, parsed);
      const beyond = createExtrasRefusal(c, parsed, authorizer);
      if (beyond !== undefined) return beyond;
      const created = await tenants.create({
        ...parsed,
        productionAllowed: parsed.productionAllowed === true,
        createdBy: c.get('systemPrincipal')?.keyId ?? 'boot',
      });
      return createdAnswer(c, created, parsed.slug);
    },
  );

  // ---------- GET / (list) ----------
  r.get('/', async (c) => {
    const denied = systemReadAcrossTenants(c, 'system:tenants', authorizer);
    if (denied !== undefined) return denied;
    const limit = parseLimit(c.req.query('limit'));
    if (typeof limit === 'string') return badInput(c, limit);
    const cursor = c.req.query('cursor');
    const page = await tenants.list({ limit, ...(cursor !== undefined && { cursor }) });
    if (page.kind === 'cursor-unreadable') {
      return badInput(c, '`cursor` is not one this route gave: start again without it');
    }
    return c.json({
      data: page.data,
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
    });
  });

  // ---------- GET /:tenantId ----------
  r.get('/:tenantId', (c) =>
    withSystemTenantContext(
      c,
      directory,
      c.req.param('tenantId'),
      ctx('system:tenants'),
      async (t) => {
        const tenant = await tenants.read(t.id);
        return tenant === null ? notFound(c, t.id) : c.json(tenant);
      },
    ),
  );

  // ---------- PATCH /:tenantId (rename) ----------
  if (renameTenant !== undefined) {
    r.patch('/:tenantId', (c) =>
      withSystemTenantContext(
        c,
        directory,
        c.req.param('tenantId'),
        { ...ctx('system:tenants'), refuse: ['closing'] },
        async (t) => {
          const patch = await readTenantPatch(c);
          if (patch instanceof Response) return patch;
          return renameAnswer(
            c,
            await renameTenant({ tenantId: t.id, ...patch }),
            t.id,
            patch,
            'tenant',
          );
        },
      ),
    );
  }

  // ---------- POST /:tenantId/close ----------
  r.post('/:tenantId/close', (c) =>
    withSystemTenantContext(
      c,
      directory,
      c.req.param('tenantId'),
      ctx('system:tenants'),
      async (t) => c.json(await tenants.close(t.id)),
    ),
  );

  // ---------- PUT /:tenantId/suspended ----------
  r.put('/:tenantId/suspended', (c) =>
    withSystemTenantContext(
      c,
      directory,
      c.req.param('tenantId'),
      { ...ctx('system:suspend'), refuse: ['closing'] },
      async (t) => {
        const body = await readJsonObject(c);
        if (typeof body === 'string') return badInput(c, body);
        const parsed = parseSuspendBody(body);
        if (typeof parsed === 'string') return badInput(c, parsed);
        return c.json(await tenants.setSuspended(t.id, parsed.suspended, parsed.reason));
      },
    ),
  );

  // ---------- PUT /:tenantId/image-prefix ----------
  r.put('/:tenantId/image-prefix', (c) =>
    withSystemTenantContext(
      c,
      directory,
      c.req.param('tenantId'),
      { ...ctx('system:tenants:image-prefix'), refuse: ['closing'] },
      async (t) => {
        const body = await readJsonObject(c);
        if (typeof body === 'string') return badInput(c, body);
        const prefix = prefixOf(body.prefix);
        if (typeof prefix === 'string') return badInput(c, prefix);
        // Moving a tenant to another repository is rare and deliberate.
        const current = (await tenants.read(t.id))?.imagePrefix;
        if (current !== undefined && current !== `${prefix.host}/${prefix.path}`) {
          const moving = systemScopeExtraRefusal(
            c,
            FULL_SYSTEM_CAPABILITY,
            `Tenant ${t.id as unknown as string} already has an image prefix; changing it`,
            authorizer,
          );
          if (moving !== undefined) return moving;
        }
        const set = await tenants.setImagePrefix(t.id, prefix);
        return set.kind === 'ok' ? c.json(set.tenant) : prefixTaken(c);
      },
    ),
  );

  // ---------- PUT /:tenantId/projects/:projectId/suspended ----------
  r.put(
    '/:tenantId/projects/:projectId/suspended',
    refuseMalformedUuidParam('projectId', 'a project id'),
    (c) =>
      withSystemTenantContext(
        c,
        directory,
        c.req.param('tenantId'),
        { ...ctx('system:suspend'), refuse: ['closing'] },
        async (t) => {
          const body = await readJsonObject(c);
          if (typeof body === 'string') return badInput(c, body);
          const parsed = parseSuspendBody(body);
          if (typeof parsed === 'string') return badInput(c, parsed);
          const projectId = c.req.param('projectId');
          const done = await tenants.setProjectSuspended(
            t.id,
            projectId,
            parsed.suspended,
            parsed.reason,
          );
          if (done.kind === 'project-not-found') {
            return answer(
              c,
              'project-not-found',
              `No project with id "${projectId}" in this tenant.`,
              {
                projectId,
              },
            );
          }
          return c.json(done.project);
        },
      ),
  );

  // ---------- GET /:tenantId/admins ----------
  // The one system read of a tenant's people: account contacts for service
  // notices (breach, maintenance, sub-processors, terms), never content.
  r.get('/:tenantId/admins', (c) =>
    withSystemTenantContext(
      c,
      directory,
      c.req.param('tenantId'),
      ctx('system:tenants:contacts'),
      async (t) => c.json({ data: await tenants.admins(t.id) }),
    ),
  );

  // ---------- POST /:tenantId/purge ----------
  // The one irreversible system action: its own scope, which no other
  // includes. A purged tenant is let through, so a run again finishes it.
  r.post('/:tenantId/purge', (c) =>
    withSystemTenantContext(
      c,
      directory,
      c.req.param('tenantId'),
      { ...ctx('system:tenants:purge'), admitPurged: true },
      async (t) => {
        if (tenants.purge === undefined) {
          return answer(c, 'tenant-purge-unsupported', "This runtime doesn't purge tenants.");
        }
        const body = await readJsonObject(c);
        if (typeof body === 'string') return badInput(c, body);
        const confirm = confirmOf(body);
        if (typeof confirm === 'object') return badInput(c, confirm.problem);
        return purgedAnswer(c, t.id, await tenants.purge(t.id, { confirm }));
      },
    ),
  );

  return r;
}

/** `GET /v1/system/whoami`: a system key's own id, scopes and expiry. Any system principal. */
export function systemWhoamiRouter(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get('/', (c) => {
    // The fence lets only a system principal reach /v1/system/*.
    const system = c.get('systemPrincipal');
    const expiresAt = c.get('tokenExpiresAt');
    return c.json({
      keyId: system?.keyId,
      scopes: c.get('capabilities') ?? [],
      ...(expiresAt !== undefined && { expiresAt: expiresAt.toISOString() }),
    });
  });
  return r;
}

interface ParsedCreate {
  readonly name: string;
  readonly slug?: string;
  readonly productionAllowed?: boolean;
  readonly test?: boolean;
  readonly imagePrefix?: ImagePrefix;
  readonly firstAdmin?: { readonly email: string; readonly name: string };
}

const CREATE_FIELDS = new Set([
  'name',
  'slug',
  'productionAllowed',
  'test',
  'imagePrefix',
  'firstAdmin',
]);

function parseCreateBody(b: Readonly<Record<string, unknown>>): ParsedCreate | Problem {
  const unknown = Object.keys(b).filter((k) => !CREATE_FIELDS.has(k));
  if (unknown.length > 0) return `Unknown field ${unknown.map((k) => `\`${k}\``).join(', ')}`;
  const name = textOf(b.name, 'name', TENANT_NAME_MAX);
  if (name === undefined || name.problem !== undefined) {
    return name?.problem ?? '`name` is required';
  }
  const flags = flagsOf(b);
  if (typeof flags === 'string') return flags;
  const rest = referencesOf(b);
  if (typeof rest === 'string') return rest;
  return { name: name.value, ...flags, ...rest };
}

/** `productionAllowed` and `test`: booleans when given. */
function flagsOf(
  b: Readonly<Record<string, unknown>>,
): Pick<ParsedCreate, 'productionAllowed' | 'test'> | Problem {
  for (const flag of ['productionAllowed', 'test'] as const) {
    if (b[flag] !== undefined && typeof b[flag] !== 'boolean')
      return `\`${flag}\` is true or false`;
  }
  return {
    ...(b.productionAllowed !== undefined && { productionAllowed: b.productionAllowed as boolean }),
    ...(b.test !== undefined && { test: b.test as boolean }),
  };
}

/** `slug`, `imagePrefix` and `firstAdmin`, each checked when given. */
function referencesOf(
  b: Readonly<Record<string, unknown>>,
): Pick<ParsedCreate, 'slug' | 'imagePrefix' | 'firstAdmin'> | Problem {
  const slug = tenantSlugOf(b.slug);
  if (typeof slug === 'object') return slug.problem;
  const imagePrefix = b.imagePrefix === undefined ? undefined : prefixOf(b.imagePrefix);
  if (typeof imagePrefix === 'string') return imagePrefix;
  const firstAdmin = b.firstAdmin === undefined ? undefined : adminOf(b.firstAdmin);
  if (typeof firstAdmin === 'string') return firstAdmin;
  return {
    ...(slug !== undefined && { slug }),
    ...(imagePrefix !== undefined && { imagePrefix }),
    ...(firstAdmin !== undefined && { firstAdmin }),
  };
}

function textOf(
  raw: unknown,
  field: string,
  max: number,
):
  | { readonly value: string; readonly problem?: undefined }
  | { readonly problem: string }
  | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > max) {
    return { problem: `\`${field}\` must be a non-empty string of at most ${max} characters` };
  }
  return { value: raw };
}

function prefixOf(raw: unknown): ImagePrefix | Problem {
  if (typeof raw !== 'string') return '`prefix` must be a string, `<host>/<path>`';
  const parsed = parseImagePrefix(raw);
  return parsed.kind === 'ok'
    ? parsed.value
    : `The image prefix is refused: ${parsed.error.reason}`;
}

function adminOf(raw: unknown): { readonly email: string; readonly name: string } | Problem {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return '`firstAdmin` is `{ email, name }`';
  }
  const a = raw as Record<string, unknown>;
  if (typeof a.email !== 'string' || a.email.length > 254 || !EMAIL_RE.test(a.email)) {
    return '`firstAdmin.email` must be an email address';
  }
  const name = textOf(a.name, 'firstAdmin.name', TENANT_NAME_MAX);
  if (name === undefined || name.problem !== undefined) {
    return name?.problem ?? '`firstAdmin.name` is required';
  }
  return { email: a.email, name: name.value };
}

function parseSuspendBody(
  b: Readonly<Record<string, unknown>>,
): { readonly suspended: boolean; readonly reason?: string } | Problem {
  if (typeof b.suspended !== 'boolean')
    return 'The body is `{ "suspended": true, "reason"? }` or `false`';
  if (b.reason === undefined) return { suspended: b.suspended };
  const reason = textOf(b.reason, 'reason', MAX_REASON);
  if (reason === undefined || reason.problem !== undefined) return reason?.problem ?? '';
  return { suspended: b.suspended, reason: reason.value };
}

function parseLimit(raw: string | undefined): number | Problem {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    return `\`limit\` must be a whole number from 1 to ${MAX_LIMIT}`;
  }
  return n;
}

/**
 * What a create asks for beyond creating, each under its own scope, so a
 * key that only creates (`system:tenants:create`, sign-up's) never gets more
 * by asking: an admin key (no `firstAdmin`) and a test tenant take the full
 * capability, production `system:tenants:production`, and an image prefix
 * `system:tenants:image-prefix`. Refused naming the scope, never dropped.
 */
function createExtrasRefusal(
  c: Context<AppEnv>,
  body: ParsedCreate,
  authorizer: Authorizer | undefined,
): Response | undefined {
  const asks: [boolean, SystemScope | typeof FULL_SYSTEM_CAPABILITY, string][] = [
    [
      body.firstAdmin === undefined,
      FULL_SYSTEM_CAPABILITY,
      'A tenant without `firstAdmin` gets an admin key',
    ],
    [body.test === true, FULL_SYSTEM_CAPABILITY, 'A test tenant leaves the counts'],
    [body.productionAllowed === true, 'system:tenants:production', 'Allowing production'],
    [body.imagePrefix !== undefined, 'system:tenants:image-prefix', 'Setting the image prefix'],
  ];
  for (const [asked, scope, why] of asks) {
    if (!asked) continue;
    const refused = systemScopeExtraRefusal(c, scope, why, authorizer);
    if (refused !== undefined) return refused;
  }
  return undefined;
}

function createdAnswer(
  c: Context<AppEnv>,
  created: SystemTenantCreateOutcome,
  slug: string | undefined,
): Response {
  if (created.kind === 'image-prefix-taken') return prefixTaken(c);
  if (created.kind === 'slug-taken') {
    return answer(c, 'tenant-slug-taken', `Another tenant has the slug "${slug}".`, { slug });
  }
  c.set('systemTargetTenant', created.tenant.id as unknown as string);
  // The admin key is shown once: an Idempotency-Key repeat doesn't get it.
  if (created.adminKey !== undefined) withholdFromReplay(c);
  c.status(201);
  return c.json({
    tenant: created.tenant,
    ...(created.firstAdmin !== undefined && { firstAdmin: created.firstAdmin }),
    ...(created.adminKey !== undefined && { adminKey: created.adminKey }),
  });
}

function confirmOf(b: Readonly<Record<string, unknown>>): string | { readonly problem: string } {
  const unknown = Object.keys(b).filter((k) => k !== 'confirm');
  if (unknown.length > 0) {
    return { problem: `Unknown field ${unknown.map((k) => `\`${k}\``).join(', ')}` };
  }
  if (typeof b.confirm !== 'string' || b.confirm === '') {
    return { problem: 'The body is `{ "confirm": "<the tenant\'s slug>" }`' };
  }
  return b.confirm;
}

function purgedAnswer(
  c: Context<AppEnv>,
  tenantId: TenantId,
  done: SystemTenantPurgeOutcome,
): Response {
  const id = tenantId as unknown as string;
  switch (done.kind) {
    case 'slug-mismatch':
      return answer(
        c,
        'tenant-slug-mismatch',
        `\`confirm\` isn't tenant ${id}'s slug. Nothing was changed.`,
        { tenantId: id },
      );
    case 'not-closing':
      return answer(
        c,
        'tenant-not-closing',
        `Tenant ${id} is ${done.state}: only a closing tenant is purged, once its export window has passed. Nothing was changed.`,
        { tenantId: id, state: done.state },
      );
    case 'window-open':
      return answer(
        c,
        'tenant-export-window-open',
        `Tenant ${id}'s export window is open until ${done.windowEndsAt}. Nothing was changed.`,
        { tenantId: id, windowEndsAt: done.windowEndsAt },
      );
    case 'record-unset':
      return answer(
        c,
        'purge-record-unset',
        "This runtime has nowhere set to keep purge records (KINDGI_TENANT_PURGE_RECORD), so a restore from a backup couldn't purge the tenant again. Nothing was changed.",
        { tenantId: id },
      );
    case 'setting-missing':
      return answer(c, 'purge-setting-missing', `Refused: ${done.reason}. Nothing was changed.`, {
        tenantId: id,
      });
    case 'authz-store-refused':
      return answer(c, 'authz-store-delete-failed', `${done.reason}. Run the purge again.`, {
        tenantId: id,
      });
    case 'ok': {
      const left = tableRows(done.left);
      return c.json({
        tenantId: id,
        complete: done.purgedAt !== undefined && left.length === 0 && done.objectsLeft === 0,
        alreadyPurged: done.alreadyPurged,
        ...(done.purgedAt !== undefined && { purgedAt: done.purgedAt }),
        deleted: tableRows(done.deleted),
        objectsDeleted: done.objectsDeleted,
        authzStoreDeleted: done.authzStoreDeleted,
        left,
        objectsLeft: done.objectsLeft,
        ...(done.leftBecause !== undefined && { leftBecause: done.leftBecause }),
      });
    }
  }
}

/** Each table with rows, as the answer names it: its name and count, nothing more. */
function tableRows(tables: readonly SystemTenantTableRows[]): SystemTenantTableRows[] {
  return tables.filter((t) => t.rows > 0).map(({ table, rows }) => ({ table, rows }));
}

async function readJsonObject(
  c: Context<AppEnv>,
): Promise<Readonly<Record<string, unknown>> | Problem> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return 'Request body must be valid JSON';
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be an object';
  }
  return body as Readonly<Record<string, unknown>>;
}

function answer(
  c: Context<AppEnv>,
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): Response {
  c.status(statusFor(code) as never);
  // `toWireError` puts every field besides code and message under `details`.
  return c.json(toWireError({ code, message, ...details }, c.get('requestId')));
}

/** Another tenant's prefix overlaps it: no two tenants' images may mix. */
function prefixTaken(c: Context<AppEnv>): Response {
  return answer(
    c,
    'image-prefix-taken',
    "That image prefix equals, holds or sits inside another tenant's: each tenant's repository is its own.",
  );
}

function badInput(c: Context<AppEnv>, message: string): Response {
  return answer(c, 'bad-input', message);
}

function notFound(c: Context<AppEnv>, tenantId: TenantId): Response {
  return answer(c, 'tenant-not-found', `No tenant with id "${tenantId as unknown as string}".`, {
    tenantId: tenantId as unknown as string,
  });
}
