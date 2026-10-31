// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { KindgiApiError } from '@kindgi/client';
import type {
  AgentCollectionPage,
  AgentPinScope,
  AgentPinnedVersion,
  AgentPinnedVersionList,
  Pin,
  PinAnswer,
  PinPage,
} from '@kindgi/client';
import type { AgentId } from '@kindgi/types';

import type { AgentId } from '@kindgi/types';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { type OutputFormat, type Rendered, renderJson, successNote } from '../output.js';
import { type ProgressLines, progressLines } from '../progress-lines.js';
import { callWaitingOutRateLimits } from '../rate-limit-wait.js';
import {
  type ApprovalWaited,
  WAIT_FLAG,
  endedLine,
  stillOpenLine,
  unreadableLine,
  waitDeadline,
  waitFlag,
  waitForApproval,
  waitWords,
  waitingLine,
} from './approval-wait.js';
import {
  ANSWER_NO_EXIT_CODE,
  type TableSpec,
  givenFlag,
  integerFlag,
  projectIdFlag,
  readJsonInput,
  requiredPositional,
  runSdk,
  runSdkRendered,
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
    { header: 'UNREGISTERED', get: (a) => a.unregisteredAt ?? '' },
  ],
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List registered agents (the latest version of each).',
  usage: 'kindgi agents list [--name=<prefix>] [--include-retired] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    name: { type: 'string', description: 'Only agents whose id starts with this.' },
    'include-retired': {
      type: 'boolean',
      description:
        'Include retired agents (every version unregistered), each as its highest version with `unregisteredAt`.',
    },
    ...PAGE_FLAGS,
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'agents list',
      async () => {
        const name = stringFlag(ctx, 'name');
        return await ctx.client().agents.list({
          ...page(ctx),
          ...(name !== undefined && { name }),
          ...(ctx.options['include-retired'] === true && { includeRetired: true }),
        });
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
      if (specText === undefined) throw new UsageError('--spec=<json-or-@file> is required');
      const spec = (await readJsonInput(specText)) as AgentDefinitionSpec;
      const projectId = await projectIdFlag(ctx);
      const agentId = await callWaitingOutRateLimits(ctx, () =>
        ctx.client().agents.define(spec, { projectId }),
      );
      return { agentId };
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

const owner: LeafCommand = {
  kind: 'leaf',
  name: 'owner',
  description:
    "Show the agent's owner, or set it: the person its corrections go to when they need the owner.",
  usage: 'kindgi agents owner <agent-id> [--set=<user-id>]',
  optionSpec: {
    set: {
      type: 'string',
      description:
        'Make this person the owner, replacing the one before. Needs admin on the agent.',
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'agents owner', async () => {
      const agentId = requiredPositional(ctx, 0, 'agent-id');
      // `--set=$U` with U unset is a usage error, never a read of the owner.
      const userId = givenFlag(ctx, 'set');
      const agents = ctx.client().agents;
      if (userId !== undefined) return await agents.setOwner(agentId, userId);
      const agent = await agents.get(agentId as AgentId);
      return { agentId, ...(agent.owner !== undefined && { owner: agent.owner }) };
    }),
};

const versions: LeafCommand = {
  kind: 'leaf',
  name: 'versions',
  description: 'List the registered versions of an agent.',
  usage: 'kindgi agents versions <agent-id> [--include-unregistered] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    'include-unregistered': {
      type: 'boolean',
      description:
        "Include unregistered versions (each with `unregisteredAt`), a retired agent's too.",
    },
    ...PAGE_FLAGS,
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'agents versions',
      async () => {
        const agentId = requiredPositional(ctx, 0, 'agent-id') as never;
        return await ctx.client().agents.versions.list(agentId, {
          ...page(ctx),
          ...(ctx.options['include-unregistered'] === true && { includeTombstoned: true }),
        });
      },
      AGENTS_TABLE,
    ),
};

