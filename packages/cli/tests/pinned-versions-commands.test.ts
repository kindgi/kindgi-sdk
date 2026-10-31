// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KindgiApiError, fromWire } from '@kindgi/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../src/main.js';

let home: string;
let cwd: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

/** Run the CLI against a stub client that records each call. */
async function run(argv: readonly string[], client: Record<string, unknown>) {
  return runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () => client as never,
  });
}

function recorder() {
  const calls: [string, ...unknown[]][] = [];
  const rec =
    (name: string, result: unknown = { ok: true }) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  return { calls, rec };
}

const PROJECT = '0b9f4c1e-1111-4a2b-8c3d-000000000001';
const ORG = '0b9f4c1e-2222-4a2b-8c3d-000000000002';

/** Each group, with an item id of its kind. */
const GROUPS = [
  ['flows', 'acme.nightly-digest'],
  ['tools', 'acme.stock-level'],
] as const;

/** A client whose `<group>.pinned` is `pinned`. */
const clientOf = (group: string, pinned: Record<string, unknown>) => ({ [group]: { pinned } });

function change(itemId: string, over: Record<string, unknown> = {}) {
  return {
    id: 'pc-1',
    itemId,
    scope: { kind: 'project', projectId: PROJECT },
    action: 'pin',
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    requestedBy: { kind: 'user', id: 'u-1' },
    createdAt: '2026-10-31T12:00:00.000Z',
    ...over,
  };
}

