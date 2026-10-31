// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `checkAgainstRuns`: a deploy stops when a newer version of one of its
 * blocks than the files' runs now in a project of one of its agents,
 * unless it names the block in `replace`. Every project counts; one the
 * caller can't read is named by the version only.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AgentId, ProjectId, Semver, TenantId, Timestamp } from '@kindgi/types';

import {
  type AgentPinnedVersion,
  type BlockUse,
  type DeployCheckDeps,
  type LatestInProject,
  type Pin,
  type PinActor,
  checkAgainstRuns,
  parseCheckBody,
  parseReplace,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const SANDBOX = randomUUID() as ProjectId;
const PROD = randomUUID() as ProjectId;
const HIDDEN = randomUUID() as ProjectId;
const DESK = 'acme.desk';
const OTHER = 'acme.other';
const ANA: PinActor = { kind: 'user', id: 'user-ana' };

interface World {
  /** Each agent's projects. */
  readonly projects?: Record<string, readonly ProjectId[]>;
  /** Each agent's pins (project and segment scopes). */
  readonly pins?: readonly AgentPinnedVersion[];
  /** Each agent's Latest by project. */
  readonly latest?: Record<string, readonly LatestInProject[]>;
  /** The agent versions that pin each block. */
  readonly uses?: Record<string, readonly BlockUse[]>;
  /** Who asked for each pin change. */
  readonly changes?: Record<string, PinActor>;
  readonly unreadable?: readonly ProjectId[];
}

function depsOf(world: World): DeployCheckDeps {
  const pins = world.pins ?? [];
  return {
    agentPins: {
      pinned: {
        async resolve(q) {
          const pin = pins.find(
            (p) =>
              p.agentId === q.agentId &&
              p.scope.kind === 'project' &&
              p.scope.projectId === q.projectId,
          );
          return pin === undefined ? null : { version: pin.version, scope: pin.scope };
        },
        list: async (q) => pins.filter((p) => p.agentId === q.agentId),
      },
      latest: {
        latest: async () => null,
        byProject: async (q) => world.latest?.[q.agentId] ?? [],
      },
      changes: {
        get: async (_t: unknown, changeId: string) => {
          const by = world.changes?.[changeId];
          return by === undefined ? null : ({ changeId, requestedBy: by } as unknown as Pin);
        },
      } as unknown as NonNullable<DeployCheckDeps['agentPins']>['changes'],
    },
    blockUse: { pinningBlock: async (q) => world.uses?.[q.blockId] ?? [] },
    projectsOf: async (_t, agentId) => world.projects?.[agentId] ?? [],
    canRead: async (projectId) => !(world.unreadable ?? []).includes(projectId),
    displayName: async (userId) => (userId === ANA.id ? 'Ana' : undefined),
  };
}

const use = (agentId: string, version: string, blockVersion: string): BlockUse => ({
  agentId: agentId as AgentId,
  version,
  as: 'prompt',
  blockVersion,
});

const latestIn = (
  projectId: ProjectId,
  version: string,
  extra: Partial<LatestInProject> = {},
): LatestInProject => ({ projectId, version: version as Semver, ...extra });

const pinned = (
  projectId: ProjectId,
  version: string,
  changeId: string,
  setAt = '2026-11-05T10:00:00.000Z',
): AgentPinnedVersion => ({
  agentId: DESK,
  scope: { kind: 'project', projectId },
  version: version as Semver,
  changeId,
  setAt: setAt as Timestamp,
});

/** The desk agent runs 2.0.0 (which pins tone 4.0.0) as Latest in the sandbox, added by Ana. */
const sandboxRunsNewer: World = {
  projects: { [DESK]: [SANDBOX, PROD] },
  latest: {
    [DESK]: [
      latestIn(SANDBOX, '2.0.0', { since: '2026-11-05T09:00:00.000Z', by: ANA }),
      latestIn(PROD, '1.0.0'),
    ],
  },
  uses: { tone: [use(DESK, '1.0.0', '3.0.0'), use(DESK, '2.0.0', '4.0.0')] },
};

const input = (blocks: { id: string; version: string }[], extra = {}) => ({
  tenantId,
  agents: [DESK],
  blocks,
  ...extra,
});

describe('checkAgainstRuns', () => {
  test('a newer version running as Latest stops the deploy, naming where, who and when', async () => {
    const check = await checkAgainstRuns(
      depsOf(sandboxRunsNewer),
      input([{ id: 'tone', version: '3.0.0' }]),
    );
    expect(check).toEqual({
      kind: 'checked',
      stops: [
        {
          blockId: 'tone',
          inFiles: '3.0.0',
          runs: {
            version: '4.0.0',
            projectId: SANDBOX,
            follows: 'latest',
            by: { kind: 'user', id: ANA.id, name: 'Ana' },
            at: '2026-11-05T09:00:00.000Z',
          },
        },
      ],
      replaced: [],
      notNeeded: [],
    });
  });

  test('the same version, a newer one in the files, and a block that runs nowhere all pass', async () => {
    const check = await checkAgainstRuns(
      depsOf(sandboxRunsNewer),
      input([
        { id: 'tone', version: '4.0.0' },
        { id: 'greeting', version: '1.0.0' },
      ]),
    );
    expect(check).toMatchObject({ kind: 'checked', stops: [] });
    const newer = await checkAgainstRuns(
      depsOf(sandboxRunsNewer),
      input([{ id: 'tone', version: '5.0.0' }]),
    );
    expect(newer).toMatchObject({ kind: 'checked', stops: [] });
  });

  test('a prerelease is older than its release', async () => {
    const world: World = {
      projects: { [DESK]: [SANDBOX] },
      latest: { [DESK]: [latestIn(SANDBOX, '2.0.0')] },
      uses: { tone: [use(DESK, '2.0.0', '4.0.0-rc.1')] },
    };
    expect(
      await checkAgainstRuns(depsOf(world), input([{ id: 'tone', version: '4.0.0' }])),
    ).toMatchObject({ stops: [] });
    const release: World = { ...world, uses: { tone: [use(DESK, '2.0.0', '4.0.0')] } };
    expect(
      await checkAgainstRuns(depsOf(release), input([{ id: 'tone', version: '4.0.0-rc.1' }])),
    ).toMatchObject({ stops: [{ blockId: 'tone', runs: { version: '4.0.0' } }] });
  });

  test('a pin says who asked for its pin change and when it was set', async () => {
    const world: World = {
      projects: { [DESK]: [PROD] },
      pins: [pinned(PROD, '2.0.0', 'change-1')],
      uses: { tone: [use(DESK, '2.0.0', '4.0.0')] },
      changes: { 'change-1': { kind: 'service', id: 'svc-release' } },
    };
    const check = await checkAgainstRuns(depsOf(world), input([{ id: 'tone', version: '3.0.0' }]));
    expect(check).toMatchObject({
      stops: [
        {
          runs: {
            version: '4.0.0',
            projectId: PROD,
            follows: 'pin',
            by: { kind: 'service', id: 'svc-release' },
            at: '2026-11-05T10:00:00.000Z',
          },
        },
      ],
    });
  });

  test('a segment pin inside a project counts, with its path', async () => {
    const segment: AgentPinnedVersion = {
      ...pinned(PROD, '2.0.0', 'change-2'),
      scope: { kind: 'segment', projectId: PROD, path: [{ key: 'region', value: 'eu' }] },
    };
    const world: World = {
      projects: { [DESK]: [PROD] },
      pins: [segment],
      latest: { [DESK]: [latestIn(PROD, '1.0.0')] },
      uses: { tone: [use(DESK, '1.0.0', '3.0.0'), use(DESK, '2.0.0', '4.0.0')] },
      changes: { 'change-2': ANA },
    };
    const check = await checkAgainstRuns(depsOf(world), input([{ id: 'tone', version: '3.0.0' }]));
    expect(check).toMatchObject({
      stops: [
        {
          runs: {
            version: '4.0.0',
            projectId: PROD,
            follows: 'pin',
            segment: [{ key: 'region', value: 'eu' }],
            by: { kind: 'user', id: ANA.id, name: 'Ana' },
          },
        },
      ],
    });
  });

  test("a project the caller can't read still stops it, named by the version only", async () => {
    const world: World = {
      projects: { [DESK]: [HIDDEN] },
      latest: { [DESK]: [latestIn(HIDDEN, '2.0.0', { by: ANA, since: '2026-11-05T09:00:00Z' })] },
      uses: { tone: [use(DESK, '2.0.0', '4.0.0')] },
      unreadable: [HIDDEN],
    };
    const check = await checkAgainstRuns(depsOf(world), input([{ id: 'tone', version: '3.0.0' }]));
    expect(check).toMatchObject({
      stops: [{ blockId: 'tone', inFiles: '3.0.0', runs: { version: '4.0.0' } }],
    });
    if (check.kind !== 'checked') throw new Error('checked');
    expect(check.stops[0]?.runs).toEqual({ version: '4.0.0' });
  });

  test('where the newest runs in a project the caller reads and one it does not, the readable one is named', async () => {
    const world: World = {
      projects: { [DESK]: [HIDDEN, SANDBOX] },
      latest: { [DESK]: [latestIn(HIDDEN, '2.0.0'), latestIn(SANDBOX, '2.0.0')] },
      uses: { tone: [use(DESK, '2.0.0', '4.0.0')] },
      unreadable: [HIDDEN],
    };
    const check = await checkAgainstRuns(depsOf(world), input([{ id: 'tone', version: '3.0.0' }]));
    expect(check).toMatchObject({ stops: [{ runs: { projectId: SANDBOX } }] });
  });

  test("an agent outside the pack doesn't count", async () => {
    const world: World = {
      projects: { [DESK]: [SANDBOX], [OTHER]: [SANDBOX] },
      latest: { [DESK]: [latestIn(SANDBOX, '1.0.0')], [OTHER]: [latestIn(SANDBOX, '9.0.0')] },
      uses: { tone: [use(DESK, '1.0.0', '3.0.0'), use(OTHER, '9.0.0', '7.0.0')] },
    };
    expect(
      await checkAgainstRuns(depsOf(world), input([{ id: 'tone', version: '3.0.0' }])),
    ).toMatchObject({ stops: [] });
  });

  test('replace lets the block through and records it; one that needs none is not needed', async () => {
    const check = await checkAgainstRuns(
      depsOf(sandboxRunsNewer),
      input(
        [
          { id: 'tone', version: '3.0.0' },
          { id: 'greeting', version: '1.0.0' },
        ],
        {
          replace: [
            { blockId: 'tone', reason: 'v4 promised a refund we no longer give' },
            { blockId: 'greeting', reason: 'just in case' },
          ],
        },
      ),
    );
    expect(check).toEqual({
      kind: 'checked',
      stops: [],
      replaced: [
        {
          blockId: 'tone',
          from: '4.0.0',
          to: '3.0.0',
          reason: 'v4 promised a refund we no longer give',
        },
      ],
      notNeeded: ['greeting'],
    });
  });

  test("a promotion's check counts only the target project's runs", async () => {
    const check = await checkAgainstRuns(
      depsOf(sandboxRunsNewer),
      input([{ id: 'tone', version: '3.0.0' }], { inProject: PROD }),
    );
    expect(check).toMatchObject({ kind: 'checked', stops: [] });
  });

  test("a runtime that doesn't read pins and Latest, or block uses, skips it", async () => {
    const { agentPins: _p, ...noPins } = depsOf(sandboxRunsNewer);
    const { blockUse: _b, ...noUses } = depsOf(sandboxRunsNewer);
    const blocks = [{ id: 'tone', version: '3.0.0' }];
    expect(await checkAgainstRuns(noPins, input(blocks))).toEqual({ kind: 'skipped' });
    expect(await checkAgainstRuns(noUses, input(blocks))).toEqual({ kind: 'skipped' });
  });
});

describe('parseReplace', () => {
  test('each entry is { blockId, reason }, a block named once', () => {
    const issues: { path: string; message: string }[] = [];
    expect(parseReplace([{ blockId: 'tone', reason: 'on purpose' }], issues)).toEqual([
      { blockId: 'tone', reason: 'on purpose' },
    ]);
    expect(issues).toEqual([]);
    parseReplace(
      [
        { blockId: 'tone', reason: 'a' },
        { blockId: 'tone', reason: 'b' },
      ],
      issues,
    );
    expect(issues.map((i) => i.message)).toEqual(['replace names block tone twice']);
  });

  test('a reason says why: 1 to 500 characters, no control characters', () => {
    for (const reason of ['', '   ', 'x'.repeat(501), 'line\nbreak', 7]) {
      const issues: { path: string; message: string }[] = [];
      parseReplace([{ blockId: 'tone', reason }], issues);
      expect(issues.map((i) => i.path)).toEqual(['replace[0].reason']);
    }
    const issues: { path: string; message: string }[] = [];
    parseReplace([{ blockId: 'tone', reason: 'x'.repeat(500) }], issues);
    expect(issues).toEqual([]);
  });

  test('absent is none, and anything but a list is refused', () => {
    const issues: { path: string; message: string }[] = [];
    expect(parseReplace(undefined, issues)).toBeUndefined();
    parseReplace({ tone: 'why' }, issues);
    expect(issues.map((i) => i.path)).toEqual(['replace']);
  });
});

describe('parseCheckBody', () => {
  test('agents by id, blocks each { id, version } named once, and replace', () => {
    const issues: { path: string; message: string }[] = [];
    expect(
      parseCheckBody(
        {
          projectId: SANDBOX,
          agents: [DESK, DESK],
          blocks: [{ id: 'tone', version: '3.0.0' }],
          replace: [{ blockId: 'tone', reason: 'on purpose' }],
        },
        issues,
      ),
    ).toEqual({
      projectId: SANDBOX,
      agents: [DESK],
      blocks: [{ id: 'tone', version: '3.0.0' }],
      replace: [{ blockId: 'tone', reason: 'on purpose' }],
    });
    expect(issues).toEqual([]);
  });

  test('a block named twice, a bad version, and agents that are not a list are refused', () => {
    const issues: { path: string; message: string }[] = [];
    const body = parseCheckBody(
      {
        agents: 'acme.desk',
        blocks: [
          { id: 'tone', version: '3.0.0' },
          { id: 'tone', version: '3.0.1' },
          { id: 'greeting', version: 'latest' },
        ],
      },
      issues,
    );
    expect(body).toBeUndefined();
    expect(issues.map((i) => i.path)).toEqual(['agents', 'blocks[1].id', 'blocks[2].version']);
  });
});
