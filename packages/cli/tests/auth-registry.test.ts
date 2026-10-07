// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi auth registry` tests. The `docker` runner, stdin and the hidden
 * prompt come in through `registryAuthSeam`, so no real `docker login`
 * runs; the real runner is checked against a stand-in `docker` on PATH.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { RegistryAuthSeam } from '../src/commands/auth.js';
import { type DockerOutcome, type DockerRunOptions, docker } from '../src/dev/runtime-container.js';
import {
  DEFAULT_RUNTIME_IMAGE,
  RUNTIME_IMAGE_REGISTRY,
  imageOnRegistry,
  registryOf,
} from '../src/dev/runtime-image.js';
import {
  credentialHelperFailure,
  credentialHelperHint,
  digestOnly,
  registryLoginCommand,
} from '../src/dev/runtime-registry.js';
import { runCli } from '../src/main.js';
import { PromptCancelled } from '../src/terminal-input.js';

const TOKEN = 'robot-token-5f1c9e';

interface DockerCall {
  readonly args: readonly string[];
  readonly options: DockerRunOptions | undefined;
}

const OK: DockerOutcome = { code: 0, stdout: '', stderr: '' };

/** A fake `docker`: each command's outcome by its first words, every call recorded. */
function fakeDocker(outcomes: { readonly [command: string]: DockerOutcome } = {}) {
  const calls: DockerCall[] = [];
  const run = async (args: readonly string[], options?: DockerRunOptions) => {
    calls.push({ args, options });
    const command = args[0] === 'buildx' ? args.slice(0, 3).join(' ') : (args[0] ?? '');
    return outcomes[command] ?? OK;
  };
  return { run, calls, commands: () => calls.map((c) => c.args.slice(0, 3).join(' ')) };
}

/** A hidden prompt that answers `answer`, recording its prompts and whether it was closed. */
function fakeTty(answer: string) {
  const state = { prompts: [] as string[], closed: false };
  return {
    state,
    tty: {
      promptHidden: async (prompt: string) => {
        state.prompts.push(prompt);
        return answer;
      },
      close: () => {
        state.closed = true;
      },
    },
  };
}

function runRegistry(argv: readonly string[], seam: RegistryAuthSeam) {
  return runCli({
    argv: ['auth', 'registry', ...argv],
    env: {},
    cwd: tmpdir(),
    home: '/tmp/fake-home',
    registryAuthSeam: seam,
  });
}

