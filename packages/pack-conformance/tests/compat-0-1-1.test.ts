// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The pack services of Kindgi 0.1.1, called by this runtime: a call whose
 * context, and a check whose trace, carry the project and org (pack
 * protocol 2.3.0) are answered as before. The released services are
 * fetched as a user gets them: `@kindgi/handler-runtime@0.1.1` from npm,
 * and the Python SDK from the 0.1.1 release commit in this clone's
 * history, installed with uv. Without npm or uv, that half is skipped and
 * says why.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { describe, test } from 'vitest';

import { describeCallContextCompatibility, fixturePackDir } from '../src/index.js';

const run = promisify(execFile);

/** The commit Kindgi 0.1.1 was released from (`@kindgi/handler-runtime@0.1.1`). */
const RELEASE_0_1_1 = 'a22f4a93e0c4a97bf02bcf171d7a16dd97a34712';

/** This repository's root, whose history holds that commit. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

async function available(command: string): Promise<boolean> {
  return run(command, ['--version']).then(
    () => true,
    () => false,
  );
}

// ---- TypeScript: @kindgi/handler-runtime 0.1.1 ------------------------------

if (!(await available('npm'))) {
  describe('an older pack service — node 0.1.1', () => {
    test.skip('npm is not on PATH', () => {});
  });
} else {
  const prefix = await mkdtemp(join(tmpdir(), 'kindgi-handler-runtime-0.1.1-'));
  await run('npm', [
    'install',
    '--prefix',
    prefix,
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    '--silent',
    '@kindgi/handler-runtime@0.1.1',
  ]);
  const root = join(prefix, 'node_modules', '@kindgi', 'handler-runtime');
  const released = (await import(pathToFileURL(join(root, 'dist', 'index.js')).href)) as {
    runIndexer(opts: {
      packDir: string;
      outputPath: string;
      artifactVersion: string;
      publishedAt: string;
    }): Promise<
      | { kind: 'ok'; value: { fileErrors: { message: string }[] } }
      | { kind: 'err'; error: { code: string; message: string } }
    >;
  };
  const packDir = fixturePackDir('node-pack');
  describeCallContextCompatibility({
    name: 'node 0.1.1',
    packDir,
    command: [process.execPath, join(root, 'dist', 'pack-service', 'main.js')],
    async buildIndex(outputPath, pins) {
      const outcome = await released.runIndexer({ packDir, outputPath, ...pins });
      if (outcome.kind === 'err') {
        throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
      }
      if (outcome.value.fileErrors.length > 0) {
        throw new Error(outcome.value.fileErrors.map((e) => e.message).join('\n'));
      }
    },
  });
}

// ---- Python: the `kindgi` package at the 0.1.1 release ----------------------

if (!(await available('uv'))) {
  describe('an older pack service — python 0.1.1', () => {
    test.skip('uv is not on PATH', () => {});
  });
} else {
  const venv = await mkdtemp(join(tmpdir(), 'kindgi-python-0.1.1-'));
  const python = join(venv, 'bin', 'python');
  await run('uv', ['venv', venv, '--quiet']);
  // The SDK as it was at the release commit, from this clone's own history
  // (fetched first when the clone is shallow, as CI's is): 0.1.1 was never
  // on PyPI, and the repository isn't public.
  const hasRelease = await run('git', [
    '-C',
    REPO_ROOT,
    'cat-file',
    '-e',
    `${RELEASE_0_1_1}^{commit}`,
  ]).then(
    () => true,
    () => false,
  );
  if (!hasRelease) {
    await run('git', [
      '-C',
      REPO_ROOT,
      'fetch',
      '--quiet',
      '--depth',
      '1',
      'origin',
      RELEASE_0_1_1,
    ]);
  }
  const source = await mkdtemp(join(tmpdir(), 'kindgi-python-0.1.1-src-'));
  const archive = join(source, 'sdk.tar');
  await run('git', [
    '-C',
    REPO_ROOT,
    'archive',
    '--format=tar',
    '-o',
    archive,
    RELEASE_0_1_1,
    'sdks/python',
  ]);
  await run('tar', ['-xf', archive, '-C', source]);
  await run('uv', [
    'pip',
    'install',
    '--quiet',
    '--python',
    python,
    join(source, 'sdks', 'python'),
  ]);
  await rm(source, { recursive: true, force: true });
  const packDir = fixturePackDir('python-pack');
  // Fixture files written with a newer SDK's features: 0.1.1 can't load them.
  const newerThan011 = new Set([
    'tools/pause.py',
    'tools/read.py',
    'tools/store.py',
    'tools/update.py',
    'tools/fails_on_purpose.py',
    'guardrails/judged.py',
    'guardrails/no_guarantees.py',
  ]);
  describeCallContextCompatibility({
    name: 'python 0.1.1',
    packDir,
    command: [python, '-m', 'kindgi.pack', 'serve'],
    async buildIndex(outputPath, pins) {
      const { stdout } = await run(python, [
        '-m',
        'kindgi.pack',
        'index',
        '--pack-dir',
        packDir,
        '--output',
        outputPath,
        '--artifact-version',
        pins.artifactVersion,
        '--published-at',
        pins.publishedAt,
        '--json',
      ]).catch((cause: { stdout?: string; stderr?: string }) => {
        throw new Error(`indexer failed: ${cause.stdout ?? ''}${cause.stderr ?? ''}`);
      });
      const outcome = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as {
        kind: string;
        value?: { fileErrors: { message: string; filePath?: string }[] };
      };
      const fileErrors = (outcome.value?.fileErrors ?? []).filter(
        (e) => e.filePath === undefined || !newerThan011.has(e.filePath),
      );
      if (outcome.kind !== 'ok' || fileErrors.length > 0) {
        throw new Error(`indexer: ${stdout}`);
      }
    },
  });
}
