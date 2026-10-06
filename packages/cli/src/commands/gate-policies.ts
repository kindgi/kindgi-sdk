// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { GatePolicy, GatePolicyPage } from '@kindgi/client';

import type { CommandContext } from '../context.js';
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

/** `kindgi gate-policies`: what a promotion of an agent must show before a version goes live. */

const TABLE: TableSpec<GatePolicyPage, GatePolicy> = {
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
  description: "List gate policies (each one's latest active version), for an agent or a scope.",
  usage: `kindgi gate-policies list [--agent=<agent-id>] [${SCOPE_USAGE}] [--limit=<n>] [--cursor=<cursor>] [--table]`,
  optionSpec: {
    agent: { type: 'string', description: 'Only the policies gating this agent.' },
    ...SCOPE_FLAGS,
    limit: { type: 'string', description: 'Page size.' },
    cursor: { type: 'string', description: 'The next page, from `nextCursor`.' },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'gate-policies list',
      async () => {
        const agentId = stringFlag(ctx, 'agent');
        const scope = scopeFrom(ctx, false);
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().gatePolicies.list({
          ...(agentId !== undefined && { agentId }),
          ...(scope !== undefined && { scope }),
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
  description: "Show a gate policy's latest active version, or one version.",
  usage: 'kindgi gate-policies show <policy-id> [<version>]',
  run: (ctx) =>
    runSdk(ctx, 'gate-policies show', async () => {
      const id = requiredPositional(ctx, 0, 'policy-id');
      const version = ctx.positionals[1];
      return version === undefined
        ? await ctx.client().gatePolicies.get(id)
        : await ctx.client().gatePolicies.versions.get(id, version);
    }),
};

const versions: LeafCommand = {
  kind: 'leaf',
  name: 'versions',
  description: "List a gate policy's versions, unregistered ones too.",
  usage: 'kindgi gate-policies versions <policy-id> [--table]',
  run: (ctx) =>
    runSdk(
      ctx,
      'gate-policies versions',
      async () =>
        await ctx.client().gatePolicies.versions.list(requiredPositional(ctx, 0, 'policy-id')),
      TABLE,
    ),
};

const publish: LeafCommand = {
  kind: 'leaf',
  name: 'publish',
  description:
    'Publish a gate policy, or a new version of one: what a promotion of the agent for the scope must show (the spec: comparison, evidence, metrics, replay, approvals). Needs admin on the tenant.',
  usage: `kindgi gate-policies publish <policy-id> --policy-version=<semver> --agent=<agent-id> ${SCOPE_USAGE} --spec='<json>'|@<file> [--description=<text>]`,
  optionSpec: {
    'policy-version': { type: 'string', description: 'The version to publish (semver).' },
    agent: { type: 'string', description: 'The agent the policy gates.' },
    ...SCOPE_FLAGS,
    spec: { type: 'string', description: 'The checks, as JSON, inline or `@<file>`.' },
    description: { type: 'string', description: 'What the policy is for.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'gate-policies publish', async () => {
      const id = requiredPositional(ctx, 0, 'policy-id');
      const version = required(ctx, 'policy-version');
      const agentId = required(ctx, 'agent');
      const spec = await readJsonInput(required(ctx, 'spec'));
      const description = stringFlag(ctx, 'description');
      return await ctx.client().gatePolicies.publish({
        id,
        version,
        agentId,
        scope: scopeFrom(ctx, true),
        spec: spec as GatePolicy['spec'],
        ...(description !== undefined && { description }),
      });
    }),
};

const unregister: LeafCommand = {
  kind: 'leaf',
  name: 'unregister',
  description:
    "Unregister a gate policy version: the policy's latest remaining active version applies, or the scope above's policy.",
  usage: 'kindgi gate-policies unregister <policy-id> <version>',
  run: (ctx) =>
    runSdk(ctx, 'gate-policies unregister', async () =>
      ctx
        .client()
        .gatePolicies.versions.unregister(
          requiredPositional(ctx, 0, 'policy-id'),
          requiredPositional(ctx, 1, 'version'),
        ),
    ),
};

const reinstate: LeafCommand = {
  kind: 'leaf',
  name: 'reinstate',
  description: 'Reinstate an unregistered gate policy version.',
  usage: 'kindgi gate-policies reinstate <policy-id> <version>',
  run: (ctx) =>
    runSdk(ctx, 'gate-policies reinstate', async () =>
      ctx
        .client()
        .gatePolicies.versions.reinstate(
          requiredPositional(ctx, 0, 'policy-id'),
          requiredPositional(ctx, 1, 'version'),
        ),
    ),
};

function required(ctx: CommandContext, flag: string): string {
  const value = stringFlag(ctx, flag);
  if (value === undefined) throw new Error(`--${flag} is required`);
  return value;
}

export const gatePoliciesCommand: Command = {
  kind: 'group',
  name: 'gate-policies',
  description:
    'Gate policies: what a promotion of an agent must show before a version goes live for a scope (list / show / versions / publish / unregister / reinstate).',
  subcommands: [list, show, versions, publish, unregister, reinstate],
};
