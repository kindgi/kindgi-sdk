// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi key` tests. Every filesystem side-effect + every crypto
 * op flows through the injected `KeyRunners` seam so these tests
 * never write real files under `~/.kindgi/keys/` and never call
 * `@kindgi/crypto` directly.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { KindgiApiError } from '@kindgi/client';

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
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('Invalid keyId');
  });

  test('--env prints the kindgi.config.ts tip', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures, ['key', 'create', 'staging-signer', '--env=staging']),
      buildConfigLoader: async () => ({}),
    });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('environments.staging');
    expect(out.stderr).toContain("signingKey: '~/.kindgi/keys/staging-signer.pem'");
    expect(out.stderr).toContain('kindgi build --env=staging');
  });

  test('--env: a block that already names this key says the build signs with it, with no hint', async () => {
    for (const block of [
      { signingKey: '~/.kindgi/keys/prod-signer.pem', signerKeyId: 'prod-signer' },
      // The path written out, and no signerKeyId: the build names the key by its file.
      { signingKey: '/tmp/fake-home/.kindgi/keys/prod-signer.pem' },
      // A relative path: the build reads it from the folder it runs in.
      { signingKey: '../fake-home/.kindgi/keys/prod-signer.pem' },
    ]) {
      const fixtures = makeFixtures();
      const out = await runCli({
        ...baseInputs(fixtures, ['key', 'create', 'prod-signer', '--env=prod']),
        buildConfigLoader: async () => ({ environments: { prod: block } }),
      });
      expect(out.exitCode).toBe(0);
      expect(out.stderr).toContain('environments.prod in kindgi.config.ts already names this key:');
      expect(out.stderr).toContain('`kindgi build --env=prod` will sign with it.');
      expect(out.stderr).not.toContain('Next step');
    }
  });

  test('--env: a block that names another key shows what it has, then the hint', async () => {
    for (const block of [
      { signingKey: '~/.kindgi/keys/prod-old.pem', signerKeyId: 'prod-old' },
      // This key's id on another key's file: the build would sign with the other file.
      { signingKey: '~/.kindgi/keys/prod-old.pem', signerKeyId: 'prod-signer' },
      // This key's file under another id: the signature would name the other key.
      { signingKey: '~/.kindgi/keys/prod-signer.pem', signerKeyId: 'prod-old' },
    ]) {
      const fixtures = makeFixtures();
      const out = await runCli({
        ...baseInputs(fixtures, ['key', 'create', 'prod-signer', '--env=prod']),
        buildConfigLoader: async () => ({ environments: { prod: block } }),
      });
      expect(out.exitCode).toBe(0);
      const has = out.stderr.indexOf('environments.prod in kindgi.config.ts has these now:');
      const next = out.stderr.indexOf('Next step: add to environments.prod in kindgi.config.ts:');
      expect(has).toBeGreaterThan(-1);
      expect(next).toBeGreaterThan(has);
      const now = out.stderr.slice(has, next);
      expect(now).toContain(`signingKey: '${block.signingKey}',`);
      expect(now).toContain(`signerKeyId: '${block.signerKeyId}',`);
      expect(out.stderr.slice(next)).toContain("signingKey: '~/.kindgi/keys/prod-signer.pem',");
      expect(out.stderr).not.toContain('already names this key');
    }
  });

  test('--env: with no HOME, a `~` path is not this key: the build reads `~` as nothing', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      argv: ['key', 'create', 'prod-signer', '--env=prod'],
      env: {},
      cwd: '/tmp/fake-cwd',
      keyRunners: fixtures.runners,
      buildConfigLoader: async () => ({
        environments: { prod: { signingKey: '~/.kindgi/keys/prod-signer.pem' } },
      }),
    });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('environments.prod in kindgi.config.ts has these now:');
    expect(out.stderr).not.toContain('already names this key');
  });

  test("--env: a config without the block, or one that won't load, keeps the hint and makes the key", async () => {
    for (const buildConfigLoader of [
      async () => ({ pack: { id: 'acme.app', version: '1.0.0' } }),
      async () => {
        throw new Error('kindgi.config.ts: SyntaxError');
      },
    ]) {
      const fixtures = makeFixtures();
      const out = await runCli({
        ...baseInputs(fixtures, ['key', 'create', 'prod-signer', '--env=prod']),
        buildConfigLoader,
      });
      expect(out.exitCode).toBe(0);
      expect(fixtures.state.files.has('/tmp/fake-home/.kindgi/keys/prod-signer.pem')).toBe(true);
      expect(out.stderr).toContain('Next step: add to environments.prod in kindgi.config.ts:');
      expect(out.stderr).not.toContain('has these now');
      expect(out.stderr).not.toContain('already names this key');
    }
  });

  test('--env --home: the hint names the file the key went to, since the build reads `~` as the home', async () => {
    for (const [home, signingKey] of [
      ['/override/root', "'/override/root/.kindgi/keys/prod-signer.pem'"],
      // A relative --home: the key went to it from here.
      ['keys-home', "'/tmp/fake-cwd/keys-home/.kindgi/keys/prod-signer.pem'"],
      // A quote in the path: the hint is still one string in kindgi.config.ts.
      ["/srv/o'brien", "'/srv/o\\'brien/.kindgi/keys/prod-signer.pem'"],
    ] as const) {
      const fixtures = makeFixtures();
      const out = await runCli({
        ...baseInputs(fixtures, ['key', 'create', 'prod-signer', '--env=prod', `--home=${home}`]),
        buildConfigLoader: async () => ({}),
      });
      expect(out.exitCode).toBe(0);
      expect(out.stderr).toContain('Next step: add to environments.prod in kindgi.config.ts:');
      expect(out.stderr).toContain(`signingKey: ${signingKey},`);
      expect(out.stderr).not.toContain('~/.kindgi/keys/');
    }
  });

  test('--env: the hint keeps `~` when the key is under the home the build reads `~` as', async () => {
    // No --home, and a --home that is the home.
    for (const homeFlag of [[], ['--home=/tmp/fake-home/']]) {
      const fixtures = makeFixtures();
      const out = await runCli({
        ...baseInputs(fixtures, ['key', 'create', 'prod-signer', '--env=prod', ...homeFlag]),
        buildConfigLoader: async () => ({}),
      });
      expect(out.exitCode).toBe(0);
      expect(out.stderr).toContain("signingKey: '~/.kindgi/keys/prod-signer.pem',");
    }
    // With no HOME, the build reads `~` as nothing: the hint names the file.
    const fixtures = makeFixtures();
    const out = await runCli({
      argv: ['key', 'create', 'prod-signer', '--env=prod'],
      env: {},
      cwd: '/tmp/fake-cwd',
      keyRunners: fixtures.runners,
      buildConfigLoader: async () => ({}),
    });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain(
      `signingKey: '${resolve(homedir(), '.kindgi', 'keys', 'prod-signer.pem')}',`,
    );
    expect(out.stderr).not.toContain('~/.kindgi/keys/');
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
    expect(out.exitCode).toBe(2);
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

// ---------- key trust / revoke (the runtime's trust list) ----------

const KEYS_DIR = '/tmp/fake-home/.kindgi/keys';
/** The 32 raw bytes of FAKE_PUBLIC_PEM's key, base64: what the runtime takes. */
const RAW_PUBLIC_KEY_BASE64 = Buffer.from(FIXED_PUBLIC_KEY).toString('base64');

/** The CLI against `client`, with a runtime URL and token. */
function remoteInputs(
  fixtures: Fixtures,
  argv: readonly string[],
  client: Record<string, unknown>,
): RunCliInputs {
  return {
    ...baseInputs(fixtures, [...argv, '--url=https://runtime.example', '--token=t']),
    clientFactory: () => client as never,
  };
}

describe('kindgi key trust', () => {
  const trusted = {
    keyId: 'acme-signing',
    publicKey: RAW_PUBLIC_KEY_BASE64,
    algorithm: 'ed25519',
    createdAt: '2026-10-04T00:00:00.000Z',
  };

  test("sends the local key's 32 raw bytes, base64 (not the SPKI form), and its label", async () => {
    const fixtures = makeFixtures({ [`${KEYS_DIR}/acme-signing.pub.pem`]: FAKE_PUBLIC_PEM });
    const calls: unknown[] = [];
    const out = await runCli(
      remoteInputs(fixtures, ['key', 'trust', 'acme-signing', '--label=release signing'], {
        signingKeys: {
          trust: async (input: unknown) => {
            calls.push(input);
            return trusted;
          },
        },
      }),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      { keyId: 'acme-signing', publicKey: RAW_PUBLIC_KEY_BASE64, label: 'release signing' },
    ]);
    const exported = await runCli(
      baseInputs(fixtures, ['key', 'export', 'acme-signing', '--format=base64']),
    );
    expect(exported.stdout.trim()).not.toBe(RAW_PUBLIC_KEY_BASE64);
    expect(JSON.parse(out.stdout)).toEqual(trusted);
    expect(out.stderr).toContain('✓ Trusted acme-signing (sha256:');
  });

  test('without --label, sends none', async () => {
    const fixtures = makeFixtures({ [`${KEYS_DIR}/acme-signing.pub.pem`]: FAKE_PUBLIC_PEM });
    const calls: unknown[] = [];
    const out = await runCli(
      remoteInputs(fixtures, ['key', 'trust', 'acme-signing'], {
        signingKeys: {
          trust: async (input: unknown) => {
            calls.push(input);
            return trusted;
          },
        },
      }),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([{ keyId: 'acme-signing', publicKey: RAW_PUBLIC_KEY_BASE64 }]);
  });

  test('no local key: says how to make one, and calls nothing', async () => {
    const fixtures = makeFixtures();
    const calls: unknown[] = [];
    const out = await runCli(
      remoteInputs(fixtures, ['key', 'trust', 'acme-signing'], {
        signingKeys: { trust: async (input: unknown) => calls.push(input) },
      }),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(`no public key at ${KEYS_DIR}/acme-signing.pub.pem`);
    expect(out.stderr).toContain('kindgi key create acme-signing');
    expect(calls).toEqual([]);
  });

  test.each(['signing-key-conflict', 'signing-key-revoked'])(
    'refused with %s: the error, and the commands for a new key id',
    async (serverCode) => {
      const fixtures = makeFixtures({ [`${KEYS_DIR}/acme-signing.pub.pem`]: FAKE_PUBLIC_PEM });
      const out = await runCli(
        remoteInputs(fixtures, ['key', 'trust', 'acme-signing'], {
          signingKeys: {
            trust: async () => {
              throw new KindgiApiError({ code: 'server', serverCode, message: 'refused' });
            },
          },
        }),
      );
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toBe(
        `Error [${serverCode}]: refused\nTo trust another key: \`kindgi key create <newId>\`, then \`kindgi key trust <newId>\`.\n`,
      );
    },
  );

  test('any other error: as usual, with no hint', async () => {
    const fixtures = makeFixtures({ [`${KEYS_DIR}/acme-signing.pub.pem`]: FAKE_PUBLIC_PEM });
    const out = await runCli(
      remoteInputs(fixtures, ['key', 'trust', 'acme-signing'], {
        signingKeys: {
          trust: async () => {
            throw new KindgiApiError({
              code: 'server',
              serverCode: 'internal-error',
              message: 'boom',
            });
          },
        },
      }),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe('Error [internal-error]: boom\n');
  });
});

describe('kindgi key revoke', () => {
  function revoker(result: unknown) {
    const calls: unknown[][] = [];
    return {
      calls,
      client: {
        signingKeys: {
          revoke: async (...args: unknown[]) => {
            calls.push(args);
            return result;
          },
        },
      },
    };
  }

  test('sends the id and --reason; the runtime refuses its new deploys', async () => {
    const { calls, client } = revoker({ keyId: 'acme-signing', revoked: true });
    const out = await runCli(
      remoteInputs(makeFixtures(), ['key', 'revoke', 'acme-signing', '--reason=rotated'], client),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['acme-signing', { reason: 'rotated' }]]);
    expect(JSON.parse(out.stdout)).toEqual({ keyId: 'acme-signing', revoked: true });
    expect(out.stderr).toContain('✓ Revoked acme-signing');
  });

  test('without --reason, sends none', async () => {
    const { calls, client } = revoker({ keyId: 'acme-signing', revoked: true });
    const out = await runCli(
      remoteInputs(makeFixtures(), ['key', 'revoke', 'acme-signing'], client),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['acme-signing', undefined]]);
  });

  test("an id the runtime doesn't trust (or revoked already): says so, and succeeds", async () => {
    const { client } = revoker({ keyId: 'acme-signing', revoked: false });
    const out = await runCli(
      remoteInputs(makeFixtures(), ['key', 'revoke', 'acme-signing'], client),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toContain("acme-signing wasn't revoked");
  });

  test("--quiet: a revoke says nothing; one that wasn't revoked still says so", async () => {
    const revoked = revoker({ keyId: 'acme-signing', revoked: true });
    const done = await runCli(
      remoteInputs(makeFixtures(), ['key', 'revoke', 'acme-signing', '--quiet'], revoked.client),
    );
    expect(done.exitCode, done.stderr).toBe(0);
    expect([done.stdout, done.stderr]).toEqual(['', '']);

    const unknown = revoker({ keyId: 'acme-signing', revoked: false });
    const out = await runCli(
      remoteInputs(makeFixtures(), ['key', 'revoke', 'acme-signing', '--quiet'], unknown.client),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain("acme-signing wasn't revoked");
  });

  test("an id `kindgi key create` wouldn't make still goes to the runtime", async () => {
    const { calls, client } = revoker({ keyId: 'Release:2026', revoked: true });
    const out = await runCli(
      remoteInputs(makeFixtures(), ['key', 'revoke', 'Release:2026'], client),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['Release:2026', undefined]]);
  });

  test('no id: an error, and nothing called', async () => {
    const { calls, client } = revoker({ revoked: true });
    const out = await runCli(remoteInputs(makeFixtures(), ['key', 'revoke'], client));
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('Missing required argument: keyId');
    expect(calls).toEqual([]);
  });
});

describe('kindgi key --quiet', () => {
  test('create, list (with keys or none) and trust print nothing; each does its work', async () => {
    const none = await runCli(baseInputs(makeFixtures(), ['key', 'list', '--quiet']));
    const fixtures = makeFixtures();
    const created = await runCli(
      baseInputs(fixtures, ['key', 'create', 'acme-signing', '--env=staging', '--quiet']),
    );
    expect([...fixtures.state.files.keys()].sort()).toEqual([
      `${KEYS_DIR}/acme-signing.pem`,
      `${KEYS_DIR}/acme-signing.pub.pem`,
    ]);
    const listed = await runCli(baseInputs(fixtures, ['key', 'list', '--quiet']));
    const calls: unknown[] = [];
    const trusted = await runCli(
      remoteInputs(fixtures, ['key', 'trust', 'acme-signing', '--quiet'], {
        signingKeys: {
          trust: async (input: unknown) => {
            calls.push(input);
            return { keyId: 'acme-signing', publicKey: RAW_PUBLIC_KEY_BASE64 };
          },
        },
      }),
    );
    expect(calls).toEqual([{ keyId: 'acme-signing', publicKey: RAW_PUBLIC_KEY_BASE64 }]);
    for (const out of [none, created, listed, trusted]) {
      expect([out.exitCode, out.stdout, out.stderr]).toEqual([0, '', '']);
    }
  });
});
