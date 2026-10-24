// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, MiddlewareHandler } from 'hono';

import { ref } from '@kindgi/authz';
import type { TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import { refused } from '../routes/denied.js';
import {
  FULL_SYSTEM_CAPABILITY,
  ONE_TENANT_SYSTEM_SCOPES,
  SYSTEM_PRINCIPAL_ALLOWED_ROUTES,
  type SystemPrincipal,
  type SystemScope,
  holdsSystemScope,
  isSystemCapability,
  isSystemKeysPath,
} from '../system.js';
import type { AppEnv } from '../types.js';
import type { Authorizer } from './authorize.js';

/** One request a system principal made, for the platform-operations record. */
export interface SystemAccessRecord {
  readonly requestId: string;
  /** The system key's id, or `boot` for the deployment's own token. */
  readonly keyId: string;
  readonly method: string;
  readonly path: string;
  /** The response's status: a refusal is recorded too. */
  readonly status: number;
  /** The scope the route checked, when it got that far. */
  readonly scope?: string;
  /** The tenant the request acted in, `*` for a read across tenants. */
  readonly tenantId?: string;
}

/** A state-changing request's attempt, recorded before it acts. */
export type SystemAccessAttempt = Omit<SystemAccessRecord, 'status' | 'scope' | 'tenantId'>;

/** What became of an attempt. */
export interface SystemAccessOutcome {
  readonly status: number;
  readonly scope?: string;
  readonly tenantId?: string;
}

/**
 * Where the runtime keeps the record of every request a system principal
 * makes (key, scope, route, target tenant): the record the access
 * procedure points to.
 *
 * - **A state-changing request** (`POST`, `PUT`, `PATCH`, `DELETE`) is
 *   recorded **before** it acts: `begin` returns the attempt's id, and
 *   `finish` adds its outcome. If `begin` fails, nothing is done (`503
 *   access-record-unavailable`). If the process stops between the two, the
 *   attempt stays on record, never silence.
 * - **A read, and a refusal before any route code,** is recorded once
 *   answered (`record`).
 */
export interface SystemAccessAuditBinding {
  record(entry: SystemAccessRecord): Promise<void>;
  begin(attempt: SystemAccessAttempt): Promise<string>;
  finish(id: string, outcome: SystemAccessOutcome): Promise<void>;
}

const STATE_CHANGING: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Seconds a refused state-changing request waits before trying again. */
const ACCESS_RECORD_RETRY_AFTER_S = 5;

const SYSTEM_PREFIX = '/v1/system/';

function isSystemPath(path: string): boolean {
  return path === '/v1/system' || path.startsWith(SYSTEM_PREFIX);
}

/** A 403 the API decides itself: recorded with the authorizer, as every such refusal is. */
function deny(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): Response {
  return refused(c, authorizer, {
    action: 'admin',
    resource: ref('tenant', c.get('tenantId') as unknown as string),
    message,
    failing: 'scope',
    code,
    ...(details !== undefined && { details }),
  });
}

/** A system route's answer about the tenant it names: not a refusal of the caller. */
function answer(
  c: Context<AppEnv>,
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
): Response {
  // `toWireError` puts every field besides code and message under `details`.
  return c.json(
    toWireError({ code, message, ...details }, c.get('requestId')),
    statusFor(code) as never,
  );
}

export interface SystemPrincipalFenceOptions {
  /** The record of every request a system principal makes. */
  readonly audit?: SystemAccessAuditBinding;
  /** Records a refusal of the caller, as every refusal the API decides itself is. */
  readonly authorizer?: Authorizer;
  /**
   * How many tenants the runtime serves (default `single`). With `multi`, a
   * tenant's key or session never holds the operator's powers: `kindgi:system`
   * and every `system:*` are dropped from its capabilities, whatever it was
   * minted with. Serving one tenant, a system key holds `system:license`
   * alone and reaches the license routes alone: under `/v1/system/*`, the
   * system keys take the deployment's own token.
   */
  readonly tenancy?: 'single' | 'multi';
}

/**
 * Fences the operator's powers in, both ways:
 * - **A system principal** reaches `/v1/system/*` and the deployment-level
 *   routes of `SYSTEM_PRINCIPAL_ALLOWED_ROUTES`; any other route answers
 *   `403 system-key-on-tenant-route` before its code runs. Every request it
 *   makes is recorded with `audit`, its refusals too.
 * - **A tenant's key or session** never reaches `/v1/system/*` (`403
 *   system-principal-required`, before any route code, so a system route
 *   mounted without a gate is still closed to it). On a runtime serving
 *   many tenants it loses `kindgi:system` and `system:*`, with a warning
 *   naming the key: a key minted before the runtime served many tenants
 *   keeps none of the operator's powers.
 * - **Serving one tenant,** a system key holds `system:license` alone: one
 *   holding anything else (minted while the runtime served many tenants,
 *   say) is refused on every route, `403 system-key-scope-not-served`. It
 *   reaches the license routes and nothing under `/v1/system/*`, where the
 *   system keys take the deployment's own token (`403 system-scope-missing`).
 *
 * The record is written once the response is known. An action already
 * taken can't be undone, so a failed write is logged at error level and
 * the response still goes out.
 */
export function systemPrincipalFence(
  options: SystemPrincipalFenceOptions = {},
): MiddlewareHandler<AppEnv> {
  const { audit, authorizer, tenancy } = options;
  return async (c, next) => {
    const system = c.get('systemPrincipal');
    if (system === undefined) {
      if (isSystemPath(c.req.path)) return principalRequired(c, authorizer);
      if (tenancy === 'multi') dropSystemCapabilities(c);
      return next();
    }
    let attemptId: string | undefined;
    const proceed = async (): Promise<Response | undefined> => {
      // A state-changing request is on record before it acts, or it doesn't act.
      if (audit !== undefined && STATE_CHANGING.has(c.req.method)) {
        try {
          attemptId = await audit.begin(attemptOf(c, system));
        } catch (cause) {
          c.get('log').error('could not record a system request before acting on it', {
            err: cause,
            keyId: system.keyId,
            method: c.req.method,
            path: c.req.path,
          });
          // As the API's other 503s do: the caller's retry backs off.
          c.header('Retry-After', String(ACCESS_RECORD_RETRY_AFTER_S));
          return answer(
            c,
            'access-record-unavailable',
            "The operator's access record can't be written just now, so nothing was done: try again.",
            {},
          );
        }
      }
      await next();
      return undefined;
    };
    const refusal =
      (tenancy === 'multi' ? undefined : oneTenantRefusal(c, system, authorizer)) ??
      (await admitSystemRequest(c, proceed, authorizer));
    if (audit !== undefined) await recordSystemRequest(c, audit, system, refusal, attemptId);
    return refusal;
  };
}

/**
 * Serving one tenant: a system key holding anything but `system:license`
 * is refused outright, and one holding it is refused under `/v1/system/*`,
 * where the system keys take the deployment's own token. The deployment's
 * own token (`boot`) is a system principal on `/v1/system/keys` alone, and
 * is refused as one anywhere else.
 */
function oneTenantRefusal(
  c: Context<AppEnv>,
  system: SystemPrincipal,
  authorizer: Authorizer | undefined,
): Response | undefined {
  if (system.keyId === 'boot') {
    if (isSystemKeysPath(c.req.path)) return undefined;
    return deny(
      c,
      authorizer,
      'system-principal-required',
      `This runtime serves one tenant, where the deployment's own token is a system principal on /v1/system/keys alone, not on ${c.req.path}.`,
    );
  }
  const held = c.get('capabilities') ?? [];
  const served =
    held.length > 0 && held.every((cap) => ONE_TENANT_SYSTEM_SCOPES.includes(cap as SystemScope));
  if (!served) {
    return deny(
      c,
      authorizer,
      'system-key-scope-not-served',
      `This runtime serves one tenant, where a system key holds ${ONE_TENANT_SYSTEM_SCOPES.join(', ')} alone; this one holds ${held.length > 0 ? held.join(', ') : 'no scope'}. Mint one with the deployment's own token (POST /v1/system/keys).`,
      { scopes: [...held], served: [...ONE_TENANT_SYSTEM_SCOPES] },
    );
  }
  if (isSystemPath(c.req.path)) {
    return deny(
      c,
      authorizer,
      'system-scope-missing',
      `This runtime serves one tenant, where a system key reads the license alone and reaches no /v1/system/* route, not ${c.req.path}: the system keys take the deployment's own token.`,
      { scope: FULL_SYSTEM_CAPABILITY },
    );
  }
  return undefined;
}

/**
 * Lets a system principal's request through to `/v1/system/*`, or to a
 * listed route when it holds that route's scope; else its refusal. The
 * listed route's scope is checked here too, so the list means what it
 * says, and the route checks again.
 */
async function admitSystemRequest(
  c: Context<AppEnv>,
  proceed: () => Promise<Response | undefined>,
  authorizer: Authorizer | undefined,
): Promise<Response | undefined> {
  const { method, path } = c.req;
  if (isSystemPath(path)) return proceed();
  const listed = SYSTEM_PRINCIPAL_ALLOWED_ROUTES.find(
    (r) => r.method === method && r.path === path,
  );
  if (listed === undefined) {
    const reaches = [
      '/v1/system/*',
      ...SYSTEM_PRINCIPAL_ALLOWED_ROUTES.map((r) => `${r.method} ${r.path}`),
    ];
    return deny(
      c,
      authorizer,
      'system-key-on-tenant-route',
      `A system key acts in no tenant: it reaches ${reaches.slice(0, -1).join(', ')} and ${reaches.at(-1)} only, not ${method} ${path}. Use a key of the tenant.`,
    );
  }
  const refusal = systemScopeRefusal(c, listed.scope, authorizer);
  if (refusal !== undefined) return refusal;
  c.set('systemScopeUsed', holdsFullSystem(c) ? FULL_SYSTEM_CAPABILITY : listed.scope);
  return proceed();
}

function attemptOf(c: Context<AppEnv>, system: SystemPrincipal): SystemAccessAttempt {
  return {
    requestId: c.get('requestId'),
    keyId: system.keyId,
    method: c.req.method,
    path: c.req.path,
  };
}

/**
 * The access record of one system request: the attempt's outcome when it
 * began one, else the whole record. A failed write is logged, never thrown:
 * an action taken can't be undone, and its attempt is already on record.
 */
async function recordSystemRequest(
  c: Context<AppEnv>,
  audit: SystemAccessAuditBinding,
  system: SystemPrincipal,
  refusal: Response | undefined,
  attemptId: string | undefined,
): Promise<void> {
  const { method, path } = c.req;
  const scope = c.get('systemScopeUsed');
  const tenantId = c.get('systemTargetTenant');
  const outcome: SystemAccessOutcome = {
    status: refusal?.status ?? c.res.status,
    ...(scope !== undefined && { scope }),
    ...(tenantId !== undefined && { tenantId }),
  };
  try {
    if (attemptId !== undefined) {
      await audit.finish(attemptId, outcome);
    } else {
      await audit.record({ ...attemptOf(c, system), ...outcome });
    }
  } catch (cause) {
    c.get('log').error('could not record a system request in the access record', {
      err: cause,
      keyId: system.keyId,
      method,
      path,
    });
  }
}

/** A tenant's key or session on a runtime serving many tenants: no operator's powers. */
function dropSystemCapabilities(c: Context<AppEnv>): void {
  const capabilities = c.get('capabilities');
  if (capabilities === undefined || !capabilities.some(isSystemCapability)) return;
  c.set(
    'capabilities',
    capabilities.filter((cap) => !isSystemCapability(cap)),
  );
  c.get('log').warn(
    "A tenant's key carries the operator's capabilities, which a runtime serving many tenants ignores: revoke it, and use a system key",
    {
      event: 'system-capability-dropped',
      tokenId: c.get('tokenId'),
      dropped: capabilities.filter(isSystemCapability),
    },
  );
}

/**
 * A system route's gate: the caller must be a system principal (a tenant
 * key is refused whatever its capabilities: `403
 * system-principal-required`) holding `scope` or `kindgi:system` (`403
 * system-scope-missing`).
 */
export function requireSystemScope(
  scope: SystemScope | readonly [SystemScope, ...SystemScope[]],
  authorizer?: Authorizer,
): MiddlewareHandler<AppEnv> {
  // Any one of them: the narrowest first, which a refusal names.
  const scopes: readonly SystemScope[] = typeof scope === 'string' ? [scope] : scope;
  return async (c, next) => {
    const held = scopes.find((s) => holdsSystemScope(c.get('capabilities'), s));
    const denied = systemScopeRefusal(c, held ?? (scopes[0] as SystemScope), authorizer);
    if (denied !== undefined) return denied;
    c.set('systemScopeUsed', held as SystemScope);
    return next();
  };
}

/**
 * A system route's refusal of a request that asks for more than its scope
 * gives (`403 system-scope-missing`, naming `scope`), recorded as every
 * refusal the API decides itself is. `undefined` when the caller holds it.
 */
export function systemScopeExtraRefusal(
  c: Context<AppEnv>,
  scope: SystemScope | typeof FULL_SYSTEM_CAPABILITY,
  why: string,
  authorizer?: Authorizer,
): Response | undefined {
  const capabilities = c.get('capabilities');
  const held =
    scope === FULL_SYSTEM_CAPABILITY
      ? (capabilities ?? []).includes(FULL_SYSTEM_CAPABILITY)
      : holdsSystemScope(capabilities, scope);
  if (held) return undefined;
  return deny(c, authorizer, 'system-scope-missing', `${why}: that takes ${scope}.`, { scope });
}

/**
 * For a request only a key holding `scope` itself may make: the system
 * principal making it, when its own capabilities include `scope`.
 * Otherwise the refusal: `kindgi:system` doesn't count (`403
 * system-scope-missing`, naming `scope`).
 */
export function ownSystemScope(
  c: Context<AppEnv>,
  scope: SystemScope,
  why: string,
  authorizer?: Authorizer,
): SystemPrincipal | Response {
  const principal = c.get('systemPrincipal');
  if (principal === undefined) return principalRequired(c, authorizer);
  if ((c.get('capabilities') ?? []).includes(scope)) return principal;
  return deny(
    c,
    authorizer,
    'system-scope-missing',
    `${why}: that takes a key holding ${scope} itself, which ${FULL_SYSTEM_CAPABILITY} doesn't stand in for.`,
    { scope },
  );
}

/** A route only the full system capability may use: minting system keys. */
export function requireFullSystem(authorizer?: Authorizer): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get('systemPrincipal') === undefined) return principalRequired(c, authorizer);
    if (!(c.get('capabilities') ?? []).includes(FULL_SYSTEM_CAPABILITY)) {
      return deny(
        c,
        authorizer,
        'system-scope-missing',
        `This takes the full system capability, ${FULL_SYSTEM_CAPABILITY}; a scoped system key can't do it.`,
        { scope: FULL_SYSTEM_CAPABILITY },
      );
    }
    c.set('systemScopeUsed', FULL_SYSTEM_CAPABILITY);
    return next();
  };
}

