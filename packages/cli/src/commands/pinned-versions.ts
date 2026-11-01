// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  PinScope,
  PinnedVersion,
  PinnedVersionChange,
  PinnedVersionChangePage,
  PinnedVersionList,
} from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { scopeCell } from './agents.js';
import { type TableSpec, integerFlag, requiredPositional, runSdk, stringFlag } from './helpers.js';
import type { Command, LeafCommand, ParseArgsOption } from './types.js';

/**
 * The pinned versions of a flow or a tool: `kindgi flows` and `kindgi
 * tools` each get `pinned`, `pinned-versions`, `pin`, `unpin` and
 * `pin-history list`. They mirror the agents' commands, without segments
 * (flows and tools pin per project, org or tenant) and without a release
 * gate.
 */
export type PinnedGroup = 'flows' | 'tools';

/** The words that differ between the two groups. */
const WORDS: Readonly<
  Record<
    PinnedGroup,
    {
      readonly noun: string;
      readonly pinned: string;
      readonly pin: string;
      readonly unpin: string;
    }
  >
> = {
  flows: {
    noun: 'flow',
    pinned:
      'Show the version of this flow that a run naming none would use in a project (or an org, or with neither the workspace), and why: a pinned version (with its scope) or the latest.',
    pin: "Pin a version of this flow for a scope, or move the scope's pin to it: its runs that name no version use it, from the next run. Pinning the version already pinned there changes nothing. A workspace- or org-wide pin of a flow in an environment order is refused (`409 pin-scope-spans-environments`): pin it per project.",
    unpin:
      "Remove a scope's own pin of this flow: its runs use the next scope up's pin, or the latest when nothing is pinned.",
  },
  tools: {
    noun: 'tool',
    pinned:
      'Show the version of this tool that the next flow version made in a project (or an org, or with neither the workspace) would lock, and why: a pinned version (with its scope) or the latest. An agent version locks a pinned version only when its range allows it.',
    pin: "Pin a version of this tool for a scope, or move the scope's pin to it: the flow versions made there next lock it, and the agent versions too when their range allows it; versions already made keep theirs. Pinning the version already pinned there changes nothing. Refused: a catalog tool or one the runtime ships (`400 tool-not-pinnable`: reference it with a range); a project that's a later environment of an order (`409 environment-takes-promotions`: pin it in the order's first environment); a workspace- or org-wide pin of a tool in an environment order (`409 pin-scope-spans-environments`).",
    unpin:
      "Remove a scope's own pin of this tool: the agent and flow versions made there next lock the next scope up's pin, or the latest when nothing is pinned.",
  },
};

/** The flags that name a scope: one of `--tenant`, `--org`, `--project`. */
const SCOPE_FLAGS: Readonly<Record<string, ParseArgsOption>> = {
  tenant: { type: 'boolean', description: 'The whole workspace (scope `tenant`).' },
  org: { type: 'string', description: 'An org, by id.' },
  project: { type: 'string', description: 'A project, by id.' },
};

const SCOPE_USAGE = '(--tenant | --org=<org-id> | --project=<project-id>)';

/** The scope the flags name; a write needs one. */
function scopeFrom(ctx: CommandContext): PinScope {
  const tenant = ctx.options.tenant === true;
  const orgId = stringFlag(ctx, 'org');
  const projectId = stringFlag(ctx, 'project');
  const named = [tenant, orgId !== undefined, projectId !== undefined].filter(Boolean).length;
  if (named > 1) throw new UsageError('Give one of --tenant, --org or --project');
  if (tenant) return { kind: 'tenant' };
  if (orgId !== undefined) return { kind: 'org', orgId };
  if (projectId !== undefined) return { kind: 'project', projectId };
  throw new UsageError(`Name the scope: ${SCOPE_USAGE}`);
}

const WRITE_FLAGS: Readonly<Record<string, ParseArgsOption>> = {
  reason: { type: 'string', description: 'Why, kept on the record.' },
  'idempotency-key': {
    type: 'string',
    description: "A retry with the same key returns the first call's result.",
  },
};

function reasonFlag(ctx: CommandContext): { reason?: string } {
  const reason = stringFlag(ctx, 'reason');
  return reason !== undefined ? { reason } : {};
}

function idempotency(ctx: CommandContext): { idempotencyKey?: string } {
  const key = stringFlag(ctx, 'idempotency-key');
  return key !== undefined ? { idempotencyKey: key } : {};
}

const PAGE_FLAGS: Readonly<Record<string, ParseArgsOption>> = {
  limit: { type: 'string', description: 'The most to return (default 25, at most 100).' },
  cursor: {
    type: 'string',
    description: "Resume after this cursor, from the previous page's `nextCursor`.",
  },
};

function page(ctx: CommandContext): { limit?: number; cursor?: string } {
  const limit = integerFlag(ctx, 'limit');
  const cursor = stringFlag(ctx, 'cursor');
  return {
    ...(limit !== undefined && { limit }),
    ...(cursor !== undefined && { cursor }),
  };
}

const actorCell = (actor: { kind: string; id: string }): string => `${actor.kind} ${actor.id}`;

