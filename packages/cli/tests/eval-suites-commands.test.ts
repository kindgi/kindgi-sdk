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

describe('kindgi eval-suites', () => {
  test('list narrows by kind and project', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['eval-suites', 'list', '--kind=judged', '--project=p-1', '--limit=5', '--cursor=c1'],
      { evalSuites: { list: rec('list', { data: [], hasMore: false }) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['list', { kind: 'judged', scopeKind: 'project', scopeId: 'p-1', limit: 5, cursor: 'c1' }],
    ]);
  });

  test('list rejects an unknown kind', async () => {
    const out = await run(['eval-suites', 'list', '--kind=bogus'], { evalSuites: {} });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('--kind must be one of');
  });

  test('show gets the latest, or a version with --suite-version', async () => {
    const { calls, rec } = recorder();
    const client = {
      evalSuites: { get: rec('get'), versions: { get: rec('versions.get') } },
    };
    expect((await run(['eval-suites', 'show', 'acme.matches'], client)).exitCode).toBe(0);
    expect(
      (await run(['eval-suites', 'show', 'acme.matches', '--suite-version=1.2.0'], client))
        .exitCode,
    ).toBe(0);
    expect(calls).toEqual([
      ['get', 'acme.matches'],
      ['versions.get', 'acme.matches', '1.2.0'],
    ]);
  });

  test('from-judgments sends the filters, repeated classes included', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'eval-suites',
        'from-judgments',
        'acme.matches',
        '--suite-version=1.0.0',
        '--project=p-1',
        '--agent=acme.matcher',
        '--agent-version=2.0.0',
        '--since=2026-10-01T00:00:00Z',
        '--until=2026-10-05T00:00:00Z',
        '--class=jc-1',
        '--class=jc-2',
        '--min-judgments=2',
        '--description=First set',
      ],
      { evalSuites: { buildFromJudgments: rec('build', { caseCount: 3 }) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'build',
        'acme.matches',
        {
          version: '1.0.0',
          projectId: 'p-1',
          agentId: 'acme.matcher',
          agentVersion: '2.0.0',
          since: '2026-10-01T00:00:00Z',
          until: '2026-10-05T00:00:00Z',
          description: 'First set',
          judgeClassIds: ['jc-1', 'jc-2'],
          minJudgments: 2,
        },
      ],
    ]);
    expect(JSON.parse(out.stdout)).toEqual({ caseCount: 3 });
  });

  test('from-judgments with a flow and nothing else', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['eval-suites', 'from-judgments', 's', '--suite-version=1.0.0', '--project=p-1', '--flow=f'],
      { evalSuites: { buildFromJudgments: rec('build') } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['build', 's', { version: '1.0.0', projectId: 'p-1', flowId: 'f' }]]);
  });

  test('from-judgments checks its flags', async () => {
    const client = { evalSuites: {} };
    const base = ['eval-suites', 'from-judgments', 's'];
    expect((await run([...base, '--project=p', '--agent=a'], client)).stderr).toContain(
      '--suite-version',
    );
    expect((await run([...base, '--suite-version=1.0.0', '--agent=a'], client)).stderr).toContain(
      '--project',
    );
    const ok = [...base, '--suite-version=1.0.0', '--project=p'];
    expect((await run(ok, client)).stderr).toContain('exactly one of --agent');
    expect((await run([...ok, '--agent=a', '--flow=f'], client)).stderr).toContain('exactly one');
    expect((await run([...ok, '--flow=f', '--agent-version=2'], client)).stderr).toContain(
      '--agent-version needs --agent',
    );
    expect((await run([...ok, '--flow=f', '--min-judgments=0'], client)).stderr).toContain(
      '--min-judgments must be 1 or more',
    );
  });

  test('cases pages a version', async () => {
    const { calls, rec } = recorder();
    const client = { evalSuites: { listCases: rec('cases', { data: [], hasMore: false }) } };
    const out = await run(
      ['eval-suites', 'cases', 's', '--suite-version=1.0.0', '--limit=10', '--cursor=c2'],
      client,
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['cases', 's', '1.0.0', { limit: 10, cursor: 'c2' }]]);
    expect((await run(['eval-suites', 'cases', 's'], client)).stderr).toContain('--suite-version');
  });
});
