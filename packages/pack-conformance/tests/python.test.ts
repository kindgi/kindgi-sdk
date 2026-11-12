// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Python pack service and indexer (`sdks/python`, `python -m kindgi.pack`).
 *
 * Runs with the interpreter in `KINDGI_CONFORMANCE_PYTHON`, else the SDK's own
 * virtualenv (`sdks/python/.venv`, made by `uv sync` there). With neither, the
 * suite is skipped and says why — CI sets the virtualenv up.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, test } from 'vitest';

import {
  type IndexFileError,
  type IndexPins,
  describePackServiceConformance,
  fixturePackDir,
} from '../src/index.js';

const run = promisify(execFile);
const venvPython = fileURLToPath(new URL('../../../sdks/python/.venv/bin/python', import.meta.url));
const python =
  process.env.KINDGI_CONFORMANCE_PYTHON ?? (existsSync(venvPython) ? venvPython : undefined);
const packDir = fixturePackDir('python-pack');
const invalidFlowPackDir = fixturePackDir('python-invalid-flow-pack');

if (python === undefined) {
  describe('pack service conformance — python', () => {
    test.skip(`no interpreter: set KINDGI_CONFORMANCE_PYTHON or run \`uv sync\` in sdks/python (${join('sdks', 'python')})`, () => {});
  });
} else {
  /** Index a pack, and return the indexer's file errors. */
  const index = async (
    dir: string,
    outputPath: string,
    pins: IndexPins,
  ): Promise<readonly IndexFileError[]> => {
    const { stdout } = await run(python, [
      '-m',
      'kindgi.pack',
      'index',
      '--pack-dir',
      dir,
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
      value?: { fileErrors: IndexFileError[] };
    };
    if (outcome.kind !== 'ok' || outcome.value === undefined) throw new Error(`indexer: ${stdout}`);
    return outcome.value.fileErrors;
  };

  describePackServiceConformance({
    name: 'python',
    packDir,
    command: [python, '-m', 'kindgi.pack', 'serve'],
    async buildIndex(outputPath, pins) {
      const fileErrors = await index(packDir, outputPath, pins);
      if (fileErrors.length > 0) throw new Error(fileErrors.map((e) => e.message).join('\n'));
    },
    indexInvalidFlowPack(outputPath, pins) {
      return index(invalidFlowPackDir, outputPath, pins);
    },
  });
}