describe('the registry', () => {
  test('is derived from the pinned image', () => {
    expect(RUNTIME_IMAGE_REGISTRY).toBe(registryOf(DEFAULT_RUNTIME_IMAGE));
    expect(RUNTIME_IMAGE_REGISTRY).toBe('quay.io');
  });

  test('is read from a reference the way Docker reads it', () => {
    expect(registryOf('quay.io/kindgi/runtime:0.1.0')).toBe('quay.io');
    expect(registryOf('127.0.0.1:5000/kindgi/runtime@sha256:abc')).toBe('127.0.0.1:5000');
    expect(registryOf('localhost/runtime')).toBe('localhost');
    expect(registryOf('kindgi/runtime:0.1.0')).toBe('docker.io');
    expect(registryOf('busybox')).toBe('docker.io');
  });

  test('a mirror carries the same repository, tag and digest', () => {
    expect(imageOnRegistry(DEFAULT_RUNTIME_IMAGE, 'quay.io')).toBe(DEFAULT_RUNTIME_IMAGE);
    expect(imageOnRegistry(DEFAULT_RUNTIME_IMAGE, 'mirror.example.com')).toBe(
      DEFAULT_RUNTIME_IMAGE.replace(/^quay\.io\//, 'mirror.example.com/'),
    );
    expect(imageOnRegistry('busybox:1.36', '127.0.0.1:5000')).toBe(
      '127.0.0.1:5000/library/busybox:1.36',
    );
  });

  test('login is to the pinned image registry by default, --registry otherwise', async () => {
    const byDefault = fakeDocker();
    await runRegistry(['--username', 'robot', '--password-stdin'], {
      docker: byDefault.run,
      readStdin: async () => TOKEN,
    });
    const login = byDefault.calls.find((c) => c.args[0] === 'login');
    expect(login?.args[1]).toBe(RUNTIME_IMAGE_REGISTRY);
    expect(byDefault.calls.at(-1)?.args).toEqual([
      'buildx',
      'imagetools',
      'inspect',
      DEFAULT_RUNTIME_IMAGE,
    ]);

    const mirror = fakeDocker();
    const out = await runRegistry(
      ['--username', 'robot', '--password-stdin', '--registry', 'mirror.example.com:5000'],
      { docker: mirror.run, readStdin: async () => TOKEN },
    );
    expect(out.exitCode).toBe(0);
    expect(mirror.calls.find((c) => c.args[0] === 'login')?.args[1]).toBe(
      'mirror.example.com:5000',
    );
    const checked = imageOnRegistry(DEFAULT_RUNTIME_IMAGE, 'mirror.example.com:5000');
    expect(mirror.calls.at(-1)?.args.at(-1)).toBe(checked);
    expect(out.stderr).toContain(`kindgi dev --runtime-image ${checked}`);
  });

  test('--registry takes a host, not a URL', async () => {
    const fake = fakeDocker();
    const out = await runRegistry(['--check', '--registry', 'https://quay.io/'], {
      docker: fake.run,
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--registry takes a registry host');
    expect(fake.calls).toEqual([]);
  });
});

describe('logging in', () => {
  test('the token goes to docker login on stdin, never into its arguments or any output', async () => {
    const fake = fakeDocker();
    const out = await runRegistry(['--username', 'robot', '--password-stdin'], {
      docker: fake.run,
      readStdin: async () => `${TOKEN}\n`,
    });
    expect(out.exitCode).toBe(0);
    expect(fake.commands()).toEqual([
      'version --format {{.Server.Version}}',
      'login quay.io --username',
      'buildx imagetools inspect',
    ]);
    const login = fake.calls[1];
    expect(login?.args).toEqual(['login', 'quay.io', '--username', 'robot', '--password-stdin']);
    // The trailing newline isn't part of the token, as docker reads it.
    expect(login?.options).toEqual({ stdin: TOKEN });
    for (const call of fake.calls) {
      expect(call.args.join(' ')).not.toContain(TOKEN);
      if (call !== login) expect(call.options?.stdin).toBeUndefined();
    }
    expect(out.stdout + out.stderr).not.toContain(TOKEN);
    expect(out.stderr).toContain('✓ Logged in to quay.io as robot');
    expect(out.stderr).toContain(
      `✓ You can pull ${DEFAULT_RUNTIME_IMAGE}, the image this CLI runs.`,
    );
  });

  test('without --password-stdin, the token comes from a hidden prompt', async () => {
    const fake = fakeDocker();
    const prompt = fakeTty(TOKEN);
    const out = await runRegistry(['--username', 'robot'], {
      docker: fake.run,
      stdinIsTty: () => true,
      tty: prompt.tty,
      readStdin: async () => {
        throw new Error('stdin is not read without --password-stdin');
      },
    });
    expect(out.exitCode).toBe(0);
    expect(prompt.state.prompts).toEqual(['Token for robot at quay.io: ']);
    expect(prompt.state.closed).toBe(true);
    expect(fake.calls.find((c) => c.args[0] === 'login')?.options).toEqual({ stdin: TOKEN });
    expect(out.stdout + out.stderr).not.toContain(TOKEN);
  });

  test('with --password-stdin, stdin is read and no prompt is shown', async () => {
    const fake = fakeDocker();
    const prompt = fakeTty('not-this-one');
    const out = await runRegistry(['--username', 'robot', '--password-stdin'], {
      docker: fake.run,
      stdinIsTty: () => true,
      tty: prompt.tty,
      readStdin: async () => `${TOKEN}\r\n`,
    });
    expect(out.exitCode).toBe(0);
    expect(prompt.state.prompts).toEqual([]);
    expect(fake.calls.find((c) => c.args[0] === 'login')?.options).toEqual({ stdin: TOKEN });
  });

  test('Ctrl+C at the prompt cancels: nothing logged in', async () => {
    const fake = fakeDocker();
    let closed = false;
    const out = await runRegistry(['--username', 'robot'], {
      docker: fake.run,
      stdinIsTty: () => true,
      tty: {
        promptHidden: async () => {
          throw new PromptCancelled();
        },
        close: () => {
          closed = true;
        },
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe('Cancelled.\n');
    expect(closed).toBe(true);
    expect(fake.calls.some((c) => c.args[0] === 'login')).toBe(false);
  });

  test('no terminal and no --password-stdin fails before anything logs in', async () => {
    const fake = fakeDocker();
    const out = await runRegistry(['--username', 'robot'], {
      docker: fake.run,
      stdinIsTty: () => false,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('No terminal to prompt for the token on');
    expect(out.stderr).toContain('--password-stdin');
    expect(fake.calls.some((c) => c.args[0] === 'login')).toBe(false);
  });

  test('an empty token is refused', async () => {
    const fake = fakeDocker();
    const out = await runRegistry(['--username', 'robot', '--password-stdin'], {
      docker: fake.run,
      readStdin: async () => '\n',
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Empty token refused');
    expect(fake.calls.some((c) => c.args[0] === 'login')).toBe(false);
  });

  test('a login needs --username', async () => {
    const fake = fakeDocker();
    const out = await runRegistry(['--password-stdin'], { docker: fake.run });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('Missing --username');
    expect(out.stderr).toContain('contact@kindgi.com');
    expect(fake.calls).toEqual([]);
  });

  test("a refused login shows docker's message, with the token blanked out", async () => {
    const fake = fakeDocker({
      login: {
        code: 1,
        stdout: '',
        stderr: `Error response from daemon: Get "https://quay.io/v2/": unauthorized: bad credentials for ${TOKEN}\n`,
      },
    });
    const out = await runRegistry(['--username', 'robot', '--password-stdin'], {
      docker: fake.run,
      readStdin: async () => TOKEN,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('docker login quay.io failed: Error response from daemon');
    expect(out.stderr).toContain('unauthorized: bad credentials for ***');
    expect(out.stderr).toContain('contact@kindgi.com');
    expect(out.stderr).not.toContain(TOKEN);
    // No check after a failed login.
    expect(fake.calls.some((c) => c.args[0] === 'buildx')).toBe(false);
  });

  test("docker's warnings on a login that worked are passed on", async () => {
    const fake = fakeDocker({
      login: {
        code: 0,
        stdout: 'Login Succeeded\n',
        stderr:
          "WARNING! Your credentials are stored unencrypted in '/home/dev/.docker/config.json'.\n",
      },
    });
    const out = await runRegistry(['--username', 'robot', '--password-stdin'], {
      docker: fake.run,
      readStdin: async () => TOKEN,
    });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('docker: WARNING! Your credentials are stored unencrypted');
  });

  test('--json prints a summary on stdout, without the token', async () => {
    const fake = fakeDocker();
    const out = await runRegistry(['--username', 'robot', '--password-stdin', '--json'], {
      docker: fake.run,
      readStdin: async () => TOKEN,
    });
    expect(JSON.parse(out.stdout)).toEqual({
      ok: true,
      registry: 'quay.io',
      loggedIn: true,
      username: 'robot',
      image: DEFAULT_RUNTIME_IMAGE,
      checkedWith: 'docker buildx imagetools inspect',
    });
    expect(out.stdout).not.toContain(TOKEN);
  });
});

describe('--check', () => {
  test('checks the pinned image without logging in', async () => {
    const fake = fakeDocker();
    const out = await runRegistry(['--check'], {
      docker: fake.run,
      readStdin: async () => {
        throw new Error('--check reads no token');
      },
    });
    expect(out.exitCode).toBe(0);
    expect(fake.calls.map((c) => c.args)).toEqual([
      ['version', '--format', '{{.Server.Version}}'],
      ['buildx', 'imagetools', 'inspect', DEFAULT_RUNTIME_IMAGE],
    ]);
    expect(out.stderr).toBe(
      `  ✓ You can pull ${DEFAULT_RUNTIME_IMAGE}, the image this CLI runs.\n`,
    );
    expect(out.stdout).toBe('');
  });

  test('exits non-zero when the image cannot be pulled', async () => {
    const fake = fakeDocker({
      'buildx imagetools inspect': { code: 1, stdout: '', stderr: 'ERROR: not found\n' },
    });
    const out = await runRegistry(['--check'], { docker: fake.run });
    expect(out.exitCode).toBe(1);
  });

  test('takes no --username or --password-stdin', async () => {
    const fake = fakeDocker();
    for (const extra of [['--username', 'robot'], ['--password-stdin']]) {
      const out = await runRegistry(['--check', ...extra], { docker: fake.run });
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain('--check only checks access');
    }
    expect(fake.calls).toEqual([]);
  });

  test('a refusal is no access: ask for it at contact@kindgi.com', async () => {
    const fake = fakeDocker({
      'buildx imagetools inspect': {
        code: 1,
        stdout: '',
        stderr:
          'ERROR: unexpected status from HEAD request to https://quay.io/v2/kindgi/runtime/manifests/sha256:91cb: 401 UNAUTHORIZED\n',
      },
    });
    const out = await runRegistry(['--check'], { docker: fake.run });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      `✗ No access to ${DEFAULT_RUNTIME_IMAGE}: ERROR: unexpected status`,
    );
    expect(out.stderr).toContain('request access at contact@kindgi.com');
    expect(out.stderr).toContain(
      'kindgi auth registry --username <the robot name you were given>.',
    );
    expect(out.stderr).not.toContain("Couldn't find");
  });

  test('a missing image or an unreachable registry is not found: the image or the network', async () => {
    for (const stderr of [
      `ERROR: ${DEFAULT_RUNTIME_IMAGE}: not found\n`,
      'ERROR: failed to do request: Head "https://quay.io/v2/": dial tcp: lookup quay.io: no such host\n',
    ]) {
      const fake = fakeDocker({ 'buildx imagetools inspect': { code: 1, stdout: '', stderr } });
      const out = await runRegistry(['--check'], { docker: fake.run });
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(`✗ Couldn't find ${DEFAULT_RUNTIME_IMAGE}`);
      expect(out.stderr).toContain(
        "Either the image isn't on quay.io, or this machine can't reach quay.io",
      );
      expect(out.stderr).not.toContain('contact@kindgi.com');
    }
  });

  test('logged in but refused: the robot has no access to this image', async () => {
    const fake = fakeDocker({
      'buildx imagetools inspect': { code: 1, stdout: '', stderr: 'ERROR: 403 Forbidden\n' },
    });
    const out = await runRegistry(['--username', 'robot', '--password-stdin'], {
      docker: fake.run,
      readStdin: async () => TOKEN,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('✓ Logged in to quay.io as robot');
    expect(out.stderr).toContain("robot is logged in to quay.io but can't pull it");
    expect(out.stderr).toContain('contact@kindgi.com');
  });
});

describe("a credential helper Docker can't run (T276)", () => {
  const HELPER: DockerOutcome = {
    code: 1,
    stdout: '',
    stderr:
      'error getting credentials - err: exec: "docker-credential-desktop": executable file not found in $PATH, out: ``\n',
  };

  test('the check names the helper and how to fix it, not the network', async () => {
    const fake = fakeDocker({ 'buildx imagetools inspect': HELPER });
    const out = await runRegistry(['--check'], { docker: fake.run });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(`✗ Couldn't check ${DEFAULT_RUNTIME_IMAGE}`);
    expect(out.stderr).toContain("names docker-credential-desktop, and Docker couldn't run it");
    expect(out.stderr).not.toContain('the network, a proxy or a firewall');
  });

  test('credentialHelperFailure: the helper named when it is; nothing for other errors', () => {
    expect(
      credentialHelperFailure(
        'error getting credentials - err: exec: "docker-credential-desktop": executable file not found in $PATH',
      ),
    ).toEqual({ helper: 'desktop' });
    expect(credentialHelperFailure('error getting credentials - err: exit status 1')).toEqual({});
    expect(credentialHelperFailure('unauthorized: authentication required')).toBeUndefined();
    expect(credentialHelperFailure(`no such manifest: ${DEFAULT_RUNTIME_IMAGE}`)).toBeUndefined();
    expect(credentialHelperHint('desktop')).toContain('names docker-credential-desktop');
    expect(credentialHelperHint(undefined)).toContain('names a credential helper');
  });

  test('so does a login that fails on it', async () => {
    const fake = fakeDocker({
      login: {
        code: 1,
        stdout: '',
        stderr:
          'Error saving credentials: error storing credentials - err: exec: "docker-credential-desktop": executable file not found in $PATH, out: ``\n',
      },
    });
    const out = await runRegistry(['--username=acme+robot', '--password-stdin'], {
      docker: fake.run,
      readStdin: async () => TOKEN,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('names docker-credential-desktop');
    expect(out.stderr).not.toContain('Check the username and the token');
    expect(out.stderr).not.toContain(TOKEN);
  });
});

describe('without docker buildx', () => {
  const NO_BUILDX: DockerOutcome = {
    code: 1,
    stdout: '',
    stderr: 'docker: unknown command: docker buildx\n',
  };
  // A release's tag, or a release candidate's (`0.1.4-rc.0`).
  const DIGEST_ONLY = DEFAULT_RUNTIME_IMAGE.replace(/:\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?@/, '@');

  test('the digest-only reference: the tag goes, the digest stays', () => {
    expect(DIGEST_ONLY).toMatch(/^quay\.io\/kindgi\/runtime@sha256:[0-9a-f]{64}$/);
    expect(digestOnly(DEFAULT_RUNTIME_IMAGE)).toBe(DIGEST_ONLY);
    expect(digestOnly('127.0.0.1:5000/kindgi/runtime:1@sha256:abc')).toBe(
      '127.0.0.1:5000/kindgi/runtime@sha256:abc',
    );
    expect(digestOnly('127.0.0.1:5000/kindgi/runtime@sha256:abc')).toBe(
      '127.0.0.1:5000/kindgi/runtime@sha256:abc',
    );
    expect(digestOnly('quay.io/kindgi/runtime:0.1.0')).toBe('quay.io/kindgi/runtime:0.1.0');
  });

  test('falls back to docker manifest inspect on the digest-only reference, and says so', async () => {
    const fake = fakeDocker({ 'buildx imagetools inspect': NO_BUILDX });
    const out = await runRegistry(['--check', '--json'], { docker: fake.run });
    expect(out.exitCode).toBe(0);
    expect(fake.calls.map((c) => c.args)).toEqual([
      ['version', '--format', '{{.Server.Version}}'],
      ['buildx', 'imagetools', 'inspect', DEFAULT_RUNTIME_IMAGE],
      ['manifest', 'inspect', DIGEST_ONLY],
    ]);
    expect(out.stderr.split('\n')).toEqual([
      `  ✓ You can pull ${DEFAULT_RUNTIME_IMAGE}, the image this CLI runs.`,
      "    Checked with docker manifest inspect: docker buildx isn't installed.",
      '',
    ]);
    expect(JSON.parse(out.stdout)).toMatchObject({ checkedWith: 'docker manifest inspect' });
  });

  test('a loopback registry gets --insecure, as Docker allows plain HTTP there', async () => {
    const fake = fakeDocker({ 'buildx imagetools inspect': NO_BUILDX });
    await runRegistry(['--check'], {
      docker: fake.run,
      image: '127.0.0.1:5000/kindgi-test/tiny:1@sha256:abc',
    });
    expect(fake.calls.at(-1)?.args).toEqual([
      'manifest',
      'inspect',
      '--insecure',
      '127.0.0.1:5000/kindgi-test/tiny@sha256:abc',
    ]);
  });

  test("the fallback's refusal is no access; its missing manifest, not found", async () => {
    const refused = fakeDocker({
      'buildx imagetools inspect': NO_BUILDX,
      manifest: {
        code: 1,
        stdout: '',
        stderr:
          'errors:\ndenied: requested access to the resource is denied\nunauthorized: authentication required\n',
      },
    });
    const noAccess = await runRegistry(['--check'], { docker: refused.run });
    expect(noAccess.exitCode).toBe(1);
    expect(noAccess.stderr).toContain(`✗ No access to ${DEFAULT_RUNTIME_IMAGE}`);
    expect(noAccess.stderr).toContain('contact@kindgi.com');
    expect(noAccess.stderr).toContain('Checked with docker manifest inspect');

    const missing = fakeDocker({
      'buildx imagetools inspect': NO_BUILDX,
      manifest: { code: 1, stdout: '', stderr: `no such manifest: ${DIGEST_ONLY}\n` },
    });
    const notFound = await runRegistry(['--check'], { docker: missing.run });
    expect(notFound.exitCode).toBe(1);
    expect(notFound.stderr).toContain(`✗ Couldn't find ${DEFAULT_RUNTIME_IMAGE}`);
    // Without credentials, docker manifest inspect says "no such manifest" too.
    expect(notFound.stderr).toContain(
      "docker manifest inspect says this both when the image isn't on quay.io and when Docker has no access to it",
    );
  });

  test('no fallback when buildx is there and the check fails for another reason', async () => {
    const fake = fakeDocker({
      'buildx imagetools inspect': { code: 1, stdout: '', stderr: 'ERROR: 401 Unauthorized\n' },
    });
    const out = await runRegistry(['--check'], { docker: fake.run });
    expect(out.exitCode).toBe(1);
    expect(fake.calls.some((c) => c.args[0] === 'manifest')).toBe(false);
    expect(out.stderr).not.toContain('Checked with');
  });

  test('--verbose names buildx when it ran', async () => {
    const fake = fakeDocker();
    const out = await runRegistry(['--check', '--verbose'], { docker: fake.run });
    expect(out.stderr).toContain('    Checked with docker buildx imagetools inspect.\n');
  });

  test('neither buildx nor docker manifest: says so', async () => {
    const fake = fakeDocker({
      'buildx imagetools inspect': NO_BUILDX,
      manifest: { code: 1, stdout: '', stderr: 'docker: unknown command: docker manifest\n' },
    });
    const out = await runRegistry(['--check'], { docker: fake.run });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('neither docker buildx nor docker manifest is available');
    expect(out.stderr).toContain('docker-buildx-plugin');
  });
});

describe('without Docker', () => {
  test('docker missing: a clear message, no prompt, no login', async () => {
    const fake = fakeDocker({ version: { code: null, stdout: '', stderr: 'spawn docker ENOENT' } });
    const prompt = fakeTty(TOKEN);
    const out = await runRegistry(['--username', 'robot'], {
      docker: fake.run,
      stdinIsTty: () => true,
      tty: prompt.tty,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("Docker isn't installed, or `docker` isn't on your PATH");
    expect(prompt.state.prompts).toEqual([]);
    expect(fake.commands()).toEqual(['version --format {{.Server.Version}}']);
  });

  test('docker not running: a clear message', async () => {
    const fake = fakeDocker({
      version: {
        code: 1,
        stdout: 'Client:\n Version: 29.4.0\n',
        stderr:
          'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
      },
    });
    const out = await runRegistry(['--check'], { docker: fake.run });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("Docker isn't running: Cannot connect to the Docker daemon");
    expect(fake.commands()).toEqual(['version --format {{.Server.Version}}']);
  });
});

describe('the refused-pull hint of kindgi dev', () => {
  test('points to kindgi auth registry, naming the registry only when it is another one', () => {
    expect(registryLoginCommand(DEFAULT_RUNTIME_IMAGE)).toBe(
      'kindgi auth registry --username <the robot name you were given>',
    );
    expect(registryLoginCommand('registry.example.com/kindgi/runtime:dev')).toBe(
      'kindgi auth registry --username <the robot name you were given> --registry registry.example.com',
    );
  });
});

describe('the docker runner', () => {
  let bin: string;
  let savedPath: string | undefined;

  beforeEach(async () => {
    bin = await mkdtemp(join(tmpdir(), 'kindgi-fake-docker-'));
    savedPath = process.env.PATH;
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    await rm(bin, { recursive: true, force: true });
  });

  test('writes stdin to docker and keeps it out of argv and the environment', async () => {
    // A stand-in `docker` that records what it was given.
    await writeFile(
      join(bin, 'docker'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${bin}/argv'\ncat > '${bin}/stdin'\nenv > '${bin}/env'\n`,
    );
    await chmod(join(bin, 'docker'), 0o755);
    process.env.PATH = `${bin}:${savedPath ?? ''}`;

    const outcome = await docker(['login', 'quay.io', '--username', 'robot', '--password-stdin'], {
      stdin: TOKEN,
    });
    expect(outcome.code).toBe(0);
    expect(await readFile(join(bin, 'stdin'), 'utf8')).toBe(TOKEN);
    const argv = await readFile(join(bin, 'argv'), 'utf8');
    expect(argv).toBe('login\nquay.io\n--username\nrobot\n--password-stdin\n');
    expect(await readFile(join(bin, 'env'), 'utf8')).not.toContain(TOKEN);

    // Without `stdin`, the command reads nothing.
    await docker(['version']);
    expect(await readFile(join(bin, 'stdin'), 'utf8')).toBe('');
  });

  test('no docker on PATH: code null, not a throw', async () => {
    process.env.PATH = bin;
    const outcome = await docker(['login', 'quay.io', '--password-stdin'], { stdin: TOKEN });
    expect(outcome.code).toBeNull();
    expect(outcome.stderr).toContain('ENOENT');
  });
});
