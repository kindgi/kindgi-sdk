// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `whatRunsByProject` looks up its projects' pins a few at a time, not one
 * after another: at most two at once, started in the projects' order, the
 * rows in that order. A failure answers as looking them up one after
 * another does. Each project's lookup waits its own time, so lookups that
 * run together overlap and can end out of order.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ProjectId, Semver, TenantId } from '@kindgi/types';

import { whatRunsByProject } from '../src/index.js';
import type { AgentPinBindings, AgentPinResolveInput, AgentPinnedVersion } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const agentId = 'acme.agent';
const q = { tenantId, agentId };
const P1 = randomUUID() as ProjectId;
const P2 = randomUUID() as ProjectId;
const P3 = randomUUID() as ProjectId;
const P4 = randomUUID() as ProjectId;
const P5 = randomUUID() as ProjectId;
const FIVE = [P1, P2, P3, P4, P5];

/** A project, and how its pin lookup goes. */
interface Lookup {
  readonly projectId: ProjectId;
  /** How long its lookup takes, in ms. */
  readonly ms: number;
  /** The pin its lookup finds; none when absent. */
  readonly finds?: AgentPinnedVersion;
  /** What its lookup fails with, after `ms`. */
  readonly fails?: Error;
}

const setAt = '2026-11-07T09:00:00.000Z' as AgentPinnedVersion['setAt'];
/** The agent's pin on P1. */
const pinP1: AgentPinnedVersion = {
  agentId,
  scope: { kind: 'project', projectId: P1 },
  version: '2.0.0' as Semver,
  changeId: 'pin-p1',
  setAt,
};
/** The agent's pin on a segment inside P2, which doesn't cover P2 itself. */
const segmentP2: AgentPinnedVersion = {
  agentId,
  scope: { kind: 'segment', projectId: P2, path: [{ key: 'company', value: 'acme' }] },
  version: '2.1.0' as Semver,
  changeId: 'pin-p2-acme',
  setAt,
};
/** P1's row: it follows its pin. */
const rowP1 = {
  projectId: P1,
  runs: { follows: 'pin', version: '2.0.0', pinnedScope: { kind: 'project', projectId: P1 } },
  pin: pinP1,
  segments: [],
};

function harness(
  lookups: readonly Lookup[],
  pins: readonly AgentPinnedVersion[] = [],
  latest: readonly { projectId: ProjectId; version: string }[] = [],
) {
  const of = new Map(lookups.map((l) => [l.projectId, l]));
  // The projects whose lookups started, in that order; how many lookups
  // were running at once, now and at the most; and how many times the
  // agent's pins and its Latest everywhere were read.
  const reads = { started: [] as ProjectId[], now: 0, most: 0, lists: 0, latests: 0 };
  const agentPins = {
    pinned: {
      async list() {
        reads.lists += 1;
        return pins;
      },
      async resolve(input: AgentPinResolveInput) {
        const l = of.get(input.projectId as ProjectId);
        reads.started.push(input.projectId as ProjectId);
        reads.now += 1;
        reads.most = Math.max(reads.most, reads.now);
        try {
          await new Promise((resolve) => setTimeout(resolve, l?.ms ?? 1));
          if (l?.fails !== undefined) throw l.fails;
          return l?.finds === undefined ? null : { version: l.finds.version, scope: l.finds.scope };
        } finally {
          reads.now -= 1;
        }
      },
    },
    latest: {
      async byProject() {
        reads.latests += 1;
        return latest;
      },
    },
  } as unknown as Pick<AgentPinBindings, 'pinned' | 'latest'>;
  return { agentPins, reads };
}

describe('whatRunsByProject looks up its projects a few at a time', () => {
  test("four projects whose lookups end out of order: the rows keep the projects' order", async () => {
    // Two at a time, P2 ends first and P1 last: P2, P3, P4, then P1.
    const { agentPins } = harness(
      [
        { projectId: P1, ms: 30, finds: pinP1 },
        { projectId: P2, ms: 5 },
        { projectId: P3, ms: 10 },
        { projectId: P4, ms: 1 },
      ],
      [pinP1, segmentP2],
      [
        { projectId: P3, version: '1.2.0' },
        { projectId: P2, version: '1.1.0' },
      ],
    );
    expect(await whatRunsByProject(agentPins, q, [P1, P2, P3, P4])).toEqual([
      rowP1,
      {
        projectId: P2,
        runs: { follows: 'latest', version: '1.1.0' },
        segments: [{ path: [{ key: 'company', value: 'acme' }], version: '2.1.0', pin: segmentP2 }],
      },
      { projectId: P3, runs: { follows: 'latest', version: '1.2.0' }, segments: [] },
      { projectId: P4, runs: null, segments: [] },
    ]);
  });

  test('five projects: at most two lookups run at once', async () => {
    const { agentPins, reads } = harness(FIVE.map((projectId) => ({ projectId, ms: 5 })));
    expect(await whatRunsByProject(agentPins, q, FIVE)).toHaveLength(5);
    expect(reads.most).toBe(2);
  });

  test("the lookups start in the projects' order", async () => {
    const { agentPins, reads } = harness(
      [20, 15, 10, 5, 1].map((ms, i) => ({ projectId: FIVE[i] as ProjectId, ms })),
    );
    await whatRunsByProject(agentPins, q, FIVE);
    expect(reads.started).toEqual(FIVE);
  });

  test("a failure answers as one after another does: the earliest project's, once the running lookups end, and no more start", async () => {
    // P3's lookup fails first, then P2's, the earlier project: P2's is
    // the one looking them up in turn gives.
    const second = new Error('the second project');
    const { agentPins, reads } = harness([
      { projectId: P1, ms: 5 },
      { projectId: P2, ms: 30, fails: second },
      { projectId: P3, ms: 10, fails: new Error('the third project') },
      { projectId: P4, ms: 5 },
      { projectId: P5, ms: 5 },
    ]);
    await expect(whatRunsByProject(agentPins, q, FIVE)).rejects.toBe(second);
    expect(reads.now).toBe(0);
    expect(reads.started).not.toContain(P4);
    expect(reads.started).not.toContain(P5);
  });

  test('no projects: nothing is read', async () => {
    const { agentPins, reads } = harness([]);
    expect(await whatRunsByProject(agentPins, q, [])).toEqual([]);
    expect(reads).toEqual({ started: [], now: 0, most: 0, lists: 0, latests: 0 });
  });

  test('one project: one lookup, and its row', async () => {
    const { agentPins, reads } = harness([{ projectId: P1, ms: 1, finds: pinP1 }], [pinP1]);
    expect(await whatRunsByProject(agentPins, q, [P1])).toEqual([rowP1]);
    expect(reads.started).toEqual([P1]);
  });
});
