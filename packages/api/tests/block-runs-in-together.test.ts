// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/blocks/:blockId/runs-in` reads the agents that pin the block a
 * few at a time, not one after another: at most four at once, their rows
 * in the order they pin it. A failure answers as reading them one after
 * another does. Each agent here is pinned to 1.0.0 in prod, the project
 * the caller reads, and its 1.0.0 pins `acme.tone` 1.0.0. Its pins read
 * waits a moment, so reads that run together overlap.
 */

import { randomUUID } from 'node:crypto';

import { HTTPException } from 'hono/http-exception';
import { describe, expect, test } from 'vitest';

import type { ProjectId, Semver, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  AgentPinBindings,
  AgentPinResolveInput,
  AgentPinnedVersion,
  BlockUse,
  CreateAppInput,
  TokenResolver,
} from '../src/index.js';
import { environmentOrders } from './support/environment-orders.js';
import { type ItemRow, grantsAuthz, itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
const PROD = randomUUID() as ProjectId;
const STAGING = randomUUID() as ProjectId;
const QA = randomUUID() as ProjectId;
const TONE = 'acme.tone';

const agent = (n: number) => `acme.agent-${n}`;

const resolveToken: TokenResolver = async (token) =>
  token === 'reader' ? { tenantId, userId: token as UserId } : null;

/** An agent that pins the block, and how its pins read goes. */
interface Pinning {
  readonly id: string;
  /** The projects that serve it; prod alone when absent. */
  readonly projects?: readonly ProjectId[];
  /** How long its pins read takes, in ms; 1 when absent. */
  readonly ms?: number;
  /** What its pins read fails with, after `ms`. */
  readonly fails?: Error;
}

const prodPin = (agentId: string): AgentPinnedVersion => ({
  agentId,
  scope: { kind: 'project', projectId: PROD },
  version: '1.0.0' as Semver,
  changeId: `pin-${agentId}`,
  setAt: '2026-11-07T09:00:00.000Z' as AgentPinnedVersion['setAt'],
});

function harness(agents: readonly Pinning[]) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const projectsOf = (a: Pinning) => a.projects ?? [PROD];
  const items = itemProjects([
    { kind: 'block', id: TONE, projects: [PROD] },
    ...agents.map(
      (a): ItemRow => ({
        kind: 'agent',
        id: a.id,
        projects: projectsOf(a),
        versions: [{ version: '1.0.0', projects: projectsOf(a) }],
      }),
    ),
  ]);
  const authz = grantsAuthz(
    { reader: [`read project:${PROD}`] },
    Object.fromEntries([
      [`block:${TONE}`, PROD],
      ...agents.map((a) => [`agent:${a.id}`, projectsOf(a)[0]]),
    ]),
  );
  // The agents whose pins were read, and how many reads were running at
  // once: now, and at the most.
  const pins = { listed: [] as string[], now: 0, most: 0 };
  const agentPins = {
    pinned: {
      async list(q: { agentId: string }) {
        const a = byId.get(q.agentId);
        pins.listed.push(q.agentId);
        pins.now += 1;
        pins.most = Math.max(pins.most, pins.now);
        await new Promise((resolve) => setTimeout(resolve, a?.ms ?? 1));
        pins.now -= 1;
        if (a?.fails !== undefined) throw a.fails;
        return [prodPin(q.agentId)];
      },
      async resolve(q: AgentPinResolveInput) {
        return q.projectId === PROD
          ? { version: '1.0.0', scope: { kind: 'project', projectId: PROD } }
          : null;
      },
    },
    latest: {
      async byProject() {
        return [];
      },
    },
  } as unknown as AgentPinBindings;
  const uses: readonly BlockUse[] = agents.map((a) => ({
    agentId: a.id as BlockUse['agentId'],
    version: '1.0.0',
    as: 'prompt',
    blockVersion: '1.0.0',
  }));
  const app = createApp({
    ...createStubAppBindings(),
    agentRegistry: {},
    blockRegistry: {
      async get(q: { blockId: string }) {
        return q.blockId === TONE
          ? { id: TONE, version: '1.0.0', kind: 'prompt', tenantId, projectId: PROD }
          : null;
      },
    },
    blockUse: {
      async pinningBlock(q: { blockId: string }) {
        return q.blockId === TONE ? uses : [];
      },
    },
    agentPins,
    resolveToken,
    authz: authz.authz,
    itemProjects: items,
    environmentOrders: environmentOrders([[STAGING, QA]]),
  } as unknown as CreateAppInput);
  const runsIn = async () => {
    const res = await app.request(`/v1/blocks/${TONE}/runs-in`, {
      headers: { authorization: 'Bearer reader', 'x-request-id': 'req-block-runs-in-together' },
    });
    // How many pins reads were still running when the answer came.
    const running = pins.now;
    return { status: res.status, running, text: await res.text() };
  };
  return { runsIn, pins, asked: items.asked, checked: authz.asked };
}

