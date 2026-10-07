// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  AgentCollectionPage,
  LivePin,
  LivePinList,
  LiveScope,
  Promotion,
  PromotionPage,
} from '@kindgi/client';

import type { AgentId } from '@kindgi/types';

import type { CommandContext } from '../context.js';
import {
  type TableSpec,
  integerFlag,
  listFlag,
  projectIdFlag,
  readJsonInput,
  requiredPositional,
  runSdk,
  segmentsFlag,
  stringFlag,
} from './helpers.js';
import type { Command, LeafCommand, ParseArgsOption } from './types.js';

// Re-declared locally to avoid pulling `@kindgi/agents` into the CLI's
// dep tree — the SDK re-exports the same shape when it fills the
// `agents.define` transport body.
type AgentDefinitionSpec = Parameters<import('@kindgi/client').KindgiClient['agents']['define']>[0];

type Agent = AgentCollectionPage['data'][number];

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

const AGENTS_TABLE: TableSpec<AgentCollectionPage, Agent> = {
  rows: (p) => p.data,
  columns: [
    { header: 'ID', get: (a) => a.id },
    { header: 'VERSION', get: (a) => a.version },
    { header: 'NAME', get: (a) => a.name },
  ],
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List registered agents (the latest version of each).',
  usage: 'kindgi agents list [--name=<prefix>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    name: { type: 'string', description: 'Only agents whose id starts with this.' },
    ...PAGE_FLAGS,
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'agents list',
      async () => {
        const name = stringFlag(ctx, 'name');
        return await ctx
          .client()
          .agents.list({ ...page(ctx), ...(name !== undefined && { name }) });
      },
      AGENTS_TABLE,
    ),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch a registered agent: its latest version, or the version given.',
  usage: 'kindgi agents get <agent-id> [<version>]',
  run: (ctx) =>
    runSdk(ctx, 'agents get', async () => {
      const agentId = requiredPositional(ctx, 0, 'agent-id') as never;
      const version = ctx.positionals[1];
      const agents = ctx.client().agents;
      return version === undefined
        ? await agents.get(agentId)
        : await agents.versions.get(agentId, version as never);
    }),
};

const publish: LeafCommand = {
  kind: 'leaf',
  name: 'publish',
  description: 'Register an agent definition.',
  usage: 'kindgi agents publish --spec=<json-or-@file> [--project=<project-id>]',
  optionSpec: {
    spec: {
      type: 'string',
      description: 'The agent definition as JSON, or `@<file>` to read it from a file. Required.',
    },
    project: {
      type: 'string',
      description:
        "The project to register the agent in, by id (default: the tenant's Default project).",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'agents publish', async () => {
      const specText = stringFlag(ctx, 'spec');
      if (specText === undefined) throw new Error('--spec=<json-or-@file> is required');
      const spec = (await readJsonInput(specText)) as AgentDefinitionSpec;
      const projectId = await projectIdFlag(ctx);
      const agentId = await ctx.client().agents.define(spec, { projectId });
      return { agentId };
    }),
};

/** `--prompt` / `--setting` values (`<block-id>=<version>`), as a pin map. */
function pinSwaps(values: readonly string[], flag: string): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const value of values) {
    const at = value.indexOf('=');
    if (at <= 0 || at === value.length - 1) {
      throw new Error(`--${flag} takes <block-id>=<version>, got '${value}'`);
    }
    pins[value.slice(0, at)] = value.slice(at + 1);
  }
  return pins;
}

const derive: LeafCommand = {
  kind: 'leaf',
  name: 'derive',
  description:
    'Publish a new agent version from a pinned one with some prompt or settings pins swapped (no code change).',
  usage:
    'kindgi agents derive <agent-id> --from=<semver> [--prompt=<block-id>=<version>]... [--setting=<block-id>=<version>]... [--label=<text>] [--project=<project-id>]',
  optionSpec: {
    from: {
      type: 'string',
      description: 'The agent version to derive from; it must be pinned. Required.',
    },
    prompt: {
      type: 'string',
      multiple: true,
      description:
        'Pin a prompt block the version already uses to this version (`<block-id>=<version>`). Repeat for several.',
    },
    setting: {
      type: 'string',
      multiple: true,
      description:
        'Pin a settings block the version already uses to this version (`<block-id>=<version>`). Repeat for several.',
    },
    label: { type: 'string', description: 'A short label for the new version.' },
    project: {
      type: 'string',
      description:
        "The agent's project, by id; only needed when the runtime doesn't record it on the version.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'agents derive', async () => {
      const agentId = requiredPositional(ctx, 0, 'agent-id');
      const from = stringFlag(ctx, 'from');
      if (from === undefined) throw new Error('--from=<semver> is required');
      const prompts = pinSwaps(listFlag(ctx, 'prompt'), 'prompt');
      const settings = pinSwaps(listFlag(ctx, 'setting'), 'setting');
      if (Object.keys(prompts).length + Object.keys(settings).length === 0) {
        throw new Error(
          'Name at least one pin to swap: --prompt=<id>=<version> or --setting=<id>=<version>',
        );
      }
      const label = stringFlag(ctx, 'label');
      const projectId = stringFlag(ctx, 'project');
      return await ctx.client().agents.versions.derive(agentId as AgentId, {
        from,
        pins: {
          ...(Object.keys(prompts).length > 0 && { prompts }),
          ...(Object.keys(settings).length > 0 && { settings }),
        },
        ...(label !== undefined && { label }),
        ...(projectId !== undefined && { projectId }),
      });
    }),
};

