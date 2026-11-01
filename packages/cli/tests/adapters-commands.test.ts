// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi adapters prepare`: what `--params` and `--model` send, through the client's `adapters.prepare`. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

async function prepare(
  argv: readonly string[],
  events: readonly unknown[] = [{ kind: 'ready', message: 'warm' }],
) {
  const calls: unknown[] = [];
  const out = await runCli({
    argv: ['adapters', 'prepare', ...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        adapters: {
          prepare: (input: { readonly signal?: AbortSignal }) => {
            const { signal: _signal, ...sent } = input;
            calls.push(sent);
            return (async function* () {
              yield* events;
            })();
          },
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi adapters prepare', () => {
  test('--params takes inline JSON', async () => {
    const { out, calls } = await prepare(['acme-onnx', '--params={"model":"small","threads":2}']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([{ adapterId: 'acme-onnx', params: { model: 'small', threads: 2 } }]);
  });

  test('--params=@<file> reads the JSON from the file', async () => {
    const file = join(cwd, 'params.json');
    await writeFile(file, '{"model":"large","threads":4}\n');
    const { out, calls } = await prepare(['acme-onnx', `--params=@${file}`]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([{ adapterId: 'acme-onnx', params: { model: 'large', threads: 4 } }]);
  });

  test('--model wins over the model in --params', async () => {
    const file = join(cwd, 'params.json');
    await writeFile(file, '{"model":"large","threads":4}');
    const { calls } = await prepare(['acme-onnx', `--params=@${file}`, '--model=small']);
    expect(calls).toEqual([{ adapterId: 'acme-onnx', params: { model: 'small', threads: 4 } }]);
  });

  test('malformed JSON, inline or in the file, is a usage error and nothing is sent', async () => {
    const file = join(cwd, 'params.json');
    await writeFile(file, '{"model":');
    for (const params of ['{"model":', `@${file}`]) {
      const { out, calls } = await prepare(['acme-onnx', `--params=${params}`]);
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain('Malformed JSON input');
      expect(calls).toEqual([]);
    }
  });

  test('a missing file fails and nothing is sent', async () => {
    const { out, calls } = await prepare(['acme-onnx', `--params=@${join(cwd, 'absent.json')}`]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('absent.json');
    expect(calls).toEqual([]);
  });

  test('--quiet: nothing for a prepare that is ready; the failure alone, or a stream that never said, is still said', async () => {
    const progress = { kind: 'progress', message: 'loading', ratio: 0.5 };
    const ready = await prepare(['acme-onnx', '--quiet'], [progress, { kind: 'ready' }]);
    expect(ready.out.exitCode, ready.out.stderr).toBe(0);
    expect([ready.out.stdout, ready.out.stderr]).toEqual(['', '']);

    const failed = await prepare(
      ['acme-onnx', '--quiet'],
      [progress, { kind: 'error', message: 'no GPU' }],
    );
    expect(failed.out.exitCode).toBe(1);
    expect(failed.out.stderr).toBe('\n  Failed: no GPU\n\n');

    const unsaid = await prepare(['acme-onnx', '--quiet'], [progress]);
    expect(unsaid.out.exitCode, unsaid.out.stderr).toBe(0);
    expect(unsaid.out.stderr).toBe('\n  Ready: stream ended without terminal event\n\n');
  });
});
