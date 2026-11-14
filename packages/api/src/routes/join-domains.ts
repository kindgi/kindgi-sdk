// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';
import { Hono } from 'hono';

import { ref } from '@kindgi/authz';
import type { SessionId, TenantId } from '@kindgi/types';

import { callerIdentity } from '../caller.js';
import { statusFor, toWireError } from '../errors.js';
import type { ProviderJoinRole } from '../identity-provider-binding.js';
import type {
  JoinDomain,
  JoinDomainBinding,
  JoinDomainCaller,
  JoinDomainRefusal,
  JoinLookupWorkspace,
} from '../join-domain-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import {
  type SystemTenantDirectory,
  systemReadAcrossTenants,
  withSystemTenantContext,
} from '../middleware/system.js';
import { holdsSystemScope } from '../system.js';
import type { AppEnv } from '../types.js';
import { hasCapability, refused } from './denied.js';
import { tenantResourceAccess } from './tenant-access.js';

/**
 * The email domains a workspace lets people join from (`JoinDomainBinding`).
 *
 * Under `/v1/auth/join-domains` (`joinDomainsRouter`); a `GET` needs `read`
 * on the tenant, a change `admin`:
 *   - `GET  /`                        the allowed domains
 *   - `POST /`                        `{domain, role?}`: allow one (`role` default `viewer`)
 *   - `PATCH /:domain`                `{role}`: change what a joiner gets
 *   - `POST /:domain/unregister`      stop allowing it: new joins stop, joiners stay
 * When the deployment's operator manages sign-in (`changes: 'operator'`),
 * allowing and raising a role take `kindgi:system` (`403
 * join-domains-operator-managed`); the list, a lower role and removing
 * don't.
 *
 * Under `/v1/system/tenants` (`systemTenantJoinDomainsRouter`), the
 * operator's, with `system:join-domains`, for the tenant the path names:
 * the same four, at `/:tenantId/join-domains`.
 *
 * Under `/v1/system/join-domains` (`systemJoinLookupRouter`):
 *   - `POST /lookup`                  `{email}`: for one verified email, of the
 *                                     workspaces that let its domain join, the ones
 *                                     it may join and the ones it's in already
 *                                     (`system:join-domains:read` or `system:join-domains`)
 */

const JOIN_ROLES: readonly ProviderJoinRole[] = ['viewer', 'runner', 'none'];

/** A host name with a dot: labels of letters, digits and inner hyphens, at most 253 characters. */
const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

const fail = (c: Context<AppEnv>, code: string, message: string) => {
  c.status(statusFor(code) as never);
  return c.json(toWireError({ code, message }, c.get('requestId')));
};

/** The body as JSON, or `undefined` when there's none, or `null` when it isn't JSON. */
async function bodyOf(c: Context<AppEnv>): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A domain as written (`acme.com`, `@acme.com`, `ACME.com`, `acme.com.`),
 * lower case, as an A-label; `undefined` when it isn't one. The routes
 * hand a binding its domains in this form, so a binding compares a proved
 * email's domain in it too (`joinEmailOf`).
 */
export function joinDomainOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const d = raw.trim().replace(/^@/, '').replace(/\.$/, '').toLowerCase();
  if (d === '') return undefined;
  const ascii = toALabel(d);
  return ascii !== undefined && DOMAIN_RE.test(ascii) ? ascii : undefined;
}

/** A host name's own ASCII characters. */
const HOST_CHARS = /^[a-z0-9.-]+$/;

/**
 * A domain's A-label form, by the URL parser's IDNA; `undefined` when it has
 * none. Any ASCII but a host name's is refused first, so the parser never
 * reads a user, a port or a path out of it (`bücher.de@evil.com`).
 */
function toALabel(domain: string): string | undefined {
  if (HOST_CHARS.test(domain)) return domain;
  if ([...domain].some((ch) => ch.charCodeAt(0) < 0x80 && !HOST_CHARS.test(ch))) return undefined;
  try {
    return new URL(`http://${domain}/`).hostname;
  } catch {
    return undefined;
  }
}

