// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, MiddlewareHandler } from 'hono';

import { ref } from '@kindgi/authz';
import type { TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import { refused } from '../routes/denied.js';
import {
  FULL_SYSTEM_CAPABILITY,
  SYSTEM_PRINCIPAL_ALLOWED_ROUTES,
  type SystemScope,
  holdsSystemScope,
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

/**
 * Where the runtime keeps the record of every request a system principal
 * makes (key, scope, route, target tenant): the record the access
 * procedure points to.
 */
export interface SystemAccessAuditBinding {
  record(entry: SystemAccessRecord): Promise<void>;
}

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

/**
 * Fences a system principal in: it reaches `/v1/system/*` and the
 * deployment-level routes of `SYSTEM_PRINCIPAL_ALLOWED_ROUTES`; any other
 * route answers `403 system-key-on-tenant-route` before its code runs.
 * Every request a system principal makes is recorded with `audit`, its
 * refusals too. Other callers pass untouched.
 *
 * The record is written once the response is known. An action already
 * taken can't be undone, so a failed write is logged at error level and
 * the response still goes out.
 */
export function systemPrincipalFence(
  audit?: SystemAccessAuditBinding,
  authorizer?: Authorizer,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const system = c.get('systemPrincipal');
    if (system === undefined) return next();
    const method = c.req.method;
    const path = c.req.path;
    const allowed =
      isSystemPath(path) ||
      SYSTEM_PRINCIPAL_ALLOWED_ROUTES.some((r) => r.method === method && r.path === path);
    let refusal: Response | undefined;
    if (allowed) {
      await next();
    } else {
      refusal = deny(
        c,
        authorizer,
        'system-key-on-tenant-route',
        `A system key acts in no tenant: it reaches /v1/system/* only, not ${method} ${path}. Use a key of the tenant.`,
      );
    }
    if (audit !== undefined) {
      const scope = c.get('systemScopeUsed');
      const tenantId = c.get('systemTargetTenant');
      try {
        await audit.record({
          requestId: c.get('requestId'),
          keyId: system.keyId,
          method,
          path,
          status: refusal?.status ?? c.res.status,
          ...(scope !== undefined && { scope }),
          ...(tenantId !== undefined && { tenantId }),
        });
      } catch (cause) {
        c.get('log').error('could not record a system request in the access record', {
          err: cause,
          keyId: system.keyId,
          method,
          path,
        });
      }
    }
    return refusal;
  };
}

/**
 * A system route's gate: the caller must be a system principal (a tenant
 * key is refused whatever its capabilities: `403
 * system-principal-required`) holding `scope` or `kindgi:system` (`403
 * system-scope-missing`).
 */
export function requireSystemScope(
  scope: SystemScope,
  authorizer?: Authorizer,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const denied = systemScopeRefusal(c, scope, authorizer);
    if (denied !== undefined) return denied;
    c.set('systemScopeUsed', scope);
    return next();
  };
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
  /** States the route refuses, each with `409 tenant-<state>`; `purged` always. */
  readonly refuse?: readonly Exclude<SystemTenantState, 'active' | 'purged'>[];
  /** Records a refusal of the caller, as every refusal the API decides itself is. */
  readonly authorizer?: Authorizer;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The one way a system route acts in a tenant the path names. It checks the
 * scope again, that the tenant exists and isn't purged (`404
 * tenant-not-found`) and isn't in a refused state (`409 tenant-closing`,
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
  if (found === null || found.state === 'purged') {
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
