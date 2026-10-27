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
  /** The slugs it had before it was renamed; absent from a runtime that doesn't keep them. */
  readonly formerSlugs?: readonly string[];
}

/** A project id-or-slug, and where it was named (`--project`, `environments.<name>.project`). */
export interface ProjectRef {
  readonly ref: string;
  readonly where: string;
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
  /** No project has the slug, and `project` had it before it was renamed. */
  | { readonly kind: 'renamed'; readonly project: ProjectRow }
  /** Several: the projects with the slug (`matches`) and those that had it (`renamed`). */
  | {
      readonly kind: 'ambiguous';
      readonly matches: readonly ProjectRow[];
      readonly renamed: readonly ProjectRow[];
    };

/**
 * A project id-or-slug against a listing: an id goes as it is; a slug is
 * matched against each project's slug and the slugs it had before it was
 * renamed. A slug only a renamed project had is `renamed`: an old slug
 * never names the project, so a command that names one is refused with the
 * new one. A slug of several projects (a slug is unique within an org, so
 * two orgs may share one, or one may have had it before another was
 * renamed from it) is ambiguous.
 */
export function resolveAgainst(rows: readonly ProjectRow[], ref: string): Resolution {
  if (PROJECT_ID_RE.test(ref)) return { kind: 'ok', id: ref };
  const matches = rows.filter((r) => r.slug === ref);
  const renamed = rows.filter((r) => r.slug !== ref && r.formerSlugs?.includes(ref) === true);
  const [only] = matches;
  const [was] = renamed;
  if (only !== undefined && matches.length === 1 && renamed.length === 0) {
    return { kind: 'ok', id: only.id };
  }
  if (only === undefined && was === undefined) return { kind: 'none' };
  if (only === undefined && was !== undefined && renamed.length === 1) {
    return { kind: 'renamed', project: was };
  }
  return { kind: 'ambiguous', matches, renamed };
}

/** A project as a refusal names it: its id, then its name and org. */
function described(p: ProjectRow): string {
  return `${p.id} (${p.name ?? '?'}${p.orgId === undefined ? '' : `, org ${p.orgId}`})`;
}

/** The refusal for `ref`, a slug only `project` had, before it was renamed; named at `where`. */
export function renamedRefusal(ref: string, project: ProjectRow, where: string): string {
  const now = project.slug ?? project.id;
  return `"${ref}" was the slug of project ${described(project)} until it was renamed to "${now}". Change ${where} to "${now}" or to the project's id.`;
}

/** The refusal for `ref`, a slug of several projects, now or before a rename. */
export function ambiguousRefusal(
  ref: string,
  matches: readonly ProjectRow[],
  renamed: readonly ProjectRow[],
): string {
  const [only] = matches;
  const parts: string[] = [];
  if (only !== undefined) {
    parts.push(
      matches.length === 1
        ? `is the slug of project ${described(only)}`
        : `is the slug of ${matches.length} projects, in different orgs: ${matches.map(described).join(', ')}`,
    );
  }
  if (renamed.length > 0) {
    const each = renamed.map(
      (p) => `project ${described(p)} until it was renamed to "${p.slug ?? p.id}"`,
    );
    parts.push(`was the slug of ${each.join(', and of ')}`);
  }
  return `"${ref}" ${parts.join(' and ')}. Pass the project id instead.`;
}

/**
 * Each id-or-slug as a project id, listing the projects only when one is a
 * slug. A slug that names none, a renamed project's old slug, or a slug of
 * several is refused (`UsageError`); a renamed one's refusal names `where`.
 * `client`: the runtime to read the projects from; default, the CLI's own.
 */
export async function resolveProjectRefs(
  ctx: CommandContext,
  refs: readonly ProjectRef[],
  client?: KindgiClient,
): Promise<string[]> {
  const needsList = refs.some((r) => !PROJECT_ID_RE.test(r.ref));
  const rows = needsList ? await listAllProjects(ctx, client) : [];
  return refs.map(({ ref, where }) => idOf(rows, ref, where));
}

/** One id-or-slug, named at `where`, as a project id, as `resolveProjectRefs` resolves each. */
export async function resolveProjectRef(
  ctx: CommandContext,
  ref: string,
  where: string,
): Promise<string> {
  return idOf(PROJECT_ID_RE.test(ref) ? [] : await listAllProjects(ctx), ref, where);
}

/** The id `ref` names in `rows`, or a `UsageError` for a slug that names none, an old one, or several. */
function idOf(rows: readonly ProjectRow[], ref: string, where: string): string {
  const resolved = resolveAgainst(rows, ref);
  switch (resolved.kind) {
    case 'ok':
      return resolved.id;
    case 'none':
      throw new UsageError(
        `No project of this tenant has the slug "${ref}". \`kindgi projects list\` shows them; pass a project id instead.`,
      );
    case 'renamed':
      throw new UsageError(renamedRefusal(ref, resolved.project, where));
    case 'ambiguous':
      throw new UsageError(ambiguousRefusal(ref, resolved.matches, resolved.renamed));
  }
}
