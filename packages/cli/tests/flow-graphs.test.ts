// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A Python or JVM pack's indexer checks a flow's schema only. Every index
 * result goes through `loadFlow`'s graph checks too, and a flow that fails
 * them leaves the result and the index file: the one `kindgi dev`'s
 * runtime serves flows from.
 */

import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PackServiceSupervisor } from '@kindgi/handler-runtime/pack-service';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { PYTHON_BUILD_RUNNERS } from '../src/build/defaults.js';
import { REAL_DEV_RUNNERS, runJavaIndexer, runPythonIndexer } from '../src/dev/defaults.js';
import { judgeFlowGraphs, writeIndexFile } from '../src/dev/flow-graphs.js';
import type { JavaPackCode } from '../src/dev/pack-code.js';
import { createPackRefresher } from '../src/dev/pack-service.js';
import { devIndexPath } from '../src/dev/paths.js';
import type { IndexResult, PackBuilder } from '../src/dev/runners.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flow-graphs-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function edge(id: string, from: string, to: string): Record<string, unknown> {
  return { id, from, to };
}

function tool(id: string): Record<string, unknown> {
  return { id, kind: 'tool', ref: 'acme.noop' };
}

/** A flow as a Python indexer writes it: the flow, its payload version and its module. */
function indexed(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `acme.${name}`,
    version: '1.0.0',
    nodes: [tool('a'), tool('b')],
    edges: [edge('e1', '$start', 'a'), edge('e2', 'a', 'b'), edge('e3', 'b', '$end')],
    kernelPayloadVersion: 1,
    modulePath: `flows/${name}.py`,
    ...overrides,
  };
}

const GOOD = indexed('good');
const CYCLE = indexed('cycle', {
  edges: [
    edge('e1', '$start', 'a'),
    edge('e2', 'a', 'b'),
    edge('e3', 'b', 'a'),
    edge('e4', 'b', '$end'),
  ],
});
const NO_START = indexed('nostart', { edges: [edge('e1', 'a', 'b'), edge('e2', 'b', '$end')] });
const MISSING = indexed('missing', { edges: [edge('e1', '$start', 'a'), edge('e2', 'a', 'gone')] });
const NEWER = indexed('newer', { nodes: [{ id: 'a', kind: 'teleport', ref: 'x' }, tool('b')] });

function indexOf(flows: readonly unknown[]): Record<string, unknown> {
  return {
    v: 1,
    packId: 'acme',
    packVersion: '0.1.0',
    artifactVersion: '20261106.1',
    publishedAt: '2026-11-06T00:00:00.000Z',
    tools: [],
    guardrails: [],
    agents: [],
    flows,
  };
}

/**
 * An indexer stand-in (CommonJS, for `node`): writes `index` compactly to
 * the path after `--output`, as the Python indexer does, then prints the
 * indexer's one-line result. It ignores every other argument.
 */
function standInSource(index: Record<string, unknown>): string {
  const flows = (index.flows as unknown[]).length;
  return `const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const out = process.argv[process.argv.indexOf('--output') + 1];
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, ${JSON.stringify(JSON.stringify(index))});
process.stdout.write(JSON.stringify({ kind: 'ok', value: { packId: 'acme', packVersion: '0.1.0', counts: { tools: 0, guardrails: 0, agents: 0, flows: ${flows} }, fileErrors: [], outputPath: out } }) + '\\n');
`;
}

/** The pack's "Python": `node` running the stand-in. */
async function python(index: Record<string, unknown>): Promise<readonly [string, ...string[]]> {
  const script = join(dir, 'python-stand-in.cjs');
  await writeFile(script, standInSource(index), 'utf8');
  return [process.execPath, script];
}

/** The pack's JDK: a `java` that is the stand-in, run by `node`. */
async function jdk(index: Record<string, unknown>): Promise<JavaPackCode> {
  const java = join(dir, 'jdk', 'bin', 'java');
  await mkdir(join(dir, 'jdk', 'bin'), { recursive: true });
  await writeFile(java, `#!${process.execPath}\n${standInSource(index)}`, 'utf8');
  await chmod(java, 0o755);
  return { language: 'java', java, workDir: join(dir, 'jvm'), maven: ['mvn'] };
}

const env = { PATH: process.env.PATH ?? '' };

const RUNNERS = {
  Python: async (outputPath: string, index: Record<string, unknown>) =>
    runPythonIndexer({ packDir: dir, outputPath, python: await python(index), env }),
  Java: async (outputPath: string, index: Record<string, unknown>) =>
    runJavaIndexer({ packDir: dir, outputPath, code: await jdk(index), env }),
} as const;

function ids(index: unknown): unknown[] {
  return ((index as { flows: { id: unknown }[] }).flows ?? []).map((f) => f.id);
}

function ok(result: IndexResult): Extract<IndexResult, { kind: 'ok' }> {
  if (result.kind !== 'ok')
    throw new Error(`expected an index: [${result.code}] ${result.message}`);
  return result;
}

const REFUSED = [
  {
    code: 'manifest-validation-failed',
    message: expect.stringMatching(
      /^flows\/cycle\.py: flow 'acme\.cycle' is invalid: cycle-detected: Flow "acme\.cycle" contains a cycle: /,
    ),
    filePath: 'flows/cycle.py',
  },
  {
    code: 'manifest-validation-failed',
    message: expect.stringMatching(
      /^flows\/nostart\.py: flow 'acme\.nostart' is invalid: missing-start-edge: /,
    ),
    filePath: 'flows/nostart.py',
  },
  {
    code: 'manifest-validation-failed',
    message: expect.stringMatching(
      /^flows\/missing\.py: flow 'acme\.missing' is invalid: unknown-node-reference: /,
    ),
    filePath: 'flows/missing.py',
  },
];

