// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { basename, isAbsolute, resolve } from 'node:path';

import { findKindgiConfig } from '@kindgi/handler-runtime';

import type { CommandContext } from '../context.js';
import { envNamesByProject, envProjectRefs } from '../env-projects.js';
import { UsageError } from '../errors.js';
import { type Column, renderJson, renderTable } from '../output.js';
import { loadPackConfig } from '../pack-config.js';
import {
  PROJECT_ID_RE,
  type ProjectRef,
  listAllProjects,
  resolveProjectRefs,
} from '../project-ref.js';
import { environmentsOf } from '../value-target.js';
import { projectOfEnv } from './build.js';
import { commandResultFromThrown, runSdk, stringFlag } from './helpers.js';
import type { Command, CommandResult, LeafCommand } from './types.js';

/** The pack root the environment names are read from: `--path`, else the cwd. */
export function packDirOf(ctx: CommandContext): string {
  const raw = stringFlag(ctx, 'path') ?? '.';
  return isAbsolute(raw) ? raw : resolve(ctx.cwd, raw);
}

/**
 * The projects for `set`, in order: `--projects` wins (a comma list, for use
 * outside a pack), else the positional environment names, each resolved
 * through the pack config's `environments.<name>.project`.
 */
async function refsForSet(ctx: CommandContext): Promise<ProjectRef[]> {
  const projectsFlag = stringFlag(ctx, 'projects');
  if (projectsFlag !== undefined) {
    const refs = projectsFlag
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    if (refs.length === 0)
      throw new UsageError('--projects needs at least one project id or slug.');
    return refs.map((ref) => ({ ref, where: '--projects' }));
  }
  const names = ctx.positionals;
  if (names.length === 0) {
    throw new UsageError(
      'Name the environments in order, e.g. `kindgi environments set staging prod`, or pass --projects <id-or-slug,…> outside a pack.',
    );
  }
  const loaded = await loadPackConfig(ctx, packDirOf(ctx));
  if (loaded.kind === 'missing') {
    throw new UsageError(
      `No pack config here (${loaded.message}). Run this in a pack, or pass --projects <id-or-slug,…>.`,
    );
  }
  if (loaded.kind === 'invalid') {
    throw new UsageError(`Couldn't read the pack config: ${loaded.message}`);
  }
  const resolved = names.map((name) => ({ name, ref: projectOfEnv(loaded.config, name) }));
  const missing = resolved.find((r) => r.ref === undefined);
  if (missing !== undefined) {
    const configName = await packConfigName(packDirOf(ctx));
    throw new UsageError(
      `${configName} names no project for environment "${missing.name}". Add \`environments.${missing.name}.project\`, or pass --projects <id-or-slug,…>.`,
    );
  }
  return resolved.map((r) => ({ ref: r.ref as string, where: `environments.${r.name}.project` }));
}

/**
 * The pack's config file, named so a refusal points at the right one — a
 * TS pack's `kindgi.config.ts`, a Python pack's `pyproject.toml`, a JVM
 * pack's `kindgi.config.json`. A generic phrase when none is on disk (a
 * test's injected loader).
 */
async function packConfigName(packDir: string): Promise<string> {
  const found = await findKindgiConfig(packDir);
  return found === undefined ? 'your pack config' : `\`${basename(found.path)}\``;
}

/**
 * Which pack-config environment each ordered project is, for the `list`
 * table. Best-effort: resolution needs `GET /v1/projects`, so any failure
 * (no config, a slug that won't resolve, no read on projects) just leaves the
 * order unlabelled rather than failing the command.
 */
async function envNameLabels(ctx: CommandContext): Promise<Map<string, string>> {
  try {
    const loaded = await loadPackConfig(ctx, packDirOf(ctx));
    if (loaded.kind !== 'ok') return new Map();
    const named = envProjectRefs(environmentsOf(loaded.config));
    if (named.length === 0) return new Map();
    const needsList = named.some((n) => !PROJECT_ID_RE.test(n.ref));
    return envNamesByProject(named, needsList ? await listAllProjects(ctx) : []);
  } catch {
    // Labels are a convenience; the order still prints without them.
    return new Map();
  }
}

const ORDER_COLUMNS: readonly Column<{
  readonly position: string;
  readonly environment: string;
  readonly project: string;
}>[] = [
  { header: 'POSITION', get: (r) => r.position },
  { header: 'ENVIRONMENT', get: (r) => r.environment },
  { header: 'PROJECT', get: (r) => r.project },
];

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description:
    "Show the order projects go live through: each environment's name (from your pack config), project and position.",
  usage: 'kindgi environments list [--org=<org-id>] [--path=<dir>]',
  optionSpec: {
    org: { type: 'string', description: "An org's order instead of the tenant's, by org id." },
    path: {
      type: 'string',
      description: 'The pack root, to name the environments. Default: the current directory.',
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    const orgId = stringFlag(ctx, 'org');
    try {
      const order =
        orgId !== undefined
          ? await ctx.client().environmentOrders.getOrgOrder(orgId)
          : await ctx.client().environmentOrders.getTenantOrder();
      if (ctx.globals.format !== 'table') {
        return { kind: 'ok', rendered: renderJson(order, ctx.globals.format) };
      }
      const labels = await envNameLabels(ctx);
      const rows = order.entries.map((e) => ({
        position: String(e.position),
        environment: e.projectId !== undefined ? (labels.get(e.projectId) ?? '') : '',
        project: e.projectId ?? '(hidden)',
      }));
      return { kind: 'ok', rendered: renderTable(rows, ORDER_COLUMNS) };
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'environments list');
    }
  },
};

const set: LeafCommand = {
  kind: 'leaf',
  name: 'set',
  description:
    'Set the order projects go live through — staging before prod, say. Names the environments from your pack config, in order; `--projects` takes project ids or slugs instead. Replaces the whole order. Tenant admins only.',
  usage:
    'kindgi environments set <env> [<env> …] [--org=<org-id>] [--projects=<id-or-slug,…>] [--path=<dir>]',
  optionSpec: {
    org: { type: 'string', description: "An org's order instead of the tenant's, by org id." },
    projects: {
      type: 'string',
      description:
        'Project ids or slugs, comma-separated, in order — for use outside a pack, instead of environment names.',
    },
    path: { type: 'string', description: 'The pack root. Default: the current directory.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'environments set', async () => {
      const orgId = stringFlag(ctx, 'org');
      const projectIds = await resolveProjectRefs(ctx, await refsForSet(ctx));
      return orgId !== undefined
        ? await ctx.client().environmentOrders.setOrgOrder(orgId, { projectIds })
        : await ctx.client().environmentOrders.setTenantOrder({ projectIds });
    }),
};

const clear: LeafCommand = {
  kind: 'leaf',
  name: 'clear',
  description:
    'Clear the environment order; projects then take builds directly again. Tenant admins only.',
  usage: 'kindgi environments clear [--org=<org-id>]',
  optionSpec: {
    org: { type: 'string', description: "An org's order instead of the tenant's, by org id." },
  },
  run: (ctx) =>
    runSdk(ctx, 'environments clear', async () => {
      const orgId = stringFlag(ctx, 'org');
      return orgId !== undefined
        ? await ctx.client().environmentOrders.setOrgOrder(orgId, { projectIds: [] })
        : await ctx.client().environmentOrders.setTenantOrder({ projectIds: [] });
    }),
};

export const environmentsCommand: Command = {
  kind: 'group',
  name: 'environments',
  description: 'The order of your environments.',
  subcommands: [list, set, clear],
};
