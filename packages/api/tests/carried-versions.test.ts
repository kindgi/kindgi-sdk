// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `carriedVersions`: the edits that move with a deployment to the next
 * environment, and the ones left behind.
 */

import { describe, expect, test } from 'vitest';

import type { Cursor, ProjectId, TenantId, VersionDerivation } from '@kindgi/types';

import { carriedVersions } from '../src/carried-versions.js';
import type { CarriedVersionsDeps } from '../src/carried-versions.js';
import type { DeploymentContents } from '../src/deployment-binding.js';

const tenantId = 't-1' as TenantId;
const staging = 'p-staging' as ProjectId;

interface Row {
  readonly version: string;
  readonly derivedFrom?: VersionDerivation;
  readonly unregisteredAt?: string;
}

const edited = (version: string, from: string, unregistered = false): Row => ({
  version,
  derivedFrom: { version: from, reason: 'edited', label: 'warmer tone' },
  ...(unregistered && { unregisteredAt: '2026-01-01T00:00:00Z' }),
});
const deployed = (version: string, from?: string): Row => ({
  version,
  ...(from !== undefined && { derivedFrom: { version: from, reason: 'pins-changed' } }),
});

/** Registries holding `rows` by id, paging by the asked limit, and the reach `unreached` leaves out. */
function deps(
  rows: { agents?: Record<string, Row[]>; flows?: Record<string, Row[]> },
  unreached: string[] = [],
): CarriedVersionsDeps & { pagesRead: number } {
  const counted = { pagesRead: 0 };
  const page = (all: Row[], limit: number, cursor: Cursor | undefined) => {
    counted.pagesRead += 1;
    const from = cursor === undefined ? 0 : Number(cursor);
    const data = all.slice(from, from + limit);
    return {
      data: data as never,
      ...(from + limit < all.length && { nextCursor: String(from + limit) as Cursor }),
    };
  };
  return Object.assign(counted, {
    agents: {
      listVersions: async (i: { agentId: string; limit: number; cursor?: Cursor }) =>
        page(rows.agents?.[i.agentId] ?? [], i.limit, i.cursor),
    },
    flows: {
      listVersions: async (i: { flowId: string; limit: number; cursor?: Cursor }) =>
        page(rows.flows?.[i.flowId] ?? [], i.limit, i.cursor),
    },
    reach: {
      reachable: async (i: { fromProjectId: ProjectId; ref: { id: string; version?: string } }) =>
        i.fromProjectId === staging && !unreached.includes(`${i.ref.id}@${i.ref.version}`),
    },
  }) as unknown as CarriedVersionsDeps & { pagesRead: number };
}

const ships = (
  agents: [string, string?][],
  flows: [string, string?][] = [],
): DeploymentContents => ({
  tools: [],
  guardrails: [],
  agents: agents.map(([id, version]) => ({ id, ...(version !== undefined && { version }) })),
  flows: flows.map(([id, version]) => ({ id, ...(version !== undefined && { version }) })),
});

const carry = (d: CarriedVersionsDeps, contents: DeploymentContents) =>
  carriedVersions(d, { tenantId, fromProjectId: staging, contents });

