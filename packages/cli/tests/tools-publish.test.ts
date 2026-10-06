// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi tools publish` (T238): a tool manifest, registered in a project. */

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

const MANIFEST = {
  id: 'acme.verify-citation',
  version: '1.0.0',
  description: 'Verify a legal citation',
  input: { type: 'object' },
  output: { type: 'object' },
};

async function publish(flags: readonly string[]) {
  const calls: unknown[][] = [];
  const out = await runCli({
    argv: ['tools', 'publish', ...flags, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        projects: { getDefault: async () => ({ id: 'p-default' }) },
        tools: {
          register: async (...args: unknown[]) => {
            calls.push(args);
            return { toolId: 'acme.verify-citation' };
          },
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi tools publish', () => {
  test('a manifest from a file, in the Default project', async () => {
    await writeFile(join(cwd, 'tool.json'), JSON.stringify(MANIFEST));
    // `@<file>` reads from the process's working directory; an absolute path here.
    const { out, calls } = await publish([`--manifest=@${join(cwd, 'tool.json')}`]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([[MANIFEST, { projectId: 'p-default' }]]);
    expect(JSON.parse(out.stdout)).toEqual({ toolId: 'acme.verify-citation' });
  });

  test('inline JSON, with --project', async () => {
    const { out, calls } = await publish([
      `--manifest=${JSON.stringify(MANIFEST)}`,
      '--project=p-2',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([[MANIFEST, { projectId: 'p-2' }]]);
  });

  test('without --manifest: an error naming it, nothing registered', async () => {
    const { out, calls } = await publish([]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('--manifest=<json-or-@file> is required');
    expect(calls).toEqual([]);
  });

  test('is in --help now', async () => {
    const { out } = await publish(['--help']);
    expect(out.stdout).toContain(
      'kindgi tools publish --manifest=<json-or-@file> [--project=<project-id>]',
    );
  });
});
