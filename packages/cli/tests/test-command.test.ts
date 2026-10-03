// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi test` tests. The vitest binary + config probe both flow
 * through the injected `TestRunners` seam so these tests never spawn
 * real vitest and never look at the filesystem for a real vitest
 * config (just for the pack config which we write to a tmpdir).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { type RunCliInputs, runCli } from '../src/main.js';
import type { RunTestsOptions, RunTestsResult, TestRunners } from '../src/test/runners.js';

let packDir: string;

interface Fixtures {
  runners: TestRunners;
  readonly state: {
    hasConfigCalls: number;
    hasConfig: boolean;
    runCalls: number;
    lastOpts?: RunTestsOptions;
    result: RunTestsResult;
  };
}

function makeFixtures(overrides: Partial<Fixtures['state']> = {}): Fixtures {
  const state: Fixtures['state'] = {
    hasConfigCalls: 0,
    hasConfig: true,
    runCalls: 0,
    result: { spawned: true, exitCode: 0, resolvedBinary: 'pnpm' },
    ...overrides,
  };
  const runners: TestRunners = {
    hasVitestConfig: async () => {
      state.hasConfigCalls += 1;
      return state.hasConfig;
    },
    runTests: async (opts) => {
      state.runCalls += 1;
      state.lastOpts = opts;
      return state.result;
    },
  };
  return { runners, state };
}

function baseInputs(fixtures: Fixtures, argv: readonly string[]): RunCliInputs {
  return {
    argv,
    env: {},
    cwd: packDir,
    home: '/tmp/fake-home',
    testRunners: fixtures.runners,
  };
}

beforeEach(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-cli-test-cmd-'));
  await writeFile(join(packDir, 'kindgi.config.ts'), 'export default {};\n', 'utf8');
});

afterEach(async () => {
  await rm(packDir, { recursive: true, force: true });
});

// ---------- happy paths ----------

describe('kindgi test — argument forwarding', () => {
  test('one-shot: prepends `run` to the forwarded args', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(baseInputs(fixtures, ['test', `--path=${packDir}`]));
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.lastOpts?.args[0]).toBe('run');
  });

  test('--watch: prepends `--watch` (not `run`)', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(baseInputs(fixtures, ['test', '--watch', `--path=${packDir}`]));
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.lastOpts?.args).toContain('--watch');
    expect(fixtures.state.lastOpts?.args).not.toContain('run');
  });

  test('--reporter threads through', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(
      baseInputs(fixtures, ['test', '--reporter=verbose', `--path=${packDir}`]),
    );
    expect(out.exitCode).toBe(0);
    const args = fixtures.state.lastOpts?.args ?? [];
    const idx = args.indexOf('--reporter');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('verbose');
  });

  test('tokens after `--` are passed through verbatim', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(
      baseInputs(fixtures, ['test', `--path=${packDir}`, '--', 'tests/unit', '--coverage']),
    );
    expect(out.exitCode).toBe(0);
    const args = fixtures.state.lastOpts?.args ?? [];
    expect(args).toContain('tests/unit');
    expect(args).toContain('--coverage');
  });
});

// ---------- error paths ----------

describe('kindgi test — error handling', () => {
  test('missing kindgi.config.ts errors clearly', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'kindgi-cli-test-empty-'));
    try {
      const fixtures = makeFixtures();
      const out = await runCli(baseInputs(fixtures, ['test', `--path=${emptyDir}`]));
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain('kindgi.config.ts');
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  test('missing vitest config errors with a create-hint', async () => {
    const fixtures = makeFixtures({ hasConfig: false });
    const out = await runCli(baseInputs(fixtures, ['test', `--path=${packDir}`]));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('vitest config');
    expect(fixtures.state.runCalls).toBe(0);
  });

  test('runner-binary-not-found hint points at `pnpm add -D vitest`', async () => {
    const fixtures = makeFixtures({
      result: { spawned: false, exitCode: 1, reason: 'runner-binary-not-found' },
    });
    const out = await runCli(baseInputs(fixtures, ['test', `--path=${packDir}`]));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('pnpm add -D vitest');
  });

  test('failing tests: non-zero exit code from vitest surfaces via CLI exit', async () => {
    const fixtures = makeFixtures({
      result: { spawned: true, exitCode: 1, resolvedBinary: 'pnpm' },
    });
    const out = await runCli(baseInputs(fixtures, ['test', `--path=${packDir}`]));
    expect(out.exitCode).toBe(1);
    const summary = JSON.parse(out.stdout) as { exitCode: number };
    expect(summary.exitCode).toBe(1);
  });
});

// ---------- JSON output ----------

describe('kindgi test — JSON output', () => {
  test('emits structured summary on stdout', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(
      baseInputs(fixtures, ['test', '--reporter=verbose', `--path=${packDir}`]),
    );
    expect(out.exitCode).toBe(0);
    const summary = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(summary.runner).toBe('vitest');
    expect(summary.watch).toBe(false);
    expect(summary.reporter).toBe('verbose');
    expect(summary.exitCode).toBe(0);
  });
});
