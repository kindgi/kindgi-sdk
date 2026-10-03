// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi dev`'s refresh: bundle → index (in a child, with the pack's
 * env) → load into the pack service → publish, one refresh at a time.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PackServiceSupervisor } from '@kindgi/handler-runtime/pack-service';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { NODE_PACK_CODE } from '../src/dev/pack-code.js';
import { createPackRefresher, packServiceIndex } from '../src/dev/pack-service.js';
import type {
  DevRunners,
  IndexResult,
  IndexerRunOptions,
  PackBuild,
  PackBuilder,
} from '../src/dev/runners.js';

let packDir: string;

beforeEach(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-refresh-'));
});

afterEach(async () => {
  await rm(packDir, { recursive: true, force: true });
});

const BUILD: PackBuild = {
  kind: 'ok',
  bundleMap: { 'tools/a.ts': '.kindgi/dev/dist/tools/a.mjs' },
};

function indexed(): IndexResult {
  return {
    kind: 'ok',
    packId: 'p',
    packVersion: '0.1.0',
    counts: { tools: 1, guardrails: 0, agents: 0, flows: 0 },
    fileErrors: [],
    index: { v: 1, tools: [{ id: 'p.a', modulePath: 'tools/a.ts' }], guardrails: [] },
  };
}

interface Harness {
  readonly steps: string[];
  /** What each publish published (the staged index). */
  readonly published: unknown[];
  readonly indexerOptions: IndexerRunOptions[];
  readonly dev: DevRunners;
  readonly pack: PackServiceSupervisor;
  readonly builder: PackBuilder;
  /** Hold the next indexer run until released. */
  hold(): () => void;
}

function harness(
  opts: { build?: PackBuild; boot?: 'ok' | 'fail'; index?: () => IndexResult } = {},
): Harness {
  const steps: string[] = [];
  const indexerOptions: IndexerRunOptions[] = [];
  const published: unknown[] = [];
  let gate: Promise<void> | undefined;
  const dev = {
    runIndexer: async (_dir: string, out?: string, options?: IndexerRunOptions) => {
      steps.push(`index ${out?.endsWith('index.next.json') ? 'staged' : out}`);
      if (options !== undefined) indexerOptions.push(options);
      if (gate !== undefined) await gate;
      return (opts.index ?? indexed)();
    },
    publishIndex: async (staged: string) => {
      steps.push('publish');
      // The real indexer writes the staged file; this fake one doesn't.
      const text = await readFile(staged, 'utf8').catch(() => undefined);
      if (text !== undefined) published.push(JSON.parse(text));
    },
  } as unknown as DevRunners;
  const pack = {
    start: async (path: string) => {
      steps.push(`start ${path.endsWith('index.next.pack.json') ? 'pack-index' : path}`);
      return opts.boot === 'fail'
        ? { kind: 'err', error: { problems: ['p.a: boom'] } }
        : { kind: 'ok', value: { port: 1 } };
    },
  } as unknown as PackServiceSupervisor;
  const builder: PackBuilder = {
    build: async () => {
      steps.push('build');
      return opts.build ?? BUILD;
    },
    watch: async () => {},
    syncEntries: async () => false,
    dispose: async () => {},
  };
  return {
    steps,
    published,
    indexerOptions,
    dev,
    pack,
    builder,
    hold() {
      let release = (): void => {};
      gate = new Promise((r) => {
        release = r;
      });
      return () => {
        gate = undefined;
        release();
      };
    },
  };
}

const env = async () => ({ DATABASE_URL: 'postgres://pack' });