/** An email as written, with its domain as `joinDomainOf` gives it; `undefined` when it isn't one. */
export function joinEmailOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const e = raw.trim();
  const at = e.lastIndexOf('@');
  if (at <= 0 || e.indexOf('@') !== at || /\s/.test(e)) return undefined;
  const domain = joinDomainOf(e.slice(at + 1));
  return domain === undefined ? undefined : `${e.slice(0, at)}@${domain}`;
}

function roleOf(raw: unknown): ProviderJoinRole | undefined {
  return JOIN_ROLES.includes(raw as ProviderJoinRole) ? (raw as ProviderJoinRole) : undefined;
}

const serialize = (d: JoinDomain) => ({
  domain: d.domain,
  role: d.role,
  createdAt: d.createdAt,
  createdBy: d.createdBy,
  ...(d.updatedAt !== undefined && { updatedAt: d.updatedAt }),
  ...(d.updatedBy !== undefined && { updatedBy: d.updatedBy }),
});

const serializeWorkspace = (w: JoinLookupWorkspace) =>
  w.kind === 'join'
    ? { kind: w.kind, tenantId: w.tenantId as unknown as string, name: w.name, role: w.role }
    : { kind: w.kind, tenantId: w.tenantId as unknown as string, name: w.name };

/** Who asks on a tenant route: the operator, a person with their session, or something with no proved email. */
function callerOf(c: Context<AppEnv>): JoinDomainCaller {
  const by = callerIdentity(c);
  if (hasCapability(c, 'kindgi:system')) return { kind: 'operator', by };
  const userId = c.get('userId') as unknown as string | undefined;
  const sessionId = c.get('sessionId') as SessionId | undefined;
  if (userId !== undefined && sessionId !== undefined && by === `user:${userId}`) {
    return { kind: 'person', userId, sessionId, by };
  }
  return { kind: 'other', by };
}

const NOT_YOURS =
  "Only a person who's a tenant admin may let people at their own email's domain join, or give joiners more, signed in with Google, Microsoft or the emailed link (not GitHub, and not an API key), or the deployment's operator: the domain's own mailbox is the proof.";

/** The binding's refusals but `not-yours`, a 403 the route records (`refused`). */
const REFUSALS: Record<
  Exclude<JoinDomainRefusal['kind'], 'not-yours'>,
  readonly [string, string]
> = {
  public: [
    'join-domain-public',
    "That's a public mailbox domain, where anyone can have an address: people there can't join by domain. Add them one by one.",
  ],
  'verified-elsewhere': [
    'join-domain-verified-elsewhere',
    "The deployment's operator verified that domain for another workspace, so only that one may let its people join.",
  ],
  'needs-authorization': [
    'domain-join-needs-authorization',
    "Joining by domain needs the deployment's authorization store: without it a joiner's role couldn't be checked, and they'd work in every project.",
  ],
};

const OPERATOR_MANAGED =
  "The deployment's operator manages sign-in here: letting more people join, or giving joiners more, takes the operator's credential.";

/** A 403 the route decides, recorded with the authorizer as its own refusals are. */
function refusedChange(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  tenantId: TenantId,
  code: 'join-domain-not-yours' | 'join-domains-operator-managed',
): Response {
  const notYours = code === 'join-domain-not-yours';
  return refused(c, authorizer, {
    action: 'admin',
    resource: ref('tenant', tenantId as unknown as string),
    message: notYours ? NOT_YOURS : OPERATOR_MANAGED,
    // Not-yours is who the caller is; operator-managed, what the deployment allows.
    failing: notYours ? 'actor' : 'scope',
    code,
  });
}

/** The binding's refusal, as the route answers it. */
function refusal(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  tenantId: TenantId,
  outcome: JoinDomainRefusal,
): Response {
  if (outcome.kind === 'not-yours')
    return refusedChange(c, authorizer, tenantId, 'join-domain-not-yours');
  const [code, message] = REFUSALS[outcome.kind];
  return fail(c, code, message);
}

const NOT_FOUND = (c: Context<AppEnv>, domain: string) =>
  fail(c, 'join-domain-not-found', `This workspace doesn't let people at ${domain} join`);