const unregister: LeafCommand = {
  kind: 'leaf',
  name: 'unregister',
  description: 'Unregister a specific agent version: runs stop using it.',
  usage: 'kindgi agents unregister <agent-id> <version>',
  run: (ctx) =>
    runSdk(ctx, 'agents unregister', async () => {
      const agentId = requiredPositional(ctx, 0, 'agent-id') as never;
      const version = requiredPositional(ctx, 1, 'version');
      return await ctx.client().agents.versions.unregister(agentId, version as never);
    }),
};

const versions: LeafCommand = {
  kind: 'leaf',
  name: 'versions',
  description: 'List the registered versions of an agent.',
  usage: 'kindgi agents versions <agent-id> [--limit=<n>] [--cursor=<c>]',
  optionSpec: PAGE_FLAGS,
  run: (ctx) =>
    runSdk(
      ctx,
      'agents versions',
      async () => {
        const agentId = requiredPositional(ctx, 0, 'agent-id') as never;
        return await ctx.client().agents.versions.list(agentId, page(ctx));
      },
      AGENTS_TABLE,
    ),
};

// ---------- live versions and promotions ----------

const SEGMENT_FLAG: ParseArgsOption = {
  type: 'string',
  multiple: true,
  description:
    'One step of the segment path, `key:value` (e.g. `company:acme`); repeat it in order, coarse to fine. Needs `--project`.',
};

/** The flags that name a scope: one of `--tenant`, `--org`, `--project` (with `--segment`s). */
export const SCOPE_FLAGS: Readonly<Record<string, ParseArgsOption>> = {
  tenant: { type: 'boolean', description: 'The whole tenant.' },
  org: { type: 'string', description: 'An org, by id.' },
  project: {
    type: 'string',
    description: 'A project, by id; with `--segment`, a segment in it.',
  },
  segment: SEGMENT_FLAG,
};

export const SCOPE_USAGE =
  '(--tenant | --org=<org-id> | --project=<project-id> [--segment=<key:value>]…)';

/** The scope the flags name. Writes need one; a history filter may name none. */
export function scopeFrom(ctx: CommandContext, required: true): LiveScope;
export function scopeFrom(ctx: CommandContext, required: false): LiveScope | undefined;
export function scopeFrom(ctx: CommandContext, required: boolean): LiveScope | undefined {
  const tenant = ctx.options.tenant === true;
  const orgId = stringFlag(ctx, 'org');
  const projectId = stringFlag(ctx, 'project');
  const segments = segmentsFlag(ctx);
  const named = [tenant, orgId !== undefined, projectId !== undefined].filter(Boolean).length;
  if (named > 1) throw new Error('Give one of --tenant, --org or --project');
  if (segments.length > 0 && projectId === undefined) throw new Error('--segment needs --project');
  if (tenant) return { kind: 'tenant' };
  if (orgId !== undefined) return { kind: 'org', orgId };
  if (projectId !== undefined) {
    return segments.length > 0
      ? { kind: 'segment', projectId, path: [...segments] }
      : { kind: 'project', projectId };
  }
  if (required) throw new Error(`Name the scope: ${SCOPE_USAGE}`);
  return undefined;
}

/** A scope in a table cell: `tenant`, `org <id>`, `project <id>`, `project <id> company=acme/role=x`. */
export function scopeCell(scope: LiveScope): string {
  switch (scope.kind) {
    case 'tenant':
      return 'tenant';
    case 'org':
      return `org ${scope.orgId}`;
    case 'project':
      return `project ${scope.projectId}`;
    case 'segment':
      return `project ${scope.projectId} ${scope.path.map((s) => `${s.key}=${s.value}`).join('/')}`;
  }
}

