// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A project named by id or slug, as `kindgi deploy --project` and a pack
 * config's `environments.<name>.project` name one, resolved to its id.
 */

import type { KindgiClient } from '@kindgi/client';

import type { CommandContext } from './context.js';
import { UsageError } from './errors.js';

/** A project id, as `kindgi deploy --project` tells one from a slug. */
export const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The fields of a project row read from `GET /v1/projects`. */
export interface ProjectRow {
  readonly id: string;
  readonly slug?: string;
  readonly name?: string;
  readonly orgId?: string;
}

/**
 * Every project of the tenant, following `nextCursor` to the last page.
 * `client`: the runtime to read them from; default, the CLI's own.
 */
export async function listAllProjects(
  ctx: CommandContext,
  client: KindgiClient = ctx.client(),
): Promise<ProjectRow[]> {
  const rows: ProjectRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await client.projects.list(cursor !== undefined ? { cursor } : {});
    rows.push(...((page.data ?? []) as readonly ProjectRow[]));
    if (page.hasMore !== true) break;
    const next = (page as { readonly nextCursor?: unknown }).nextCursor;
    if (typeof next !== 'string' || next === '') break;
    cursor = next;
  }
  return rows;
}

export type Resolution =
  | { readonly kind: 'ok'; readonly id: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly matches: readonly ProjectRow[] };

/**
 * A project id-or-slug against a listing: an id goes as it is; a slug is
 * matched, and a slug that names several projects (a slug is unique within an
 * org, so two orgs may share one) is ambiguous.
 */
export function resolveAgainst(rows: readonly ProjectRow[], ref: string): Resolution {
  if (PROJECT_ID_RE.test(ref)) return { kind: 'ok', id: ref };
  const matches = rows.filter((r) => r.slug === ref);
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length > 1) return { kind: 'ambiguous', matches };
  const only = matches[0];
  return only === undefined ? { kind: 'none' } : { kind: 'ok', id: only.id };
}

/**
 * Each id-or-slug as a project id, listing the projects only when one is a
 * slug. A slug that names none or several is refused (`UsageError`).
 * `client`: the runtime to read the projects from; default, the CLI's own.
 */
export async function resolveProjectRefs(
  ctx: CommandContext,
  refs: readonly string[],
  client?: KindgiClient,
): Promise<string[]> {
  const needsList = refs.some((r) => !PROJECT_ID_RE.test(r));
  const rows = needsList ? await listAllProjects(ctx, client) : [];
  return refs.map((ref) => idOf(rows, ref));
}

/** One id-or-slug as a project id, as `resolveProjectRefs` resolves each. */
export async function resolveProjectRef(ctx: CommandContext, ref: string): Promise<string> {
  return idOf(PROJECT_ID_RE.test(ref) ? [] : await listAllProjects(ctx), ref);
}

/** The id `ref` names in `rows`, or a `UsageError` for a slug that names none or several. */
function idOf(rows: readonly ProjectRow[], ref: string): string {
  const resolved = resolveAgainst(rows, ref);
  if (resolved.kind === 'none') {
    throw new UsageError(
      `No project of this workspace has the slug "${ref}". \`kindgi projects list\` shows them; pass a project id instead.`,
    );
  }
  if (resolved.kind === 'ambiguous') {
    const named = resolved.matches
      .map((m) => `${m.id} (${m.name ?? '?'}${m.orgId === undefined ? '' : `, org ${m.orgId}`})`)
      .join(', ');
    throw new UsageError(
      `"${ref}" is the slug of ${resolved.matches.length} projects, in different orgs: ${named}. Pass the project id instead.`,
    );
  }
  return resolved.id;
}