describe('createPackRefresher', () => {
  test('bundle, index with the bundles and the pack env, load, then publish', async () => {
    const h = harness();
    const refresher = createPackRefresher({ ...h, packDir, env, code: NODE_PACK_CODE });
    const r = await refresher.refresh();
    expect(r.kind).toBe('ok');
    expect(h.steps).toEqual(['build', 'index staged', 'start pack-index', 'publish']);
    expect(h.indexerOptions[0]?.bundleMap).toEqual(BUILD.bundleMap);
    expect(await h.indexerOptions[0]?.env?.()).toEqual({ DATABASE_URL: 'postgres://pack' });
    const packIndex = JSON.parse(
      await readFile(join(packDir, '.kindgi', 'dev', 'index.next.pack.json'), 'utf8'),
    );
    expect(packIndex.tools[0].modulePath).toBe('.kindgi/dev/dist/tools/a.mjs');
  });

  test("code that doesn't bundle is reported with its locations; nothing else runs", async () => {
    const h = harness({ build: { kind: 'err', errors: ['tools/a.ts:3:7: Expected ";"'] } });
    const r = await createPackRefresher({ ...h, packDir, env, code: NODE_PACK_CODE }).refresh();
    expect(r).toMatchObject({ kind: 'err', code: 'bundle-failed' });
    expect(r.kind === 'err' && r.message).toContain('tools/a.ts:3:7');
    expect(h.steps).toEqual(['build']);
  });

  test("code that doesn't load in the pack service is not published", async () => {
    const h = harness({ boot: 'fail' });
    const r = await createPackRefresher({ ...h, packDir, env, code: NODE_PACK_CODE }).refresh();
    expect(r).toMatchObject({ kind: 'err', code: 'pack-service-boot-failed' });
    expect(h.steps).not.toContain('publish');
  });

  test('without a build (an env-file change), the last good bundle is reused', async () => {
    const h = harness();
    const refresher = createPackRefresher({ ...h, packDir, env, code: NODE_PACK_CODE });
    await refresher.refresh();
    await refresher.refresh();
    expect(h.steps.filter((s) => s === 'build')).toHaveLength(1);
    expect(h.steps.filter((s) => s === 'publish')).toHaveLength(2);
  });

  test('refreshes run one at a time; those asked for meanwhile collapse into one, with the latest build', async () => {
    const h = harness();
    const refresher = createPackRefresher({ ...h, packDir, env, code: NODE_PACK_CODE });
    const release = h.hold();
    const first = refresher.refresh(BUILD);
    // Let the first refresh start (it then waits in the indexer).
    await new Promise((r) => setTimeout(r, 10));
    const later = (n: number): Extract<PackBuild, { kind: 'ok' }> => ({
      kind: 'ok',
      bundleMap: { 'tools/a.ts': `.kindgi/dev/dist/tools/a.v${n}.mjs` },
    });
    const second = refresher.refresh(later(2));
    const third = refresher.refresh(later(3));
    expect(third).toBe(second);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.steps.filter((s) => s.startsWith('start'))).toHaveLength(0);
    release();
    await Promise.all([first, second]);
    expect(h.steps.filter((s) => s.startsWith('index'))).toHaveLength(2);
    expect(h.indexerOptions[1]?.bundleMap).toEqual(later(3).bundleMap);
    await refresher.idle();
  });
});

describe('createPackRefresher — the last primitives deleted', () => {
  const empty = (): IndexResult => ({
    kind: 'err',
    code: 'discovery-empty',
    message: 'no primitives',
  });

  async function publishedBefore(index: Record<string, unknown>): Promise<void> {
    await mkdir(join(packDir, '.kindgi', 'dev'), { recursive: true });
    await writeFile(join(packDir, '.kindgi', 'dev', 'index.json'), JSON.stringify(index));
  }

  test('publishes the previous index emptied, so the deleted primitives stop being listed', async () => {
    await publishedBefore({
      v: 1,
      packId: 'p',
      packVersion: '0.1.0',
      tools: [{ id: 'p.a' }],
      guardrails: [],
      agents: [{ id: 'p.agent' }],
      flows: [],
    });
    const h = harness({ index: empty });
    const r = await createPackRefresher({ ...h, packDir, env, code: NODE_PACK_CODE }).refresh();
    expect(r).toMatchObject({ kind: 'err', code: 'discovery-empty' });
    expect(h.steps).toEqual(['build', 'index staged', 'publish']);
    expect(h.published[0]).toMatchObject({
      v: 1,
      packId: 'p',
      packVersion: '0.1.0',
      tools: [],
      guardrails: [],
      agents: [],
      flows: [],
    });
  });

  test('nothing to clear: no index published yet, or the published one already empty', async () => {
    const h = harness({ index: empty });
    const refresher = createPackRefresher({ ...h, packDir, env, code: NODE_PACK_CODE });
    await refresher.refresh();
    await publishedBefore({ v: 1, packId: 'p', tools: [], guardrails: [], agents: [], flows: [] });
    await refresher.refresh();
    expect(h.steps).not.toContain('publish');
  });
});

describe('packServiceIndex', () => {
  test("points tool modules and guardrail check modules at their bundles; keeps what isn't bundled", () => {
    expect(
      packServiceIndex(
        {
          v: 1,
          tools: [
            { id: 'a', modulePath: 'tools/a.ts' },
            { id: 'b', modulePath: 'tools/b.ts' },
          ],
          guardrails: [{ id: 'g', checkModulePath: 'guardrails/g.ts' }],
          agents: [{ id: 'x', modulePath: 'agents/x.ts' }],
        },
        { 'tools/a.ts': 'dist/a.mjs', 'guardrails/g.ts': 'dist/g.mjs' },
      ),
    ).toEqual({
      v: 1,
      tools: [
        { id: 'a', modulePath: 'dist/a.mjs' },
        { id: 'b', modulePath: 'tools/b.ts' },
      ],
      guardrails: [{ id: 'g', checkModulePath: 'dist/g.mjs' }],
      agents: [{ id: 'x', modulePath: 'agents/x.ts' }],
    });
  });
});