describe.each(GROUPS)('kindgi %s — pinned versions', (group, id) => {
  test('pinned resolves for a project, an org, or neither', async () => {
    const { calls, rec } = recorder();
    const resolved = { itemId: id, version: '1.1.0', via: 'latest' };
    const client = clientOf(group, { resolve: rec('resolve', resolved) });
    const forProject = await run([group, 'pinned', id, `--project=${PROJECT}`], client);
    expect(forProject.exitCode, forProject.stderr).toBe(0);
    expect(JSON.parse(forProject.stdout)).toEqual(resolved);
    const forOrg = await run([group, 'pinned', id, `--org=${ORG}`], client);
    expect(forOrg.exitCode, forOrg.stderr).toBe(0);
    const forTenant = await run([group, 'pinned', id], client);
    expect(forTenant.exitCode, forTenant.stderr).toBe(0);
    expect(calls).toEqual([
      ['resolve', id, { projectId: PROJECT }],
      ['resolve', id, { orgId: ORG }],
      ['resolve', id, {}],
    ]);
  });

  test('pinned with both --project and --org fails before calling', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [group, 'pinned', id, `--project=${PROJECT}`, `--org=${ORG}`],
      clientOf(group, { resolve: rec('resolve') }),
    );
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('Give --project or --org, not both');
    expect(calls).toEqual([]);
  });

  test('pin to a project, with a reason and an idempotency key; the change is printed', async () => {
    const { calls, rec } = recorder();
    const pinned = change(id, { reason: 'tried in staging' });
    const out = await run(
      [
        group,
        'pin',
        id,
        '1.1.0',
        `--project=${PROJECT}`,
        '--reason=tried in staging',
        '--idempotency-key=k-1',
      ],
      clientOf(group, { pin: rec('pin', pinned) }),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'pin',
        id,
        {
          version: '1.1.0',
          scope: { kind: 'project', projectId: PROJECT },
          reason: 'tried in staging',
        },
        { idempotencyKey: 'k-1' },
      ],
    ]);
    expect(JSON.parse(out.stdout)).toEqual(pinned);
  });

  test('pin to the tenant or an org', async () => {
    const { calls, rec } = recorder();
    const client = clientOf(group, { pin: rec('pin', change(id)) });
    expect((await run([group, 'pin', id, '1.1.0', '--tenant'], client)).exitCode).toBe(0);
    expect((await run([group, 'pin', id, '1.1.0', `--org=${ORG}`], client)).exitCode).toBe(0);
    expect(calls).toEqual([
      ['pin', id, { version: '1.1.0', scope: { kind: 'tenant' } }, {}],
      ['pin', id, { version: '1.1.0', scope: { kind: 'org', orgId: ORG } }, {}],
    ]);
  });

  test.each([
    [['1.1.0'], 'Name the scope'],
    [['1.1.0', '--tenant', `--org=${ORG}`], 'one of --tenant, --org or --project'],
    [['1.1.0', `--project=${PROJECT}`, '--segment=company:acme'], 'segment'],
    [['--tenant'], 'version'],
  ])('pin %j fails before calling: %s', async (flags, message) => {
    const { calls, rec } = recorder();
    const out = await run([group, 'pin', id, ...flags], clientOf(group, { pin: rec('pin') }));
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain(message);
    expect(calls).toEqual([]);
  });

  test("unpin a project's own pin; the change is printed", async () => {
    const { calls, rec } = recorder();
    const unpinned = change(id, { action: 'unpin', fromVersion: '1.1.0', toVersion: null });
    const out = await run(
      [group, 'unpin', id, `--project=${PROJECT}`, '--reason=back to the latest'],
      clientOf(group, { unpin: rec('unpin', unpinned) }),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'unpin',
        id,
        { scope: { kind: 'project', projectId: PROJECT }, reason: 'back to the latest' },
        {},
      ],
    ]);
    expect(JSON.parse(out.stdout)).toEqual(unpinned);
  });

  test('unpin without a scope fails before calling', async () => {
    const { calls, rec } = recorder();
    const out = await run([group, 'unpin', id], clientOf(group, { unpin: rec('unpin') }));
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('Name the scope');
    expect(calls).toEqual([]);
  });

  test('pinned-versions --table shows each scope, its version, and when and by whom it was set', async () => {
    const out = await run(
      [group, 'pinned-versions', id, '--table'],
      clientOf(group, {
        list: async () => ({
          data: [
            {
              itemId: id,
              scope: { kind: 'org', orgId: ORG },
              version: '1.1.0',
              changeId: 'pc-1',
              setAt: '2026-10-31T12:00:00.000Z',
              setBy: { kind: 'user', id: 'u-1' },
            },
          ],
        }),
      }),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    const [header, rule, row] = out.stdout.split('\n');
    expect(header).toMatch(/^SCOPE\s+VERSION\s+SET AT\s+SET BY/);
    expect(rule).toMatch(/^─+/);
    expect(row).toContain(`org ${ORG}`);
    expect(row).toContain('1.1.0');
    expect(row).toContain('user u-1');
  });

  test('pin-history list pages with --limit and --cursor', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [group, 'pin-history', 'list', id, '--limit=10', '--cursor=c-2'],
      clientOf(group, { history: rec('history', { data: [change(id)], hasMore: false }) }),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['history', id, { limit: 10, cursor: 'c-2' }]]);
  });

  test('pin-history list --table shows each pin and unpin', async () => {
    const out = await run(
      [group, 'pin-history', 'list', id, '--table'],
      clientOf(group, {
        history: async () => ({
          data: [
            change(id, { id: 'pc-unpin', action: 'unpin', fromVersion: '1.1.0', toVersion: null }),
            change(id, { id: 'pc-pin', fromVersion: null }),
          ],
          hasMore: false,
        }),
      }),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    const lines = out.stdout.split('\n');
    expect(lines[0]).toMatch(/^ID\s+ACTION\s+SCOPE\s+FROM\s+TO\s+BY\s+AT/);
    const cells = (rowId: string) => lines.find((l) => l.startsWith(rowId))?.split(/\s{2,}/);
    expect(cells('pc-unpin')?.slice(1, 5)).toEqual(['unpin', `project ${PROJECT}`, '1.1.0', '-']);
    expect(cells('pc-pin')?.slice(1, 5)).toEqual(['pin', `project ${PROJECT}`, '-', '1.1.0']);
  });
});

// A 400 is tagged as the client's `invalid-request`, a 409 with its own code.
describe('kindgi tools pin: what the API refuses is said as it says it', () => {
  test.each([
    [
      'tool-not-pinnable',
      400,
      'invalid-request',
      "A remote tool follows its server, and the runtime's own tools follow the runtime; reference it with a range.",
    ],
    [
      'environment-takes-promotions',
      409,
      'environment-takes-promotions',
      'Tools lock when an agent or flow version is made, which in this order is in its first environment: pin it there.',
    ],
  ])('%s (%i): exit 1, and the message tagged %s', async (code, status, tag, message) => {
    const out = await run(['tools', 'pin', 'acme.stock-level', '1.1.0', `--project=${PROJECT}`], {
      tools: {
        pinned: {
          pin: async () => {
            throw new KindgiApiError(fromWire({ code, message }, status));
          },
        },
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(`Error [${tag}]: ${message}`);
  });
});