/** The four changes, for the tenant the route names, by `caller`. */
function handlers(binding: JoinDomainBinding, authorizer: Authorizer | undefined) {
  return {
    async list(c: Context<AppEnv>, tenantId: TenantId) {
      const list = await binding.list(tenantId);
      return c.json({ data: list.map(serialize), hasMore: false });
    },
    async allow(c: Context<AppEnv>, tenantId: TenantId, caller: JoinDomainCaller) {
      const body = await bodyOf(c);
      if (!isObject(body)) {
        return fail(c, 'bad-input', 'The body is `{ "domain": "acme.com", "role": "viewer" }`');
      }
      const { domain: rawDomain, role: rawRole, ...rest } = body;
      const unknown = Object.keys(rest)[0];
      if (unknown !== undefined) return fail(c, 'bad-input', `Unknown field: ${unknown}`);
      const domain = joinDomainOf(rawDomain);
      if (domain === undefined) {
        return fail(c, 'bad-input', '`domain` is an email domain, such as `acme.com`');
      }
      const role = rawRole === undefined ? 'viewer' : roleOf(rawRole);
      if (role === undefined) return fail(c, 'bad-input', '`role` is `viewer`, `runner` or `none`');
      const outcome = await binding.allow({ tenantId, domain, role, caller });
      switch (outcome.kind) {
        case 'allowed':
          c.status(201);
          return c.json(serialize(outcome.joinDomain));
        case 'exists':
          return fail(
            c,
            'join-domain-exists',
            `People at ${domain} may join already, as ${outcome.joinDomain.role}: change its role instead.`,
          );
        default:
          return refusal(c, authorizer, tenantId, outcome);
      }
    },
    async change(
      c: Context<AppEnv>,
      tenantId: TenantId,
      caller: JoinDomainCaller,
      raiseRefused: boolean,
    ) {
      const domain = joinDomainOf(c.req.param('domain'));
      if (domain === undefined) return fail(c, 'join-domain-not-found', 'No such allowed domain');
      const body = await bodyOf(c);
      const role = isObject(body) && Object.keys(body).length === 1 ? roleOf(body.role) : undefined;
      if (role === undefined) {
        return fail(c, 'bad-input', 'The body is `{ "role": "viewer" }`, `"runner"` or `"none"`');
      }
      const outcome = await binding.change({ tenantId, domain, role, caller, raiseRefused });
      switch (outcome.kind) {
        case 'changed':
        case 'unchanged':
          return c.json(serialize(outcome.joinDomain));
        case 'not-found':
          return NOT_FOUND(c, domain);
        case 'operator-managed':
          return refusedChange(c, authorizer, tenantId, 'join-domains-operator-managed');
        default:
          return refusal(c, authorizer, tenantId, outcome);
      }
    },
    async remove(c: Context<AppEnv>, tenantId: TenantId, by: string) {
      const domain = joinDomainOf(c.req.param('domain'));
      if (domain === undefined) return fail(c, 'join-domain-not-found', 'No such allowed domain');
      const removed = await binding.remove({ tenantId, domain, by });
      if (removed.kind === 'not-found') return NOT_FOUND(c, domain);
      return c.json({ domain, unregistered: true });
    },
  };
}

export interface JoinDomainsRouterOptions {
  readonly binding: JoinDomainBinding;
  readonly authorizer?: Authorizer;
  /**
   * Who may let more people join: `tenant` (default) a tenant admin, by
   * the binding's rules; `operator` only the operator (`kindgi:system`),
   * for a deployment whose operator manages sign-in
   * (`identityProviderChanges`). The list and narrowing are unchanged.
   */
  readonly changes?: 'tenant' | 'operator';
}

