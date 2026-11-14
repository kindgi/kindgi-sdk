// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a frozen tenant may still do: the rules `tenantStateGate`
 * (`tenant-state.ts`) checks, and the spec (`openapi/operations.ts`) reads to
 * say which writes can answer `503 tenant-state-unavailable`. It imports
 * nothing, so the spec's build stays free of middleware code.
 */

/** Methods that change nothing, and deletes: always allowed. */
export const ALWAYS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'DELETE']);

/**
 * `POST`s a frozen tenant may still make: reads that are posts, its signed
 * exports, signing in and out, and every way this API deletes, erases and
 * revokes (unregistering is its soft delete). Nothing here creates or
 * changes what the tenant runs. Matched for `POST` only: any other write to
 * these paths is refused.
 */
export const ALLOWED_POSTS: readonly RegExp[] = [
  // signing in and out; registering or changing a provider is a write
  /^\/v1\/auth\/(?:token-sign-in|refresh|logout)$/,
  // reads that are posts
  /^\/v1\/memory\/retrieve$/,
  // the signed exports a closing tenant takes away with it
  /^\/v1\/approvals\/[^/]+\/audit-bundle$/,
  /^\/v1\/provenance\/[^/]+\/export$/,
  /^\/v1\/compliance\/evidence\/export$/,
  // erasure, in every state before purge: the runtime processes the data, and
  // an erasure request can't wait on billing or a suspension
  /^\/v1\/memory\/erasures$/,
  /^\/v1\/memory\/erasures\/replay$/,
  /^\/v1\/memory\/erasures\/[^/]+\/resume$/,
  /^\/v1\/retention\/sweep(?:\/[^/]+)?$/,
  // deletes and revocations
  /\/unregister$/,
  /\/revoke$/,
  /\/revoke-sessions$/,
];

/** Whether a frozen tenant may still make this request (`method` upper case, as sent). */
export function frozenTenantMay(method: string, path: string): boolean {
  return ALWAYS.has(method) || (method === 'POST' && ALLOWED_POSTS.some((re) => re.test(path)));
}