function systemScopeRefusal(
  c: Context<AppEnv>,
  scope: SystemScope,
  authorizer: Authorizer | undefined,
): Response | undefined {
  if (c.get('systemPrincipal') === undefined) return principalRequired(c, authorizer);
  if (!holdsSystemScope(c.get('capabilities'), scope)) {
    return deny(
      c,
      authorizer,
      'system-scope-missing',
      `This system route takes the ${scope} scope.`,
      {
        scope,
      },
    );
  }
  return undefined;
}

function holdsFullSystem(c: Context<AppEnv>): boolean {
  return (c.get('capabilities') ?? []).includes(FULL_SYSTEM_CAPABILITY);
}

function principalRequired(c: Context<AppEnv>, authorizer: Authorizer | undefined): Response {
  return deny(
    c,
    authorizer,
    'system-principal-required',
    "This is a system route: it takes a system key (kgi_sy_…), not a tenant's key or session.",
  );
}

/** A tenant's state, from its record: `closing` wins over `suspended`. */
export type SystemTenantState = 'active' | 'suspended' | 'closing' | 'purged';

/** The tenants a system route can name, and the state each is in. */
export interface SystemTenantDirectory {
  get(
    tenantId: TenantId,
  ): Promise<{ readonly id: TenantId; readonly state: SystemTenantState } | null>;
}

