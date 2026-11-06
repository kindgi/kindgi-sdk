// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * With `HOME` set but empty, `os.homedir()` answers '' (Node reads `HOME`
 * first), and a '' home put `.kindgi/` under the current folder: `kindgi
 * key create` wrote the private key there, often a pack's repo, and
 * `kindgi auth login` the token. Here `homedir` answers '' as it does
 * then: each command that keeps files under the home refuses instead, and
 * the CLI's config reads no home file.
 */

import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { resolveDevSandbox } from '../src/dev/sandbox/notices.js';
import { homeFolder } from '../src/home.js';
import { agentAccessRows, patchAgentAccess } from '../src/init/agent-access.js';
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

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe('homeFolder', () => {
  test('a home given is the home; with none, or an empty one, there is none', () => {
    expect(homeFolder('/tmp/acme-home')).toBe('/tmp/acme-home');
    expect(homeFolder('')).toBeUndefined();
    expect(homeFolder()).toBeUndefined();
  });
});

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
  test.each([
    ['submit', ['feedback', 'submit']],
    ['status', ['feedback', 'status']],
    ['withdraw', ['feedback', 'withdraw', 'fbr_acme0000report01']],
  ])('%s refuses, sends nothing, and writes nothing under the pack', async (subcommand, argv) => {
    const pack = await tempDir('acme-feedback-pack-');
    const cli = (args: string[]) =>
      runCli({
        argv: args,
        env: { HOME: '' },
        cwd: pack,
        configReadFile: async () => null,
        fetchImpl: (async () => {
          throw new Error('no request is made');
        }) as typeof fetch,
      });
    if (subcommand === 'submit') {
      const written = await cli([
        'feedback',
        'write',
        '--kind=bug',
        '--title=A bug',
        '--body=Body.',
        '--authored-by=claude-code',
      ]);
      expect(written.exitCode).toBe(0);
    }
    const out = await cli(argv);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      'Found no home folder for .kindgi/feedback/, since HOME is empty. Set HOME and run it again.',
    );
    expect(await readdir(pack)).not.toContain('.kindgi');
  });
});

describe('the config, with HOME set but empty', () => {
  test('no home file is read: only the folder one', async () => {
    const read: string[] = [];
    await loadConfig({
      env: {},
      cwd: '/tmp/acme-pack',
      readFile: async (path) => {
        read.push(path);
        return null;
      },
    });
    expect(read).toEqual(['/tmp/acme-pack/.kindgirc.json']);
  });

  test('auth login refuses before it reads or writes a file', async () => {
    const out = await runCli({
      argv: ['auth', 'login', '--url=http://127.0.0.1:4100', '--token=acme-token'],
      env: { HOME: '' },
      cwd: '/tmp/acme-pack',
      configReadFile: async () => null,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      'Found no home folder for .kindgi/config.json, since HOME is empty. Set HOME and run it again.',
    );
    expect(out.stdout).toBe('');
  });
});

describe('kindgi dev, with HOME set but empty', () => {
  const base = { config: undefined, packDir: '/work/acme-pack', home: homeFolder() };
  const available = async () => ({ kind: 'available', engine: 'bwrap' }) as const;
  const missing = async () =>
    ({
      kind: 'unavailable',
      reason: "bubblewrap (bwrap) isn't installed",
      fix: 'Install bubblewrap.',
    }) as const;

  test('the sandbox, which keeps the home closed, refuses before it starts', async () => {
    expect(await resolveDevSandbox({ ...base, env: {}, detect: available })).toEqual({
      kind: 'error',
      message:
        'found no home folder for the dev sandbox to keep closed, since HOME is empty. Set HOME and run it again.',
    });
  });

  test.each([
    ['KINDGI_DEV_SANDBOX=off', { env: { KINDGI_DEV_SANDBOX: 'off' }, detect: available }],
    ['dev.sandbox: false', { config: { dev: { sandbox: false } }, env: {}, detect: available }],
    ['no sandbox on this system', { env: {}, detect: missing }],
  ])('with no sandbox (%s), it runs as before', async (_why, over) => {
    expect(await resolveDevSandbox({ ...base, ...over })).toMatchObject({
      kind: 'ok',
      sandbox: undefined,
    });
  });
});

describe('kindgi init, with HOME set but empty', () => {
  test('nothing goes into the repo root, which may be the home, and init says why', async () => {
    const root = await tempDir('acme-repo-');
    await mkdir(join(root, '.git'));
    const pack = join(root, 'scratch', 'acme-pack');
    await mkdir(pack, { recursive: true });

    const result = await patchAgentAccess(pack);
    expect(result.repoRoot).toEqual({ dir: root, prefix: 'scratch/acme-pack', skipped: 'no-home' });
    await expect(stat(join(root, '.claude'))).rejects.toThrow();
    const { warnings } = agentAccessRows(pack, result);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      `${join(root, '.claude', 'settings.json')} not written: HOME is empty, so init can't tell whether the repo root is your home folder; add the rules yourself`,
    );
  });
});
