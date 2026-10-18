// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Which project each environment of a pack config is
 * (`environments.<name>.project`, an id or a slug), and the way back: which
 * environment a project is. `kindgi environments` and `kindgi deploy`'s
 * refusal into a later environment both name environments this way.
 */

import { projectOfEnv } from './commands/build.js';
import { type ProjectRow, resolveAgainst } from './project-ref.js';

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
  rows: readonly ProjectRow[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const { name, ref } of environments) {
    const resolved = resolveAgainst(rows, ref);
    if (resolved.kind === 'ok' && !names.has(resolved.id)) names.set(resolved.id, name);
  }
  return names;
}
