// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The license key `kindgi dev` runs the runtime with: where it comes from
 * (the shell, else the copy `kindgi auth registry` keeps), how it reaches
 * the container (by name, in `docker run`'s own environment only), and
 * where it never goes (`docker`'s arguments, the pack's `runtime.env`).
 */

import { generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { RegistryAuthSeam } from '../src/commands/auth.js';
import {
  DEV_LICENSE_KEY_VAR,
  NO_DEV_LICENSE_KEY,
  resolveDevLicenseKey,
} from '../src/dev/license-key.js';
import {
  type DockerOutcome,
  type DockerRunOptions,
  type RuntimeContainerOptions,
  docker,
  runtimeRunArgs,
  startRuntimeContainer,
} from '../src/dev/runtime-container.js';
import { buildRuntimeEnv, shellReferencesOf, writeRuntimeEnv } from '../src/dev/runtime-env.js';
import { homeLicenseKeyPath, licenseKeyHome, saveHomeLicenseKey } from '../src/license/home-key.js';
import { runCli } from '../src/main.js';

const SIGNER = generateKeyPairSync('ed25519');
const PUBLIC_KEYS = {
  'test-lk': Buffer.from(
    SIGNER.publicKey.export({ format: 'jwk' }).x as string,
    'base64url',
  ).toString('base64'),
};
const NOW = Date.UTC(2026, 10, 7);
const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A license key signed with `SIGNER`: self-serve (`gh-42`), 200 days left, unless `over` says otherwise. */
function licenseKey(over: Record<string, unknown> = {}): string {
  const payload = {
    v: 1,
    kid: 'test-lk',
    sub: 'gh-42',
    name: 'Acme',
    use: 'non-production',
    iat: (NOW - 30 * DAY) / 1000,
    exp: (NOW + 200 * DAY) / 1000,
    ...over,
  };
  const signed = `kgi_lk_${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${signed}.${sign(null, Buffer.from(signed, 'ascii'), SIGNER.privateKey).toString('base64url')}`;
}

const SELF_SERVE_RENEW =
  'Renew it: sign in at https://access.kindgi.com, which shows your latest key, then run kindgi auth registry with it again.';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-dev-license-home-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

const resolve = (env: Record<string, string> = {}, publicKeys = PUBLIC_KEYS) =>
  resolveDevLicenseKey({ env, home, now: () => NOW, publicKeys });
const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe('the key kindgi dev runs with', () => {
  test("the shell's KINDGI_LICENSE_KEY first, over the one kept for kindgi dev", async () => {
    await saveHomeLicenseKey(licenseKey({ name: 'Kept' }), home);
    const shell = licenseKey();
    expect(await resolve({ [DEV_LICENSE_KEY_VAR]: ` ${shell}\n` })).toEqual({
      kind: 'ok',
      key: shell,
      from: 'KINDGI_LICENSE_KEY',
      what: `Acme's non-production key, until ${day(NOW + 200 * DAY)} (200 days)`,
    });
  });

  test('else the one kindgi auth registry kept, an empty KINDGI_LICENSE_KEY included', async () => {
    const kept = licenseKey({ name: 'Kept' });
    await saveHomeLicenseKey(kept, home);
    for (const env of [{}, { [DEV_LICENSE_KEY_VAR]: '' }, { [DEV_LICENSE_KEY_VAR]: '  ' }]) {
      expect(await resolve(env)).toMatchObject({
        kind: 'ok',
        key: kept,
        from: homeLicenseKeyPath(home),
        what: expect.stringMatching(/^Kept's non-production key, until /),
      });
    }
  });

  test('neither: refused, saying where to get a free one and how kindgi dev keeps it', async () => {
    expect(await resolve()).toEqual({ kind: 'error', message: NO_DEV_LICENSE_KEY });
    expect(NO_DEV_LICENSE_KEY).toContain('https://access.kindgi.com');
    expect(NO_DEV_LICENSE_KEY).toContain('kindgi auth registry');
    expect(NO_DEV_LICENSE_KEY).toContain('KINDGI_LICENSE_KEY');
    // An empty file is no key either.
    await mkdir(join(home, '.kindgi', 'license'), { recursive: true });
    await writeFile(homeLicenseKeyPath(home) as string, '\n');
    expect(await resolve()).toEqual({ kind: 'error', message: NO_DEV_LICENSE_KEY });
  });

  test("a value that isn't a license key: refused, naming where it came from, never quoting it", async () => {
    const got = await resolve({ [DEV_LICENSE_KEY_VAR]: 'kgi_lk_not-a-key' });
    expect(got).toEqual({
      kind: 'error',
      message:
        "The value in KINDGI_LICENSE_KEY isn't a Kindgi license key (malformed). Give the whole key, starting kgi_lk_, to kindgi auth registry: from https://access.kindgi.com, or the one Kindgi sent you.",
    });
    expect(JSON.stringify(got)).not.toContain('not-a-key');
  });

  test.skipIf(process.platform === 'win32')(
    "a kept file it can't read: refused, naming the file",
    async () => {
      await saveHomeLicenseKey(licenseKey(), home);
      await chmod(homeLicenseKeyPath(home) as string, 0o000);
      const got = await resolve();
      expect(got.kind).toBe('error');
      expect(got.kind === 'error' && got.message).toMatch(
        new RegExp(`^Couldn't read the license key in ${homeLicenseKeyPath(home)}: `),
      );
    },
  );

  test("signed with a key this CLI doesn't know yet: it runs, and the runtime judges it", async () => {
    const key = licenseKey();
    expect(await resolve({ [DEV_LICENSE_KEY_VAR]: key }, {})).toEqual({
      kind: 'ok',
      key,
      from: 'KINDGI_LICENSE_KEY',
      warning:
        "The license key in KINDGI_LICENSE_KEY is signed with a key this CLI doesn't know yet, so the runtime checks it: update the Kindgi CLI.",
    });
  });

  test("expiring, in its grace, or expired: it starts, with a laptop's way to renew it", async () => {
    const at = async (exp: number, sub = 'gh-42') => {
      const got = await resolve({ [DEV_LICENSE_KEY_VAR]: licenseKey({ exp: exp / 1000, sub }) });
      expect(got.kind).toBe('ok');
      return got.kind === 'ok' ? got.warning : undefined;
    };
    expect(await at(NOW + 12 * DAY)).toBe(
      `Acme's non-production key expires in 12 days (${day(NOW + 12 * DAY)}). ${SELF_SERVE_RENEW}`,
    );
    expect(await at(NOW - 3 * DAY)).toBe(
      `Acme's non-production key expired on ${day(NOW - 3 * DAY)}: the runtime starts with it until ${day(NOW + 11 * DAY)}. ${SELF_SERVE_RENEW}`,
    );
    expect(await at(NOW - 20 * DAY)).toBe(
      `Acme's non-production key expired on ${day(NOW - 20 * DAY)}, more than 14 days ago: the runtime won't start with it. ${SELF_SERVE_RENEW}`,
    );
    // A key Kindgi issued renews by writing to Kindgi: no command to run.
    expect(await at(NOW + 12 * DAY, 'org-acme')).toBe(
      `Acme's non-production key expires in 12 days (${day(NOW + 12 * DAY)}). Renew it: contact@kindgi.com.`,
    );
  });
});

describe('kept for kindgi dev: ~/.kindgi/license/license-key', () => {
  test.skipIf(process.platform === 'win32')(
    'a 0600 file in 0700 folders that hold the license only, the key and a newline',
    async () => {
      const key = licenseKey();
      const path = await saveHomeLicenseKey(` ${key}\n`, home);
      expect(path).toBe(join(home, '.kindgi', 'license', 'license-key'));
      expect(await readFile(path, 'utf8')).toBe(`${key}\n`);
      expect(await mode(path)).toBe(0o600);
      expect(await mode(join(home, '.kindgi', 'license'))).toBe(0o700);
      expect(await mode(join(home, '.kindgi'))).toBe(0o700);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'a looser ~/.kindgi made earlier is made 0700; a new key replaces the old one',
    async () => {
      await mkdir(join(home, '.kindgi'), { mode: 0o755 });
      await chmod(join(home, '.kindgi'), 0o755);
      await saveHomeLicenseKey(licenseKey({ name: 'Old' }), home);
      expect(await mode(join(home, '.kindgi'))).toBe(0o700);
      const renewed = licenseKey({ name: 'Renewed' });
      const path = await saveHomeLicenseKey(renewed, home);
      expect(await readFile(path, 'utf8')).toBe(`${renewed}\n`);
      expect(await mode(path)).toBe(0o600);
    },
  );

  test('the home it goes under: HOME, else the context', () => {
    expect(licenseKeyHome({ env: { HOME: '/home/acme' }, home: '/ctx' })).toBe('/home/acme');
    expect(licenseKeyHome({ env: { HOME: '' }, home: '/ctx' })).toBe('/ctx');
    expect(licenseKeyHome({ env: {}, home: '/ctx' })).toBe('/ctx');
  });
});

describe('the key reaches the runtime by name only', () => {
  const KEY = licenseKey();
  const containerOptions = (
    over: Partial<RuntimeContainerOptions> = {},
  ): RuntimeContainerOptions => ({
    image: 'registry.kindgi.com/kindgi/runtime:1.0.0',
    packDir: join(home, 'pack'),
    envFile: join(home, 'pack', '.kindgi', 'dev', 'runtime.env'),
    network: 'alias',
    hostPort: 4999,
    onLog: () => undefined,
    ...over,
  });

  test("docker run's arguments name it, --env KINDGI_LICENSE_KEY, and never hold it", () => {
    const args = runtimeRunArgs('kindgi-dev-acme', containerOptions({ licenseKey: KEY }));
    const at = args.indexOf(DEV_LICENSE_KEY_VAR);
    expect(args[at - 1]).toBe('--env');
    expect(args.filter((a) => a.includes(DEV_LICENSE_KEY_VAR))).toEqual([DEV_LICENSE_KEY_VAR]);
    expect(args.some((a) => a.includes(KEY))).toBe(false);
    expect(runtimeRunArgs('kindgi-dev-acme', containerOptions())).not.toContain(
      DEV_LICENSE_KEY_VAR,
    );
  });

  test("its value is only in docker run's own environment: not in inspect, logs or rm", async () => {
    // No docker on PATH: the log follower doesn't start, and every command goes to the fake.
    vi.stubEnv('PATH', home);
    const calls: { args: readonly string[]; options: DockerRunOptions | undefined }[] = [];
    const answer = (args: readonly string[]): DockerOutcome => {
      if (args[0] === 'run') return { code: 0, stdout: '0123456789ab\n', stderr: '' };
      if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) {
        return { code: 0, stdout: 'false\n', stderr: '' };
      }
      // No container of that name yet; the stopped one's state and log.
      if (args[0] === 'inspect' && args.at(-1) !== '0123456789ab') {
        return { code: 1, stdout: '', stderr: 'No such object' };
      }
      return { code: 0, stdout: args[0] === 'inspect' ? '2|false|\n' : '', stderr: '' };
    };
    const fake = async (args: readonly string[], options?: DockerRunOptions) => {
      calls.push({ args, options });
      return answer(args);
    };
    await expect(
      startRuntimeContainer(containerOptions({ licenseKey: KEY, docker: fake }), {
        timeoutMs: 1_000,
        fetch: async () => new Response('', { status: 503 }),
      }),
    ).rejects.toThrow();
    const commands = calls.map((c) => c.args[0]);
    expect(commands).toContain('run');
    expect(commands).toContain('inspect');
    expect(commands).toContain('rm');
    for (const call of calls) {
      expect(call.args.some((a) => a.includes(KEY))).toBe(false);
      expect(call.options?.env).toEqual(
        call.args[0] === 'run' ? { [DEV_LICENSE_KEY_VAR]: KEY } : undefined,
      );
    }
  });

  test.skipIf(process.platform === 'win32')(
    "docker's spawn keeps this process's environment (DOCKER_HOST) and adds the key to it",
    async () => {
      const bin = join(home, 'bin');
      await mkdir(bin);
      await writeFile(
        join(bin, 'docker'),
        '#!/bin/sh\nprintf \'%s|%s|%s\\n\' "$DOCKER_HOST" "${KINDGI_LICENSE_KEY-unset}" "$*"\n',
      );
      await chmod(join(bin, 'docker'), 0o755);
      vi.stubEnv('PATH', bin);
      vi.stubEnv('DOCKER_HOST', 'unix:///tmp/acme-docker.sock');
      const shellKey = process.env[DEV_LICENSE_KEY_VAR];
      delete process.env[DEV_LICENSE_KEY_VAR];
      try {
        const run = await docker(['run', '--env', DEV_LICENSE_KEY_VAR], {
          env: { [DEV_LICENSE_KEY_VAR]: KEY },
        });
        expect(run.stdout.trim()).toBe(
          `unix:///tmp/acme-docker.sock|${KEY}|run --env KINDGI_LICENSE_KEY`,
        );
        const other = await docker(['inspect', 'kindgi-dev-acme']);
        expect(other.stdout.trim()).toBe(
          'unix:///tmp/acme-docker.sock|unset|inspect kindgi-dev-acme',
        );
      } finally {
        if (shellKey !== undefined) process.env[DEV_LICENSE_KEY_VAR] = shellKey;
      }
    },
  );

  test("none in the pack's runtime.env, even with a pack's ${KINDGI_LICENSE_KEY} reference", async () => {
    const packDir = join(home, 'pack');
    await mkdir(packDir);
    await writeFile(
      join(packDir, '.env'),
      'ACME_LICENSE=${KINDGI_LICENSE_KEY}\nACME_TOKEN=${ACME_TOKEN}\n',
    );
    const shellReferences = await shellReferencesOf({
      packDir,
      shellEnv: { [DEV_LICENSE_KEY_VAR]: KEY, ACME_TOKEN: 'acme-shell-token' },
    });
    expect(shellReferences).toEqual({ [DEV_LICENSE_KEY_VAR]: KEY, ACME_TOKEN: 'acme-shell-token' });
    const env = buildRuntimeEnv({
      apiPort: 4000,
      publicUrl: 'http://127.0.0.1:4999',
      packDir,
      databaseUrl: 'postgres://kindgi@127.0.0.1:5432/kindgi',
      tenantId: 't-1',
      token: 'kgi_bt_dev',
      seedUserId: 'u-1',
      packService: { url: 'http://127.0.0.1:8080', token: 'pack-token' },
      corsOrigins: [],
      shellReferences,
    });
    expect(env.ACME_TOKEN).toBe('acme-shell-token');
    expect(env).not.toHaveProperty(DEV_LICENSE_KEY_VAR);
    const path = join(packDir, '.kindgi', 'dev', 'runtime.env');
    await writeRuntimeEnv(path, env);
    expect(await readFile(path, 'utf8')).not.toContain(KEY);
  });
});

describe('kindgi auth registry keeps the key for kindgi dev', () => {
  const OK: DockerOutcome = { code: 0, stdout: '', stderr: '' };
  const registry = (argv: readonly string[], seam: RegistryAuthSeam) =>
    runCli({
      argv: ['auth', 'registry', ...argv],
      env: {},
      cwd: tmpdir(),
      home,
      registryAuthSeam: seam,
    });
  const fakeDocker = () => {
    const calls: { args: readonly string[]; options: DockerRunOptions | undefined }[] = [];
    return {
      calls,
      run: async (args: readonly string[], options?: DockerRunOptions) => {
        calls.push({ args, options });
        return OK;
      },
    };
  };
  const KEY = licenseKey();
  const kept = () => join(home, '.kindgi', 'license', 'license-key');

  test.skipIf(process.platform === 'win32')(
    'a login with the license key writes it, 0600, once Docker has logged in with it',
    async () => {
      const fake = fakeDocker();
      const out = await registry(['--password-stdin'], {
        docker: fake.run,
        readStdin: async () => KEY,
      });
      expect(out.exitCode).toBe(0);
      expect(fake.calls.find((c) => c.args[0] === 'login')?.options?.stdin).toBe(KEY);
      expect(await readFile(kept(), 'utf8')).toBe(`${KEY}\n`);
      expect(await mode(kept())).toBe(0o600);
      expect(fake.calls.every((c) => !c.args.some((a) => a.includes(KEY)))).toBe(true);
    },
  );

  test('--check logs nothing in and keeps nothing', async () => {
    const fake = fakeDocker();
    const out = await registry(['--check'], { docker: fake.run });
    expect(out.exitCode).toBe(0);
    expect(fake.calls.some((c) => c.args[0] === 'login')).toBe(false);
    await expect(stat(join(home, '.kindgi', 'license'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test("a mirror's token isn't a license key: it isn't kept", async () => {
    const fake = fakeDocker();
    const out = await registry(
      ['--registry', 'quay.io', '--username', 'robot', '--password-stdin'],
      { docker: fake.run, readStdin: async () => 'robot-token' },
    );
    expect(out.exitCode).toBe(0);
    await expect(stat(kept())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
