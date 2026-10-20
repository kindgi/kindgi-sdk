// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi tenant`: your workspace, the tenant your key or session is in.
 * Read it, and rename it. Mirrors the clients' `tenant.get` and
 * `tenant.update`.
 */

import type { CommandContext } from '../context.js';
import { UsageError, extractKindgiError } from '../errors.js';
import { renderJson } from '../output.js';
import { TENANT_SLUG } from '../slug.js';
import { commandResultFromThrown, givenFlag, runSdk } from './helpers.js';
import type { Command, CommandResult, LeafCommand } from './types.js';

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description:
    'Your workspace: its id, name and slug, and what the runtime adds (whether it may put projects in production, its limits, its state).',
  usage: 'kindgi tenant get',
  run: (ctx) => runSdk(ctx, 'tenant get', async () => await ctx.client().tenant.get()),
};

const rename: LeafCommand = {
  kind: 'leaf',
  name: 'rename',
  description:
    "Change your workspace's name, its slug, or both. Prints it. Its id stays, so whatever names it by its id keeps working. The console's addresses carry the slug: after a new one, links with the old one stop opening it. Nothing in the CLI uses the slug. For tenant admins. Needs a runtime on Kindgi 0.1.10 or later.",
  usage: 'kindgi tenant rename [--name=<name>] [--slug=<slug>]',
  optionSpec: {
    name: { type: 'string', description: 'The new name, at most 100 characters.' },
    slug: {
      type: 'string',
      description:
        "The new slug: lowercase letters, digits and single hyphens, at most 63 characters, unique across workspaces. The console's addresses change with it.",
    },
  },
  run: async (ctx) => {
    try {
      const name = givenFlag(ctx, 'name');
      const slug = givenFlag(ctx, 'slug');
      if (name === undefined && slug === undefined) {
        throw new UsageError('Give --name, --slug, or both');
      }
      if (slug !== undefined && !TENANT_SLUG.test(slug)) {
        throw new UsageError(
          `--slug=${slug}: lowercase letters, digits and single hyphens, starting and ending with a letter or digit, at most 63 characters`,
        );
      }
      await ctx.client().tenant.update({
        ...(name !== undefined && { name }),
        ...(slug !== undefined && { slug }),
      });
      return await printTenant(ctx);
    } catch (err) {
      return tenantRefusal(err, ctx, 'kindgi tenant rename');
    }
  },
};

/**
 * The workspace, as `tenant get` prints it. The rename went through before
 * this read, so a read that fails says so, rather than read as a rename
 * that failed.
 */
async function printTenant(ctx: CommandContext): Promise<CommandResult> {
  try {
    const tenant = await ctx.client().tenant.get();
    return { kind: 'ok', rendered: renderJson(tenant, ctx.globals.format) };
  } catch (err) {
    const why =
      extractKindgiError(err)?.message ?? (err instanceof Error ? err.message : String(err));
    return {
      kind: 'ok',
      rendered: {
        stdout: '',
        stderr: `Renamed your workspace, but couldn't read it back: ${why}. \`kindgi tenant get\` shows it.\n`,
      },
    };
  }
}

/**
 * The refusals named by the server's own code, since the client's families
 * would mislead: `permission-denied` (not a tenant admin) is a 403, filed
 * under `auth`, and `tenant-not-found` a 404, filed under `not-found`. The
 * 409s (`tenant-slug-taken`, `tenant-slug-in-config`, `tenant-closing`,
 * `tenant-setup-pending`) need nothing here: a conflict's line already
 * names its reason.
 */
const TENANT_REFUSALS = new Set(['permission-denied', 'tenant-not-found']);

function tenantRefusal(err: unknown, ctx: CommandContext, commandLabel: string): CommandResult {
  const wire = extractKindgiError(err);
  const code = wire !== null && 'serverCode' in wire ? wire.serverCode : undefined;
  if (wire !== null && code !== undefined && TENANT_REFUSALS.has(code)) {
    // As every refusal's line: with `--verbose`, the whole error (its requestId too).
    const detail = ctx.globals.verbose ? `\n${JSON.stringify(wire, null, 2)}` : '';
    return { kind: 'error', stderr: `Error [${code}]: ${wire.message}${detail}\n`, exitCode: 1 };
  }
  return commandResultFromThrown(err, ctx, commandLabel);
}

export const tenantCommand: Command = {
  kind: 'group',
  name: 'tenant',
  description: 'Your workspace: read it (get) and rename it (rename).',
  subcommands: [get, rename],
};
