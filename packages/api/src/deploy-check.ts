// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A deploy's check against what runs. A deploy ships each block at its
 * version in the pack's files, and its agents' new versions pin those.
 * When a newer version of a block runs now in a project of one of the
 * pack's agents (added there from a suggested change, or pinned by a
 * person), the deploy would put the older one back without anyone
 * choosing to. So the deploy stops, and says where the newer one runs,
 * unless the deploy names the block in `replace`.
 *
 * The rule doesn't depend on who deploys: every project of every pack
 * agent counts, the ones the caller can't read included. A place the
 * caller can't read is named by its version only.
 *
 * `POST /v1/deployments` runs it before anything is published,
 * `POST /v1/deployments/check` gives the same answer and writes nothing,
 * and a promotion that pins runs it against the target project's runs.
 */

import { highestVersion } from '@kindgi/tools';
import type { ProjectId, ScopeSegment, TenantId } from '@kindgi/types';

import type { AgentPinBindings, AgentPinnedVersion, PinActor } from './agent-pin-binding.js';
import type { BlockUseBinding } from './block-binding.js';
import type { LatestAnswer } from './latest-binding.js';
import { type WhatRunsInProject, whatRunsByProject } from './what-runs.js';

/** What the check reads. Without `agentPins` or `blockUse`, it's skipped. */
export interface DeployCheckDeps {
  /** The agents' pins and Latest, which say what runs in each project, and the pin changes, which say who pinned. */
  readonly agentPins?: CheckPins;
  /** The agent versions that pin each block, and the block version each pins. */
  readonly blockUse?: BlockUseBinding;
  /**
   * Every project an agent runs in, whoever asks: its own, then each one
   * a version of it can run in.
   */
  readonly projectsOf: (tenantId: TenantId, agentId: string) => Promise<readonly ProjectId[]>;
  /** Whether the caller reads the project. One it doesn't is named by the version only. */
  readonly canRead: (projectId: ProjectId) => Promise<boolean>;
  /** A person's display name, when the directory has one. */
  readonly displayName?: (userId: string) => Promise<string | undefined>;
  /** The pull request opened for a block version in a project, when one was. */
  readonly pullRequest?: (
    projectId: ProjectId,
    blockId: string,
    version: string,
  ) => Promise<{ readonly url: string } | undefined>;
}

export interface DeployCheckInput {
  readonly tenantId: TenantId;
  /** The pack's agents. */
  readonly agents: readonly string[];
  /** The pack's blocks, each at its version in the files. */
  readonly blocks: readonly { readonly id: string; readonly version: string }[];
  /** The blocks the deploy puts back on purpose. */
  readonly replace?: readonly ReplaceBlock[];
  /** Only this project's runs count: a promotion that pins compares against its target. */
  readonly inProject?: ProjectId;
}

/** Who made the newer version run there. */
export interface DeployCheckActor {
  readonly kind: PinActor['kind'];
  readonly id: string;
  /** A person's display name, when the directory has one. */
  readonly name?: string;
}

/** Where a newer version of a block runs now. */
export interface RunsNewer {
  readonly version: string;
  /** Absent for a project the caller can't read, and so is everything below. */
  readonly projectId?: ProjectId;
  readonly follows?: 'pin' | 'latest';
  /** The segment path, when a pin on a segment inside the project runs it. */
  readonly segment?: readonly ScopeSegment[];
  /** Who pinned it, or who added it as Latest. Absent when nothing records a person or a service. */
  readonly by?: DeployCheckActor;
  /** ISO-8601: when it was pinned, or became Latest there. */
  readonly at?: string;
}

/** A block the deploy would put back to an older version. */
export interface DeployCheckStop {
  readonly blockId: string;
  /** The version in the pack's files. */
  readonly inFiles: string;
  readonly runs: RunsNewer;
  /** The pull request opened for the newer version there, when one was. */
  readonly pr?: { readonly url: string };
}

/** A block the deploy names in `replace` that a newer version runs for. */
export interface ReplacedBlock {
  readonly blockId: string;
  /** The newest version that runs now. */
  readonly from: string;
  /** The version in the pack's files, which the deploy ships. */
  readonly to: string;
  readonly reason: string;
}