export interface SystemTenantOptions {
  /** The scope the route takes, checked again here. */
  readonly scope: SystemScope;
  /** States the route refuses, each with `409 tenant-<state>`; `purged` always, unless `admitPurged`. */
  readonly refuse?: readonly Exclude<SystemTenantState, 'active' | 'purged'>[];
  /**
   * The purge's route only: a purged tenant is let through, so running the
   * purge again deletes what was written after its mark. Every other route
   * answers `404 tenant-not-found` for one.
   */
  readonly admitPurged?: boolean;
  /** Records a refusal of the caller, as every refusal the API decides itself is. */
  readonly authorizer?: Authorizer;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The one way a system route acts in a tenant the path names. It checks the
 * scope again, that the tenant exists and isn't purged (`404
 * tenant-not-found`; `admitPurged` lets a purged one through, for the
 * purge's route) and isn't in a refused state (`409 tenant-closing`,
 * `409 tenant-suspended`), and marks the tenant on the access record. Then
 * `fn` runs with the tenant; the route passes that id to its bindings,
 * which act inside the tenant's own row-level security.
 *
 * Only `/v1/system/*` handlers may call it: anywhere else it throws.
 */
export async function withSystemTenantContext(
  c: Context<AppEnv>,
  directory: SystemTenantDirectory,
  tenantId: string,
  options: SystemTenantOptions,
  fn: (tenant: { readonly id: TenantId; readonly state: SystemTenantState }) => Promise<Response>,
): Promise<Response> {
  if (!isSystemPath(c.req.path)) {
    throw new Error(`withSystemTenantContext is for /v1/system/* routes, not ${c.req.path}`);
  }
  const denied = systemScopeRefusal(c, options.scope, options.authorizer);
  if (denied !== undefined) return denied;
  c.set('systemScopeUsed', options.scope);
  c.set('systemTargetTenant', tenantId);
  const found = UUID_RE.test(tenantId) ? await directory.get(tenantId as TenantId) : null;
  if (found === null || (found.state === 'purged' && options.admitPurged !== true)) {
    return answer(c, 'tenant-not-found', `No tenant with id "${tenantId}".`, { tenantId });
  }
  if (options.refuse?.includes(found.state as Exclude<SystemTenantState, 'active' | 'purged'>)) {
    return answer(c, `tenant-${found.state}`, `Tenant ${tenantId} is ${found.state}.`, {
      tenantId,
      state: found.state,
    });
  }
  return fn(found);
}

/** Marks a read across every tenant (`*`) on the access record, after checking the scope. */
export function systemReadAcrossTenants(
  c: Context<AppEnv>,
  scope: SystemScope,
  authorizer?: Authorizer,
): Response | undefined {
  const denied = systemScopeRefusal(c, scope, authorizer);
  if (denied !== undefined) return denied;
  c.set('systemScopeUsed', scope);
  c.set('systemTargetTenant', '*');
  return undefined;
}
