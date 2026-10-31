// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/blocks/:blockId/runs-in`: where the block's versions run now.
 * An environment order carries `acme.desk` and its prompt block
 * `acme.tone` from staging to prod. Desk 1.0.0 pins tone 1.0.0, 1.1.0
 * pins tone 1.1.0, and 1.2.0 (made in staging only) pins tone 1.2.0. Prod
 * is pinned to desk 1.0.0 and its EU segment to 1.1.0; staging follows
 * its Latest, 1.1.0. The rows are the ones `GET /v1/agents/:id/projects`
 * gives, kept where the running version pins the block.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AgentPinScope, ProjectId, Semver, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  AgentPinBindings,
  AgentPinResolveInput,
  AgentPinnedVersion,
  BlockUse,
  BlockVersionPullRequest,
  CreateAppInput,
  LatestInProject,
  TokenResolver,
} from '../src/index.js';
import { environmentOrders } from './support/environment-orders.js';
import { type Grant, type ItemRow, grantsAuthz, itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
const STAGING = randomUUID() as ProjectId;
const PROD = randomUUID() as ProjectId;

const DESK = 'acme.desk';
const TONE = 'acme.tone';
const EU = [{ key: 'region', value: 'eu' }];

const ROWS: ItemRow[] = [
  {
    kind: 'agent',
    id: DESK,
    projects: [STAGING, PROD],
    versions: [
      { version: '1.0.0', projects: [STAGING, PROD] },
      { version: '1.1.0', projects: [STAGING, PROD] },
      { version: '1.2.0', projects: [STAGING] },
    ],
  },
  {
    kind: 'block',
    id: TONE,
    projects: [STAGING, PROD],
    versions: [
      { version: '1.0.0', projects: [STAGING, PROD] },
      { version: '1.1.0', projects: [STAGING, PROD] },
      { version: '1.2.0', projects: [STAGING] },
    ],
  },
];

const PEOPLE: Record<string, readonly Grant[]> = {
  both: [`read project:${STAGING}`, `read project:${PROD}`],
  prod: [`read project:${PROD}`],
};

const resolveToken: TokenResolver = async (token) =>
  token in PEOPLE ? { tenantId, userId: token as UserId } : null;

const pin = (scope: AgentPinScope, version: string): AgentPinnedVersion => ({
  agentId: DESK,
  scope,
  version: version as Semver,
  changeId: `pin-${version}`,
  setAt: '2026-10-20T09:00:00.000Z' as AgentPinnedVersion['setAt'],
});

const PROD_PIN = pin({ kind: 'project', projectId: PROD }, '1.0.0');
const EU_PIN = pin({ kind: 'segment', projectId: PROD, path: EU }, '1.1.0');

const STAGING_LATEST: LatestInProject = {
  projectId: STAGING,
  version: '1.1.0' as Semver,
  since: '2026-10-25T12:00:00.000Z',
  deploymentId: 'dep-staging',
};

/** Each desk version pins the tone version with its own number. */
const ALL_USES: readonly BlockUse[] = ['1.0.0', '1.1.0', '1.2.0'].map((version) => ({
  agentId: DESK as BlockUse['agentId'],
  version,
  as: 'prompt',
  blockVersion: version,
}));

/** Pins and Latest over fixed rows: `resolve` answers the most specific pin covering the scope. */
function agentPinsOf(pins: readonly AgentPinnedVersion[], latest: readonly LatestInProject[]) {
  const covers = (scope: AgentPinScope, q: AgentPinResolveInput) => {
    switch (scope.kind) {
      case 'tenant':
        return true;
      case 'project':
        return scope.projectId === q.projectId;
      case 'segment':
        return (
          scope.projectId === q.projectId &&
          JSON.stringify(scope.path) === JSON.stringify(q.segments ?? [])
        );
      default:
        return false;
    }
  };
  const rank = { segment: 0, project: 1, org: 2, tenant: 3 } as const;
  return {
    pinned: {
      async resolve(q: AgentPinResolveInput) {
        const found = pins
          .filter((p) => covers(p.scope, q))
          .sort((a, b) => rank[a.scope.kind] - rank[b.scope.kind])[0];
        return found === undefined ? null : { version: found.version, scope: found.scope };
      },
      async list() {
        return pins;
      },
    },
    latest: {
      async byProject() {
        return latest;
      },
    },
  } as unknown as AgentPinBindings;
}

/** A deployment: the agents it ships and the block versions it lists. */
interface Shipped {
  readonly agents: readonly string[];
  readonly blocks: readonly { readonly id: string; readonly version: string }[];
}

const desk = (version: string): Shipped => ({ agents: [DESK], blocks: [{ id: TONE, version }] });
/** Another pack in the same project: its own agent, and maybe the same block. */
const billing = (version?: string): Shipped => ({
  agents: ['acme.billing'],
  blocks: version === undefined ? [] : [{ id: TONE, version }],
});

function harness(opts: {
  readonly pins: readonly AgentPinnedVersion[];
  readonly latest: readonly LatestInProject[];
  readonly uses?: readonly BlockUse[];
  /** `false`: no pins and Latest in this runtime. */
  readonly wired?: boolean;
  /** Each project's deployments, newest first; absent: no deployments read. */
  readonly deployed?: Partial<Record<ProjectId, readonly Shipped[]>>;
  /** The pull request opened per `<projectId> <version>`, `'fails'` for one that can't be read; absent: none read. */
  readonly prs?: Readonly<Record<string, BlockVersionPullRequest | 'fails'>>;
}) {
  const { deployed, prs } = opts;
  const authz = grantsAuthz(PEOPLE, { [`agent:${DESK}`]: STAGING, [`block:${TONE}`]: STAGING });
  const app = createApp({
    ...createStubAppBindings(),
    agentRegistry: {},
    blockRegistry: {
      async get(q: { blockId: string }) {
        return q.blockId === TONE
          ? { id: TONE, version: '1.2.0', kind: 'prompt', tenantId, projectId: STAGING }
          : null;
      },
    },
    blockUse: {
      async pinningBlock(q: { blockId: string }) {
        return q.blockId === TONE ? (opts.uses ?? ALL_USES) : [];
      },
    },
    ...(opts.wired !== false && { agentPins: agentPinsOf(opts.pins, opts.latest) }),
    ...(deployed !== undefined && {
      deploymentRegistry: {
        async list(q: { projectId: ProjectId; limit: number; cursor?: string }) {
          const all = deployed[q.projectId] ?? [];
          const from = Number(q.cursor ?? 0);
          const to = from + q.limit;
          return {
            data: all.slice(from, to).map((d) => ({
              contents: {
                tools: [],
                guardrails: [],
                agents: d.agents.map((id) => ({ id, version: '1.0.0' })),
                flows: [],
                blocks: d.blocks,
              },
            })),
            ...(to < all.length && { nextCursor: String(to) }),
          };
        },
      },
    }),
    ...(prs !== undefined && {
      blockVersionPullRequests: {
        async forVersion(q: { projectId: ProjectId; blockId: string; version: string }) {
          const pr = q.blockId === TONE ? prs[`${q.projectId} ${q.version}`] : undefined;
          if (pr === 'fails') throw new Error('the repository did not answer');
          return pr ?? null;
        },
      },
    }),
    resolveToken,
    authz: authz.authz,
    itemProjects: itemProjects(ROWS),
    environmentOrders: environmentOrders([[STAGING, PROD]]),
  } as unknown as CreateAppInput);
  const runsIn = async (who: string, blockId = TONE) => {
    const res = await app.request(`/v1/blocks/${blockId}/runs-in`, {
      headers: { authorization: `Bearer ${who}`, 'x-request-id': 'req-block-runs-in' },
    });
    return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> };
  };
  return { runsIn };
}