export type DeployCheck =
  /** The runtime doesn't read the agents' pins and Latest, or the blocks' uses: nothing is checked. */
  | { readonly kind: 'skipped' }
  | {
      readonly kind: 'checked';
      /** The blocks the deploy would put back, in the order of `blocks`. Empty: it can go. */
      readonly stops: readonly DeployCheckStop[];
      /** The blocks it puts back on purpose. */
      readonly replaced: readonly ReplacedBlock[];
      /** The blocks `replace` names that nothing newer runs for: nothing to replace. */
      readonly notNeeded: readonly string[];
    };

type CheckPins = Pick<AgentPinBindings, 'pinned' | 'latest' | 'changes'>;

/** One place a version of a block runs, before it's known who may read it. */
interface Running {
  readonly blockVersion: string;
  readonly projectId: ProjectId;
  readonly follows: 'pin' | 'latest';
  readonly segment?: readonly ScopeSegment[];
  readonly pin?: AgentPinnedVersion;
  readonly latest?: LatestAnswer;
}

/**
 * Checks the pack's blocks against what runs. For each block, the newest
 * version that runs in a project of a pack agent (the project's own
 * version, or a segment pin inside it), by the one version rule: a
 * prerelease is older than its release. When it's newer than the files',
 * the block stops the deploy, unless `replace` names it. Equal passes, a
 * newer one in the files passes, and a block that runs nowhere passes.
 */
export async function checkAgainstRuns(
  deps: DeployCheckDeps,
  input: DeployCheckInput,
): Promise<DeployCheck> {
  const { agentPins, blockUse } = deps;
  if (agentPins === undefined || blockUse === undefined) return { kind: 'skipped' };
  const { tenantId } = input;
  const agents = new Set(input.agents);
  const rowsOf = new Map<string, Awaited<ReturnType<typeof whatRunsByProject>>>();
  for (const agentId of agents) {
    const projects =
      input.inProject !== undefined ? [input.inProject] : await deps.projectsOf(tenantId, agentId);
    rowsOf.set(agentId, await whatRunsByProject(agentPins, { tenantId, agentId }, projects));
  }
  const replacing = new Map((input.replace ?? []).map((r) => [r.blockId, r.reason]));
  const stops: DeployCheckStop[] = [];
  const replaced: ReplacedBlock[] = [];
  for (const block of input.blocks) {
    const uses = await blockUse.pinningBlock({ tenantId, blockId: block.id });
    const running = runningVersions(rowsOf, uses);
    const newest = highestVersion([block.version, ...running.map((r) => r.blockVersion)]);
    if (newest === undefined || !isNewer(newest, block.version)) continue;
    const reason = replacing.get(block.id);
    if (reason !== undefined) {
      replaced.push({ blockId: block.id, from: newest, to: block.version, reason });
      continue;
    }
    const where = running.filter((r) => r.blockVersion === newest);
    stops.push(await stopFor({ ...deps, agentPins }, tenantId, block, newest, where));
  }
  const counted = new Set(replaced.map((r) => r.blockId));
  return {
    kind: 'checked',
    stops,
    replaced,
    notNeeded: [...replacing.keys()].filter((id) => !counted.has(id)),
  };
}

/**
 * `a` is newer than `b` by the one version rule. `highestVersion` keeps the
 * first of two that rank the same, so both orders must give `a`, and the
 * same version is never newer than itself.
 */
function isNewer(a: string, b: string): boolean {
  return a !== b && highestVersion([a, b]) === a && highestVersion([b, a]) === a;
}

/**
 * Each place a pack agent runs a version that pins the block: a project's
 * own version, or a segment pin inside it, with the block version it pins:
 * in the order of the pack's agents, then of their projects.
 */
function runningVersions(
  rowsOf: ReadonlyMap<string, Awaited<ReturnType<typeof whatRunsByProject>>>,
  uses: Awaited<ReturnType<BlockUseBinding['pinningBlock']>>,
): Running[] {
  const pins = new Map<string, Map<string, string>>();
  for (const use of uses) {
    const agentId = use.agentId as unknown as string;
    if (!rowsOf.has(agentId)) continue;
    const versions = pins.get(agentId) ?? new Map<string, string>();
    versions.set(use.version, use.blockVersion);
    pins.set(agentId, versions);
  }
  const out: Running[] = [];
  for (const [agentId, rows] of rowsOf) {
    const versions = pins.get(agentId);
    if (versions === undefined) continue;
    for (const row of rows) out.push(...rowRunning(row, versions));
  }
  return out;
}

