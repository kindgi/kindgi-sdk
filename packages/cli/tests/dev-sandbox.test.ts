// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The dev sandbox's parts that need no sandbox to test: the settings, what
 * detection says, the Seatbelt profile and bwrap's arguments for a policy,
 * the policy's roots, and what `kindgi dev` prints. The sandbox itself,
 * for real: `dev-sandbox-live.test.ts`.
 */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { appSecrets, bwrapArgs } from '../src/dev/sandbox/bwrap.js';
import { type ProbeResult, detectDevSandbox } from '../src/dev/sandbox/detect.js';
import { resolveDevSandbox } from '../src/dev/sandbox/notices.js';
import { type SandboxPolicy, classpathEntries, sandboxPolicy } from '../src/dev/sandbox/policy.js';
import { seatbeltProfile } from '../src/dev/sandbox/seatbelt.js';
import { devSandboxSettings } from '../src/dev/sandbox/settings.js';

const PATHS = { packDir: '/work/app', home: '/home/me' };
const ON = { mode: 'on', source: 'default', allowRead: [], allowUnixSockets: [] } as const;

describe('the settings', () => {
  test('on by default; off or required from KINDGI_DEV_SANDBOX, which wins over the config', () => {
    expect(devSandboxSettings(undefined, {}, PATHS)).toEqual({ kind: 'ok', value: ON });
    expect(devSandboxSettings({ dev: { sandbox: false } }, {}, PATHS)).toMatchObject({
      value: { mode: 'off', source: 'config' },
    });
    expect(
      devSandboxSettings({ dev: { sandbox: false } }, { KINDGI_DEV_SANDBOX: 'required' }, PATHS),
    ).toMatchObject({
      value: { mode: 'required', source: 'env' },
    });
    expect(devSandboxSettings(undefined, { KINDGI_DEV_SANDBOX: 'off' }, PATHS)).toMatchObject({
      value: { mode: 'off', source: 'env' },
    });
  });

  test('allowRead and allowUnixSockets: ~ under home, relative under the pack root', () => {
    const outcome = devSandboxSettings(
      {
        dev: {
          sandbox: {
            allowRead: ['~/.aws', 'data', '/srv/shared'],
            allowUnixSockets: ['/tmp/.s.PGSQL.5432'],
          },
        },
      },
      {},
      PATHS,
    );
    expect(outcome).toEqual({
      kind: 'ok',
      value: {
        ...ON,
        allowRead: ['/home/me/.aws', '/work/app/data', '/srv/shared'],
        allowUnixSockets: ['/tmp/.s.PGSQL.5432'],
      },
    });
  });

  test('a value it doesn’t know is refused, saying what it takes', () => {
    expect(devSandboxSettings(undefined, { KINDGI_DEV_SANDBOX: 'yes' }, PATHS)).toEqual({
      kind: 'invalid',
      message: 'KINDGI_DEV_SANDBOX must be `on`, `off` or `required`, not "yes"',
    });
    expect(devSandboxSettings({ dev: { sandbox: 'off' } }, {}, PATHS)).toMatchObject({
      kind: 'invalid',
    });
    expect(devSandboxSettings({ dev: { sandbox: { allowWrite: [] } } }, {}, PATHS)).toMatchObject({
      kind: 'invalid',
      message: expect.stringContaining('not `allowWrite`'),
    });
    expect(
      devSandboxSettings({ dev: { sandbox: { allowRead: '~/.aws' } } }, {}, PATHS),
    ).toMatchObject({
      kind: 'invalid',
      message: '`dev.sandbox.allowRead` must be a list of paths',
    });
  });
});

describe('detection', () => {
  const probe = (result: ProbeResult) => async (): Promise<ProbeResult> => result;

  test('macOS: Seatbelt, or why not (nested inside another sandbox)', async () => {
    expect(await detectDevSandbox('darwin', probe({ code: 0, stderr: '' }))).toEqual({
      kind: 'available',
      engine: 'seatbelt',
    });
    expect(
      await detectDevSandbox(
        'darwin',
        probe({ code: 71, stderr: 'sandbox-exec: sandbox_apply: Operation not permitted' }),
      ),
    ).toMatchObject({
      kind: 'unavailable',
      reason: expect.stringContaining('already inside a sandbox'),
    });
  });

  test('Linux: bubblewrap, or why not, with the fix', async () => {
    expect(await detectDevSandbox('linux', probe({ code: 0, stderr: '' }))).toEqual({
      kind: 'available',
      engine: 'bwrap',
    });
    expect(
      await detectDevSandbox(
        'linux',
        probe({ code: null, stderr: 'spawn bwrap ENOENT', errorCode: 'ENOENT' }),
      ),
    ).toMatchObject({
      reason: "bubblewrap (bwrap) isn't installed",
      fix: expect.stringContaining('apt-get install bubblewrap'),
    });
    expect(
      await detectDevSandbox(
        'linux',
        probe({ code: 1, stderr: 'bwrap: setting up uid map: Permission denied' }),
      ),
    ).toMatchObject({
      reason: expect.stringContaining('Ubuntu 23.10'),
    });
    expect(
      await detectDevSandbox(
        'linux',
        probe({ code: 1, stderr: 'bwrap: Creating new namespace failed: Operation not permitted' }),
      ),
    ).toMatchObject({ reason: expect.stringContaining('a container') });
  });

  test('Windows: none; WSL has one', async () => {
    expect(await detectDevSandbox('win32', probe({ code: 0, stderr: '' }))).toMatchObject({
      kind: 'unavailable',
      fix: expect.stringContaining('WSL'),
    });
  });
});

