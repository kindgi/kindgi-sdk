// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi projects`: find the project ids the `--project=<id>` flags take
 * (blocks, test sets and runs, corrector groups), make and
 * rename projects, and put a project in production. Mirrors the clients'
 * `projects.list`, `projects.getDefault`, `projects.get`,
 * `projects.create`, `projects.update` and `projects.setProduction`.
 */

import type { CommandContext } from '../context.js';
import { UsageError, extractKindgiError } from '../errors.js';
import { renderJson } from '../output.js';
import { SLUG, slugOf } from '../slug.js';
import {
  commandResultFromThrown,
  givenFlag,
  integerFlag,
  requiredPositional,
  runSdk,
  stringFlag,
} from './helpers.js';
import type { Command, CommandResult, LeafCommand } from './types.js';

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: "List the tenant's projects.",
  usage: 'kindgi projects list [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    limit: { type: 'string', description: 'The most projects to return.' },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'projects list', async () => {
      const limit = integerFlag(ctx, 'limit');
      const cursor = stringFlag(ctx, 'cursor');
      return await ctx.client().projects.list({
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor }),
      });
    }),
};

const getDefault: LeafCommand = {
  kind: 'leaf',
  name: 'get-default',
  description: "The tenant's default project, the one used when none is named.",
  usage: 'kindgi projects get-default',
  run: (ctx) =>
    runSdk(ctx, 'projects get-default', async () => await ctx.client().projects.getDefault()),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'One project, by id.',
  usage: 'kindgi projects get <project-id>',
  run: (ctx) =>
    runSdk(ctx, 'projects get', async () => {
      const id = requiredPositional(ctx, 0, 'project-id');
      return await ctx.client().projects.get(id);
    }),
};

/**
 * The project, as `projects get` prints it. The change went through before
 * this read, so a read that fails prints its id and says so, rather than
 * read as a change that failed (run again, it would meet its own slug).
 */
async function printProject(
  ctx: CommandContext,
  projectId: string,
  done: string,
): Promise<CommandResult> {
  try {
    const project = await ctx.client().projects.get(projectId);
    return { kind: 'ok', rendered: renderJson(project, ctx.globals.format) };
  } catch (err) {
    const why =
      extractKindgiError(err)?.message ?? (err instanceof Error ? err.message : String(err));
    return {
      kind: 'ok',
      rendered: {
        stdout: renderJson({ id: projectId }, ctx.globals.format).stdout,
        stderr: `${done}, but couldn't read it back: ${why}. \`kindgi projects get ${projectId}\` shows it.\n`,
      },
    };
  }
}

function checkSlug(slug: string): string {
  if (!SLUG.test(slug)) {
    throw new UsageError(
      `--slug=${slug}: lowercase letters, digits and hyphens, starting with a letter or digit, at most 63 characters`,
    );
  }
  return slug;
}

const create: LeafCommand = {
  kind: 'leaf',
  name: 'create',
  description:
    'Make a project. Prints it, with its id for the `--project=<id>` flags. For tenant admins.',
  usage:
    'kindgi projects create --name=<name> [--slug=<slug>] [--description=<text>] [--org=<org-id>]',
  optionSpec: {
    name: { type: 'string', description: 'What people see, e.g. `Support bot`. Required.' },
    slug: {
      type: 'string',
      description:
        "The project's short name, unique in its org (or among projects in none); `kindgi deploy --project <id|slug>` takes it. Defaults to the name as a slug: `Support bot` is `support-bot`.",
    },
    description: { type: 'string', description: 'What the project is for.' },
    org: { type: 'string', description: 'The org it belongs to, by id. Without it, none.' },
  },
  run: async (ctx) => {
    try {
      const name = givenFlag(ctx, 'name');
      if (name === undefined) throw new UsageError('--name=<name> is required');
      const given = givenFlag(ctx, 'slug');
      const slug = given !== undefined ? checkSlug(given) : slugOf(name);
      if (slug === '') {
        throw new UsageError(
          `"${name}" has no letters or digits to make a slug of: give --slug=<slug>`,
        );
      }
      const description = givenFlag(ctx, 'description');
      const orgId = givenFlag(ctx, 'org');
      const made = await ctx.client().projects.create({
        name,
        slug,
        ...(description !== undefined && { description }),
        ...(orgId !== undefined && { orgId }),
      });
      return await printProject(ctx, made.id, `Made project ${made.id}`);
    } catch (err) {
      return projectRefusal(err, ctx, 'kindgi projects create');
    }
  },
};