/**
 * What one project runs that pins the block (`versions`: an agent version
 * to the block version it pins): its own version, then its segment pins.
 */
function rowRunning(
  { projectId, runs, pin, segments }: WhatRunsInProject,
  versions: ReadonlyMap<string, string>,
): Running[] {
  const out: Running[] = [];
  const blockVersion = runs === null ? undefined : versions.get(runs.version as unknown as string);
  if (runs !== null && blockVersion !== undefined) {
    out.push(
      runs.follows === 'pin'
        ? { blockVersion, projectId, follows: 'pin', ...(pin !== undefined && { pin }) }
        : { blockVersion, projectId, follows: 'latest', latest: runs },
    );
  }
  for (const s of segments) {
    const segmentBlockVersion = versions.get(s.version as unknown as string);
    if (segmentBlockVersion === undefined) continue;
    out.push({
      blockVersion: segmentBlockVersion,
      projectId,
      follows: 'pin',
      segment: s.path.map(({ key, value }) => ({ key, value })),
      pin: s.pin,
    });
  }
  return out;
}

/**
 * The stop for a block: the first place the newest version runs that the
 * caller reads, with who made it run there, when, and the pull request
 * opened for it. When the caller reads none of them, the version only.
 */
async function stopFor(
  deps: DeployCheckDeps & { readonly agentPins: CheckPins },
  tenantId: TenantId,
  block: { readonly id: string; readonly version: string },
  newest: string,
  where: readonly Running[],
): Promise<DeployCheckStop> {
  for (const r of where) {
    if (!(await deps.canRead(r.projectId))) continue;
    const [by, pr] = await Promise.all([
      actorOf(deps, tenantId, r),
      deps.pullRequest?.(r.projectId, block.id, newest),
    ]);
    const at = r.pin !== undefined ? (r.pin.setAt as unknown as string) : r.latest?.since;
    return {
      blockId: block.id,
      inFiles: block.version,
      runs: {
        version: newest,
        projectId: r.projectId,
        follows: r.follows,
        ...(r.segment !== undefined && { segment: r.segment }),
        ...(by !== undefined && { by }),
        ...(at !== undefined && { at }),
      },
      ...(pr !== undefined && { pr: { url: pr.url } }),
    };
  }
  return { blockId: block.id, inFiles: block.version, runs: { version: newest } };
}

/** Who pinned it (the pin change's requester), or who added it as Latest, with a person's name. */
async function actorOf(
  deps: Pick<DeployCheckDeps, 'displayName'> & { readonly agentPins: CheckPins },
  tenantId: TenantId,
  r: Running,
): Promise<DeployCheckActor | undefined> {
  const actor =
    r.pin !== undefined
      ? (await deps.agentPins.changes.get(tenantId, r.pin.changeId))?.requestedBy
      : r.latest?.by;
  if (actor === undefined) return undefined;
  if (actor.kind !== 'user') return { kind: actor.kind, id: actor.id };
  const name = await deps.displayName?.(actor.id);
  return {
    kind: actor.kind,
    id: actor.id,
    ...(name !== undefined && name.length > 0 && { name }),
  };
}

/** The most characters a `replace` entry's reason holds. */
export const REPLACE_REASON_MAX = 500;

/** A block a deploy puts back on purpose, as the body names it. */
export interface ReplaceBlock {
  readonly blockId: string;
  readonly reason: string;
}

/**
 * A body's `replace`: each entry `{ blockId, reason }`, a block named once,
 * a reason of 1 to {@link REPLACE_REASON_MAX} characters with no control
 * characters. `undefined` when the body has none; each problem is pushed
 * onto `issues`.
 */
