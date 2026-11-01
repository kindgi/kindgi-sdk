// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

describe('kindgi blocks', () => {
  test("list --project lists that project's blocks (a project scope)", async () => {
    const { calls, rec } = recorder();
    const out = await run(['blocks', 'list', '--project=p-1', '--kind=settings'], {
      blocks: { list: rec('list', { data: [], hasMore: false }) },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['list', { kind: 'settings', scope: { kind: 'project', projectId: 'p-1' } }],
    ]);
  });
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
    expect(both.exitCode).toBe(2);
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

describe('kindgi blocks pull', () => {
  /** A pack in `cwd` with a prompt block at 1.0.0 and a settings block at 2.0.0. */
  async function pack() {
    await mkdir(join(cwd, 'blocks'), { recursive: true });
    const tone = {
      id: 'acme.tone',
      version: '1.0.0',
      kind: 'prompt',
      description: 'How replies sound',
      content: { template: 'Be brief.' },
    };
    const weights = {
      id: 'acme.weights',
      version: '2.0.0',
      kind: 'settings',
      content: { values: {} },
    };
    await writeFile(join(cwd, 'blocks/tone.json'), `${JSON.stringify(tone, null, 2)}\n`);
    await writeFile(join(cwd, 'blocks/weights.json'), `${JSON.stringify(weights, null, 2)}\n`);
  }
  const row = (blockVersion: string) => ({
    projectId: 'p-1',
    agentId: 'acme.desk',
    agentVersion: '1.0.0',
    blockVersion,
    follows: 'pin',
  });
  /** The runtime's block versions: the pack's files hold acme.tone 1.0.0 and acme.weights 2.0.0. */
  const VERSIONS: Record<string, Record<string, unknown>> = {
    'acme.tone@1.0.0': { template: 'Be brief.' },
    'acme.tone@1.2.0': { template: 'Be brief and kind.' },
    'acme.weights@2.0.0': { values: {}, schema: { type: 'object' } },
    'acme.weights@2.1.0': { values: { calls: 2 }, schema: { type: 'object' } },
  };
  /** `versions.get` from VERSIONS, recording each call; any other is block-not-found. */
  function versionsGet(calls: [string, ...unknown[]][]) {
    return async (blockId: string, version: string) => {
      calls.push(['versions.get', blockId, version]);
      const content = VERSIONS[`${blockId}@${version}`];
      if (content === undefined) {
        throw new KindgiApiError(
          fromWire({ code: 'block-not-found', message: `No ${blockId} ${version}.` }, 404),
        );
      }
      return { content };
    };
  }
  /** `runsIn` that runs each block at these versions, recording each call. */
  function runsInAt(calls: [string, ...unknown[]][], versions: Record<string, string[]>) {
    return async (blockId: string) => {
      calls.push(['runsIn', blockId]);
      return { data: (versions[blockId] ?? []).map(row) };
    };
  }
  async function pull(argv: readonly string[], client: Record<string, unknown>) {
    return runCli({
      argv: ['blocks', 'pull', ...argv, '--url=https://x', '--token=t'],
      env: {},
      cwd,
      home,
      clientFactory: () => client as never,
      buildConfigLoader: async () => ({ pack: { id: 'acme.app', version: '1.0.0' } }),
    });
  }

  test('writes the newest version running anywhere where it is newer than the file', async () => {
    await pack();
    const calls: [string, ...unknown[]][] = [];
    const out = await pull([], {
      blocks: {
        runsIn: runsInAt(calls, { 'acme.tone': ['1.1.0', '1.2.0'], 'acme.weights': ['1.0.0'] }),
        versions: { get: versionsGet(calls) },
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    // Every block is checked against its file's own version before any is written.
    expect(calls).toEqual([
      ['runsIn', 'acme.tone'],
      ['versions.get', 'acme.tone', '1.0.0'],
      ['runsIn', 'acme.weights'],
      ['versions.get', 'acme.tone', '1.2.0'],
    ]);
    expect(JSON.parse(out.stdout)).toEqual({
      wrote: [{ blockId: 'acme.tone', from: '1.0.0', to: '1.2.0', file: 'blocks/tone.json' }],
      // 2.0.0 in the file is newer than anything that runs: it's left as it is.
      unchanged: [{ blockId: 'acme.weights', version: '2.0.0', runs: '1.0.0' }],
    });
    expect(JSON.parse(await readFile(join(cwd, 'blocks/tone.json'), 'utf8'))).toEqual({
      id: 'acme.tone',
      version: '1.2.0',
      kind: 'prompt',
      description: 'How replies sound',
      content: { template: 'Be brief and kind.' },
    });
  });

  test('only the blocks named, and a block that runs nowhere is left', async () => {
    await pack();
    const { calls, rec } = recorder();
    const out = await pull(['acme.weights'], {
      blocks: { runsIn: rec('runsIn', { data: [] }) },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['runsIn', 'acme.weights']]);
    expect(JSON.parse(out.stdout)).toEqual({
      wrote: [],
      unchanged: [{ blockId: 'acme.weights', version: '2.0.0' }],
    });
  });

  describe("a file that doesn't hold its own version as the runtime has it is refused, and nothing is written", () => {
    test.each<[string, () => Promise<void>, string]>([
      [
        'an edited block file',
        async () => {
          const tone = JSON.parse(await readFile(join(cwd, 'blocks/tone.json'), 'utf8'));
          await writeFile(
            join(cwd, 'blocks/tone.json'),
            `${JSON.stringify({ ...tone, content: { template: 'Be short.' } }, null, 2)}\n`,
          );
        },
        "blocks/tone.json holds acme.tone 1.0.0 with edits that aren't in the runtime's 1.0.0: pulling 1.2.0 would drop them. Give the edits a version of their own and deploy it, or undo them (`git restore -- blocks/tone.json`), then pull again.",
      ],
      [
        'an edited template file',
        async () => {
          const tone = JSON.parse(await readFile(join(cwd, 'blocks/tone.json'), 'utf8'));
          await writeFile(join(cwd, 'blocks/tone.liquid'), 'Be short.');
          await writeFile(
            join(cwd, 'blocks/tone.json'),
            `${JSON.stringify({ ...tone, content: { templateFile: 'tone.liquid' } }, null, 2)}\n`,
          );
        },
        "blocks/tone.json and its template blocks/tone.liquid hold acme.tone 1.0.0 with edits that aren't in the runtime's 1.0.0: pulling 1.2.0 would drop them. Give the edits a version of their own and deploy it, or undo them (`git restore -- blocks/tone.json blocks/tone.liquid`), then pull again.",
      ],
      [
        "a version the runtime doesn't have",
        async () => {
          const tone = JSON.parse(await readFile(join(cwd, 'blocks/tone.json'), 'utf8'));
          await writeFile(
            join(cwd, 'blocks/tone.json'),
            `${JSON.stringify({ ...tone, version: '1.0.1' }, null, 2)}\n`,
          );
        },
        "blocks/tone.json holds acme.tone 1.0.1, which this runtime doesn't have, so Kindgi can't tell whether it holds edits. Deploy 1.0.1 first, or bring the file back to a version the runtime has.",
      ],
    ])('%s', async (_name, edit, said) => {
      await pack();
      await edit();
      const before = await readFile(join(cwd, 'blocks/tone.json'), 'utf8');
      const calls: [string, ...unknown[]][] = [];
      const out = await pull(['acme.tone'], {
        blocks: {
          runsIn: runsInAt(calls, { 'acme.tone': ['1.2.0'] }),
          versions: { get: versionsGet(calls) },
        },
      });
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(said);
      expect(await readFile(join(cwd, 'blocks/tone.json'), 'utf8')).toBe(before);
      // The version that runs isn't even fetched.
      expect(calls.filter(([name]) => name === 'versions.get')).toHaveLength(1);
    });
  });

  test('every refused file is named, and none of the blocks is written', async () => {
    await pack();
    const tone = JSON.parse(await readFile(join(cwd, 'blocks/tone.json'), 'utf8'));
    await writeFile(
      join(cwd, 'blocks/tone.json'),
      `${JSON.stringify({ ...tone, content: { template: 'Be short.' } }, null, 2)}\n`,
    );
    const weights = JSON.parse(await readFile(join(cwd, 'blocks/weights.json'), 'utf8'));
    await writeFile(
      join(cwd, 'blocks/weights.json'),
      `${JSON.stringify({ ...weights, version: '2.0.1' }, null, 2)}\n`,
    );
    const calls: [string, ...unknown[]][] = [];
    const out = await pull([], {
      blocks: {
        runsIn: runsInAt(calls, { 'acme.tone': ['1.2.0'], 'acme.weights': ['2.1.0'] }),
        versions: { get: versionsGet(calls) },
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      "blocks/tone.json holds acme.tone 1.0.0 with edits that aren't in the runtime's 1.0.0",
    );
    expect(out.stderr).toContain(
      "blocks/weights.json holds acme.weights 2.0.1, which this runtime doesn't have",
    );
    expect(JSON.parse(await readFile(join(cwd, 'blocks/tone.json'), 'utf8')).version).toBe('1.0.0');
    expect(JSON.parse(await readFile(join(cwd, 'blocks/weights.json'), 'utf8')).version).toBe(
      '2.0.1',
    );
  });

  test('a settings file that gives no schema holds its version, which the runtime stored with the schema it carried', async () => {
    await pack();
    const calls: [string, ...unknown[]][] = [];
    const out = await pull(['acme.weights'], {
      blocks: {
        runsIn: runsInAt(calls, { 'acme.weights': ['2.1.0'] }),
        versions: { get: versionsGet(calls) },
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout).wrote).toEqual([
      { blockId: 'acme.weights', from: '2.0.0', to: '2.1.0', file: 'blocks/weights.json' },
    ]);
  });

  test("a block the pack doesn't have is a usage error, before any call", async () => {
    await pack();
    const { calls, rec } = recorder();
    const out = await pull(['acme.nothing'], { blocks: { runsIn: rec('runsIn') } });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("Not among the pack's blocks");
    expect(out.stderr).toContain('acme.nothing');
    expect(calls).toEqual([]);
  });
});
