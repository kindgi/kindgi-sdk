// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What pack code prints while the indexer (a child) loads it reaches
 * `onOutput` line by line; the indexer's own result line doesn't.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runPythonIndexer } from '../src/dev/defaults.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'indexer-output-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A stand-in for the pack's Python: prints `body`'s lines, ignoring its arguments. */
async function standIn(body: string): Promise<readonly [string, ...string[]]> {
  const script = join(dir, 'stand-in.mjs');
  await writeFile(script, body, 'utf8');
  return [process.execPath, script];
}

const RESULT = JSON.stringify({ kind: 'err', error: { code: 'discovery-empty', message: 'none' } });

async function index(python: readonly [string, ...string[]]) {
  const output: string[] = [];
  const result = await runPythonIndexer({
    packDir: dir,
    outputPath: join(dir, 'index.json'),
    python,
    env: { PATH: process.env.PATH ?? '' },
    onOutput: (line, stream) => output.push(`${stream}: ${line}`),
  });
  return { result, output };
}

describe('the indexer child’s output', () => {
  test('every line pack code printed, in order per stream; not the result line', async () => {
    const { result, output } = await index(
      await standIn(
        `process.stdout.write('connecting\\n');
process.stderr.write('a warning\\n');
process.stdout.write('still loading\\n${RESULT.replace(/'/g, "\\'")}\\n');
`,
      ),
    );
    expect(result).toMatchObject({ kind: 'err', code: 'discovery-empty' });
    expect(output.filter((l) => l.startsWith('stdout'))).toEqual([
      'stdout: connecting',
      'stdout: still loading',
    ]);
    expect(output.filter((l) => l.startsWith('stderr'))).toEqual(['stderr: a warning']);
  });

  test('a child that dies without a result: its last line is output too', async () => {
    const { result, output } = await index(
      await standIn("process.stdout.write('half way\\n'); process.exit(3);\n"),
    );
    expect(result).toMatchObject({ kind: 'err', code: 'index-child-failed' });
    expect(output).toEqual(['stdout: half way']);
  });
});