export function parseReplace(
  raw: unknown,
  issues: { path: string; message: string }[],
): readonly ReplaceBlock[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    issues.push({ path: 'replace', message: 'replace must be a list of { blockId, reason }' });
    return undefined;
  }
  const out: ReplaceBlock[] = [];
  const named = new Set<string>();
  raw.forEach((entry: unknown, i) => {
    const path = `replace[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push({ path, message: `${path} must be { blockId, reason }` });
      return;
    }
    const { blockId, reason } = entry as Record<string, unknown>;
    if (typeof blockId !== 'string' || blockId.length === 0) {
      issues.push({ path: `${path}.blockId`, message: `${path}.blockId must be a block id` });
      return;
    }
    if (named.has(blockId)) {
      issues.push({ path: `${path}.blockId`, message: `replace names block ${blockId} twice` });
      return;
    }
    named.add(blockId);
    if (
      typeof reason !== 'string' ||
      reason.trim().length === 0 ||
      reason.length > REPLACE_REASON_MAX ||
      hasControlCharacter(reason)
    ) {
      issues.push({
        path: `${path}.reason`,
        message: `${path}.reason must say why, in 1 to ${REPLACE_REASON_MAX} characters with no control characters`,
      });
      return;
    }
    out.push({ blockId, reason });
  });
  return out;
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** The most agents, and the most blocks, one check names. */
export const CHECK_LIST_MAX = 500;

/** `POST /v1/deployments/check`'s body, parsed. */
export interface DeployCheckBody {
  /** The project the deploy goes into: admin there is the right it needs. Absent: admin on the tenant. */
  readonly projectId?: string;
  readonly agents: readonly string[];
  readonly blocks: readonly { readonly id: string; readonly version: string }[];
  readonly replace?: readonly ReplaceBlock[];
}

/**
 * `POST /v1/deployments/check`'s body: the pack's agents by id, its blocks
 * each `{ id, version }` (a block named once, a valid version), and
 * `replace` as a deploy's. Each problem is pushed onto `issues`.
 */
export function parseCheckBody(
  raw: unknown,
  issues: { path: string; message: string }[],
): DeployCheckBody | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ path: '', message: 'the body must be an object' });
    return undefined;
  }
  const b = raw as Record<string, unknown>;
  const before = issues.length;
  if (b.projectId !== undefined && (typeof b.projectId !== 'string' || b.projectId.length === 0)) {
    issues.push({ path: 'projectId', message: 'projectId must be a project id' });
  }
  const agents = Array.isArray(b.agents) ? b.agents : undefined;
  if (
    agents === undefined ||
    agents.length > CHECK_LIST_MAX ||
    agents.some((a) => typeof a !== 'string' || a.length === 0)
  ) {
    issues.push({
      path: 'agents',
      message: `agents must be a list of up to ${CHECK_LIST_MAX} agent ids`,
    });
  }
  const blocks: { id: string; version: string }[] = [];
  if (!Array.isArray(b.blocks) || b.blocks.length > CHECK_LIST_MAX) {
    issues.push({
      path: 'blocks',
      message: `blocks must be a list of up to ${CHECK_LIST_MAX} { id, version }`,
    });
  } else {
    const named = new Set<string>();
    b.blocks.forEach((entry: unknown, i) => {
      const block = parseCheckBlock(entry, `blocks[${i}]`, named, issues);
      if (block !== undefined) blocks.push(block);
    });
  }
  const replace = parseReplace(b.replace, issues);
  if (issues.length > before) return undefined;
  return {
    ...(typeof b.projectId === 'string' && { projectId: b.projectId }),
    agents: [...new Set(agents as string[])],
    blocks,
    ...(replace !== undefined && { replace }),
  };
}

/** One of the check body's `blocks`: `{ id, version }`, a block named once (`named`), a valid version. */
function parseCheckBlock(
  entry: unknown,
  path: string,
  named: Set<string>,
  issues: { path: string; message: string }[],
): { id: string; version: string } | undefined {
  const { id, version } =
    entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
  if (typeof id !== 'string' || id.length === 0) {
    issues.push({ path: `${path}.id`, message: `${path}.id must be a block id` });
    return undefined;
  }
  if (named.has(id)) {
    issues.push({ path: `${path}.id`, message: `blocks names block ${id} twice` });
    return undefined;
  }
  if (typeof version !== 'string' || highestVersion([version]) !== version) {
    issues.push({ path: `${path}.version`, message: `${path}.version must be a version` });
    return undefined;
  }
  named.add(id);
  return { id, version };
}
