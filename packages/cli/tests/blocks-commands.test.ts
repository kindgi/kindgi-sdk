// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

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

describe('kindgi blocks', () => {
  test('publish --prompt reads the template from a file', async () => {
    const { calls, rec } = recorder();
    const file = join(cwd, 'intake.liquid');
    await writeFile(file, 'Sort the request for {{ firm }}.', 'utf8');
    const out = await run(
      [
        'blocks',
        'publish',
        'acme.intake-prompt',
        '--block-version=1.1.0',
        '--project=p-1',
        `--prompt=@${file}`,
      ],
      { blocks: { publish: rec('publish') } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'publish',
        {
          id: 'acme.intake-prompt',
          version: '1.1.0',
          kind: 'prompt',
          content: { template: 'Sort the request for {{ firm }}.' },
        },
        { projectId: 'p-1' },
      ],
    ]);
  });

  test('publish --settings takes values and a schema as JSON', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'blocks',
        'publish',
        'acme.weights',
        '--block-version=1.0.0',
        '--project=p-1',
        '--settings={"recency":0.3}',
        '--schema={"type":"object"}',
        '--description=First weights',
      ],
      { blocks: { publish: rec('publish') } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls[0]?.[1]).toEqual({
      id: 'acme.weights',
      version: '1.0.0',
      kind: 'settings',
      content: { values: { recency: 0.3 }, schema: { type: 'object' } },
      description: 'First weights',
    });
  });

  test('publish takes a full definition as JSON, and refuses both --prompt and --settings', async () => {
    const { calls, rec } = recorder();
    const definition = {
      id: 'acme.weights',
      version: '2.0.0',
      kind: 'settings',
      content: { values: {} },
    };
    const ok = await run(['blocks', 'publish', '--project=p-1', JSON.stringify(definition)], {
      blocks: { publish: rec('publish') },
    });
    expect(ok.exitCode, ok.stderr).toBe(0);
    expect(calls).toEqual([['publish', definition, { projectId: 'p-1' }]]);

    const both = await run(
      [
        'blocks',
        'publish',
        'acme.x',
        '--block-version=1.0.0',
        '--project=p-1',
        '--prompt=hi',
        '--settings={}',
      ],
      { blocks: {} },
    );
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain('Give one of --prompt or --settings');
  });

  test('show, versions, unregister and reinstate', async () => {
    const { calls, rec } = recorder();
    const client = {
      blocks: {
        get: rec('get'),
        versions: {
          get: rec('versions.get'),
          list: rec('versions.list', { data: [], hasMore: false }),
          unregister: rec('versions.unregister'),
          reinstate: rec('versions.reinstate'),
        },
      },
    };
    for (const argv of [
      ['blocks', 'show', 'acme.weights'],
      ['blocks', 'show', 'acme.weights', '--block-version=1.0.0'],
      ['blocks', 'versions', 'acme.weights', '--include-unregistered'],
      ['blocks', 'unregister', 'acme.weights', '--block-version=1.0.0'],
      ['blocks', 'reinstate', 'acme.weights', '--block-version=1.0.0'],
    ]) {
      const out = await run(argv, client);
      expect(out.exitCode, out.stderr).toBe(0);
    }
    expect(calls).toEqual([
      ['get', 'acme.weights'],
      ['versions.get', 'acme.weights', '1.0.0'],
      ['versions.list', 'acme.weights', { includeTombstoned: true }],
      ['versions.unregister', 'acme.weights', '1.0.0'],
      ['versions.reinstate', 'acme.weights', '1.0.0'],
    ]);
  });
});
