// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * How `kindgi dev` keeps the pack's code and its index in step. The
 * pack service loads an index once, when it boots, so a change is
 * picked up in this order:
 *
 *   1. bundle the pack's code (esbuild; a watch rebuild hands its result in) —
 *      for a Python pack, the sources are the build;
 *   2. index the bundles (or sources) in a child process with the pack's
 *      environment, into a staging file — the TypeScript indexer, or
 *      `python -m kindgi.pack index`;
 *   3. boot a pack service on it — once it listens (every module
 *      imported), calls go to it and the previous one stops;
 *   4. publish the staged index as the one the api-server reads.
 *
 * So the api-server never lists a tool whose code isn't running. Code
 * that fails to bundle or to load leaves the previous pack service and
 * index in place. A pack whose last primitives were deleted publishes an
 * empty index, so what was deleted stops being listed.
 *
 * Refreshes run one at a time. A refresh asked for while one runs waits
 * for it, and several such requests collapse into one, with the latest
 * build — so two pack services never start at once.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  PackServiceSupervisor,
  PackServiceSupervisorEvent,
} from '@kindgi/handler-runtime/pack-service';

import type { PackCode } from './pack-code.js';
import { devIndexPath, devStagedIndexPath, devStagedPackIndexPath } from './paths.js';
import type { DevRunners, IndexResult, PackBuild, PackBuilder } from './runners.js';

export interface PackRefresherDeps {
  readonly dev: DevRunners;
  readonly pack: PackServiceSupervisor;
  readonly builder: PackBuilder;
  readonly packDir: string;
  /** The pack's environment (the indexer child runs with it). */
  readonly env: () => Promise<Readonly<Record<string, string>>>;
  /** The pack's code: which indexer reads it. */
  readonly code: PackCode;
}

export interface PackRefresher {
  /**
   * Bundle (or use `build`, a watch rebuild's result), index, load and
   * publish. Without `build`, reuses the last good bundle when there is
   * one (an env-file change) and bundles otherwise.
   */
  refresh(build?: PackBuild): Promise<IndexResult>;
  /** Resolves once no refresh is running or waiting. */
  idle(): Promise<void>;
}

interface Request {
  build: PackBuild | undefined;
  result: Promise<IndexResult>;
}

