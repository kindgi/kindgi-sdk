// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The supervisor `kindgi dev` uses (`createPackServiceSupervisor`) with the
 * Python pack service as its child: calls go through the front, and a new
 * index swaps the code behind the same address.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createPackServiceSupervisor } from '@kindgi/handler-runtime/pack-service';
import { afterAll, describe, expect, test } from 'vitest';

import { fixturePackDir } from '../src/index.js';

const run = promisify(execFile);
const venvPython = fileURLToPath(new URL('../../../sdks/python/.venv/bin/python', import.meta.url));
const python =
  process.env.KINDGI_CONFORMANCE_PYTHON ?? (existsSync(venvPython) ? venvPython : undefined);

const cleanup: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const step of cleanup.reverse()) await step();
});

async function index(python: string, packDir: string, out: string): Promise<void> {
  await run(python, [
    '-m',
    'kindgi.pack',
    'index',
    '--pack-dir',
    packDir,
    '--output',
    out,
    '--json',
  ]);
}

describe.skipIf(python === undefined)('the supervisor runs a Python pack service', () => {
  test('calls go through the front; a new index swaps the code behind it', async () => {
    const py = python as string;
    const packDir = await mkdtemp(join(tmpdir(), 'kindgi-py-supervised-'));
    cleanup.push(() => rm(packDir, { recursive: true, force: true }));
    await cp(fixturePackDir('python-pack'), packDir, { recursive: true });

    const supervisor = createPackServiceSupervisor({
      command: [py, '-m', 'kindgi.pack', 'serve'],
      moduleRoot: packDir,
      env: async () => ({ PATH: process.env.PATH ?? '' }),
    });
    cleanup.push(() => supervisor.close());
    const { url } = await supervisor.listen();

    const echo = async (): Promise<unknown> => {
      const res = await fetch(`${url}/v1/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'kindgi-pack-token': supervisor.token },
        body: JSON.stringify({
          v: 2,
          kind: 'invoke',
          tool: { id: 'conformance.echo' },
          input: { message: 'hi' },
          ctx: { tenantId: 't', runId: 'r' },
        }),
      });
      return ((await res.json()) as { output?: unknown }).output;
    };

    const first = join(packDir, 'index-1.json');
    await index(py, packDir, first);
    const started = await supervisor.start(first);
    expect(started.kind).toBe('ok');
    expect(await echo()).toEqual({ message: 'hi' });

    // Edit the code: echo now shouts. A new index, a new child, the same front.
    const source = join(packDir, 'tools', 'echo.py');
    await writeFile(
      source,
      (await readFile(source, 'utf8')).replace(
        'message=input.message',
        'message=input.message.upper()',
      ),
      'utf8',
    );
    const second = join(packDir, 'index-2.json');
    await index(py, packDir, second);
    const swapped = await supervisor.start(second);
    expect(swapped.kind).toBe('ok');
    expect(await echo()).toEqual({ message: 'HI' });
  });
});