const NOT_CHECKED = [
  {
    code: 'flow-not-checked',
    message: expect.stringMatching(
      /^flows\/newer\.py: flow 'acme\.newer' was not checked: it has a shape this CLI doesn't know \(.+\)$/,
    ),
    filePath: 'flows/newer.py',
  },
];

describe.each(Object.entries(RUNNERS))(
  '%s: every index result goes through the graph checks',
  (_language, run) => {
    test('a flow that fails them is a file error, and leaves the result and the index file', async () => {
      const out = join(dir, '.kindgi', 'dev', 'index.json');
      const result = ok(await run(out, indexOf([GOOD, CYCLE, NO_START, MISSING, NEWER])));
      expect(result.fileErrors).toEqual(REFUSED);
      expect(result.warnings).toEqual(NOT_CHECKED);
      expect(result.counts.flows).toBe(2);
      expect(ids(result.index)).toEqual(['acme.good', 'acme.newer']);

      const onDisk = JSON.parse(await readFile(out, 'utf8')) as Record<string, unknown>;
      expect(ids(onDisk)).toEqual(['acme.good', 'acme.newer']);
      expect(onDisk).toEqual(indexOf([GOOD, NEWER]));
    });

    test('an index whose flows pass is left as the indexer wrote it, byte for byte', async () => {
      const out = join(dir, '.kindgi', 'dev', 'index.json');
      const result = ok(await run(out, indexOf([GOOD, NEWER])));
      expect(result.fileErrors).toEqual([]);
      expect(result.counts.flows).toBe(2);
      expect(await readFile(out, 'utf8')).toBe(JSON.stringify(indexOf([GOOD, NEWER])));
    });
  },
);

describe('kindgi build', () => {
  test("the Python pack's local indexer step reports the file errors that stop the build", async () => {
    const out = join(dir, '.kindgi', 'build', 'index.json');
    const result = ok(
      await PYTHON_BUILD_RUNNERS.runLocalIndexer({
        packDir: dir,
        outputPath: out,
        artifactVersion: '20261106.1',
        publishedAt: '2026-11-06T00:00:00.000Z',
        python: await python(indexOf([GOOD, CYCLE])),
        env,
      }),
    );
    expect(result.fileErrors).toEqual([REFUSED[0]]);
  });
});

describe('kindgi dev', () => {
  const builder: PackBuilder = {
    build: async () => ({ kind: 'ok', bundleMap: {} }),
    watch: async () => {},
    syncEntries: async () => false,
    dispose: async () => {},
  };
  const pack = {
    start: async () => ({ kind: 'ok', value: { port: 1 } }),
    serveEmpty: () => {},
  } as unknown as PackServiceSupervisor;

  test('on boot and after a save, the published index has no flow that fails them', async () => {
    let flows: unknown[] = [GOOD, CYCLE];
    const refresher = createPackRefresher({
      dev: REAL_DEV_RUNNERS,
      pack,
      builder,
      packDir: dir,
      env: async () => env,
      code: { language: 'python', python: [process.execPath, join(dir, 'python-stand-in.cjs')] },
    });
    const published = async () => JSON.parse(await readFile(devIndexPath(dir), 'utf8')) as unknown;

    await python(indexOf(flows));
    const booted = ok(await refresher.refresh());
    expect(booted.fileErrors).toEqual([REFUSED[0]]);
    expect(booted.counts.flows).toBe(1);
    expect(ids(await published())).toEqual(['acme.good']);

    flows = [GOOD, CYCLE, NO_START, NEWER];
    await python(indexOf(flows));
    const saved = ok(await refresher.refresh());
    expect(saved.fileErrors).toEqual([REFUSED[0], REFUSED[1]]);
    expect(saved.warnings).toEqual(NOT_CHECKED);
    expect(saved.counts.flows).toBe(2);
    expect(ids(await published())).toEqual(['acme.good', 'acme.newer']);
  });
});

describe('judgeFlowGraphs', () => {
  test('an index with no flows, or not an index, is left alone', () => {
    for (const index of [indexOf([]), { v: 1 }, null, 'index']) {
      expect(judgeFlowGraphs(index)).toEqual({ index, dropped: 0, fileErrors: [], warnings: [] });
    }
  });

  test('a flow with no module path is named without one', () => {
    const { modulePath: _, ...bare } = CYCLE;
    const found = judgeFlowGraphs(indexOf([bare]));
    expect(found.dropped).toBe(1);
    expect(found.fileErrors).toEqual([
      {
        code: 'manifest-validation-failed',
        message: expect.stringMatching(/^flow 'acme\.cycle' is invalid: cycle-detected: /),
      },
    ]);
  });
});

describe('writeIndexFile', () => {
  test('a rename that fails leaves no temporary file, and throws', async () => {
    // A directory that isn't empty can't be renamed over.
    const target = join(dir, 'index.json');
    await mkdir(join(target, 'held'), { recursive: true });
    await expect(writeIndexFile(target, indexOf([GOOD]))).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['index.json']);
  });
});