export function createPackRefresher(deps: PackRefresherDeps): PackRefresher {
  let tail: Promise<unknown> = Promise.resolve();
  let waiting: Request | undefined;
  let lastGood: PackBuild | undefined;

  async function refreshOnce(given: PackBuild | undefined): Promise<IndexResult> {
    const build = given ?? lastGood ?? (await deps.builder.build());
    if (build.kind === 'err') {
      return {
        kind: 'err',
        code: 'bundle-failed',
        message: `The pack's code did not build:\n      ${build.errors.join('\n      ')}`,
      };
    }
    lastGood = build;
    const staged = devStagedIndexPath(deps.packDir);
    const indexed = await deps.dev.runIndexer(deps.packDir, staged, {
      bundleMap: build.bundleMap,
      env: deps.env,
      code: deps.code,
    });
    if (indexed.kind !== 'ok') {
      if (indexed.code === 'discovery-empty') await publishEmpty();
      return indexed;
    }

    const packIndex = devStagedPackIndexPath(deps.packDir);
    await mkdir(dirname(packIndex), { recursive: true });
    await writeFile(
      packIndex,
      JSON.stringify(packServiceIndex(indexed.index, build.bundleMap)),
      'utf8',
    );
    const started = await deps.pack.start(packIndex);
    if (started.kind === 'err') {
      return {
        kind: 'err',
        code: 'pack-service-boot-failed',
        message: `The pack's code did not load: ${started.error.problems.join('; ')}`,
      };
    }
    await deps.dev.publishIndex(staged, devIndexPath(deps.packDir));
    return indexed;
  }

  /**
   * The pack has no primitives left (the last ones were deleted): publish
   * the previous index's header with nothing in it, so the api-server
   * stops listing them. Nothing to do before any index was published, or
   * when the published one is already empty. The pack service keeps its
   * old code until the next refresh with primitives; nothing calls it.
   */
  async function publishEmpty(): Promise<void> {
    const published = devIndexPath(deps.packDir);
    let previous: Record<string, unknown>;
    try {
      previous = JSON.parse(await readFile(published, 'utf8')) as Record<string, unknown>;
    } catch {
      return;
    }
    const kinds = ['tools', 'guardrails', 'agents', 'flows'] as const;
    const listed = (kind: (typeof kinds)[number]): boolean => {
      const entries = previous[kind];
      return Array.isArray(entries) && entries.length > 0;
    };
    if (!kinds.some(listed)) return;
    const staged = devStagedIndexPath(deps.packDir);
    await mkdir(dirname(staged), { recursive: true });
    await writeFile(
      staged,
      JSON.stringify({
        ...previous,
        publishedAt: new Date().toISOString(),
        tools: [],
        guardrails: [],
        agents: [],
        flows: [],
      }),
      'utf8',
    );
    await deps.dev.publishIndex(staged, published);
  }

  async function guarded(build: PackBuild | undefined): Promise<IndexResult> {
    try {
      return await refreshOnce(build);
    } catch (cause) {
      return {
        kind: 'err',
        code: 'refresh-failed',
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  return {
    refresh(build) {
      if (waiting !== undefined) {
        // Collapse into the waiting refresh; the latest build wins.
        if (build !== undefined) waiting.build = build;
        return waiting.result;
      }
      const request: Request = { build, result: Promise.resolve(undefined as never) };
      request.result = tail.then(() => {
        if (waiting === request) waiting = undefined;
        return guarded(request.build);
      });
      waiting = request;
      tail = request.result;
      return request.result;
    },
    async idle() {
      await tail;
    },
  };
}

/**
 * The index as the pack service reads it: each tool's module and each
 * guardrail's check module point at their bundles (paths relative to
 * the pack root, which is the pack service's module root).
 */
export function packServiceIndex(
  index: unknown,
  bundleMap: Readonly<Record<string, string>>,
): unknown {
  const doc = index as {
    readonly tools?: readonly Record<string, unknown>[];
    readonly guardrails?: readonly Record<string, unknown>[];
  };
  const bundled = (path: unknown): unknown =>
    typeof path === 'string' ? (bundleMap[path] ?? path) : path;
  return {
    ...doc,
    ...(doc.tools !== undefined && {
      tools: doc.tools.map((t) => ({ ...t, modulePath: bundled(t.modulePath) })),
    }),
    ...(doc.guardrails !== undefined && {
      guardrails: doc.guardrails.map((g) => ({
        ...g,
        checkModulePath: bundled(g.checkModulePath),
      })),
    }),
  };
}

/**
 * The dev console's view of the pack service: what pack code prints,
 * failed calls, and crashes. Successful calls and restarts that work
 * stay quiet.
 */
/** A pack service log line worth a line of `kindgi dev` output: a failed call, missing env. */
function describePackLog(event: unknown): string | undefined {
  const e = event as { kind?: unknown; id?: unknown; outcome?: unknown; names?: unknown };
  if (e.kind === 'missing-env' && Array.isArray(e.names)) {
    const names = e.names.map(String);
    const one = names.length === 1;
    return `  ⚠ the pack's env.required ${one ? 'name' : 'names'} ${names.join(', ')} ${one ? 'has' : 'have'} no value: add ${one ? 'it' : 'them'} to the pack's env files (a deployment won't be ready without ${one ? 'it' : 'them'})`;
  }
  return e.kind === 'call' && e.outcome !== 'ok'
    ? `  [pack] ✗ ${String(e.id)}: ${String(e.outcome)}`
    : undefined;
}

export function describePackEvent(event: PackServiceSupervisorEvent): string | undefined {
  switch (event.kind) {
    case 'exited':
      return `  ⚠ pack service exited (${event.signal ?? event.code}) — restarting`;
    case 'gave-up':
      return `  ✗ pack service kept exiting (${event.attempts} restarts) — fix the code and save to retry`;
    case 'log':
      return describePackLog(event.event);
    default:
      return undefined;
  }
}