export function joinDomainsRouter(options: JoinDomainsRouterOptions): Hono<AppEnv> {
  const { binding, authorizer } = options;
  const operatorManaged = options.changes === 'operator';
  const h = handlers(binding, authorizer);
  const r = new Hono<AppEnv>();
  // '/*' matches '/' too: one gate, `read` for a GET, `admin` for a change.
  r.use('/*', tenantResourceAccess(authorizer));

  const tenantOf = (c: Context<AppEnv>) => c.get('tenantId') as TenantId;

  r.get('/', (c) => h.list(c, tenantOf(c)));
  r.post('/', (c) => {
    // Allowing always widens: under operator-managed sign-in it's the
    // operator's, before the body or any other rule (step 1).
    if (operatorManaged && !hasCapability(c, 'kindgi:system')) {
      return refusedChange(c, authorizer, tenantOf(c), 'join-domains-operator-managed');
    }
    return h.allow(c, tenantOf(c), callerOf(c));
  });
  r.patch('/:domain', (c) => {
    const caller = callerOf(c);
    return h.change(c, tenantOf(c), caller, operatorManaged && caller.kind !== 'operator');
  });
  r.post('/:domain/unregister', (c) => h.remove(c, tenantOf(c), callerIdentity(c)));

  return r;
}

export interface SystemJoinDomainsRouterOptions {
  readonly binding: JoinDomainBinding;
  readonly directory: SystemTenantDirectory;
  readonly authorizer?: Authorizer;
}

/**
 * The operator's join domains for the tenant the path names, under
 * `/v1/system/tenants`, with `system:join-domains`. The operator manages
 * sign-in here already, so `identityProviderChanges` doesn't apply. A
 * closing tenant is frozen: its writes answer `409 tenant-closing`.
 */
export function systemTenantJoinDomainsRouter(
  options: SystemJoinDomainsRouterOptions,
): Hono<AppEnv> {
  const { binding, directory, authorizer } = options;
  const h = handlers(binding, authorizer);
  const r = new Hono<AppEnv>();
  const scope = 'system:join-domains' as const;
  const read = { scope, ...(authorizer !== undefined && { authorizer }) };
  const write = { ...read, refuse: ['closing'] as const };
  const operator = (c: Context<AppEnv>): JoinDomainCaller => ({
    kind: 'operator',
    by: callerIdentity(c),
  });

  r.get('/:tenantId/join-domains', (c) =>
    withSystemTenantContext(c, directory, c.req.param('tenantId'), read, (t) => h.list(c, t.id)),
  );
  r.post('/:tenantId/join-domains', (c) =>
    withSystemTenantContext(c, directory, c.req.param('tenantId'), write, (t) =>
      h.allow(c, t.id, operator(c)),
    ),
  );
  r.patch('/:tenantId/join-domains/:domain', (c) =>
    withSystemTenantContext(c, directory, c.req.param('tenantId'), write, (t) =>
      h.change(c, t.id, operator(c), false),
    ),
  );
  r.post('/:tenantId/join-domains/:domain/unregister', (c) =>
    withSystemTenantContext(c, directory, c.req.param('tenantId'), write, (t) =>
      h.remove(c, t.id, callerIdentity(c)),
    ),
  );
  return r;
}

/**
 * `POST /lookup` under `/v1/system/join-domains`: for one email a sign-up
 * page verified, of the workspaces that let people at its domain join, the
 * ones it may join and the ones it's in already, never every workspace it's
 * in. The email goes in the body, so it stays out of access logs. A writer
 * may look up too: `system:join-domains` holds the read.
 */
export function systemJoinLookupRouter(options: {
  readonly binding: JoinDomainBinding;
  readonly authorizer?: Authorizer;
}): Hono<AppEnv> {
  const { binding, authorizer } = options;
  const r = new Hono<AppEnv>();

  r.post('/lookup', async (c) => {
    // The narrowest scope held, which a refusal names when there's neither.
    const scope =
      holdsSystemScope(c.get('capabilities'), 'system:join-domains') &&
      !holdsSystemScope(c.get('capabilities'), 'system:join-domains:read')
        ? 'system:join-domains'
        : 'system:join-domains:read';
    const denied = systemReadAcrossTenants(c, scope, authorizer);
    if (denied !== undefined) return denied;
    const body = await bodyOf(c);
    const email =
      isObject(body) && Object.keys(body).length === 1 ? joinEmailOf(body.email) : undefined;
    if (email === undefined) {
      return fail(
        c,
        'bad-input',
        'The body is `{ "email": "lee@acme.com" }`, an email its page verified',
      );
    }
    const workspaces = await binding.lookup(email);
    return c.json({ data: workspaces.map(serializeWorkspace), hasMore: false });
  });

  return r;
}
