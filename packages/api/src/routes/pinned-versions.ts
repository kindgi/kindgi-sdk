// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, Hono, MiddlewareHandler } from 'hono';

import type {
  Cursor,
  OrgId,
  PinScope,
  PinnedItemKind,
  ProjectId,
  Semver,
  TenantId,
} from '@kindgi/types';

import { environmentTakesPromotionsResponse, laterEnvironment } from '../environment-entry.js';
import type { EnvironmentOrderBinding } from '../environment-orders-binding.js';
import { statusFor, toWireError } from '../errors.js';
import { type ItemRights, pinChangeRefusal, pinWidthRefusal } from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import type {
  PinnedVersion,
  PinnedVersionBinding,
  PinnedVersionChange,
  PinnedVersionError,
} from '../pinned-version-binding.js';
import {
  type ReferenceScopeBinding,
  outOfScopeResponse,
  referencesOutOfScope,
} from '../reference-scope.js';
import type { AppEnv } from '../types.js';
import { actorOf } from './agent-releases.js';
import { refuseUnissuedCursor } from './issued-cursor.js';
import { clampLimit } from './pagination.js';
import { parsePinScopeBody, pinScopeToWire } from './pin-scope-wire.js';

type Ctx = Context<AppEnv>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The routes that change an item's pins: authorized as `pin` on the item (`pinChangeRefusal`), not `admin`. */
export function isPinWrite(method: string, path: string): boolean {
  return method === 'POST' && /\/pinned\/(pin|unpin)$/.test(path);
}

/** What the pin routes ask of the item's own registry. */
export interface PinnedItem {
  readonly kind: PinnedItemKind;
  /** The item in this tenant: registered (`ok`), never (`not-found`), or with no active version left (`gone`). */
  state(tenantId: TenantId, itemId: string): Promise<'ok' | 'not-found' | 'gone'>;
  /** Whether `version` is registered and active. */
  active(tenantId: TenantId, itemId: string, version: Semver): Promise<boolean>;
  /**
   * The version `GET …/pinned` answers when no pin covers: what a run that
   * names none takes (a flow), or what the next published agent or flow
   * version locks (a tool), for `projectId` when one is named, as the
   * caller sees it. `undefined`: the route's 404.
   */
  latest(
    c: Ctx,
    tenantId: TenantId,
    itemId: string,
    projectId: ProjectId | undefined,
  ): Promise<string | undefined>;
  /**
   * Whether the item follows something a pin can't hold still (a tool an
   * MCP endpoint's catalog lists): its pin is refused, `tool-not-pinnable`.
   * Absent: every item can be pinned, as far as the route can tell.
   */
  followsItsServer?(tenantId: TenantId, itemId: string): Promise<boolean>;
}

export interface PinnedRouteDeps {
  readonly authorizer?: Authorizer;
  /** Rights on an item more than one project serves (`item-rights.ts`); absent → the item's own. */
  readonly itemRights?: ItemRights;
  /** A project scope must reach the item (or, for a flow, the version); absent → as named. */
  readonly referenceScope?: ReferenceScopeBinding;
  /** Where a tool's pin acts: never in a later environment of an order. Absent → no orders. */
  readonly environmentOrders?: Pick<EnvironmentOrderBinding, 'orderOf'>;
}

/**
 * The rights a pin write asks, before its handler reads the body
 * (`pinChangeRefusal`). Install it ahead of the item's own middleware,
 * which leaves pin writes to it (`isPinWrite`).
 */
export function pinRightsMiddleware(
  kind: PinnedItemKind,
  param: string,
  deps: PinnedRouteDeps,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (deps.authorizer === undefined || !isPinWrite(c.req.method, c.req.path)) return next();
    const refused = await pinChangeRefusal(c, {
      authorizer: deps.authorizer,
      rights: deps.itemRights,
      kind,
      itemId: c.req.param(param) ?? '',
      scope: await bodyPinScope(c),
    });
    return refused ?? next();
  };
}