describe('carriedVersions', () => {
  test("the edits of a version it ships move with it, along the chain; another build's edits are left behind", async () => {
    const d = deps({
      agents: {
        'acme.matcher': [
          deployed('0.9.0'),
          edited('0.9.1', '0.9.0'),
          deployed('1.0.0'),
          edited('1.0.1', '1.0.0'),
          edited('1.0.2', '1.0.1'),
          // Another deploy's build of the same agent, and its edit.
          deployed('1.1.0', '1.0.0'),
          edited('1.1.1', '1.1.0'),
        ],
      },
    });
    expect(await carry(d, ships([['acme.matcher', '1.0.0']]))).toEqual({
      carried: [
        { kind: 'agent', id: 'acme.matcher', version: '1.0.1' },
        { kind: 'agent', id: 'acme.matcher', version: '1.0.2' },
      ],
      leftBehind: [
        { kind: 'agent', id: 'acme.matcher', version: '0.9.1', from: '0.9.0' },
        { kind: 'agent', id: 'acme.matcher', version: '1.1.1', from: '1.1.0' },
      ],
    });
  });

  test('an edit of a later build is left behind when the earlier build moves, though that build derives from it', async () => {
    // 1.1.0 is another deploy's build of the agent (its pins changed from 1.0.0), and 1.1.1 edits it.
    // 1.1.1 leads back to 1.0.0 only through that build: it isn't an edit of what moves.
    const d = deps({
      agents: { a: [deployed('1.0.0'), deployed('1.1.0', '1.0.0'), edited('1.1.1', '1.1.0')] },
    });
    expect(await carry(d, ships([['a', '1.0.0']]))).toEqual({
      carried: [],
      leftBehind: [{ kind: 'agent', id: 'a', version: '1.1.1', from: '1.1.0' }],
    });
  });

  test('a version it ships is not carried, though it is an edit', async () => {
    const d = deps({ agents: { a: [deployed('1.0.0'), edited('1.0.1', '1.0.0')] } });
    expect(
      await carry(
        d,
        ships([
          ['a', '1.0.0'],
          ['a', '1.0.1'],
        ]),
      ),
    ).toEqual({
      carried: [],
      leftBehind: [],
    });
  });

  test('an unregistered edit stays; a chain through one still leads to the build', async () => {
    const d = deps({
      agents: {
        a: [deployed('1.0.0'), edited('1.0.1', '1.0.0', true), edited('1.0.2', '1.0.1')],
      },
    });
    expect(await carry(d, ships([['a', '1.0.0']]))).toEqual({
      carried: [{ kind: 'agent', id: 'a', version: '1.0.2' }],
      leftBehind: [],
    });
  });

  test("an edit the deployment's project doesn't reach neither moves nor is left behind", async () => {
    const d = deps(
      { agents: { a: [deployed('1.0.0'), edited('1.0.1', '1.0.0'), edited('0.9.1', '0.9.0')] } },
      ['a@1.0.1', 'a@0.9.1'],
    );
    expect(await carry(d, ships([['a', '1.0.0']]))).toEqual({ carried: [], leftBehind: [] });
    // From another project, nothing is reached.
    expect(
      await carriedVersions(d, {
        tenantId,
        fromProjectId: 'p-prod' as ProjectId,
        contents: ships([['a', '1.0.0']]),
      }),
    ).toEqual({ carried: [], leftBehind: [] });
  });

  test('flows by the same rule, after agents; an item shipped without a version carries nothing', async () => {
    const d = deps({
      agents: { a: [deployed('1.0.0'), edited('1.0.1', '1.0.0')] },
      flows: { f: [deployed('2.0.0'), edited('2.0.1', '2.0.0')] },
    });
    expect(await carry(d, ships([['a']], [['f', '2.0.0']]))).toEqual({
      carried: [{ kind: 'flow', id: 'f', version: '2.0.1' }],
      leftBehind: [],
    });
  });

  test('every page of versions is read; a chain that loops ends', async () => {
    const many = Array.from({ length: 230 }, (_, i) => deployed(`0.0.${i}`));
    const d = deps({
      agents: {
        a: [...many, deployed('1.0.0'), edited('1.0.1', '1.0.0')],
        b: [deployed('1.0.0'), edited('1.0.1', '1.0.2'), edited('1.0.2', '1.0.1')],
      },
    });
    expect(
      await carry(
        d,
        ships([
          ['a', '1.0.0'],
          ['b', '1.0.0'],
        ]),
      ),
    ).toEqual({
      carried: [{ kind: 'agent', id: 'a', version: '1.0.1' }],
      leftBehind: [
        { kind: 'agent', id: 'b', version: '1.0.1', from: '1.0.1' },
        { kind: 'agent', id: 'b', version: '1.0.2', from: '1.0.2' },
      ],
    });
    // a: three pages; b: one; the flows: none.
    expect(d.pagesRead).toBe(4);
  });

  test('without the registries, nothing is carried', async () => {
    expect(
      await carriedVersions(
        {},
        { tenantId, fromProjectId: staging, contents: ships([['a', '1.0.0']]) },
      ),
    ).toEqual({
      carried: [],
      leftBehind: [],
    });
  });
});
