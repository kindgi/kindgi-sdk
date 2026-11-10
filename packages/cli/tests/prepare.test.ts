// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
// reads-source: packages/cli/src/templates/*/AGENTS.md

/**
 * `kindgi prepare`: Kindgi Cloud's own build step. Over a Node pack with
 * faked build runners (as tests/build.test.ts does), it writes `pack.tgz`
 * and `expected-index.json`, prints one JSON line, and never sends, checks
 * an image or signs. It reads no key, token or profile, and refuses a pack
 * that needs a private registry before writing anything. It's hidden from
 * `--help`, the reference and their suggestions, and still runs.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type {
  BuildRunners,
  EsbuildBundleResult,
  LocalIndexResult,
  TarPackResult,
} from '../src/build/runners.js';
import type { Command, LeafCommand } from '../src/commands/types.js';
import { wiredCommands } from '../src/commands/unwired.js';
import { commandHelpText, rootHelpText, unknownSubcommandText } from '../src/help.js';
import { type RunCliInputs, runCli } from '../src/main.js';
import { describeCommands } from '../src/reference.js';

let cwd: string;
let home: string;
let packDir: string;

const SAMPLE_INDEX = {
  v: 1,
  packId: 'my-pack',
  packVersion: '0.1.0',
  artifactVersion: '20260921.1',
  publishedAt: '1970-01-01T00:00:00.000Z',
  tools: [
    {
      id: 'my-pack.echo',
      input: { type: 'object' },
      output: { type: 'object' },
      modulePath: 'tools/echo/index.js',
    },
  ],
  guardrails: [],
  agents: [],
  flows: [],
};
const SAMPLE_INDEX_BYTES = new TextEncoder().encode(JSON.stringify(SAMPLE_INDEX));
const TARBALL_BYTES = new TextEncoder().encode('fake-tarball-bytes');

beforeEach(async () => {
  // An empty HOME: no stored key, token or profile.
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-prepare-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-prepare-cwd-'));
  packDir = join(cwd, 'sample-pack');
  await mkdir(packDir, { recursive: true });
  await writeFile(join(packDir, 'kindgi.config.ts'), 'export default {};\n', 'utf8');
  await writeFile(
    join(packDir, 'package.json'),
    '{"name": "test-pack", "version": "0.1.0"}\n',
    'utf8',
  );
  await writeFile(join(packDir, 'package-lock.json'), '{"lockfileVersion": 3}\n', 'utf8');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

interface Calls {
  indexer: number;
  esbuild: number;
  tar: number;
  /** The steps `kindgi prepare` never takes: Kindgi Cloud does them. */
  post: number;
  stream: number;
  pull: number;
  sign: number;
}

function fakeRunners(): { readonly runners: BuildRunners; readonly calls: Calls } {
  const calls: Calls = { indexer: 0, esbuild: 0, tar: 0, post: 0, stream: 0, pull: 0, sign: 0 };
  const runners: BuildRunners = {
    runLocalIndexer: async (o) => {
      calls.indexer += 1;
      await writeFile(o.outputPath, SAMPLE_INDEX_BYTES);
      return {
        kind: 'ok',
        packId: 'my-pack',
        packVersion: '0.1.0',
        counts: { tools: 1, guardrails: 0, agents: 0, flows: 0 },
        fileErrors: [],
        index: SAMPLE_INDEX,
      } as LocalIndexResult;
    },
    esbuildBundle: async () => {
      calls.esbuild += 1;
      const res: EsbuildBundleResult = {
        emitted: ['dist/tools/echo/index.mjs', 'dist/kindgi-index.mjs'],
        totalBytes: 2048,
        externals: [],
        bundleMap: { 'tools/echo/index.ts': 'tools/echo/index.mjs' },
      };
      return res;
    },
    writeContainerfile: async (o) => {
      await writeFile(o.outputPath, '# fake containerfile\n', 'utf8');
    },
    writeContext: async (o) => {
      await mkdir(o.contextDir, { recursive: true });
    },
    tarPack: async (o) => {
      calls.tar += 1;
      await writeFile(o.outputPath, TARBALL_BYTES);
      const res: TarPackResult = {
        path: o.outputPath,
        bytes: TARBALL_BYTES,
        size: TARBALL_BYTES.length,
      };
      return res;
    },
    postBuild: async () => {
      calls.post += 1;
      throw new Error('kindgi prepare never posts a build');
    },
    streamBuildLogs: async () => {
      calls.stream += 1;
      throw new Error('kindgi prepare never streams a build');
    },
    pullImageIndex: async () => {
      calls.pull += 1;
      throw new Error('kindgi prepare never pulls an image');
    },
    signEnvelope: async () => {
      calls.sign += 1;
      throw new Error('kindgi prepare never signs');
    },
    hostPnpmVersion: async () => '10.28.0',
    loadedInstall: async () => {
      throw new Error('the pack keeps every dependency');
    },
  };
  return { runners, calls };
}