// ---------- pinned versions and the pin history ----------

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
export function scopeFrom(ctx: CommandContext, required: true): AgentPinScope;
export function scopeFrom(ctx: CommandContext, required: false): AgentPinScope | undefined;
export function scopeFrom(ctx: CommandContext, required: boolean): AgentPinScope | undefined {
  const tenant = ctx.options.tenant === true;
  const orgId = stringFlag(ctx, 'org');
  const projectId = stringFlag(ctx, 'project');
  const segments = segmentsFlag(ctx);
  const named = [tenant, orgId !== undefined, projectId !== undefined].filter(Boolean).length;
  if (named > 1) throw new UsageError('Give one of --tenant, --org or --project');
  if (segments.length > 0 && projectId === undefined)
    throw new UsageError('--segment needs --project');
  if (tenant) return { kind: 'tenant' };
  if (orgId !== undefined) return { kind: 'org', orgId };
  if (projectId !== undefined) {
    return segments.length > 0
      ? { kind: 'segment', projectId, path: [...segments] }
      : { kind: 'project', projectId };
  }
  if (required) throw new UsageError(`Name the scope: ${SCOPE_USAGE}`);
  return undefined;
}

/** A scope in a table cell: `tenant`, `org <id>`, `project <id>`, `project <id> company=acme/role=x`. */
export function scopeCell(scope: AgentPinScope): string {
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

const pinned: LeafCommand = {
  kind: 'leaf',
  name: 'pinned',
  description:
    'Show the version a run of this agent would use for a project and segment path, and why: a pinned version (with its scope) or the latest.',
  usage: 'kindgi agents pinned <agent-id> [--project=<project-id> [--segment=<key:value>]…]',
  optionSpec: {
    project: { type: 'string', description: "The run's project, by id." },
    segment: SEGMENT_FLAG,
  },
  run: (ctx) =>
    runSdk(ctx, 'agents pinned', async () => {
      const agentId = requiredPositional(ctx, 0, 'agent-id');
      const projectId = stringFlag(ctx, 'project');
      const segments = segmentsFlag(ctx);
      if (segments.length > 0 && projectId === undefined) {
        throw new UsageError('--segment needs --project');
      }
      return await ctx.client().agents.pinned.resolve(agentId, {
        ...(projectId !== undefined && { projectId }),
        ...(segments.length > 0 && { segments }),
      });
    }),
};

const PINNED_VERSIONS_TABLE: TableSpec<AgentPinnedVersionList, AgentPinnedVersion> = {
  rows: (p) => p.data,
  columns: [
    { header: 'SCOPE', get: (pin) => scopeCell(pin.scope) },
    { header: 'VERSION', get: (pin) => pin.version },
    { header: 'SET AT', get: (pin) => pin.setAt },
  ],
};

const pinnedVersions: LeafCommand = {
  kind: 'leaf',
  name: 'pinned-versions',
  description: 'List every scope with a version of this agent pinned.',
  usage: 'kindgi agents pinned-versions <agent-id>',
  run: (ctx) =>
    runSdk(
      ctx,
      'agents pinned-versions',
      async () => await ctx.client().agents.pinned.list(requiredPositional(ctx, 0, 'agent-id')),
      PINNED_VERSIONS_TABLE,
    ),
};

const pin: LeafCommand = {
  kind: 'leaf',
  name: 'pin',
  description:
    "Pin a version for a scope: its runs that don't name a version use it, from the next run. Open conversations keep their version. It prints the pin's answer: the pin under `pin`, the test runs that check it, and the corrections a reused run marked `fixed` or reopened. With a release gate for the scope, the run on the test cases named by --test-run is checked first: the pin's `status` is `pinned`, or `pending-approval` (a reviewer approves it); a refusal lists every check. A pin that would take a project that follows Latest off it is refused (`409 pin-stops-latest`) unless --stop-following-latest. `--check` asks what the release gate would say, changing nothing. Exits 3 when the answer is no: the gate refuses the version, or it waits for an approval (`--wait` waits for the decision).",
  usage: `kindgi agents pin <agent-id> <version> ${SCOPE_USAGE} [--test-run=<test-run-id>] [--reason=<text>] [--stop-following-latest] [--check] [--wait[=<duration>]]`,
  optionSpec: {
    ...SCOPE_FLAGS,
    'test-run': {
      type: 'string',
      description: 'The run on the test cases the release gate checks, kept on the record.',
    },
    'stop-following-latest': {
      type: 'boolean',
      description:
        'Pin even when it takes a project that follows Latest off it: that project then runs the pinned version, and no longer takes each new Latest. Without it, such a pin is refused (`409 pin-stops-latest`).',
    },
    check: {
      type: 'boolean',
      description:
        'What the release gate would say: would-pin, needs-approval or gate-failed. Changes nothing. Exits 3 unless it would pin.',
    },
    ...WAIT_FLAG,
    ...WRITE_FLAGS,
  },
  run: (ctx) => runSdkRendered(ctx, 'agents pin', () => pinAgent(ctx), gateFailed),
};

/** A release gate's refusal (`422 gate-failed`): the command's answer, not a failure. */
function gateFailed(err: unknown): boolean {
  if (!(err instanceof KindgiApiError)) return false;
  const e = err.error;
  return e.code === 'server' && e.serverCode === 'gate-failed';
}

async function pinAgent(ctx: CommandContext): Promise<Rendered & { readonly exitCode?: number }> {
  const agentId = requiredPositional(ctx, 0, 'agent-id');
  const version = requiredPositional(ctx, 1, 'version');
  const testRunId = stringFlag(ctx, 'test-run');
  const waitMs = waitFlag(ctx);
  const input = {
    version,
    scope: scopeFrom(ctx, true),
    ...reasonFlag(ctx),
    ...(testRunId !== undefined && { testRunId }),
    ...(ctx.options['stop-following-latest'] === true && { stopFollowingLatest: true }),
  };
  const format = ctx.globals.format;
  const pins = ctx.client().agents.pinned;
  if (ctx.options.check === true) {
    if (waitMs !== undefined) {
      throw new UsageError('--wait waits for a pin, and --check makes none: leave one out');
    }
    const check = await pins.check(agentId, input);
    return {
      ...renderJson(check, format),
      ...(check.outcome !== 'would-pin' && { exitCode: ANSWER_NO_EXIT_CODE }),
    };
  }
  const answer = await pins.pin(agentId, input, idempotency(ctx));
  const change = answer.pin;
  if (change.status !== 'pending-approval') return renderJson(answer, format);
  if (waitMs === undefined) {
    return {
      stdout: renderJson(answer, format).stdout,
      stderr: successNote(format, `${stillOpenLine(change)} \`--wait\` waits for the decision.\n`),
      exitCode: ANSWER_NO_EXIT_CODE,
    };
  }
  const out = progressLines(ctx.progress, format === 'quiet');
  out.line(waitingLine(change, waitMs));
  const waited = await waitForApproval(
    ctx,
    change,
    () => pins.getChange(agentId, change.id),
    waitDeadline(ctx, waitMs),
  );
  return waitedAnswer(answer, waited, waitMs, format, out);
}

/**
 * What `agents pin --wait` answers: the pin's answer with the pin as the
 * wait ended it, and how it ended. Its test runs started with the request.
 */
function waitedAnswer(
  answer: PinAnswer,
  waited: ApprovalWaited,
  waitMs: number,
  format: OutputFormat,
  out: ProgressLines,
): Rendered & { readonly exitCode?: number } {
  const stdout = renderJson({ ...answer, pin: waited.pin }, format).stdout;
  switch (waited.kind) {
    case 'stopped':
      out.line(`Stopped waiting. ${stillOpenLine(waited.pin)}`);
      return { stdout, stderr: out.kept(), exitCode: 130 };
    case 'still-waiting':
      out.problem(`Still waiting after ${waitWords(waitMs)}. ${stillOpenLine(waited.pin)}`);
      return { stdout, stderr: out.kept(), exitCode: ANSWER_NO_EXIT_CODE };
    case 'unreadable':
      out.problem(unreadableLine(waited.pin, waited.message));
      return { stdout, stderr: out.kept(), exitCode: 1 };
    case 'decided':
      if (waited.pin.status === 'pinned') return { stdout, stderr: out.kept() };
      out.problem(endedLine(waited.pin));
      return { stdout, stderr: out.kept(), exitCode: ANSWER_NO_EXIT_CODE };
  }
}

const releaseGate: LeafCommand = {
  kind: 'leaf',
  name: 'release-gate',
  description:
    'Show the release gate that pinning a version of this agent for a scope is checked against (the most specific scope with one), or null.',
  usage: `kindgi agents release-gate <agent-id> ${SCOPE_USAGE}`,
  optionSpec: SCOPE_FLAGS,
  run: (ctx) =>
    runSdk(ctx, 'agents release-gate', async () => {
      const agentId = requiredPositional(ctx, 0, 'agent-id');
      return await ctx.client().agents.releaseGate.resolve(agentId, scopeFrom(ctx, true));
    }),
};

const unpin: LeafCommand = {
  kind: 'leaf',
  name: 'unpin',
  description:
    "Remove a scope's own pin: its runs use the next scope up (or the latest when nothing is pinned).",
  usage: `kindgi agents unpin <agent-id> ${SCOPE_USAGE} [--reason=<text>]`,
  optionSpec: { ...SCOPE_FLAGS, ...WRITE_FLAGS },
  run: (ctx) =>
    runSdk(ctx, 'agents unpin', async () => {
      const agentId = requiredPositional(ctx, 0, 'agent-id');
      return await ctx
        .client()
        .agents.pinned.unpin(
          agentId,
          { scope: scopeFrom(ctx, true), ...reasonFlag(ctx) },
          idempotency(ctx),
        );
    }),
};

/**
 * Where a history row stands: a pin's `status`; a pin made before
 * gates (no status) took effect, and an unpin is immediate. A refused
 * or pending row changed nothing.
 */
function pinStatus(p: Pin): string {
  return p.status ?? (p.action === 'pin' ? 'pinned' : 'done');
}

const PIN_HISTORY_TABLE: TableSpec<PinPage, Pin> = {
  rows: (p) => p.data,
  columns: [
    { header: 'ID', get: (p) => p.id },
    { header: 'ACTION', get: (p) => p.action },
    { header: 'STATUS', get: pinStatus },
    { header: 'SCOPE', get: (p) => scopeCell(p.scope) },
    { header: 'FROM', get: (p) => p.fromVersion ?? '-' },
    { header: 'TO', get: (p) => p.toVersion ?? '-' },
    { header: 'BY', get: (p) => `${p.requestedBy.kind} ${p.requestedBy.id}` },
    { header: 'AT', get: (p) => p.createdAt },
  ],
};

const pinHistoryList: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description:
    "List an agent's pin history, newest first: requests to pin a version, and unpins; name a scope for only its history.",
  usage: `kindgi agents pin-history list <agent-id> [${SCOPE_USAGE}] [--limit=<n>] [--cursor=<c>]`,
  optionSpec: { ...SCOPE_FLAGS, ...PAGE_FLAGS },
  run: (ctx) =>
    runSdk(
      ctx,
      'agents pin-history list',
      async () => {
        const agentId = requiredPositional(ctx, 0, 'agent-id');
        const scope = scopeFrom(ctx, false);
        return await ctx.client().agents.pinned.history(agentId, {
          ...page(ctx),
          ...(scope !== undefined && { scope }),
        });
      },
      PIN_HISTORY_TABLE,
    ),
};

const pinHistoryGet: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: "Fetch one entry of an agent's pin history.",
  usage: 'kindgi agents pin-history get <agent-id> <change-id>',
  run: (ctx) =>
    runSdk(ctx, 'agents pin-history get', async () => {
      const agentId = requiredPositional(ctx, 0, 'agent-id');
      const changeId = requiredPositional(ctx, 1, 'change-id');
      return await ctx.client().agents.pinned.getChange(agentId, changeId);
    }),
};

const pinHistory: Command = {
  kind: 'group',
  name: 'pin-history',
  description: 'The history of what was pinned or unpinned.',
  subcommands: [pinHistoryList, pinHistoryGet],
};

export const agentsCommand: Command = {
  kind: 'group',
  name: 'agents',
  description: 'Manage agent registrations and which version runs where.',
  subcommands: [
    list,
    get,
    publish,
    unregister,
    owner,
    versions,
    pinned,
    pinnedVersions,
    pin,
    releaseGate,
    unpin,
    pinHistory,
  ],
};