/** The rows of an answer. */
const rowsOf = (res: { readonly text: string }) => (JSON.parse(res.text) as { data: unknown }).data;

/** The row an agent gives: pinned to 1.0.0 in prod, which pins tone 1.0.0. */
const row = (agentId: string) => ({
  projectId: PROD,
  agentId,
  agentVersion: '1.0.0',
  blockVersion: '1.0.0',
  follows: 'pin',
});

describe('GET /v1/blocks/:blockId/runs-in reads its agents a few at a time', () => {
  test('two agents are read together, and their rows keep the order they pin the block in', async () => {
    // The first agent's read ends last: read one after another, the two never overlap.
    const { runsIn, pins } = harness([{ id: agent(1), ms: 20 }, { id: agent(2) }]);
    const res = await runsIn();
    expect(res.status, res.text).toBe(200);
    expect(pins.most).toBe(2);
    expect(rowsOf(res)).toEqual([row(agent(1)), row(agent(2))]);
  });

  test('six agents: at most four are read at once, and every row comes back in order', async () => {
    const six = [1, 2, 3, 4, 5, 6].map((n) => ({ id: agent(n), ms: 20 }));
    const { runsIn, pins } = harness(six);
    const res = await runsIn();
    expect(res.status, res.text).toBe(200);
    expect(pins.most).toBe(4);
    expect(rowsOf(res)).toEqual(six.map((a) => row(a.id)));
  });

  test("a failure answers as one after another does: the earliest agent's, once the running reads end, and no more start", async () => {
    // The second agent's read fails first. The first agent's fails after
    // it, with an answer of its own, and that's the one read in turn gives.
    const { runsIn, pins, asked } = harness([
      { id: agent(1), ms: 20, fails: new HTTPException(409, { message: 'the first agent' }) },
      { id: agent(2), fails: new Error('the second agent') },
      { id: agent(3), ms: 20 },
      { id: agent(4), ms: 20 },
      { id: agent(5) },
      { id: agent(6) },
    ]);
    const res = await runsIn();
    expect(res.status, res.text).toBe(409);
    expect(res.running).toBe(0);
    expect(pins.most).toBe(4);
    expect(asked).not.toContain(`projectsOf agent ${agent(5)}`);
    expect(asked).not.toContain(`projectsOf agent ${agent(6)}`);
  });

  test("an agent in none of the caller's projects is read no further: neither its pins nor its versions", async () => {
    // Staging and QA serve the second agent; the caller reads prod only.
    const { runsIn, pins, asked, checked } = harness([
      { id: agent(1) },
      { id: agent(2), projects: [STAGING, QA] },
    ]);
    const res = await runsIn();
    expect(res.status, res.text).toBe(200);
    expect(rowsOf(res)).toEqual([row(agent(1))]);
    expect(asked).toContain(`projectsOf agent ${agent(2)}`);
    expect(pins.listed).toEqual([agent(1)]);
    expect(checked.filter((c) => c.endsWith(`agent:${agent(2)}`))).toEqual([]);
  });
});
