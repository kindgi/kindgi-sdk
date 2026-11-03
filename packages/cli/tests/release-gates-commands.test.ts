// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi release-gates …`, `kindgi agents release-gate` and `kindgi agents pin --check`. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const RELEASE_GATE = {
  id: 'acme.drafter-prod',
  version: '1.0.0',
  agentId: 'acme.drafter',
  scope: { kind: 'project', projectId: PROJECT },
  spec: { metrics: [{ name: 'passRate', minCandidate: 0.7 }], approvals: {} },
  createdAt: '2026-10-06T12:00:00.000Z',
};

describe('kindgi release-gates', () => {
  test('publish, with the spec from a file', async () => {
    const { calls, rec } = recorder();
    const file = join(cwd, 'spec.json');
    await writeFile(file, JSON.stringify(RELEASE_GATE.spec));
    const out = await run(
      [
        'release-gates',
        'publish',
        'acme.drafter-prod',
        '--release-gate-version=1.0.0',
        '--agent=acme.drafter',
        `--project=${PROJECT}`,
        `--spec=@${file}`,
        '--description=Production gate',
      ],
      { releaseGates: { publish: rec('publish', RELEASE_GATE) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'publish',
        {
          id: 'acme.drafter-prod',
          version: '1.0.0',
          agentId: 'acme.drafter',
          scope: { kind: 'project', projectId: PROJECT },
          spec: RELEASE_GATE.spec,
          description: 'Production gate',
        },
      ],
    ]);
  });

  test.each([
    [['--agent=acme.drafter', '--tenant', '--spec={}'], '--release-gate-version'],
    [['--release-gate-version=1.0.0', '--tenant', '--spec={}'], '--agent'],
    [['--release-gate-version=1.0.0', '--agent=acme.drafter', '--spec={}'], 'Name the scope'],
    [['--release-gate-version=1.0.0', '--agent=acme.drafter', '--tenant'], '--spec'],
  ])('publish %j fails before calling: %s', async (flags, message) => {
    const { calls, rec } = recorder();
    const out = await run(['release-gates', 'publish', 'acme.drafter-prod', ...flags], {
      releaseGates: { publish: rec('publish') },
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain(message);
    expect(calls).toEqual([]);
  });

  test('list for an agent, as a table', async () => {
    const { calls, rec } = recorder();
    const out = await run(['release-gates', 'list', '--agent=acme.drafter', '--table'], {
      releaseGates: { list: rec('list', { data: [RELEASE_GATE], hasMore: false }) },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['list', { agentId: 'acme.drafter' }]]);
    expect(out.stdout).toMatch(/acme\.drafter-prod\s+1\.0\.0\s+acme\.drafter\s+project /);
  });

  test('show (latest or a version), versions, unregister and reinstate call the client', async () => {
    const { calls, rec } = recorder();
    const client = {
      releaseGates: {
        get: rec('get', RELEASE_GATE),
        versions: {
          get: rec('versions.get', RELEASE_GATE),
          list: rec('versions.list', { data: [RELEASE_GATE], hasMore: false }),
          unregister: rec('versions.unregister', RELEASE_GATE),
          reinstate: rec('versions.reinstate', RELEASE_GATE),
        },
      },
    };
    for (const argv of [
      ['release-gates', 'show', 'acme.drafter-prod'],
      ['release-gates', 'show', 'acme.drafter-prod', '1.0.0'],
      ['release-gates', 'versions', 'acme.drafter-prod'],
      ['release-gates', 'unregister', 'acme.drafter-prod', '1.0.0'],
      ['release-gates', 'reinstate', 'acme.drafter-prod', '1.0.0'],
    ]) {
      const out = await run(argv, client);
      expect(out.exitCode, out.stderr).toBe(0);
    }
    expect(calls).toEqual([
      ['get', 'acme.drafter-prod'],
      ['versions.get', 'acme.drafter-prod', '1.0.0'],
      ['versions.list', 'acme.drafter-prod'],
      ['versions.unregister', 'acme.drafter-prod', '1.0.0'],
      ['versions.reinstate', 'acme.drafter-prod', '1.0.0'],
    ]);
  });
});

describe('kindgi agents: the gate', () => {
  test('release-gate resolves the release gate for a scope', async () => {
    const { calls, rec } = recorder();
    const out = await run(['agents', 'release-gate', 'acme.drafter', '--tenant'], {
      agents: { releaseGate: { resolve: rec('resolve', { releaseGate: null }) } },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['resolve', 'acme.drafter', { kind: 'tenant' }]]);
    expect(JSON.parse(out.stdout)).toEqual({ releaseGate: null });
  });

  test('pin --check asks the gate and changes nothing', async () => {
    const { calls, rec } = recorder();
    const answer = {
      outcome: 'needs-approval',
      releaseGate: { id: RELEASE_GATE.id, version: '1.0.0' },
      checks: [],
    };
    const out = await run(
      [
        'agents',
        'pin',
        'acme.drafter',
        '1.2.0',
        `--project=${PROJECT}`,
        '--test-run=er-1',
        '--check',
      ],
      { agents: { pinned: { check: rec('check', answer), pin: rec('pin') } } },
    );
    // `needs-approval` is a no: the answer is printed, and it exits 3.
    expect(out.exitCode, out.stderr).toBe(3);
    expect(calls).toEqual([
      [
        'check',
        'acme.drafter',
        { version: '1.2.0', scope: { kind: 'project', projectId: PROJECT }, testRunId: 'er-1' },
      ],
    ]);
    expect(JSON.parse(out.stdout)).toEqual(answer);
  });
});
