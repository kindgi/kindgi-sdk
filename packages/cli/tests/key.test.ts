// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi key` tests. Every filesystem side-effect + every crypto
 * op flows through the injected `KeyRunners` seam so these tests
 * never write real files under `~/.kindgi/keys/` and never call
 * `@kindgi/crypto` directly.
 */

import { describe, expect, test } from 'vitest';

import type {
  GeneratedKeyPair,
  KeyDirEntry,
  KeyRunners,
  WriteFileOptions,
} from '../src/key/runners.js';
import { type RunCliInputs, runCli } from '../src/main.js';

// ---------- fake KeyRunners ----------

interface RecordedCall {
  readonly op: 'mkdir' | 'writeFile';
  readonly path: string;
  readonly mode: number;
  readonly contents?: string | Uint8Array;
}

interface Fixtures {
  runners: KeyRunners;
  readonly state: {
    generatedCount: number;
    calls: RecordedCall[];
    files: Map<string, { contents: string; mode: number }>;
    dirs: Set<string>;
  };
}

const FIXED_PUBLIC_KEY = new Uint8Array(32).fill(0x11);
const FIXED_PRIVATE_KEY = new Uint8Array(32).fill(0x22);
const FAKE_PUBLIC_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAERERERERERERERERERERERERERERERERERERERERERE=\n-----END PUBLIC KEY-----\n';
const FAKE_PRIVATE_PEM =
  '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIi\n-----END PRIVATE KEY-----\n';

function makeFixtures(preExistingFiles: Record<string, string> = {}): Fixtures {
  const files = new Map<string, { contents: string; mode: number }>();
  for (const [path, contents] of Object.entries(preExistingFiles)) {
    files.set(path, { contents, mode: 0o644 });
  }
  const state: Fixtures['state'] = {
    generatedCount: 0,
    calls: [],
    files,
    dirs: new Set(),
  };
  const runners: KeyRunners = {
    generateKeyPair: async (): Promise<GeneratedKeyPair> => {
      state.generatedCount += 1;
      return {
        publicKey: FIXED_PUBLIC_KEY,
        privateKey: FIXED_PRIVATE_KEY,
        privateKeyPem: FAKE_PRIVATE_PEM,
        publicKeyPem: FAKE_PUBLIC_PEM,
      };
    },
    mkdir: async (path, mode) => {
      state.calls.push({ op: 'mkdir', path, mode });
      state.dirs.add(path);
    },
    writeFile: async (opts: WriteFileOptions) => {
      state.calls.push({
        op: 'writeFile',
        path: opts.path,
        mode: opts.mode,
        contents: opts.contents,
      });
      state.files.set(opts.path, {
        contents: typeof opts.contents === 'string' ? opts.contents : '',
        mode: opts.mode,
      });
    },
    readFile: async (path) => {
      const file = state.files.get(path);
      return file === undefined ? null : file.contents;
    },
    readdir: async (path): Promise<readonly KeyDirEntry[]> => {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const entries: KeyDirEntry[] = [];
      for (const filePath of state.files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        if (rest.includes('/')) continue;
        entries.push({ name: rest, isFile: true });
      }
      return entries;
    },
    exists: async (path) => state.files.has(path),
  };
  return { runners, state };
}

function baseInputs(
  fixtures: Fixtures,
  argv: readonly string[],
  home = '/tmp/fake-home',
): RunCliInputs {
  return {
    argv,
    env: { HOME: home },
    home,
    cwd: '/tmp/fake-cwd',
    keyRunners: fixtures.runners,
  };
}

// ---------- key create ----------

describe('kindgi key create', () => {
  test('writes private + public PEM with correct modes + fingerprint', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(baseInputs(fixtures, ['key', 'create', 'dev-signing']));
    expect(out.exitCode).toBe(0);
    const summary = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(summary.keyId).toBe('dev-signing');
    expect(summary.privateKeyPath).toBe('/tmp/fake-home/.kindgi/keys/dev-signing.pem');
    expect(summary.publicKeyPath).toBe('/tmp/fake-home/.kindgi/keys/dev-signing.pub.pem');
    expect(typeof summary.fingerprint).toBe('string');
    expect((summary.fingerprint as string).startsWith('sha256:')).toBe(true);

    const priv = fixtures.state.calls.find(
      (c) => c.op === 'writeFile' && c.path.endsWith('dev-signing.pem'),
    );
    const pub = fixtures.state.calls.find(
      (c) => c.op === 'writeFile' && c.path.endsWith('dev-signing.pub.pem'),
    );
    expect(priv?.mode).toBe(0o600);
    expect(pub?.mode).toBe(0o644);
    const mkdirCall = fixtures.state.calls.find((c) => c.op === 'mkdir');
    expect(mkdirCall?.mode).toBe(0o700);
  });

  test('refuses to overwrite an existing private key', async () => {
    const fixtures = makeFixtures({
      '/tmp/fake-home/.kindgi/keys/dev-signing.pem': FAKE_PRIVATE_PEM,
    });
    const out = await runCli(baseInputs(fixtures, ['key', 'create', 'dev-signing']));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('refuses to overwrite');
    expect(fixtures.state.generatedCount).toBe(0);
  });

  test('rejects an invalid keyId', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(baseInputs(fixtures, ['key', 'create', 'BAD_ID_WITH_UPPER']));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Invalid keyId');
  });

  test('--env prints the kindgi.config.ts tip', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(
      baseInputs(fixtures, ['key', 'create', 'staging-signer', '--env=staging']),
    );
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('environments.staging');
    expect(out.stderr).toContain("signingKey: '~/.kindgi/keys/staging-signer.pem'");
    expect(out.stderr).toContain('kindgi build --env=staging');
  });

  test('--home overrides HOME env + ctx home', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures, ['key', 'create', 'k1', '--home=/override/root']),
      env: { HOME: '/env-home' },
    });
    expect(out.exitCode).toBe(0);
    const summary = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(summary.privateKeyPath).toBe('/override/root/.kindgi/keys/k1.pem');
  });
});

