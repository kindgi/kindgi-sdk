// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import type { RenameTenantOutcome } from '@kindgi/platform';
import { TENANT_SLUG, TENANT_SLUG_MAX, type TenantId } from '@kindgi/types';

import { NAME_MAX, boundedText } from '../bounded-text.js';
import { statusFor, toWireError } from '../errors.js';
import type { AppEnv } from '../types.js';

/**
 * A tenant's name and slug, as creating and renaming one take them, and
 * the answer to a rename: `PATCH /v1/tenant` (a tenant admin's) and
 * `PATCH /v1/system/tenants/{tenantId}` (the operator's) share both.
 */

/**
 * The slug given, `undefined` when it isn't, or why it's refused. A tenant's
 * slug is `@kindgi/types`' {@link TENANT_SLUG}, and unique across tenants.
 */
export function tenantSlugOf(raw: unknown): string | undefined | { readonly problem: string } {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !TENANT_SLUG.test(raw)) {
    return {
      problem: `\`slug\` must be lowercase letters, digits and single hyphens, at most ${TENANT_SLUG_MAX} characters`,
    };
  }
  return raw;
}

/** The name given, `undefined` when it isn't, or why it's refused. */
export function tenantNameOf(
  raw: unknown,
  field = 'name',
): string | undefined | { readonly problem: string } {
  if (raw === undefined) return undefined;
  const name = boundedText(raw, field, NAME_MAX);
  return name.problem === undefined ? name.value : { problem: name.problem };
}

/** A rename's body: each field optional, and one left out stays as it is. */
export interface TenantPatch {
  readonly name?: string;
  readonly slug?: string;
}

const PATCH_FIELDS = new Set(['name', 'slug']);

/** The body, or the response refusing it. */
export async function readTenantPatch(c: Context<AppEnv>): Promise<TenantPatch | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return answer(c, 'bad-input', 'Request body must be valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return answer(c, 'bad-input', 'Request body must be an object');
  }
  const b = body as Readonly<Record<string, unknown>>;
  const unknown = Object.keys(b).find((k) => !PATCH_FIELDS.has(k));
  if (unknown !== undefined) return answer(c, 'unknown-field', `Unknown field \`${unknown}\``);
  const name = tenantNameOf(b.name);
  if (typeof name === 'object') return answer(c, 'bad-input', name.problem);
  const slug = tenantSlugOf(b.slug);
  if (typeof slug === 'object') return answer(c, 'bad-input', slug.problem);
  return { ...(name !== undefined && { name }), ...(slug !== undefined && { slug }) };
}

/** `204` once renamed (or already so); otherwise why not. */
export function renameAnswer(
  c: Context<AppEnv>,
  outcome: RenameTenantOutcome,
  tenantId: TenantId,
  patch: TenantPatch,
): Response {
  const id = tenantId as unknown as string;
  switch (outcome.kind) {
    case 'ok':
      c.status(204);
      return c.body(null);
    case 'tenant-not-found':
      return answer(c, 'tenant-not-found', `No tenant with id "${id}".`, { tenantId: id });
    case 'tenant-closing':
      return answer(c, 'tenant-closing', `Tenant ${id} is closing, so it can't be renamed.`, {
        tenantId: id,
        state: 'closing',
      });
    case 'tenant-setup-pending':
      return answer(
        c,
        'tenant-setup-pending',
        `Tenant ${id}'s setup hasn't finished, so it can't be renamed yet. Sending the request that created it again finishes it.`,
        { tenantId: id },
      );
    case 'slug-taken':
      return answer(c, 'tenant-slug-taken', `Another tenant has the slug "${patch.slug}".`, {
        slug: patch.slug,
      });
    case 'slug-in-config':
      if (outcome.names === 'current') {
        const entries = outcome.domains.map((d) => `${d}:${outcome.slug}`).join(', ');
        return answer(
          c,
          'tenant-slug-in-config',
          `The server's KINDGI_AUTH_VERIFIED_DOMAINS names this tenant by its slug (${entries}), so its slug can't change yet: the server would find no tenant by it when it next starts. The server's operator names it there by its id (${id}) instead and restarts the server; then rename it.`,
          { slug: outcome.slug, domains: outcome.domains },
        );
      }
      return answer(
        c,
        'tenant-slug-in-config',
        `The server's KINDGI_AUTH_VERIFIED_DOMAINS names the slug "${patch.slug}", so no tenant can be renamed to it. Choose another.`,
        { slug: patch.slug },
      );
  }
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
