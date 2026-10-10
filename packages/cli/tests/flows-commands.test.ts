// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi flows` (T238), through the client's `flows` and `flows.versions`. */

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

const FLOW = {
  id: 'acme.intake',
  version: '1.0.0',
  name: 'Intake',
  nodes: [{ id: 'extract', kind: 'tool', ref: 'inline' }],
  edges: [],
};
const PAGE = { data: [FLOW], hasMore: false, items: [FLOW] };

async function flows(argv: readonly string[]) {
  const calls: unknown[][] = [];
  const record =
    (name: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  const out = await runCli({
    argv: ['flows', ...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        projects: { getDefault: record('projects.getDefault', { id: 'p-default' }) },
        flows: {
          list: record('list', PAGE),
          get: record('get', FLOW),
          define: record('define', { flowId: 'acme.intake', version: '1.0.0' }),
          versions: {
            list: record('versions.list', PAGE),
            get: record('versions.get', FLOW),
            unregister: record('versions.unregister', { unregistered: true }),
            reinstate: record('versions.reinstate', { wasTombstoned: true }),
          },
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi flows (T238)', () => {
  test('list, with its filters, and --table', async () => {
    const { out, calls } = await flows(['list', '--name=acme.', '--limit=5', '--cursor=c-1']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['list', { limit: 5, cursor: 'c-1', name: 'acme.' }]]);
    const table = await flows(['list', '--table']);
    expect(table.out.stdout).toMatch(/acme\.intake\s+1\.0\.0\s+Intake\s+1/);
  });

  test('get <flow-id> is the latest version; get <flow-id> <version> is that one', async () => {
    expect((await flows(['get', 'acme.intake'])).calls).toEqual([['get', 'acme.intake']]);
    expect((await flows(['get', 'acme.intake', '1.0.0'])).calls).toEqual([
      ['versions.get', 'acme.intake', '1.0.0'],
    ]);
  });

  test('publish: into the Default project unless --project names one; it prints the id and version', async () => {
    const spec = JSON.stringify(FLOW);
    const plain = await flows(['publish', `--spec=${spec}`]);
    expect(plain.out.exitCode, plain.out.stderr).toBe(0);
    expect(plain.calls).toEqual([
      ['projects.getDefault'],
      ['define', FLOW, { projectId: 'p-default' }],
    ]);
    expect(JSON.parse(plain.out.stdout)).toEqual({ flowId: 'acme.intake', version: '1.0.0' });
    const named = await flows(['publish', `--spec=${spec}`, '--project=p-1']);
    expect(named.calls).toEqual([['define', FLOW, { projectId: 'p-1' }]]);
    const missing = await flows(['publish']);
    expect(missing.out.stderr).toContain('--spec=<json-or-@file> is required');
    expect(missing.calls).toEqual([]);
  });

  test('versions, unregister and reinstate take the flow id, and the version as an argument', async () => {
    expect((await flows(['versions', 'acme.intake', '--limit=2'])).calls).toEqual([
      ['versions.list', 'acme.intake', { limit: 2 }],
    ]);
    expect((await flows(['unregister', 'acme.intake', '1.0.0'])).calls).toEqual([
      ['versions.unregister', 'acme.intake', '1.0.0'],
    ]);
    expect((await flows(['reinstate', 'acme.intake', '1.0.0'])).calls).toEqual([
      ['versions.reinstate', 'acme.intake', '1.0.0'],
    ]);
    const noVersion = await flows(['unregister', 'acme.intake']);
    expect(noVersion.out.exitCode).not.toBe(0);
    expect(noVersion.out.stderr).toContain('version');
    expect(noVersion.calls).toEqual([]);
  });

  test('a retired flow and unregistered versions: list --include-retired, versions --include-unregistered', async () => {
    expect((await flows(['list', '--include-retired'])).calls).toEqual([
      ['list', { includeRetired: true }],
    ]);
    expect((await flows(['versions', 'acme.intake', '--include-unregistered'])).calls).toEqual([
      ['versions.list', 'acme.intake', { includeTombstoned: true }],
    ]);
  });

  test('help lists every flows command', async () => {
    const { out } = await flows(['--help']);
    for (const sub of ['list', 'get', 'publish', 'unregister', 'versions', 'reinstate']) {
      expect(out.stdout).toMatch(new RegExp(`^ {2}${sub} `, 'm'));
    }
  });
});