const rename: LeafCommand = {
  kind: 'leaf',
  name: 'rename',
  description:
    "Change a project's name, its slug, or both. Prints the project. `kindgi deploy --project <id|slug>` then takes the new slug, not the old one. For the project's admins (an admin of its org, or a tenant admin, is one).",
  usage: 'kindgi projects rename <project-id> [--name=<name>] [--slug=<slug>]',
  optionSpec: {
    name: { type: 'string', description: 'The new name.' },
    slug: {
      type: 'string',
      description: 'The new slug, unique in its org (or among projects in none).',
    },
  },
  run: async (ctx) => {
    try {
      const projectId = requiredPositional(ctx, 0, 'project-id');
      const name = givenFlag(ctx, 'name');
      const slug = givenFlag(ctx, 'slug');
      if (name === undefined && slug === undefined) {
        throw new UsageError('Give --name, --slug, or both');
      }
      if (slug !== undefined) checkSlug(slug);
      await ctx.client().projects.update(projectId, {
        ...(name !== undefined && { name }),
        ...(slug !== undefined && { slug }),
      });
      return await printProject(ctx, projectId, `Changed project ${projectId}`);
    } catch (err) {
      return projectRefusal(err, ctx, 'kindgi projects rename');
    }
  },
};

/** A project's production state, as `on`, `off` and `status` all print it. */
interface ProductionState {
  readonly projectId: string;
  readonly productionSince: string | null;
}

const PRODUCTION_ACTIONS = ['on', 'off', 'status'] as const;
type ProductionAction = (typeof PRODUCTION_ACTIONS)[number];

const production: LeafCommand = {
  kind: 'leaf',
  name: 'production',
  description:
    "Put a project in production (`on`), take it out (`off`), or say whether it's in production (`status`). A run in a project in production is a production run; a run anywhere else is staging. `on` and `off` are for tenant admins.",
  usage: 'kindgi projects production <project-id> <on|off|status>',
  run: async (ctx) => {
    try {
      const projectId = requiredPositional(ctx, 0, 'project-id');
      const action = productionAction(requiredPositional(ctx, 1, 'on|off|status'));
      const state = await productionState(ctx, projectId, action);
      return {
        kind: 'ok',
        rendered: ctx.globals.formatRequested
          ? renderJson(state, ctx.globals.format)
          : { stdout: `${productionText(state)}\n`, stderr: '' },
      };
    } catch (err) {
      return projectRefusal(err, ctx, 'kindgi projects production');
    }
  },
};

function productionAction(raw: string): ProductionAction {
  if ((PRODUCTION_ACTIONS as readonly string[]).includes(raw)) return raw as ProductionAction;
  throw new UsageError(`The second argument is on, off or status, not "${raw}".`);
}

/** `on` and `off` set it; `status` reads the project, whose `productionSince` is absent while it isn't in production. */
async function productionState(
  ctx: CommandContext,
  projectId: string,
  action: ProductionAction,
): Promise<ProductionState> {
  if (action === 'status') {
    const project = await ctx.client().projects.get(projectId);
    return { projectId: project.id, productionSince: project.productionSince ?? null };
  }
  const answer = await ctx.client().projects.setProduction(projectId, action === 'on');
  return { projectId: answer.projectId, productionSince: answer.productionSince };
}

function productionText(state: ProductionState): string {
  return state.productionSince === null
    ? `${state.projectId} isn't in production: its runs are staging runs.`
    : `${state.projectId} is in production, since ${state.productionSince}: its runs are production runs.`;
}

/**
 * The refusals named by the server's own code, since the client's families
 * would mislead: `production-not-allowed` and `permission-denied` (not a
 * tenant admin, or not the project's admin) are 403s, filed under `auth`,
 * and `production-not-allowed`'s message says what lets the tenant in
 * (`details.next`, when the runtime names it); `tenant-not-found`,
 * `project-not-found` and `org-not-found` are 404s, filed under
 * `not-found`. The 409s (`slug-conflict`, the slug taken in that org;
 * `project-default-already-exists`) need nothing here: a conflict's line
 * already names its reason.
 */
const PROJECT_REFUSALS = new Set([
  'production-not-allowed',
  'permission-denied',
  'tenant-not-found',
  'project-not-found',
  'org-not-found',
]);

function projectRefusal(err: unknown, ctx: CommandContext, commandLabel: string): CommandResult {
  const wire = extractKindgiError(err);
  const code = wire !== null && 'serverCode' in wire ? wire.serverCode : undefined;
  if (wire !== null && code !== undefined && PROJECT_REFUSALS.has(code)) {
    // As every refusal's line: with `--verbose`, the whole error (its requestId too).
    const detail = ctx.globals.verbose ? `\n${JSON.stringify(wire, null, 2)}` : '';
    return { kind: 'error', stderr: `Error [${code}]: ${wire.message}${detail}\n`, exitCode: 1 };
  }
  return commandResultFromThrown(err, ctx, commandLabel);
}

export const projectsCommand: Command = {
  kind: 'group',
  name: 'projects',
  description:
    'Find projects, for the commands that take `--project=<id>` (list / get-default / get), make and rename them (create / rename), and put one in production (production).',
  subcommands: [list, getDefault, get, create, rename, production],
};
