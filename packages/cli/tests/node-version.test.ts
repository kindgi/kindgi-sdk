// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * On a Node older than the CLI needs, `kindgi` stops with one line that
 * says what to do, before the rest of the CLI loads (npm's EBADENGINE
 * warnings come before it, from npm). The spawned runs need the build
 * (`dist/cli.js`).
 */

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import { MIN_NODE, atLeast, unsupportedNode } from '../src/node-version.js';

const DIST = new URL('../dist/', import.meta.url);
const CLI = fileURLToPath(new URL('cli.js', DIST));
const OLD_NODE = fileURLToPath(new URL('./fixtures/old-node.mjs', import.meta.url));

async function cliPackage(): Promise<{ version: string; engines: { node: string } }> {
  return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
}

test('MIN_NODE is the CLI package’s engines.node', async () => {
  expect((await cliPackage()).engines.node).toBe(`>=${MIN_NODE}`);
  expect(atLeast('22.12.0', MIN_NODE)).toBe(true);
  expect(atLeast('22.11.9', MIN_NODE)).toBe(false);
  expect(atLeast('v23.0.0', MIN_NODE)).toBe(true);
});

test.each([
  ['20.11.0', 'stops'],
  ['22.11.9', 'stops'],
  ['22.12.0', 'runs'],
  ['23.0.0', 'runs'],
])('Node %s: the CLI %s', (version, outcome) => {
  expect(unsupportedNode(version) === undefined ? 'runs' : 'stops').toBe(outcome);
});

test('the line names both Nodes and what to do', () => {
  expect(unsupportedNode('20.11.0')).toBe(
    'Kindgi needs Node 22.12.0 or later; this is Node 20.11.0. Install or switch to it (nvm install 22, or https://nodejs.org), then run the command again.',
  );
});

test('an older Node: that line alone and exit 1, with nothing past the check loaded', () => {
  const run = spawnSync(process.execPath, ['--import', OLD_NODE, CLI, '--version'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({
    status: 1,
    stdout: '',
    stderr: `${unsupportedNode('20.11.0')}\n`,
  });
});

test('cli.js and the modules it loads before the check: no `??` or `?.`, so Node 12 parses them', async () => {
  const read = (file: string) => readFile(new URL(file, DIST), 'utf8');
  const beforeTheCheck = [
    ...(await read('cli.js')).matchAll(/^import .* from '\.\/([^']+)';$/gm),
  ].map((m) => m[1] as string);
  expect(beforeTheCheck).toContain('node-version.js');
  for (const file of ['cli.js', ...beforeTheCheck]) {
    expect({ file, newer: (await read(file)).match(/\?\?|\?\.(?!\d)/g) }).toEqual({
      file,
      newer: null,
    });
  }
});

test('the Node running these tests: the CLI runs', async () => {
  const run = spawnSync(process.execPath, [CLI, '--version'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(run.status).toBe(0);
  expect(run.stdout).toBe(`${(await cliPackage()).version}\n`);
  expect(run.stderr).not.toContain('Kindgi needs Node');
});
