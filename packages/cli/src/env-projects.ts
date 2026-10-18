// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Which project each environment of a pack config is
 * (`environments.<name>.project`, an id or a slug), and the way back: which
 * environment a project is. `kindgi environments` and `kindgi deploy`'s
 * refusal into a later environment both name environments this way.
 */

import { projectOfEnv } from './commands/build.js';

/** A project id, as `kindgi deploy --project` tells one from a slug. */
export const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The fields of a project row these read from `GET /v1/projects`. */
export interface ListedProject {
  readonly id: string;
  readonly slug?: string;
  readonly name?: string;
  readonly orgId?: string;
}

export type Resolution =
  | { readonly kind: 'ok'; readonly id: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly matches: readonly ListedProject[] };

/**
 * A project id-or-slug against a listing: an id goes as it is; a slug is
 * matched, and a slug that names several projects (a slug is unique within an
 * org, so two orgs may share one) is ambiguous.
 */
export function resolveAgainst(rows: readonly ListedProject[], ref: string): Resolution {
  if (PROJECT_ID_RE.test(ref)) return { kind: 'ok', id: ref };
  const matches = rows.filter((r) => r.slug === ref);
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length > 1) return { kind: 'ambiguous', matches };
  const only = matches[0];
  return only === undefined ? { kind: 'none' } : { kind: 'ok', id: only.id };
}

/** Each environment of the pack config that names its project, in the config's order. */
export function envProjectRefs(
  config: { readonly environments?: unknown } | undefined,
): { readonly name: string; readonly ref: string }[] {
  const environments = config?.environments;
  if (environments === null || typeof environments !== 'object') return [];
  const named: { readonly name: string; readonly ref: string }[] = [];
  for (const name of Object.keys(environments as Record<string, unknown>)) {
    const ref = projectOfEnv(config, name);
    if (ref !== undefined) named.push({ name, ref });
  }
  return named;
}

/**
 * Which environment each project is, by project id. A slug that names no
 * project, or several, names none; when two environments name one project,
 * the first one names it.
 */
export function envNamesByProject(
  environments: readonly { readonly name: string; readonly ref: string }[],
  rows: readonly ListedProject[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const { name, ref } of environments) {
    const resolved = resolveAgainst(rows, ref);
    if (resolved.kind === 'ok' && !names.has(resolved.id)) names.set(resolved.id, name);
  }
  return names;
}
