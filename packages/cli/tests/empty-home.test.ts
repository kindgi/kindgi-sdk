// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * With `HOME` set but empty, `os.homedir()` answers '' (Node reads `HOME`
 * first), and a '' home put `.kindgi/` under the current folder: `kindgi
 * key create` wrote the private key there, often a pack's repo. Here
 * `homedir` answers '' as it does then, and each command that keeps files
 * under the home refuses instead.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

import type { GeneratedKeyPair, KeyRunners } from '../src/key/runners.js';
import { runCli } from '../src/main.js';

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => '',
}));

const FAKE_PUBLIC_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAERERERERERERERERERERERERERERERERERERERERERE=\n-----END PUBLIC KEY-----\n';
const FAKE_PRIVATE_PEM =
  '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIi\n-----END PRIVATE KEY-----\n';

/** Key runners that record each call, and answer as an empty keys folder. */
function recordingRunners(): { readonly runners: KeyRunners; readonly calls: string[] } {
  const calls: string[] = [];
  const runners: KeyRunners = {
    generateKeyPair: async (): Promise<GeneratedKeyPair> => {
      calls.push('generateKeyPair');
      return {
        publicKey: new Uint8Array(32).fill(0x11),
        privateKey: new Uint8Array(32).fill(0x22),
        privateKeyPem: FAKE_PRIVATE_PEM,
        publicKeyPem: FAKE_PUBLIC_PEM,
      };
    },
    mkdir: async (path) => {
      calls.push(`mkdir ${path}`);
    },
    writeFile: async (opts) => {
      calls.push(`writeFile ${opts.path}`);
    },
    readFile: async (path) => {
      calls.push(`readFile ${path}`);
      return null;
    },
    readdir: async (path) => {
      calls.push(`readdir ${path}`);
      return [];
    },
    exists: async (path) => {
      calls.push(`exists ${path}`);
      return false;
    },
  };
  return { runners, calls };
}

describe('kindgi key, with HOME set but empty', () => {
  test.each([
    ['create', ['key', 'create', 'dev-signing']],
    ['export', ['key', 'export', 'dev-signing']],
    ['list', ['key', 'list']],
    ['trust', ['key', 'trust', 'dev-signing']],
  ])('%s refuses, and touches no file', async (subcommand, argv) => {
    const { runners, calls } = recordingRunners();
    const out = await runCli({
      argv,
      env: { HOME: '' },
      cwd: '/tmp/acme-pack',
      keyRunners: runners,
      configReadFile: async () => null,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe(
      `kindgi key ${subcommand}: found no home folder for .kindgi/keys/, since HOME is empty. Set HOME, or pass --home <dir>.\n`,
    );
    expect(calls).toEqual([]);
  });

  test('--home still names the home', async () => {
    const { runners, calls } = recordingRunners();
    const out = await runCli({
      argv: ['key', 'create', 'dev-signing', '--home=/tmp/acme-home'],
      env: { HOME: '' },
      cwd: '/tmp/acme-pack',
      keyRunners: runners,
      configReadFile: async () => null,
    });
    expect(out.exitCode).toBe(0);
    expect(calls).toContain('writeFile /tmp/acme-home/.kindgi/keys/dev-signing.pem');
  });
});

describe('kindgi feedback, with HOME set but empty', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  test('status refuses, and writes nothing under the pack', async () => {
    const pack = await mkdtemp(join(tmpdir(), 'acme-feedback-pack-'));
    dirs.push(pack);
    const out = await runCli({
      argv: ['feedback', 'status'],
      env: { HOME: '' },
      cwd: pack,
      configReadFile: async () => null,
      fetchImpl: (async () => {
        throw new Error('no request is made');
      }) as typeof fetch,
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(
      'Found no home folder for .kindgi/feedback/, since HOME is empty. Set HOME and run it again.',
    );
    expect(await readdir(pack)).toEqual([]);
  });
});
