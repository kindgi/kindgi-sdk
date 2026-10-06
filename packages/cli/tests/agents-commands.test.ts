// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

function promotion(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    agentId: 'acme.drafter',
    scope: { kind: 'segment', projectId: PROJECT, path: [{ key: 'company', value: 'acme' }] },
    action: 'promote',
    fromVersion: null,
    toVersion: '1.1.0',
    requestedBy: { kind: 'user', id: 'u-1' },
    createdAt: '2026-10-05T12:00:00.000Z',
    ...over,
  };
}

describe('kindgi agents — the registry', () => {
  test('list, get (latest or a version), versions and unregister call the client', async () => {
    const { calls, rec } = recorder();
    const client = {
      agents: {
        list: rec('list', { data: [], hasMore: false }),
        get: rec('get'),
        versions: {
          get: rec('versions.get'),
          list: rec('versions.list', { data: [], hasMore: false }),
          unregister: rec('versions.unregister'),
        },
      },
    };
    for (const argv of [
      ['agents', 'list', '--name=acme', '--limit=5'],
      ['agents', 'get', 'acme.drafter'],
      ['agents', 'get', 'acme.drafter', '1.0.0'],
      ['agents', 'versions', 'acme.drafter', '--cursor=c-1'],
      ['agents', 'unregister', 'acme.drafter', '1.0.0'],
    ]) {
      const out = await run(argv, client);
      expect(out.exitCode, out.stderr).toBe(0);
    }
    expect(calls).toEqual([
      ['list', { limit: 5, name: 'acme' }],
      ['get', 'acme.drafter'],
      ['versions.get', 'acme.drafter', '1.0.0'],
      ['versions.list', 'acme.drafter', { cursor: 'c-1' }],
      ['versions.unregister', 'acme.drafter', '1.0.0'],
    ]);
  });

  test('unregister without a version fails before calling', async () => {
    const { calls, rec } = recorder();
    const out = await run(['agents', 'unregister', 'acme.drafter'], {
      agents: { versions: { unregister: rec('versions.unregister') } },
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('version');
    expect(calls).toEqual([]);
  });
});

describe('kindgi agents — live versions', () => {
  test('live resolves for a project and a segment path, in order', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'agents',
        'live',
        'acme.drafter',
        `--project=${PROJECT}`,
        '--segment=company:acme',
        '--segment=role:counsel',
      ],
      { agents: { live: { resolve: rec('resolve', { version: '1.1.0', via: 'live' }) } } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'resolve',
        'acme.drafter',
        {
          projectId: PROJECT,
          segments: [
            { key: 'company', value: 'acme' },
            { key: 'role', value: 'counsel' },
          ],
        },
      ],
    ]);
  });

  test('promote to a segment scope, with a reason and the eval run', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'agents',
        'promote',
        'acme.drafter',
        '1.1.0',
        `--project=${PROJECT}`,
        '--segment=company:acme',
        '--reason=passed the gate',
        '--eval-run=er-1',
        '--idempotency-key=k-1',
      ],
      { agents: { promotions: { create: rec('create', promotion()) } } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'create',
        'acme.drafter',
        {
          version: '1.1.0',
          scope: { kind: 'segment', projectId: PROJECT, path: [{ key: 'company', value: 'acme' }] },
          reason: 'passed the gate',
          evalRunId: 'er-1',
        },
        { idempotencyKey: 'k-1' },
      ],
    ]);
  });

  test.each([
    [['1.1.0'], 'Name the scope'],
    [['1.1.0', '--tenant', `--org=${ORG}`], 'one of --tenant, --org or --project'],
    [['1.1.0', '--segment=company:acme'], '--segment needs --project'],
    [['1.1.0', `--project=${PROJECT}`, '--segment=company'], 'key:value'],
    [['--tenant'], 'version'],
  ])('promote %j fails before calling: %s', async (flags, message) => {
    const { calls, rec } = recorder();
    const out = await run(['agents', 'promote', 'acme.drafter', ...flags], {
      agents: { promotions: { create: rec('create') } },
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain(message);
    expect(calls).toEqual([]);
  });

  test('rollback an org to a named version; unpin the tenant', async () => {
    const { calls, rec } = recorder();
    const client = {
      agents: {
        live: {
          rollback: rec('rollback', promotion({ action: 'rollback' })),
          unpin: rec('unpin', promotion({ action: 'unpin' })),
        },
      },
    };
    const rolled = await run(
      ['agents', 'rollback', 'acme.drafter', `--org=${ORG}`, '--to=1.0.0'],
      client,
    );
    expect(rolled.exitCode, rolled.stderr).toBe(0);
    const unpinned = await run(['agents', 'unpin', 'acme.drafter', '--tenant'], client);
    expect(unpinned.exitCode, unpinned.stderr).toBe(0);
    expect(calls).toEqual([
      ['rollback', 'acme.drafter', { scope: { kind: 'org', orgId: ORG }, toVersion: '1.0.0' }, {}],
      ['unpin', 'acme.drafter', { scope: { kind: 'tenant' } }, {}],
    ]);
  });

  test('live-versions --table shows each scope and its version', async () => {
    const { rec } = recorder();
    const out = await run(['agents', 'live-versions', 'acme.drafter', '--table'], {
      agents: {
        live: {
          list: rec('list', {
            data: [
              {
                agentId: 'acme.drafter',
                scope: {
                  kind: 'segment',
                  projectId: PROJECT,
                  path: [{ key: 'company', value: 'acme' }],
                },
                version: '1.1.0',
                promotionId: 'p-1',
                setAt: '2026-10-05T12:00:00.000Z',
              },
            ],
          }),
        },
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).toContain('SCOPE');
    expect(out.stdout).toContain(`project ${PROJECT} company=acme`);
    expect(out.stdout).toContain('1.1.0');
  });

  test('promotions list --table says where each row stands', async () => {
    const out = await run(['agents', 'promotions', 'list', 'acme.drafter', '--table'], {
      agents: {
        promotions: {
          list: async () => ({
            data: [
              promotion({ id: 'p-pending', toVersion: '1.4.0', status: 'pending-approval' }),
              promotion({ id: 'p-refused', toVersion: '1.3.0', status: 'refused' }),
              promotion({ id: 'p-live', toVersion: '1.2.0', status: 'promoted' }),
              promotion({ id: 'p-before-gates', toVersion: '1.1.0' }),
              promotion({ id: 'p-unpin', action: 'unpin', fromVersion: '1.1.0', toVersion: null }),
            ],
            hasMore: false,
          }),
        },
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    const lines = out.stdout.split('\n');
    expect(lines[0]).toMatch(/^ID\s+ACTION\s+STATUS\s+SCOPE/);
    const status = (id: string) => lines.find((l) => l.startsWith(id))?.split(/\s+/)[2];
    expect(status('p-pending')).toBe('pending-approval');
    expect(status('p-refused')).toBe('refused');
    expect(status('p-live')).toBe('promoted');
    expect(status('p-before-gates')).toBe('promoted');
    expect(status('p-unpin')).toBe('done');
  });

  test('promotions list narrows to a scope; promotions get fetches one', async () => {
    const { calls, rec } = recorder();
    const client = {
      agents: {
        promotions: {
          list: rec('list', { data: [promotion()], hasMore: false }),
          get: rec('get', promotion()),
        },
      },
    };
    const listed = await run(
      ['agents', 'promotions', 'list', 'acme.drafter', `--project=${PROJECT}`, '--limit=10'],
      client,
    );
    expect(listed.exitCode, listed.stderr).toBe(0);
    const got = await run(['agents', 'promotions', 'get', 'acme.drafter', 'p-1'], client);
    expect(got.exitCode, got.stderr).toBe(0);
    expect(calls).toEqual([
      ['list', 'acme.drafter', { limit: 10, scope: { kind: 'project', projectId: PROJECT } }],
      ['get', 'acme.drafter', 'p-1'],
    ]);
  });
});