const POLICY: SandboxPolicy = {
  app: '/work/app',
  home: '/home/me',
  readRoots: ['/home/me/.nvm/versions/node/v22.21.1', '/work/node_modules'],
  skipped: [],
  allowUnixSockets: ['/tmp/.s.PGSQL.5432'],
  tmpDir: '/private/var/folders/xx/yy/T/kindgi-dev-abc',
};

describe('the Seatbelt profile', () => {
  const profile = seatbeltProfile(POLICY);
  const at = (needle: string): number => {
    const i = profile.indexOf(needle);
    expect(i, needle).toBeGreaterThanOrEqual(0);
    return i;
  };

  test('closes home and shared temp before it opens the roots, and the secrets after (the last rule wins)', () => {
    const closeHome = at('(deny file-read* file-write* (subpath "/home/me")');
    const openRoots = at(
      '(allow file-read* (subpath "/home/me/.nvm/versions/node/v22.21.1") (subpath "/work/node_modules"))',
    );
    const openApp = at('(allow file-read* file-write* (subpath "/work/app"))');
    const closeSecrets = at('(regex #"/\\.env[^/]*$")');
    const devOutputs = at('(literal "/work/app/.kindgi/dev/index.json")');
    expect(closeHome).toBeLessThan(openRoots);
    expect(openRoots).toBeLessThan(openApp);
    expect(openApp).toBeLessThan(closeSecrets);
    expect(closeSecrets).toBeLessThan(devOutputs);
    expect(profile).toContain('(subpath "/private/var/folders") (subpath "/private/tmp")');
    expect(profile).toContain(
      '(allow file-read* file-write* (subpath "/private/var/folders/xx/yy/T/kindgi-dev-abc"))',
    );
  });

  test('the folders above what it runs can be looked up, not read', () => {
    expect(profile).toMatch(/\(allow file-read-metadata [^\n]*\(literal "\/work"\)/);
    expect(profile).toContain('(literal "/work/app/.kindgi")');
  });

  test('no UNIX sockets but DNS and the allowed ones', () => {
    expect(profile).toContain('(deny network-outbound (remote unix-socket))');
    expect(profile).toContain(
      '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")) (remote unix-socket (path-literal "/tmp/.s.PGSQL.5432")))',
    );
  });

  test('a path with a quote or a backslash stays one string', () => {
    const odd = seatbeltProfile({ ...POLICY, app: '/work/a "b"\\c', readRoots: [] });
    expect(odd).toContain('(subpath "/work/a \\"b\\"\\\\c")');
  });
});

describe('bubblewrap', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-bwrap-')));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('the secrets in the app: files masked, folders emptied; dependencies and links not searched', async () => {
    const app = join(root, 'app');
    await mkdir(join(app, 'apps', 'web', '.kindgi'), { recursive: true });
    await mkdir(join(app, 'node_modules', 'x'), { recursive: true });
    await mkdir(join(app, '.git'), { recursive: true });
    await writeFile(join(app, '.env.local'), 'x');
    await writeFile(join(app, 'apps', 'web', '.env'), 'x');
    await writeFile(join(app, '.npmrc'), 'x');
    await writeFile(join(app, 'node_modules', 'x', '.env'), 'x');
    await writeFile(join(app, 'README.md'), 'x');
    await symlink(join(root, 'elsewhere'), join(app, 'linked'));
    const secrets = await appSecrets(app);
    expect([...secrets.files].sort()).toEqual(
      [join(app, '.env.local'), join(app, '.npmrc'), join(app, 'apps', 'web', '.env')].sort(),
    );
    expect([...secrets.dirs].sort()).toEqual(
      [join(app, '.git'), join(app, 'apps', 'web', '.kindgi')].sort(),
    );
    expect(secrets.truncated).toBe(false);
  });

  test('the arguments: root read-only, home and temp emptied, roots and app bound back, secrets masked, PID 1', () => {
    const args = bwrapArgs(
      { ...POLICY, allowUnixSockets: [] },
      {
        files: ['/work/app/.env.local'],
        dirs: ['/work/app/.git'],
        truncated: false,
      },
    );
    const joined = args.join(' ');
    expect(args.slice(0, 4)).toEqual([
      '--die-with-parent',
      '--unshare-pid',
      '--as-pid-1',
      '--unshare-ipc',
    ]);
    expect(joined).toContain('--ro-bind / /');
    expect(joined).toContain('--tmpfs /home/me --tmpfs /tmp --tmpfs /var/tmp --tmpfs /run');
    expect(joined).toContain(
      '--ro-bind /home/me/.nvm/versions/node/v22.21.1 /home/me/.nvm/versions/node/v22.21.1',
    );
    expect(joined).toContain('--bind /work/app /work/app');
    expect(joined).toContain('--ro-bind /dev/null /work/app/.env.local');
    expect(joined).toContain('--tmpfs /work/app/.git');
    expect(joined).not.toContain('--unshare-net');
    expect(args.slice(-5)).toEqual(['--chdir', '/work/app', '--setenv', 'TMPDIR', '/tmp']);
    expect(joined.indexOf('--tmpfs /home/me')).toBeLessThan(
      joined.indexOf('--ro-bind /home/me/.nvm'),
    );
    expect(joined.indexOf('--bind /work/app /work/app')).toBeLessThan(
      joined.indexOf('--ro-bind /dev/null'),
    );
  });
});

