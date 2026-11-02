// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ReleaseGate, ReleaseGatePage } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { SCOPE_FLAGS, SCOPE_USAGE, scopeCell, scopeFrom } from './agents.js';
import {
  type TableSpec,
  integerFlag,
  readJsonInput,
  requiredPositional,
  runSdk,
  stringFlag,
} from './helpers.js';
import type { Command, LeafCommand } from './types.js';

/** `kindgi release-gates`: what an agent version must show before it is pinned. */

const TABLE: TableSpec<ReleaseGatePage, ReleaseGate> = {
  rows: (page) => page.data,
  columns: [
    { header: 'ID', get: (p) => p.id },
    { header: 'VERSION', get: (p) => p.version },
    { header: 'AGENT', get: (p) => p.agentId },
    { header: 'SCOPE', get: (p) => scopeCell(p.scope) },
    { header: 'UNREGISTERED', get: (p) => p.unregisteredAt ?? '' },
  ],
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: "List release gates (each one's latest active version), for an agent or a scope.",
  usage: `kindgi release-gates list [--agent=<agent-id>] [${SCOPE_USAGE}] [--include-retired] [--limit=<n>] [--cursor=<cursor>] [--table]`,
  optionSpec: {
    agent: { type: 'string', description: 'Only the release gates of this agent.' },
    ...SCOPE_FLAGS,
    'include-retired': {
      type: 'boolean',
      description:
        'Include retired release gates (every version unregistered), each as its highest version with `unregisteredAt`.',
    },
    limit: { type: 'string', description: 'Page size.' },
    cursor: { type: 'string', description: 'The next page, from `nextCursor`.' },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'release-gates list',
      async () => {
        const agentId = stringFlag(ctx, 'agent');
        const scope = scopeFrom(ctx, false);
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().releaseGates.list({
          ...(agentId !== undefined && { agentId }),
          ...(scope !== undefined && { scope }),
          ...(ctx.options['include-retired'] === true && { includeRetired: true }),
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor }),
        });
      },
      TABLE,
    ),
};

const show: LeafCommand = {
  kind: 'leaf',
  name: 'show',
  description: "Show a release gate's latest active version, or one version.",
  usage: 'kindgi release-gates show <release-gate-id> [<version>]',
  run: (ctx) =>
    runSdk(ctx, 'release-gates show', async () => {
      const id = requiredPositional(ctx, 0, 'release-gate-id');
      const version = ctx.positionals[1];
      return version === undefined
        ? await ctx.client().releaseGates.get(id)
        : await ctx.client().releaseGates.versions.get(id, version);
    }),
};

const versions: LeafCommand = {
  kind: 'leaf',
  name: 'versions',
  description: "List a release gate's versions, unregistered ones too.",
  usage: 'kindgi release-gates versions <release-gate-id> [--table]',
  run: (ctx) =>
    runSdk(
      ctx,
      'release-gates versions',
      async () =>
        await ctx
          .client()
          .releaseGates.versions.list(requiredPositional(ctx, 0, 'release-gate-id')),
      TABLE,
    ),
};

const publish: LeafCommand = {
  kind: 'leaf',
  name: 'publish',
  description:
    'Publish a release gate, or a new version of one: what pinning a version of the agent for the scope must show (the keys of the spec: comparison, evidence, metrics, replay, cases, approvals, onlyExpertGroups). Needs admin on the workspace.',
  usage: `kindgi release-gates publish <release-gate-id> --release-gate-version=<semver> --agent=<agent-id> ${SCOPE_USAGE} --spec='<json>'|@<file> [--description=<text>]`,
  optionSpec: {
    'release-gate-version': { type: 'string', description: 'The version to publish (semver).' },
    agent: { type: 'string', description: 'The agent the gate checks.' },
    ...SCOPE_FLAGS,
    spec: { type: 'string', description: 'The checks, as JSON, inline or `@<file>`.' },
    description: { type: 'string', description: 'What the gate is for.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'release-gates publish', async () => {
      const id = requiredPositional(ctx, 0, 'release-gate-id');
      const version = required(ctx, 'release-gate-version');
      const agentId = required(ctx, 'agent');
      const spec = await readJsonInput(required(ctx, 'spec'));
      const description = stringFlag(ctx, 'description');
      return await ctx.client().releaseGates.publish({
        id,
        version,
        agentId,
        scope: scopeFrom(ctx, true),
        spec: spec as ReleaseGate['spec'],
        ...(description !== undefined && { description }),
      });
    }),
};

const unregister: LeafCommand = {
  kind: 'leaf',
  name: 'unregister',
  description:
    "Unregister a release gate version: the gate's latest remaining active version applies, or the scope above's gate.",
  usage: 'kindgi release-gates unregister <release-gate-id> <version>',
  run: (ctx) =>
    runSdk(ctx, 'release-gates unregister', async () =>
      ctx
        .client()
        .releaseGates.versions.unregister(
          requiredPositional(ctx, 0, 'release-gate-id'),
          requiredPositional(ctx, 1, 'version'),
        ),
    ),
};

const reinstate: LeafCommand = {
  kind: 'leaf',
  name: 'reinstate',
  description: 'Reinstate an unregistered release gate version.',
  usage: 'kindgi release-gates reinstate <release-gate-id> <version>',
  run: (ctx) =>
    runSdk(ctx, 'release-gates reinstate', async () =>
      ctx
        .client()
        .releaseGates.versions.reinstate(
          requiredPositional(ctx, 0, 'release-gate-id'),
          requiredPositional(ctx, 1, 'version'),
        ),
    ),
};

function required(ctx: CommandContext, flag: string): string {
  const value = stringFlag(ctx, flag);
  if (value === undefined) throw new UsageError(`--${flag} is required`);
  return value;
}

export const releaseGatesCommand: Command = {
  kind: 'group',
  name: 'release-gates',
  description:
    'Release gates: what a request to pin a version of an agent must show before it is pinned for a scope (list / show / versions / publish / unregister / reinstate).',
  subcommands: [list, show, versions, publish, unregister, reinstate],
};