const stagingRow = {
  projectId: STAGING,
  agentId: DESK,
  agentVersion: '1.1.0',
  blockVersion: '1.1.0',
  follows: 'latest',
};
const prodRow = {
  projectId: PROD,
  agentId: DESK,
  agentVersion: '1.0.0',
  blockVersion: '1.0.0',
  follows: 'pin',
};
const euRow = {
  projectId: PROD,
  agentId: DESK,
  agentVersion: '1.1.0',
  blockVersion: '1.1.0',
  follows: 'pin',
  segment: EU,
};

describe('GET /v1/blocks/:blockId/runs-in', () => {
  test('a row for each project and segment pin whose running version pins the block', async () => {
    const { runsIn } = harness({ pins: [PROD_PIN, EU_PIN], latest: [STAGING_LATEST] });
    expect(await runsIn('both')).toEqual({
      status: 200,
      body: { data: [stagingRow, prodRow, euRow] },
    });
  });

  test("a running version that doesn't pin the block gives no row", async () => {
    const onlyNewer = ALL_USES.filter((u) => u.version !== '1.0.0');
    const { runsIn } = harness({
      pins: [PROD_PIN, EU_PIN],
      latest: [STAGING_LATEST],
      uses: onlyNewer,
    });
    expect((await runsIn('both')).body).toEqual({ data: [stagingRow, euRow] });
  });

  test("only the projects the caller reads, and no agent version it can't see", async () => {
    // 1.2.0 was made in staging only: a caller who reads prod alone can't see it.
    const hiddenEu = pin({ kind: 'segment', projectId: PROD, path: EU }, '1.2.0');
    const { runsIn } = harness({ pins: [PROD_PIN, hiddenEu], latest: [STAGING_LATEST] });
    expect((await runsIn('prod')).body).toEqual({ data: [prodRow] });
  });

  test("in your files: yes where the pack's newest deployment in the project lists that version or a newer one", async () => {
    const { runsIn } = harness({
      pins: [PROD_PIN, EU_PIN],
      latest: [STAGING_LATEST],
      deployed: { [STAGING]: [desk('1.2.0')], [PROD]: [desk('1.0.0'), desk('1.1.0')] },
    });
    expect((await runsIn('both')).body).toEqual({
      data: [
        { ...stagingRow, inYourFiles: { state: 'yes' } },
        { ...prodRow, inYourFiles: { state: 'yes' } },
        { ...euRow, inYourFiles: { state: 'not-yet' } },
      ],
    });
  });

  test("another pack's newer deployment in the project doesn't count: the agent's pack's newest does", async () => {
    const { runsIn } = harness({
      pins: [PROD_PIN, EU_PIN],
      latest: [STAGING_LATEST],
      deployed: {
        // Staging: another pack lists a newer tone; the desk's pack an older one.
        [STAGING]: [billing('1.2.0'), desk('1.0.0')],
        // Prod: another pack, with no desk and no tone, deployed last.
        [PROD]: [billing(), desk('1.1.0')],
      },
    });
    expect((await runsIn('both')).body).toEqual({
      data: [
        { ...stagingRow, inYourFiles: { state: 'not-yet' } },
        { ...prodRow, inYourFiles: { state: 'yes' } },
        { ...euRow, inYourFiles: { state: 'yes' } },
      ],
    });
  });

  test("past the project's 200 newest deployments, the pack reads as not deployed there", async () => {
    const { runsIn } = harness({
      pins: [PROD_PIN, EU_PIN],
      latest: [STAGING_LATEST],
      deployed: { [STAGING]: [...Array.from({ length: 200 }, () => billing()), desk('1.1.0')] },
    });
    expect((await runsIn('both')).body).toMatchObject({
      data: [{ ...stagingRow, inYourFiles: { state: 'not-yet' } }, {}, {}],
    });
  });

  test("the pack's newest deployment on a later page of the project's list; none at all is not yet", async () => {
    const { runsIn } = harness({
      pins: [PROD_PIN, EU_PIN],
      latest: [STAGING_LATEST],
      deployed: { [STAGING]: [...Array.from({ length: 120 }, () => billing()), desk('1.1.0')] },
    });
    expect((await runsIn('both')).body).toEqual({
      data: [
        { ...stagingRow, inYourFiles: { state: 'yes' } },
        { ...prodRow, inYourFiles: { state: 'not-yet' } },
        { ...euRow, inYourFiles: { state: 'not-yet' } },
      ],
    });
  });

  test('a prerelease is older than its release: 1.1.0-rc.1 holds 1.0.0, not 1.1.0', async () => {
    const { runsIn } = harness({
      pins: [PROD_PIN, EU_PIN],
      latest: [STAGING_LATEST],
      deployed: { [STAGING]: [desk('1.1.0-rc.1')], [PROD]: [desk('1.1.0-rc.1')] },
    });
    expect((await runsIn('both')).body).toEqual({
      data: [
        { ...stagingRow, inYourFiles: { state: 'not-yet' } },
        { ...prodRow, inYourFiles: { state: 'yes' } },
        { ...euRow, inYourFiles: { state: 'not-yet' } },
      ],
    });
  });

  test('a pull request opened for the version: merged is yes, open or closed is not yet, each with it', async () => {
    const pr = (n: number, state: BlockVersionPullRequest['state']): BlockVersionPullRequest => ({
      number: n,
      url: `https://github.com/acme/agents/pull/${n}`,
      state,
    });
    const { runsIn } = harness({
      pins: [PROD_PIN, EU_PIN],
      latest: [STAGING_LATEST],
      deployed: {},
      prs: {
        [`${STAGING} 1.1.0`]: pr(9, 'closed'),
        [`${PROD} 1.0.0`]: pr(7, 'merged'),
        [`${PROD} 1.1.0`]: pr(12, 'open'),
      },
    });
    expect((await runsIn('both')).body).toEqual({
      data: [
        { ...stagingRow, inYourFiles: { state: 'not-yet', pr: pr(9, 'closed') } },
        { ...prodRow, inYourFiles: { state: 'yes', pr: pr(7, 'merged') } },
        { ...euRow, inYourFiles: { state: 'not-yet', pr: pr(12, 'open') } },
      ],
    });
  });

  test("a pull request that can't be read leaves its row without inYourFiles; the page still answers", async () => {
    const { runsIn } = harness({
      pins: [PROD_PIN, EU_PIN],
      latest: [STAGING_LATEST],
      prs: { [`${PROD} 1.1.0`]: 'fails' },
    });
    expect(await runsIn('both')).toEqual({
      status: 200,
      body: {
        data: [
          { ...stagingRow, inYourFiles: { state: 'not-yet' } },
          { ...prodRow, inYourFiles: { state: 'not-yet' } },
          euRow,
        ],
      },
    });
  });

  test('a block no running version pins: an empty list', async () => {
    const { runsIn } = harness({ pins: [], latest: [], uses: [] });
    expect(await runsIn('both')).toEqual({ status: 200, body: { data: [] } });
  });

  test('an unknown block is 404 block-not-found', async () => {
    const { runsIn } = harness({ pins: [], latest: [] });
    const { status, body } = await runsIn('both', 'acme.nothing');
    expect(status).toBe(404);
    expect((body.error as { code: string }).code).toBe('block-not-found');
  });

  test("without pins and Latest in this runtime, it says it can't tell (501)", async () => {
    const { runsIn } = harness({ pins: [], latest: [], wired: false });
    const { status, body } = await runsIn('both');
    expect(status).toBe(501);
    expect(body.error).toMatchObject({
      code: 'runs-in-unsupported',
      message: "This runtime can't say where a block runs: it doesn't read pins and Latest",
    });
  });
});