/**
 * An item's pinned versions per scope, and their history:
 *   GET  /:id/pinned           the version in use for a project (or org), and why
 *   GET  /:id/pinned-versions  every pin
 *   POST /:id/pinned/pin       pin a version for a scope, or move the scope's pin
 *   POST /:id/pinned/unpin     remove the scope's pin (it falls back to the scope above)
 *   GET  /:id/pin-history      every pin and unpin, newest first
 */
export function mountPinnedVersionRoutes(
  r: Hono<AppEnv>,
  param: string,
  item: PinnedItem,
  binding: PinnedVersionBinding,
  deps: PinnedRouteDeps = {},
): void {
  const { kind } = item;
  const at = (suffix: string) => `/:${param}/${suffix}`;
  const idOf = (c: Ctx) => c.req.param(param) ?? '';

  /** The versions among `versions` the caller can see: all, unless more than one project serves the item. */
  async function seen(
    c: Ctx,
    itemId: string,
    versions: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const projects = await deps.itemRights?.multi(c, kind, itemId);
    if (deps.itemRights === undefined || projects === undefined) return new Set(versions);
    return new Set(
      await deps.itemRights.visibleVersions(c, kind, itemId, projects, versions, (v) => v),
    );
  }
  /**
   * Whether the pin `GET …/pinned` found is the one a run in `projectId`
   * takes: a flow's pinned version must reach the project, else the run
   * passes the pin over for the newest version the project reaches. A
   * tool's pin, and a lookup with no project, take the pin as found.
   */
  async function pinRuns(
    tenantId: TenantId,
    itemId: string,
    version: Semver,
    projectId: ProjectId | undefined,
  ): Promise<boolean> {
    if (kind !== 'flow' || projectId === undefined) return true;
    const outOfScope = await referencesOutOfScope(deps.referenceScope, tenantId, projectId, [
      { path: '/projectId', kind, id: itemId, version: version as unknown as string },
    ]);
    return outOfScope === undefined;
  }
  const named = (p: PinnedVersionChange): string[] =>
    [p.fromVersion, p.toVersion].filter((v): v is Semver => v !== null).map(String);

  r.get(at('pinned'), async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const itemId = idOf(c);
    const where = resolveQuery(c);
    if (typeof where === 'string') return badInput(c, requestId, where);
    const { projectId, orgId } = where;
    const resolved = await binding.resolve({
      tenantId,
      kind,
      itemId,
      ...(projectId !== undefined && { projectId }),
      ...(orgId !== undefined && { orgId }),
    });
    if (resolved !== null && (await pinRuns(tenantId, itemId, resolved.version, projectId))) {
      const version = resolved.version as unknown as string;
      if (!(await seen(c, itemId, [version])).has(version))
        return notFound(c, requestId, kind, itemId);
      return c.json({
        itemId,
        version,
        via: 'pinned',
        pinnedScope: pinScopeToWire(resolved.scope),
      });
    }
    const latest = await item.latest(c, tenantId, itemId, projectId);
    if (latest === undefined) return notFound(c, requestId, kind, itemId);
    return c.json({ itemId, version: latest, via: 'latest' });
  });

  r.get(at('pinned-versions'), async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const itemId = idOf(c);
    const all = await binding.list({ tenantId, kind, itemId });
    const visible = await seen(
      c,
      itemId,
      all.map((p) => p.version as unknown as string),
    );
    return c.json({
      data: all
        .filter((p) => visible.has(p.version as unknown as string))
        .map(serializePinnedVersion),
    });
  });

  r.post(at('pinned/pin'), async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const itemId = idOf(c);
    const read = await readPinBody(c, requestId, kind);
    if (read instanceof Response) return read;
    const { scope, version, reason } = read;
    const refused =
      (await itemRefusal(c, requestId, itemId, version)) ??
      (await pinScopeRefusal(c, requestId, itemId, version, scope));
    if (refused !== undefined) return refused;

    const outcome = await binding.pin({
      tenantId,
      kind,
      itemId,
      scope,
      version,
      requestedBy: actorOf(c),
      ...(reason !== undefined && { reason }),
    });
    if (outcome.kind === 'err') return failed(c, requestId, kind, itemId, outcome.error, version);
    return c.json(serializePinnedVersionChange(outcome.value.change));
  });

  /**
   * The third check of a pin: the item is registered and not
   * gone, it can be pinned, and the version is registered and active.
   */
  async function itemRefusal(
    c: Ctx,
    requestId: string,
    itemId: string,
    version: Semver,
  ): Promise<Response | undefined> {
    const tenantId = c.get('tenantId') as TenantId;
    const state = await item.state(tenantId, itemId);
    if (state === 'not-found') return notFound(c, requestId, kind, itemId);
    if (state === 'gone') return gone(c, requestId, kind, itemId);
    if ((await item.followsItsServer?.(tenantId, itemId)) === true) {
      return notPinnable(c, requestId, itemId);
    }
    return (await item.active(tenantId, itemId, version))
      ? undefined
      : notFound(c, requestId, kind, itemId, version as unknown as string);
  }

  /**
   * The fourth to sixth checks of a pin: a project scope must reach
   * the item (a flow: the version); a tool pins only where versions are
   * made; and a pin wider than one project is refused for an item in an
   * environment order.
   */
  async function pinScopeRefusal(
    c: Ctx,
    requestId: string,
    itemId: string,
    version: Semver,
    scope: PinScope,
  ): Promise<Response | undefined> {
    const tenantId = c.get('tenantId') as TenantId;
    if (scope.kind === 'project') {
      const outOfScope = await referencesOutOfScope(
        deps.referenceScope,
        tenantId,
        scope.projectId,
        [
          {
            path: '/scope',
            kind,
            id: itemId,
            ...(kind === 'flow' && { version: version as unknown as string }),
          },
        ],
      );
      if (outOfScope !== undefined) return outOfScopeResponse(c, requestId, outOfScope);
      if (kind === 'tool') {
        const later = await laterEnvironment(deps.environmentOrders, tenantId, scope.projectId);
        if (later !== undefined) {
          return environmentTakesPromotionsResponse(
            c,
            requestId,
            deps.authorizer,
            { kind: 'tool-pin' },
            later,
          );
        }
      }
      return undefined;
    }
    return pinWidthRefusal(c, { rights: deps.itemRights, kind, itemId, scope });
  }

  r.post(at('pinned/unpin'), async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const itemId = idOf(c);
    const body = await readBody(c);
    if (body === undefined) return badInput(c, requestId, 'Request body must be a JSON object');
    const scope = pinScopeOf(c, requestId, body.scope);
    if (scope instanceof Response) return scope;
    const reason = optionalReason(body);
    if (reason.kind === 'err') return badInput(c, requestId, reason.message);
    if ((await item.state(tenantId, itemId)) === 'not-found') {
      return notFound(c, requestId, kind, itemId);
    }
    const outcome = await binding.unpin({
      tenantId,
      kind,
      itemId,
      scope,
      requestedBy: actorOf(c),
      ...reason.value,
    });
    if (outcome.kind === 'err') return failed(c, requestId, kind, itemId, outcome.error);
    return c.json(serializePinnedVersionChange(outcome.value));
  });

  r.get(at('pin-history'), async (c) => {
    const cursor = c.req.query('cursor');
    const refused = refuseUnissuedCursor(c, binding, 'pin-history', cursor);
    if (refused !== undefined) return refused;
    const itemId = idOf(c);
    const page = await binding.history({
      tenantId: c.get('tenantId') as TenantId,
      kind,
      itemId,
      limit: clampLimit(c.req.query('limit')),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
    });
    const visible = await seen(c, itemId, [...new Set(page.data.flatMap(named))]);
    return c.json({
      data: page.data
        .filter((p) => named(p).every((v) => visible.has(v)))
        .map(serializePinnedVersionChange),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });
}

/** `GET …/pinned`'s `?projectId=` and `?orgId=`, or the 400's message. */
function resolveQuery(c: Ctx): { projectId?: ProjectId; orgId?: OrgId } | string {
  const projectId = c.req.query('projectId');
  const orgId = c.req.query('orgId');
  if (projectId !== undefined && !UUID_RE.test(projectId)) {
    return '`projectId` must be a project id (a UUID)';
  }
  if (orgId !== undefined && !UUID_RE.test(orgId)) return '`orgId` must be an org id (a UUID)';
  return {
    ...(projectId !== undefined && { projectId: projectId as ProjectId }),
    ...(orgId !== undefined && { orgId: orgId as OrgId }),
  };
}

/** A pin's body (`{version, scope, reason?}`), or the 400 to answer. */
async function readPinBody(
  c: Ctx,
  requestId: string,
  kind: PinnedItemKind,
): Promise<{ scope: PinScope; version: Semver; reason?: string } | Response> {
  const body = await readBody(c);
  if (body === undefined) return badInput(c, requestId, 'Request body must be a JSON object');
  const scope = pinScopeOf(c, requestId, body.scope);
  if (scope instanceof Response) return scope;
  if (typeof body.version !== 'string' || body.version.length === 0) {
    return badInput(c, requestId, `\`version\` is required: the ${kind} version to pin`);
  }
  const reason = optionalReason(body);
  if (reason.kind === 'err') return badInput(c, requestId, reason.message);
  return { scope, version: body.version as Semver, ...reason.value };
}

/** The scope a pin or unpin body names, read leniently for the rights check: `undefined` when it names no pin scope. */
async function bodyPinScope(c: Ctx): Promise<PinScope | undefined> {
  try {
    const body: unknown = await c.req.json();
    if (body === null || typeof body !== 'object') return undefined;
    const scope = parsePinScopeBody((body as Record<string, unknown>).scope);
    return scope.kind === 'ok' ? scope.scope : undefined;
  } catch {
    return undefined;
  }
}

/** The body's scope, or the 400 to answer: `bad-input` when malformed, `scope-invalid` for a segment. */
function pinScopeOf(c: Ctx, requestId: string, raw: unknown): PinScope | Response {
  const scope = parsePinScopeBody(raw);
  if (scope.kind === 'ok') return scope.scope;
  if (scope.kind === 'err') return badInput(c, requestId, scope.message);
  c.status(statusFor('scope-invalid') as never);
  return c.json(
    toWireError(
      {
        code: 'scope-invalid',
        message: 'Flows and tools pin per project, org or tenant, not per segment',
      },
      requestId,
    ),
  );
}

async function readBody(c: Ctx): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await c.req.json();
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** `reason`: absent, or a non-empty string of at most 2000 characters. */
function optionalReason(
  body: Readonly<Record<string, unknown>>,
): { kind: 'ok'; value: { reason?: string } } | { kind: 'err'; message: string } {
  const v = body.reason;
  if (v === undefined) return { kind: 'ok', value: {} };
  if (typeof v !== 'string' || v.trim() === '' || v.length > 2000) {
    return {
      kind: 'err',
      message: '`reason` must be a non-empty string of at most 2000 characters when supplied',
    };
  }
  return { kind: 'ok', value: { reason: v } };
}

function badInput(c: Ctx, requestId: string, message: string) {
  c.status(statusFor('bad-input') as never);
  return c.json(toWireError({ code: 'bad-input', message }, requestId));
}

function notFound(
  c: Ctx,
  requestId: string,
  kind: PinnedItemKind,
  itemId: string,
  version?: string,
) {
  const code = `${kind}-not-found`;
  c.status(statusFor(code) as never);
  return c.json(
    toWireError(
      {
        code,
        message:
          version === undefined
            ? `No ${kind} registered with id "${itemId}"`
            : `No active version ${version} of ${kind} "${itemId}" is registered`,
        [`${kind}Id`]: itemId,
        ...(version !== undefined && { version }),
      },
      requestId,
    ),
  );
}

function gone(c: Ctx, requestId: string, kind: PinnedItemKind, itemId: string) {
  const code = `${kind}-gone`;
  c.status(statusFor(code) as never);
  return c.json(
    toWireError(
      {
        code,
        message: `${kind === 'flow' ? 'Flow' : 'Tool'} "${itemId}" has no active versions; reinstate a tombstoned version or publish a new one`,
        [`${kind}Id`]: itemId,
      },
      requestId,
    ),
  );
}

function notPinnable(c: Ctx, requestId: string, toolId: string) {
  c.status(statusFor('tool-not-pinnable') as never);
  return c.json(
    toWireError(
      {
        code: 'tool-not-pinnable',
        message: `Tool "${toolId}" follows its server (an MCP catalog's tool, its metadata under "kindgi.mcp") or the runtime, so a pin couldn't keep it still: reference it with a version range instead. Nothing was pinned.`,
        toolId,
      },
      requestId,
    ),
  );
}

/**
 * `409 flow-version-pinned` / `tool-version-pinned`: an unregister of a
 * version some scope pins (the registry's `pinned`), naming those scopes.
 */
export function versionPinnedResponse(
  c: Ctx,
  kind: PinnedItemKind,
  itemId: string,
  version: string,
  scopes: readonly PinScope[],
): Response {
  const code = kind === 'flow' ? 'flow-version-pinned' : 'tool-version-pinned';
  c.status(statusFor(code) as never);
  return c.json(
    toWireError(
      {
        code,
        message: `${itemId} ${version} is pinned in ${
          scopes.length === 1 ? 'a scope' : `${scopes.length} scopes`
        }: move those pins to another version, or unpin them, first, then unregister it.`,
        [kind === 'flow' ? 'flowId' : 'toolId']: itemId,
        version,
        scopes: scopes.map(pinScopeToWire),
      },
      c.get('requestId'),
    ),
  );
}

/** A binding's refusal, as the route answers it. */
function failed(
  c: Ctx,
  requestId: string,
  kind: PinnedItemKind,
  itemId: string,
  error: PinnedVersionError,
  version?: Semver,
) {
  switch (error.code) {
    case 'not-found':
      return notFound(c, requestId, kind, itemId);
    case 'version-not-found':
      return notFound(c, requestId, kind, itemId, version as unknown as string | undefined);
    case 'gone':
      return gone(c, requestId, kind, itemId);
    case 'not-pinnable':
      return notPinnable(c, requestId, itemId);
    default:
      c.status(statusFor(error.code) as never);
      return c.json(toWireError({ code: error.code, message: error.message }, requestId));
  }
}

export function serializePinnedVersion(p: PinnedVersion): Record<string, unknown> {
  return {
    itemId: p.itemId,
    scope: pinScopeToWire(p.scope),
    version: p.version as unknown as string,
    changeId: p.changeId,
    setAt: p.setAt as unknown as string,
    setBy: p.setBy,
  };
}

export function serializePinnedVersionChange(p: PinnedVersionChange): Record<string, unknown> {
  return {
    id: p.id,
    itemId: p.itemId,
    scope: pinScopeToWire(p.scope),
    action: p.action,
    fromVersion: p.fromVersion as unknown as string | null,
    toVersion: p.toVersion as unknown as string | null,
    requestedBy: p.requestedBy,
    ...(p.reason !== undefined && { reason: p.reason }),
    createdAt: p.createdAt as unknown as string,
  };
}