/** No env at all: no `KINDGI_API_TOKEN`, `KINDGI_TENANT_ID` or profile. */
function inputs(runners: BuildRunners, argv: readonly string[]): RunCliInputs {
  return {
    argv,
    env: {},
    cwd,
    home,
    buildRunners: runners,
    // A config with no env block: prepare reads none.
    buildConfigLoader: async () => ({ pack: { id: 'my-pack', version: '0.1.0' } }),
  };
}

describe('kindgi prepare', () => {
  test('writes pack.tgz and expected-index.json, and stdout is exactly one JSON line', async () => {
    const { runners, calls } = fakeRunners();
    const out = await runCli(
      inputs(runners, ['prepare', '--target', 'production', `--path=${packDir}`]),
    );
    expect(out.exitCode).toBe(0);

    const lines = out.stdout.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('');
    const result = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(
      ['counts', 'expectedIndex', 'packTgz', 'sha256', 'size'].sort(),
    );
    expect(result.packTgz).toMatch(/[/\\]\.kindgi[/\\]build[/\\]pack\.tgz$/);
    expect(result.expectedIndex).toMatch(/[/\\]\.kindgi[/\\]build[/\\]expected-index\.json$/);
    expect(await readFile(result.packTgz as string)).toEqual(Buffer.from(TARBALL_BYTES));
    expect(await readFile(result.expectedIndex as string)).toEqual(Buffer.from(SAMPLE_INDEX_BYTES));
    expect(result.sha256).toBe(
      `sha256:${createHash('sha256').update(TARBALL_BYTES).digest('hex')}`,
    );
    expect(result.size).toBe(TARBALL_BYTES.length);
    expect(result.counts).toEqual({ tools: 1, guardrails: 0, agents: 0, flows: 0 });

    // The progress lines go to stderr, never stdout.
    expect(out.stderr).toContain('Target:      production');
    expect(out.stdout).not.toContain('Target:');
    expect(calls).toMatchObject({ indexer: 1, esbuild: 1, tar: 1 });
  });

  test('progress streamed as it comes still never reaches stdout', async () => {
    const { runners } = fakeRunners();
    const streamed: string[] = [];
    const out = await runCli({
      ...inputs(runners, ['prepare', '--target', 'production', `--path=${packDir}`]),
      progress: (text) => streamed.push(text),
    });
    expect(out.exitCode).toBe(0);
    expect(streamed.join('')).toContain('Target:      production');
    expect(out.stdout.split('\n')).toHaveLength(2);
    expect(() => JSON.parse(out.stdout)).not.toThrow();
  });

  test('never posts, streams, pulls or signs', async () => {
    const { runners, calls } = fakeRunners();
    const out = await runCli(
      inputs(runners, ['prepare', '--target', 'production', `--path=${packDir}`]),
    );
    expect(out.exitCode).toBe(0);
    expect(calls).toMatchObject({ post: 0, stream: 0, pull: 0, sign: 0 });
    const outDir = join(packDir, '.kindgi', 'build');
    expect(existsSync(join(outDir, 'deploy-envelope.json'))).toBe(false);
  });

  test('with an empty HOME and no token, tenant or profile in the env, it succeeds', async () => {
    expect(await readdir(home)).toEqual([]);
    const { runners } = fakeRunners();
    const run = inputs(runners, ['prepare', '--target', 'production', `--path=${packDir}`]);
    expect(Object.keys(run.env ?? {}).filter((k) => k.startsWith('KINDGI_'))).toEqual([]);
    const out = await runCli(run);
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toHaveProperty('packTgz');
    // And it leaves HOME as it found it.
    expect(await readdir(home)).toEqual([]);
  });

  test('without --target it fails as a usage error, before anything is built', async () => {
    const { runners, calls } = fakeRunners();
    const out = await runCli(inputs(runners, ['prepare', `--path=${packDir}`]));
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('--target');
    expect(calls).toMatchObject({ indexer: 0, esbuild: 0, tar: 0 });
  });

  test('a pack that needs a private registry is refused, and nothing is written under --out', async () => {
    await writeFile(join(packDir, '.npmrc'), '//registry.example.com/:_authToken=x\n', 'utf8');
    const { runners, calls } = fakeRunners();
    const out = await runCli(
      inputs(runners, ['prepare', '--target', 'production', `--path=${packDir}`]),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain(
      "This version needs a private package registry, which Deploy doesn't reach yet: its install reads .npmrc.",
    );
    const outDir = join(packDir, '.kindgi', 'build');
    expect(existsSync(join(outDir, 'pack.tgz'))).toBe(false);
    expect(existsSync(join(outDir, 'expected-index.json'))).toBe(false);
    expect(await readdir(outDir)).toEqual([]);
    expect(calls).toMatchObject({ indexer: 0, esbuild: 0, tar: 0 });
  });
});

describe('kindgi prepare is hidden', () => {
  test('kindgi --help leaves it out', async () => {
    expect(rootHelpText()).toMatch(/^ {2}build\s/m);
    expect(rootHelpText()).not.toMatch(/^ {2}prepare\s/m);
    const { runners } = fakeRunners();
    const out = await runCli(inputs(runners, ['--help']));
    expect(out.exitCode).toBe(0);
    expect(out.stdout).not.toMatch(/^ {2}prepare\s/m);
  });

  test('the reference (and the docs site built from it) leaves it out', () => {
    const names = describeCommands().map((c) => c.name);
    expect(names).toContain('build');
    expect(names).not.toContain('prepare');
  });

  test('kindgi prepare --help still shows its own help, saying what it is for', async () => {
    const { runners } = fakeRunners();
    const out = await runCli(inputs(runners, ['prepare', '--help']));
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain(
      "Kindgi Cloud's own build step: indexes the pack and writes `pack.tgz` and `expected-index.json` under `--out`.",
    );
    expect(out.stdout).toContain('Not for self-hosted runtimes yet: build with `kindgi build`.');
    expect(out.stdout).toContain('--target');
  });

  test("a hidden subcommand is left out of its group's help and its did-you-mean", () => {
    const leaf = (name: string, hidden: boolean): LeafCommand => ({
      kind: 'leaf',
      name,
      description: `${name} it`,
      usage: `kindgi grp ${name}`,
      ...(hidden && { hidden: true as const }),
      run: async () => ({ kind: 'ok', rendered: { stdout: '', stderr: '' } }),
    });
    const group: Extract<Command, { kind: 'group' }> = {
      kind: 'group',
      name: 'grp',
      description: 'A group.',
      subcommands: [leaf('shown', false), leaf('secret', true)],
    };
    expect(wiredCommands(group.subcommands, ['grp']).map((c) => c.name)).toEqual(['shown']);
    const help = commandHelpText(group, ['grp']);
    expect(help).toMatch(/^ {2}shown\s/m);
    expect(help).not.toContain('secret');
    expect(unknownSubcommandText(group, ['grp'], 'secrte')).not.toContain('secret"');
    expect(unknownSubcommandText(group, ['grp'], 'shwn')).toContain('Did you mean "shown"?');
  });
});

describe("the templates' AGENTS.md", () => {
  test('each tells the coding agent not to run prepare with a self-hosted runtime', async () => {
    const templates = fileURLToPath(new URL('../src/templates/', import.meta.url));
    const names = (await readdir(templates, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && existsSync(join(templates, d.name, 'AGENTS.md')))
      .map((d) => d.name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const cli = name === 'java' || name === 'scala' ? './kindgiw' : 'kindgi';
      const text = (await readFile(join(templates, name, 'AGENTS.md'), 'utf8')).replace(
        /\s+/g,
        ' ',
      );
      expect(text, name).toContain(
        `\`${cli} prepare\` is Kindgi Cloud's own build step: with a self-hosted runtime, don't run it; build with \`${cli} build\`.`,
      );
    }
  });
});
