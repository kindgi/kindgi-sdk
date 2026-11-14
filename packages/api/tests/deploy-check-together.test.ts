// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `checkAgainstRuns` reads the pack's agents two at a time, then its
 * blocks two at a time. The answer keeps the agents' and the blocks' order
 * whichever read ends first, and a failure answers as reading them one
 * after another does. Each agent runs 1.0.0 as Latest in its own project,
 * and agent 1's 1.0.0 pins each block at 2.0.0 (agent 2's too, where a
 * case says so), newer than the files' 1.0.0. So every block stops unless
 * `replace` names it. An agent's projects and a block's uses wait a
 * moment, so reads that run together overlap.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AgentId, ProjectId, Semver, TenantId } from '@kindgi/types';

import {
  type BlockUse,
  type DeployCheckDeps,
  type DeployCheckStop,
  type ReplaceBlock,
  checkAgainstRuns,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const FIVE = [1, 2, 3, 4, 5];
const PROJECTS = FIVE.map(() => randomUUID() as ProjectId);

/** The nth agent, from 1, and the project it runs in. */
const agent = (n: number) => `acme.agent-${n}`;
const project = (n: number) => PROJECTS[n - 1] as ProjectId;
const projectOf = (agentId: string) => project(Number(agentId.slice('acme.agent-'.length)));

/** How a held read goes. */
interface Hold {
  /** How long it takes, in ms; 1 when absent. */
  readonly ms?: number;
  /** What it fails with, after `ms`. */
  readonly fails?: Error;
}

/** Held reads: the ids started, in order, and how many ran at once (now, and at the most). */
function held(holds: Readonly<Record<string, Hold>>) {
  const reads = { started: [] as string[], now: 0, most: 0 };
  const hold = async (id: string) => {
    reads.started.push(id);
    reads.now += 1;
    reads.most = Math.max(reads.most, reads.now);
    try {
      await new Promise((resolve) => setTimeout(resolve, holds[id]?.ms ?? 1));
      const fails = holds[id]?.fails;
      if (fails !== undefined) throw fails;
    } finally {
      reads.now -= 1;
    }
  };
  return { reads, hold };
}

interface Pack {
  readonly agents: readonly string[];
  readonly blocks: readonly string[];
  /** The agents whose 1.0.0 pins each block at 2.0.0: agent 1 when absent. */
  readonly pinnedBy?: Readonly<Record<string, readonly number[]>>;
  readonly replace?: readonly ReplaceBlock[];
  /** How each agent's projects are read. */
  readonly agentHolds?: Readonly<Record<string, Hold>>;
  /** How each block's uses are read. */
  readonly blockHolds?: Readonly<Record<string, Hold>>;
}

function harness(pack: Pack) {
  const agents = held(pack.agentHolds ?? {});
  const blocks = held(pack.blockHolds ?? {});
  const uses = (blockId: string): BlockUse[] =>
    (pack.pinnedBy?.[blockId] ?? [1]).map((n) => ({
      agentId: agent(n) as AgentId,
      version: '1.0.0',
      as: 'prompt',
      blockVersion: '2.0.0',
    }));
  const deps: DeployCheckDeps = {
    agentPins: {
      pinned: { resolve: async () => null, list: async () => [] },
      latest: {
        latest: async () => null,
        byProject: async (q) => [{ projectId: projectOf(q.agentId), version: '1.0.0' as Semver }],
      },
      changes: {
        get: async () => null,
      } as unknown as NonNullable<DeployCheckDeps['agentPins']>['changes'],
    },
    blockUse: {
      async pinningBlock(q) {
        await blocks.hold(q.blockId);
        return uses(q.blockId);
      },
    },
    async projectsOf(_t, agentId) {
      await agents.hold(agentId);
      return [projectOf(agentId)];
    },
    canRead: async () => true,
  };
  const check = () =>
    checkAgainstRuns(deps, {
      tenantId,
      agents: pack.agents,
      blocks: pack.blocks.map((id) => ({ id, version: '1.0.0' })),
      ...(pack.replace !== undefined && { replace: pack.replace }),
    });
  return { check, agentReads: agents.reads, blockReads: blocks.reads };
}

/** The stop a block gives, naming the nth agent's project, where its 1.0.0 runs as Latest. */
const stop = (blockId: string, n: number): DeployCheckStop => ({
  blockId,
  inFiles: '1.0.0',
  runs: { version: '2.0.0', projectId: project(n), follows: 'latest' },
});

/** The check's failure, with how many held reads were still running when it came. */
async function failure(
  check: () => Promise<unknown>,
  reads: { readonly now: number },
): Promise<{ readonly error: unknown; readonly running: number }> {
  try {
    await check();
  } catch (error) {
    return { error, running: reads.now };
  }
  throw new Error('the check answered, with no failure');
}

describe('checkAgainstRuns reads its agents, then its blocks, two at a time', () => {
  test("two agents are read together, and a stop names the first agent's project", async () => {
    // Agent 2's read ends first. Both agents' 1.0.0 pins the block.
    const { check, agentReads } = harness({
      agents: [agent(1), agent(2)],
      blocks: ['acme.tone'],
      pinnedBy: { 'acme.tone': [1, 2] },
      agentHolds: { [agent(1)]: { ms: 20 } },
    });
    expect(await check()).toEqual({
      kind: 'checked',
      stops: [stop('acme.tone', 1)],
      replaced: [],
      notNeeded: [],
    });
    expect(agentReads.most).toBe(2);
  });

  test('five agents: at most two are read at once, and each once', async () => {
    // Agent 1 is named twice.
    const { check, agentReads } = harness({
      agents: [agent(1), agent(2), agent(1), agent(3), agent(4), agent(5)],
      blocks: ['acme.tone'],
      agentHolds: Object.fromEntries(FIVE.map((n) => [agent(n), { ms: 20 }])),
    });
    expect(await check()).toEqual({
      kind: 'checked',
      stops: [stop('acme.tone', 1)],
      replaced: [],
      notNeeded: [],
    });
    expect(agentReads.most).toBe(2);
    expect(agentReads.started).toEqual(FIVE.map(agent));
  });

  test("three blocks are read two at a time, and stops and replaced keep the blocks' order", async () => {
    // The reads end b2, b3, b1. The deploy puts b2 back on purpose.
    const { check, blockReads } = harness({
      agents: [agent(1)],
      blocks: ['acme.b1', 'acme.b2', 'acme.b3'],
      replace: [{ blockId: 'acme.b2', reason: 'on purpose' }],
      blockHolds: { 'acme.b1': { ms: 20 }, 'acme.b3': { ms: 5 } },
    });
    expect(await check()).toEqual({
      kind: 'checked',
      stops: [stop('acme.b1', 1), stop('acme.b3', 1)],
      replaced: [{ blockId: 'acme.b2', from: '2.0.0', to: '1.0.0', reason: 'on purpose' }],
      notNeeded: [],
    });
    expect(blockReads.most).toBe(2);
  });

  test('five blocks: at most two are read at once', async () => {
    const ids = FIVE.map((n) => `acme.b${n}`);
    const { check, blockReads } = harness({
      agents: [agent(1)],
      blocks: ids,
      blockHolds: Object.fromEntries(ids.map((id) => [id, { ms: 20 }])),
    });
    expect(await check()).toEqual({
      kind: 'checked',
      stops: ids.map((id) => stop(id, 1)),
      replaced: [],
      notNeeded: [],
    });
    expect(blockReads.most).toBe(2);
    expect(blockReads.started).toEqual(ids);
  });

  test("an agent's failure is the earliest agent's, once the running read ends, and no more start", async () => {
    // Agent 2's read fails first. Agent 1's fails after it, and that's the
    // one reading in turn gives.
    const first = new Error('the first agent');
    const { check, agentReads, blockReads } = harness({
      agents: FIVE.map(agent),
      blocks: ['acme.tone'],
      agentHolds: {
        [agent(1)]: { ms: 20, fails: first },
        [agent(2)]: { fails: new Error('the second agent') },
        [agent(3)]: { ms: 20 },
        [agent(4)]: { ms: 20 },
        [agent(5)]: { ms: 20 },
      },
    });
    const failed = await failure(check, agentReads);
    expect(failed.error).toBe(first);
    expect(failed.running).toBe(0);
    expect(agentReads.started).toEqual([agent(1), agent(2)]);
    expect(blockReads.started).toEqual([]);
  });

  test("a block's failure is the earliest block's, once the running read ends, and no more start", async () => {
    const first = new Error('the first block');
    const { check, blockReads } = harness({
      agents: [agent(1)],
      blocks: FIVE.map((n) => `acme.b${n}`),
      blockHolds: {
        'acme.b1': { ms: 20, fails: first },
        'acme.b2': { fails: new Error('the second block') },
        'acme.b3': { ms: 20 },
        'acme.b4': { ms: 20 },
        'acme.b5': { ms: 20 },
      },
    });
    const failed = await failure(check, blockReads);
    expect(failed.error).toBe(first);
    expect(failed.running).toBe(0);
    expect(blockReads.started).toEqual(['acme.b1', 'acme.b2']);
  });
});
