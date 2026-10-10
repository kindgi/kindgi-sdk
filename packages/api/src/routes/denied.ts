// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import { type Action, type Decision, type ResourceRef, denyPayload, ref } from '@kindgi/authz';

import { toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';

/**
 * An in-handler check, for a resource known only once the request is
 * read: nothing when the caller may take `action` on `resource` (or there
 * is no authorizer), else the authorizer's own 403, to return as is.
 */
export async function deniedBy(
  authorizer: Authorizer | undefined,
  c: Context<AppEnv>,
  action: Action,
  resource: ResourceRef,
): Promise<Response | undefined> {
  if (authorizer === undefined) return undefined;
  let allowed = false;
  const answer = await authorizer.authorize(action, () => resource)(c, async () => {
    allowed = true;
  });
  return allowed ? undefined : (answer as Response);
}

/**
 * A refusal a route decides itself, on a check the authorization model
 * doesn't make (a reviewer role, an API key's capability): recorded with
 * the authorizer (`record`), as its own refusals are, so the access audit
 * holds it, and answered `403 permission-denied` with what was refused in
 * the details. The message stays the route's own words. `failing`:
 * `actor` when it's who the caller is, `scope` when it's what their key
 * carries. `code`: a 403 code of the refusal's own, when the API names one
 * (`identity-providers-operator-managed`); else `permission-denied`.
 */
export function refused(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  refusal: {
    readonly action: Action;
    readonly resource: ResourceRef;
    readonly message: string;
    readonly failing: 'actor' | 'scope';
    readonly code?: string;
  },
): Response {
  const { action, resource, message, failing, code } = refusal;
  const decision: Decision = {
    allowed: false,
    failing,
    reason: message,
    evidence: {
      action,
      relation: '',
      resource: `${resource.type}:${resource.id}`,
      actorSubject: '',
    },
  };
  authorizer?.record?.(c, action, resource, decision);
  const deny = denyPayload(action, resource.type, resource.id, message);
  const requestId = c.get('requestId');
  c.status(403);
  return c.json(
    toWireError(
      {
        code: code ?? deny.code,
        message,
        action: deny.action,
        resource: deny.resource,
        reason: deny.reason,
      },
      typeof requestId === 'string' ? requestId : '',
    ),
  );
}

/** Whether the caller's key carries `cap`: fail-closed when `capabilities` is absent. */
export function hasCapability(
  c: { get: (k: 'capabilities') => readonly string[] | undefined },
  cap: string,
): boolean {
  const caps = c.get('capabilities');
  if (caps === undefined) return false;
  return caps.includes(cap);
}

/**
 * Nothing when the caller's key carries `cap`; else its refusal, recorded
 * (`refused`, failing `scope`: what the key carries). `purpose` ends the
 * message: "for this route", "to change the trusted signing keys".
 */
export function capabilityRefusal(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  cap: string,
  purpose = 'for this route',
): Response | undefined {
  if (hasCapability(c, cap)) return undefined;
  return refused(c, authorizer, {
    action: 'admin',
    resource: ref('tenant', c.get('tenantId') as unknown as string),
    message: `Bearer token is missing the \`${cap}\` capability required ${purpose}.`,
    failing: 'scope',
  });
}