function reasonFlag(ctx: CommandContext): { reason?: string } {
  const reason = stringFlag(ctx, 'reason');
  return reason !== undefined ? { reason } : {};
}

function idempotency(ctx: CommandContext): { idempotencyKey?: string } {
  const key = stringFlag(ctx, 'idempotency-key');
  return key !== undefined ? { idempotencyKey: key } : {};
}

const WRITE_FLAGS: Readonly<Record<string, ParseArgsOption>> = {
  reason: { type: 'string', description: 'Why, kept on the record.' },
  'idempotency-key': {
    type: 'string',
    description: "A retry with the same key returns the first call's result.",
  },
};

const live: LeafCommand = {
  kind: 'leaf',
  name: 'live',
  description:
    'Show the version a run of this agent would use for a project and segment path, and why: a live version (with its scope) or the latest.',
  usage: 'kindgi agents live <agent-id> [--project=<project-id> [--segment=<key:value>]…]',
  optionSpec: {
    project: { type: 'string', description: "The run's project, by id." },
    segment: SEGMENT_FLAG,
  },
  run: (ctx) =>
    runSdk(ctx, 'agents live', async () => {
      const agentId = requiredPositional(ctx, 0, 'agent-id');
      const projectId = stringFlag(ctx, 'project');
      const segments = segmentsFlag(ctx);
      if (segments.length > 0 && projectId === undefined) {
        throw new Error('--segment needs --project');
      }
      return await ctx.client().agents.live.resolve(agentId, {
        ...(projectId !== undefined && { projectId }),
        ...(segments.length > 0 && { segments }),
      });
    }),
};

const LIVE_VERSIONS_TABLE: TableSpec<LivePinList, LivePin> = {
  rows: (p) => p.data,
  columns: [
    { header: 'SCOPE', get: (pin) => scopeCell(pin.scope) },
    { header: 'VERSION', get: (pin) => pin.version },
    { header: 'SET AT', get: (pin) => pin.setAt },
  ],
};

const liveVersions: LeafCommand = {
  kind: 'leaf',
  name: 'live-versions',
  description: 'List every scope with a live version of this agent pinned.',
  usage: 'kindgi agents live-versions <agent-id>',
  run: (ctx) =>
    runSdk(
      ctx,
      'agents live-versions',
      async () => await ctx.client().agents.live.list(requiredPositional(ctx, 0, 'agent-id')),
      LIVE_VERSIONS_TABLE,
    ),
};

const promote: LeafCommand = {
  kind: 'leaf',
  name: 'promote',
  description:
    "Make a version live for a scope: its runs that don't name a version use it, from the next run. Open conversations keep their version. With a gate policy for the scope, the comparison named by --eval-run is checked first: the answer's `status` is `promoted`, or `pending-approval` (a reviewer approves it); a refusal lists every check. `--check` asks what would happen, changing nothing.",
  usage: `kindgi agents promote <agent-id> <version> ${SCOPE_USAGE} [--eval-run=<eval-run-id>] [--reason=<text>] [--check]`,
  optionSpec: {
    ...SCOPE_FLAGS,
    'eval-run': {
      type: 'string',
      description: 'The comparison eval run the gate checks, kept on the record.',
    },
    check: {
      type: 'boolean',
      description:
        'What the gate would say: would-promote, needs-approval or gate-failed. Changes nothing.',
    },
    ...WRITE_FLAGS,
  },
  run: (ctx) =>
    runSdk(ctx, 'agents promote', async () => {
      const agentId = requiredPositional(ctx, 0, 'agent-id');
      const version = requiredPositional(ctx, 1, 'version');
      const evalRunId = stringFlag(ctx, 'eval-run');
      const input = {
        version,
        scope: scopeFrom(ctx, true),
        ...reasonFlag(ctx),
        ...(evalRunId !== undefined && { evalRunId }),
      };
      if (ctx.options.check === true) {
        return await ctx.client().agents.promotions.check(agentId, input);
      }
      return await ctx.client().agents.promotions.create(agentId, input, idempotency(ctx));
    }),
};

const gatePolicy: LeafCommand = {
  kind: 'leaf',
  name: 'gate-policy',
  description:
    'Show the gate policy a promotion of this agent for a scope is checked against (the most specific scope with one), or null.',
  usage: `kindgi agents gate-policy <agent-id> ${SCOPE_USAGE}`,
  optionSpec: SCOPE_FLAGS,
  run: (ctx) =>
    runSdk(ctx, 'agents gate-policy', async () => {
      const agentId = requiredPositional(ctx, 0, 'agent-id');
      return await ctx.client().agents.gatePolicy.resolve(agentId, scopeFrom(ctx, true));
    }),
};