describe('the policy', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-policy-')));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("Python: the interpreter's paths, but never one that holds the home folder", async () => {
    const home = join(root, 'home');
    const app = join(home, 'app');
    const venvSite = join(app, '.venv', 'lib');
    const uvPython = join(home, '.local', 'share', 'uv', 'python', 'cpython-3.12');
    await mkdir(venvSite, { recursive: true });
    await mkdir(join(uvPython, 'bin'), { recursive: true });
    await writeFile(join(uvPython, 'bin', 'python3.12'), '');
    const policy = await sandboxPolicy({
      packDir: app,
      home,
      code: { language: 'python', python: ['python3'] },
      settings: ON,
      tmpDir: join(root, 'tmp'),
      env: {},
      node: { execPath: process.execPath, entry: '/nowhere' },
      queryPython: async () => ({
        path: ['', venvSite, home, join(uvPython, 'lib')],
        prefix: join(app, '.venv'),
        basePrefix: uvPython,
        executable: join(uvPython, 'bin', 'python3.12'),
      }),
    });
    expect(policy.readRoots).toEqual([uvPython]);
    expect(policy.skipped).toEqual([home]);
  });

  test("a JVM pack's classpath, from its @argfile, wildcards and escapes included", async () => {
    const args = join(root, 'java.args');
    await writeFile(args, '-cp "/m2/a.jar:/m2/b \\"quoted\\".jar:/lib/*"\n');
    expect(await classpathEntries(args)).toEqual(['/m2/a.jar', '/m2/b "quoted".jar', '/lib']);
  });
});

describe('what kindgi dev says', () => {
  const available = async () => ({ kind: 'available', engine: 'bwrap' }) as const;
  const missing = async () =>
    ({
      kind: 'unavailable',
      reason: "bubblewrap (bwrap) isn't installed",
      fix: 'Install bubblewrap.',
    }) as const;
  const base = { config: undefined, packDir: '/work/app', home: '/home/me' };

  test('on and available: one line naming it, then each path dev.sandbox opens', async () => {
    const outcome = await resolveDevSandbox({
      ...base,
      config: { dev: { sandbox: { allowRead: ['~/.aws'] } } },
      env: {},
      detect: available,
    });
    expect(outcome).toMatchObject({ kind: 'ok', sandbox: { engine: 'bwrap', home: '/home/me' } });
    expect(outcome.kind === 'ok' && outcome.lines).toEqual([
      expect.stringMatching(/^✓ dev sandbox: bubblewrap: your tools' code can't read your keys/),
      '  also reads /home/me/.aws (dev.sandbox.allowRead)',
    ]);
  });

  test('on and not available: a loud warning with why and the fix, and it runs without', async () => {
    const outcome = await resolveDevSandbox({ ...base, env: {}, detect: missing });
    expect(outcome).toMatchObject({ kind: 'ok', sandbox: undefined });
    expect(outcome.kind === 'ok' && outcome.lines).toEqual([
      '⚠ Your tools run without the dev sandbox on this system: they can read your files and keys.',
      "  Why: bubblewrap (bwrap) isn't installed. Install bubblewrap.",
      expect.stringContaining('KINDGI_DEV_SANDBOX=required'),
    ]);
  });

  test('required and not available: refused, before anything starts', async () => {
    expect(
      await resolveDevSandbox({
        ...base,
        env: { KINDGI_DEV_SANDBOX: 'required' },
        detect: missing,
      }),
    ).toEqual({
      kind: 'error',
      message:
        "the dev sandbox is required (KINDGI_DEV_SANDBOX=required), and can't run here: bubblewrap (bwrap) isn't installed. Install bubblewrap.",
    });
  });

  test('off: one line, and nothing is detected', async () => {
    let detected = false;
    const outcome = await resolveDevSandbox({
      ...base,
      env: { KINDGI_DEV_SANDBOX: 'off' },
      detect: async () => {
        detected = true;
        return available();
      },
    });
    expect(outcome).toMatchObject({
      kind: 'ok',
      sandbox: undefined,
      lines: [expect.stringContaining('dev sandbox: off (KINDGI_DEV_SANDBOX=off)')],
    });
    expect(detected).toBe(false);
  });
});