const PINNED_VERSIONS_TABLE: TableSpec<PinnedVersionList, PinnedVersion> = {
  rows: (p) => p.data,
  columns: [
    { header: 'SCOPE', get: (pin) => scopeCell(pin.scope) },
    { header: 'VERSION', get: (pin) => pin.version },
    { header: 'SET AT', get: (pin) => pin.setAt },
    { header: 'SET BY', get: (pin) => actorCell(pin.setBy) },
  ],
};

const PIN_HISTORY_TABLE: TableSpec<PinnedVersionChangePage, PinnedVersionChange> = {
  rows: (p) => p.data,
  columns: [
    { header: 'ID', get: (p) => p.id },
    { header: 'ACTION', get: (p) => p.action },
    { header: 'SCOPE', get: (p) => scopeCell(p.scope) },
    { header: 'FROM', get: (p) => p.fromVersion ?? '-' },
    { header: 'TO', get: (p) => p.toVersion ?? '-' },
    { header: 'BY', get: (p) => actorCell(p.requestedBy) },
    { header: 'AT', get: (p) => p.createdAt },
  ],
};

/** `kindgi <group> pinned`, `pinned-versions`, `pin`, `unpin` and `pin-history list`. */
export function pinnedVersionCommands(group: PinnedGroup): readonly Command[] {
  const { noun, ...words } = WORDS[group];
  const idLabel = `${noun}-id`;
  const pins = (ctx: CommandContext) => ctx.client()[group].pinned;

  const pinned: LeafCommand = {
    kind: 'leaf',
    name: 'pinned',
    description: words.pinned,
    usage: `kindgi ${group} pinned <${idLabel}> [--project=<project-id> | --org=<org-id>]`,
    optionSpec: {
      project: {
        type: 'string',
        description: "A project, by id: its pin, else its org's, else the workspace's.",
      },
      org: { type: 'string', description: "An org, by id: its pin, else the workspace's." },
    },
    run: (ctx) =>
      runSdk(ctx, `${group} pinned`, async () => {
        const id = requiredPositional(ctx, 0, idLabel);
        const projectId = stringFlag(ctx, 'project');
        const orgId = stringFlag(ctx, 'org');
        // A given org stands in for the project's own, which no run there does.
        if (projectId !== undefined && orgId !== undefined) {
          throw new UsageError('Give --project or --org, not both');
        }
        return await pins(ctx).resolve(id, {
          ...(projectId !== undefined && { projectId }),
          ...(orgId !== undefined && { orgId }),
        });
      }),
  };

  const pinnedVersions: LeafCommand = {
    kind: 'leaf',
    name: 'pinned-versions',
    description: `List every scope with a version of this ${noun} pinned.`,
    usage: `kindgi ${group} pinned-versions <${idLabel}>`,
    run: (ctx) =>
      runSdk(
        ctx,
        `${group} pinned-versions`,
        async () => await pins(ctx).list(requiredPositional(ctx, 0, idLabel)),
        PINNED_VERSIONS_TABLE,
      ),
  };

  const pin: LeafCommand = {
    kind: 'leaf',
    name: 'pin',
    description: words.pin,
    usage: `kindgi ${group} pin <${idLabel}> <version> ${SCOPE_USAGE} [--reason=<text>]`,
    optionSpec: { ...SCOPE_FLAGS, ...WRITE_FLAGS },
    run: (ctx) =>
      runSdk(ctx, `${group} pin`, async () => {
        const id = requiredPositional(ctx, 0, idLabel);
        const version = requiredPositional(ctx, 1, 'version');
        return await pins(ctx).pin(
          id,
          { version, scope: scopeFrom(ctx), ...reasonFlag(ctx) },
          idempotency(ctx),
        );
      }),
  };

  const unpin: LeafCommand = {
    kind: 'leaf',
    name: 'unpin',
    description: words.unpin,
    usage: `kindgi ${group} unpin <${idLabel}> ${SCOPE_USAGE} [--reason=<text>]`,
    optionSpec: { ...SCOPE_FLAGS, ...WRITE_FLAGS },
    run: (ctx) =>
      runSdk(ctx, `${group} unpin`, async () => {
        const id = requiredPositional(ctx, 0, idLabel);
        return await pins(ctx).unpin(
          id,
          { scope: scopeFrom(ctx), ...reasonFlag(ctx) },
          idempotency(ctx),
        );
      }),
  };

  const pinHistoryList: LeafCommand = {
    kind: 'leaf',
    name: 'list',
    description: `List this ${noun}'s pin history, newest first: every pin and unpin.`,
    usage: `kindgi ${group} pin-history list <${idLabel}> [--limit=<n>] [--cursor=<c>]`,
    optionSpec: PAGE_FLAGS,
    run: (ctx) =>
      runSdk(
        ctx,
        `${group} pin-history list`,
        async () => await pins(ctx).history(requiredPositional(ctx, 0, idLabel), page(ctx)),
        PIN_HISTORY_TABLE,
      ),
  };

  const pinHistory: Command = {
    kind: 'group',
    name: 'pin-history',
    description: 'The history of what was pinned or unpinned.',
    subcommands: [pinHistoryList],
  };

  return [pinned, pinnedVersions, pin, unpin, pinHistory];
}
