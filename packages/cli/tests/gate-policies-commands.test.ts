// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi gate-policies …`, `kindgi agents gate-policy` and `kindgi agents promote --check` (evals step 4b). */

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
const POLICY = {
  id: 'acme.drafter-prod',
  version: '1.0.0',
  agentId: 'acme.drafter',
  scope: { kind: 'project', projectId: PROJECT },
  spec: { metrics: [{ name: 'weightedYesShare', minCandidate: 0.7 }], approvals: {} },
  createdAt: '2026-10-06T12:00:00.000Z',
};

describe('kindgi gate-policies', () => {
  test('publish, with the spec from a file', async () => {
    const { calls, rec } = recorder();
    const file = join(cwd, 'spec.json');
    await writeFile(file, JSON.stringify(POLICY.spec));
    const out = await run(
      [
        'gate-policies',
        'publish',
        'acme.drafter-prod',
        '--policy-version=1.0.0',
        '--agent=acme.drafter',
        `--project=${PROJECT}`,
        `--spec=@${file}`,
        '--description=Production gate',
      ],
      { gatePolicies: { publish: rec('publish', POLICY) } },
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
          spec: POLICY.spec,
          description: 'Production gate',
        },
      ],
    ]);
  });

  test.each([
    [['--agent=acme.drafter', '--tenant', '--spec={}'], '--policy-version'],
    [['--policy-version=1.0.0', '--tenant', '--spec={}'], '--agent'],
    [['--policy-version=1.0.0', '--agent=acme.drafter', '--spec={}'], 'Name the scope'],
    [['--policy-version=1.0.0', '--agent=acme.drafter', '--tenant'], '--spec'],
  ])('publish %j fails before calling: %s', async (flags, message) => {
    const { calls, rec } = recorder();
    const out = await run(['gate-policies', 'publish', 'acme.drafter-prod', ...flags], {
      gatePolicies: { publish: rec('publish') },
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain(message);
    expect(calls).toEqual([]);
  });

  test('list for an agent, as a table', async () => {
    const { calls, rec } = recorder();
    const out = await run(['gate-policies', 'list', '--agent=acme.drafter', '--table'], {
      gatePolicies: { list: rec('list', { data: [POLICY], hasMore: false }) },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['list', { agentId: 'acme.drafter' }]]);
    expect(out.stdout).toMatch(/acme\.drafter-prod\s+1\.0\.0\s+acme\.drafter\s+project /);
  });

  test('show (latest or a version), versions, unregister and reinstate call the client', async () => {
    const { calls, rec } = recorder();
    const client = {
      gatePolicies: {
        get: rec('get', POLICY),
        versions: {
          get: rec('versions.get', POLICY),
          list: rec('versions.list', { data: [POLICY], hasMore: false }),
          unregister: rec('versions.unregister', POLICY),
          reinstate: rec('versions.reinstate', POLICY),
        },
      },
    };
    for (const argv of [
      ['gate-policies', 'show', 'acme.drafter-prod'],
      ['gate-policies', 'show', 'acme.drafter-prod', '1.0.0'],
      ['gate-policies', 'versions', 'acme.drafter-prod'],
      ['gate-policies', 'unregister', 'acme.drafter-prod', '1.0.0'],
      ['gate-policies', 'reinstate', 'acme.drafter-prod', '1.0.0'],
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
  test('gate-policy resolves the policy for a scope', async () => {
    const { calls, rec } = recorder();
    const out = await run(['agents', 'gate-policy', 'acme.drafter', '--tenant'], {
      agents: { gatePolicy: { resolve: rec('resolve', { policy: null }) } },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['resolve', 'acme.drafter', { kind: 'tenant' }]]);
    expect(JSON.parse(out.stdout)).toEqual({ policy: null });
  });

  test('promote --check asks the gate and changes nothing', async () => {
    const { calls, rec } = recorder();
    const answer = {
      outcome: 'needs-approval',
      policy: { id: POLICY.id, version: '1.0.0' },
      checks: [],
    };
    const out = await run(
      [
        'agents',
        'promote',
        'acme.drafter',
        '1.2.0',
        `--project=${PROJECT}`,
        '--eval-run=er-1',
        '--check',
      ],
      { agents: { promotions: { check: rec('check', answer), create: rec('create') } } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'check',
        'acme.drafter',
        { version: '1.2.0', scope: { kind: 'project', projectId: PROJECT }, evalRunId: 'er-1' },
      ],
    ]);
    expect(JSON.parse(out.stdout)).toEqual(answer);
  });
});