// ---------- key export ----------

describe('kindgi key export', () => {
  test('defaults to PEM format', async () => {
    const fixtures = makeFixtures({
      '/tmp/fake-home/.kindgi/keys/k1.pub.pem': FAKE_PUBLIC_PEM,
    });
    const out = await runCli(baseInputs(fixtures, ['key', 'export', 'k1']));
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('-----BEGIN PUBLIC KEY-----');
    expect(out.stdout).toContain('-----END PUBLIC KEY-----');
  });

  test('--format=base64 emits the compact wire form', async () => {
    const fixtures = makeFixtures({
      '/tmp/fake-home/.kindgi/keys/k1.pub.pem': FAKE_PUBLIC_PEM,
    });
    const out = await runCli(baseInputs(fixtures, ['key', 'export', 'k1', '--format=base64']));
    expect(out.exitCode).toBe(0);
    // Base64 output should not contain PEM header/footer, be non-empty, and terminate with newline.
    expect(out.stdout).not.toContain('-----BEGIN');
    expect(out.stdout.trim().length).toBeGreaterThan(0);
    expect(out.stdout.endsWith('\n')).toBe(true);
  });

  test('--format=raw-hex emits 64 hex chars for 32 key bytes', async () => {
    const fixtures = makeFixtures({
      '/tmp/fake-home/.kindgi/keys/k1.pub.pem': FAKE_PUBLIC_PEM,
    });
    const out = await runCli(baseInputs(fixtures, ['key', 'export', 'k1', '--format=raw-hex']));
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  test('missing key errors with a create-hint', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(baseInputs(fixtures, ['key', 'export', 'missing-key']));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('kindgi key create missing-key');
  });

  test('unknown --format errors clearly', async () => {
    const fixtures = makeFixtures({
      '/tmp/fake-home/.kindgi/keys/k1.pub.pem': FAKE_PUBLIC_PEM,
    });
    const out = await runCli(baseInputs(fixtures, ['key', 'export', 'k1', '--format=jwk']));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Unknown --format: jwk');
  });
});

// ---------- key list ----------

describe('kindgi key list', () => {
  test('lists paired keys sorted', async () => {
    const fixtures = makeFixtures({
      '/tmp/fake-home/.kindgi/keys/staging.pem': FAKE_PRIVATE_PEM,
      '/tmp/fake-home/.kindgi/keys/staging.pub.pem': FAKE_PUBLIC_PEM,
      '/tmp/fake-home/.kindgi/keys/prod.pem': FAKE_PRIVATE_PEM,
      '/tmp/fake-home/.kindgi/keys/prod.pub.pem': FAKE_PUBLIC_PEM,
    });
    const out = await runCli(baseInputs(fixtures, ['key', 'list']));
    expect(out.exitCode).toBe(0);
    const summary = JSON.parse(out.stdout) as { count: number; keys: Array<{ keyId: string }> };
    expect(summary.count).toBe(2);
    expect(summary.keys.map((k) => k.keyId)).toEqual(['prod', 'staging']);
  });

  test('ignores orphaned private key (no matching .pub.pem)', async () => {
    const fixtures = makeFixtures({
      '/tmp/fake-home/.kindgi/keys/orphan.pem': FAKE_PRIVATE_PEM,
    });
    const out = await runCli(baseInputs(fixtures, ['key', 'list']));
    expect(out.exitCode).toBe(0);
    const summary = JSON.parse(out.stdout) as { count: number };
    expect(summary.count).toBe(0);
  });

  test('ignores orphaned public key (no matching .pem)', async () => {
    const fixtures = makeFixtures({
      '/tmp/fake-home/.kindgi/keys/orphan.pub.pem': FAKE_PUBLIC_PEM,
    });
    const out = await runCli(baseInputs(fixtures, ['key', 'list']));
    expect(out.exitCode).toBe(0);
    const summary = JSON.parse(out.stdout) as { count: number };
    expect(summary.count).toBe(0);
  });

  test('empty dir returns count 0 with a friendly banner', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(baseInputs(fixtures, ['key', 'list']));
    expect(out.exitCode).toBe(0);
    const summary = JSON.parse(out.stdout) as { count: number };
    expect(summary.count).toBe(0);
    expect(out.stderr).toContain('(no keys under');
  });

  test('fingerprint is stable across list calls', async () => {
    const fixtures = makeFixtures({
      '/tmp/fake-home/.kindgi/keys/k.pem': FAKE_PRIVATE_PEM,
      '/tmp/fake-home/.kindgi/keys/k.pub.pem': FAKE_PUBLIC_PEM,
    });
    const out1 = await runCli(baseInputs(fixtures, ['key', 'list']));
    const out2 = await runCli(baseInputs(fixtures, ['key', 'list']));
    const s1 = JSON.parse(out1.stdout) as { keys: Array<{ fingerprint: string }> };
    const s2 = JSON.parse(out2.stdout) as { keys: Array<{ fingerprint: string }> };
    expect(s1.keys[0]?.fingerprint).toBe(s2.keys[0]?.fingerprint);
    expect(s1.keys[0]?.fingerprint).toMatch(/^sha256:[0-9a-f]{24}$/);
  });
});