const rollback: LeafCommand = {
  kind: 'leaf',
  name: 'rollback',
  description: 'Put a scope back on its previous live version, or on the version given.',
  usage: `kindgi agents rollback <agent-id> ${SCOPE_USAGE} [--to=<semver>] [--reason=<text>]`,
  optionSpec: {
    ...SCOPE_FLAGS,
    to: {
      type: 'string',
      description: 'An earlier version to go back to (default: the previous one).',
    },
    ...WRITE_FLAGS,
  },
  run: (ctx) =>
    runSdk(ctx, 'agents rollback', async () => {
      const agentId = requiredPositional(ctx, 0, 'agent-id');
      const toVersion = stringFlag(ctx, 'to');
      return await ctx.client().agents.live.rollback(
        agentId,
        {
          scope: scopeFrom(ctx, true),
          ...(toVersion !== undefined && { toVersion }),
          ...reasonFlag(ctx),
        },
        idempotency(ctx),
      );
    }),
};

const unpin: LeafCommand = {
  kind: 'leaf',
  name: 'unpin',
  description:
    "Remove a scope's own live version: its runs use the next scope up (or the latest when nothing is pinned).",
  usage: `kindgi agents unpin <agent-id> ${SCOPE_USAGE} [--reason=<text>]`,
  optionSpec: { ...SCOPE_FLAGS, ...WRITE_FLAGS },
  run: (ctx) =>
    runSdk(ctx, 'agents unpin', async () => {
      const agentId = requiredPositional(ctx, 0, 'agent-id');
      return await ctx
        .client()
        .agents.live.unpin(
          agentId,
          { scope: scopeFrom(ctx, true), ...reasonFlag(ctx) },
          idempotency(ctx),
        );
    }),
};

/**
 * Where a history row stands: a promotion's `status`; a promotion made
 * before gates (no status) went live, and a rollback or unpin is
 * immediate. A refused or pending row changed nothing live.
 */
function promotionStatus(p: Promotion): string {
  return p.status ?? (p.action === 'promote' ? 'promoted' : 'done');
}

const PROMOTIONS_TABLE: TableSpec<PromotionPage, Promotion> = {
  rows: (p) => p.data,
  columns: [
    { header: 'ID', get: (p) => p.id },
    { header: 'ACTION', get: (p) => p.action },
    { header: 'STATUS', get: promotionStatus },
    { header: 'SCOPE', get: (p) => scopeCell(p.scope) },
    { header: 'FROM', get: (p) => p.fromVersion ?? '-' },
    { header: 'TO', get: (p) => p.toVersion ?? '-' },
    { header: 'BY', get: (p) => `${p.requestedBy.kind} ${p.requestedBy.id}` },
    { header: 'AT', get: (p) => p.createdAt },
  ],
};

const promotionsList: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description:
    "List an agent's promotions, rollbacks and unpins, newest first; name a scope for only its history.",
  usage: `kindgi agents promotions list <agent-id> [${SCOPE_USAGE}] [--limit=<n>] [--cursor=<c>]`,
  optionSpec: { ...SCOPE_FLAGS, ...PAGE_FLAGS },
  run: (ctx) =>
    runSdk(
      ctx,
      'agents promotions list',
      async () => {
        const agentId = requiredPositional(ctx, 0, 'agent-id');
        const scope = scopeFrom(ctx, false);
        return await ctx.client().agents.promotions.list(agentId, {
          ...page(ctx),
          ...(scope !== undefined && { scope }),
        });
      },
      PROMOTIONS_TABLE,
    ),
};

const promotionsGet: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch one promotion of an agent.',
  usage: 'kindgi agents promotions get <agent-id> <promotion-id>',
  run: (ctx) =>
    runSdk(ctx, 'agents promotions get', async () => {
      const agentId = requiredPositional(ctx, 0, 'agent-id');
      const promotionId = requiredPositional(ctx, 1, 'promotion-id');
      return await ctx.client().agents.promotions.get(agentId, promotionId);
    }),
};

const promotions: Command = {
  kind: 'group',
  name: 'promotions',
  description: 'The history of what was made live, rolled back or unpinned.',
  subcommands: [promotionsList, promotionsGet],
};

export const agentsCommand: Command = {
  kind: 'group',
  name: 'agents',
  description: 'Manage agent registrations and which version runs where.',
  subcommands: [
    list,
    get,
    publish,
    derive,
    unregister,
    versions,
    live,
    liveVersions,
    promote,
    gatePolicy,
    rollback,
    unpin,
    promotions,
  ],
};
