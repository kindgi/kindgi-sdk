// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The runtime image's pull, against a fake `docker` on `PATH`: the pull
 * is said and started at once, whatever the registry does with the
 * manifest read beside it, which is given up when the pull ends.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ensureRuntimeImage } from '../src/dev/runtime-container.js';
import { createStartPhases } from '../src/dev/start-phases.js';

/** `docker` as the pull uses it: no image yet, a manifest read (hanging unless given one), a 1s pull. */
const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> "$FAKE_DOCKER_DIR/calls.log"
case "$1" in
  image)
    if [ -n "$FAKE_DOCKER_DOWN" ]; then
      echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2
      exit 1
    fi
    if [ -n "$FAKE_DOCKER_DENIED" ]; then
      echo 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/images/json": dial unix /var/run/docker.sock: connect: permission denied' >&2
      exit 1
    fi
    echo "Error response from daemon: No such image: $5" >&2; exit 1 ;;
  version) echo "linux/arm64"; exit 0 ;;
  manifest)
    if [ -n "$FAKE_MANIFEST" ]; then cat "$FAKE_MANIFEST"; exit 0; fi
    echo $$ > "$FAKE_DOCKER_DIR/manifest.pid"
    exec sleep 30 ;;
  pull)
    if [ -n "$FAKE_PULL_DENIED" ]; then
      echo "Error response from daemon: unauthorized: access to the requested resource is not authorized" >&2
      exit 1
    fi
    sleep 1
    printf '1.0: Pulling from acme/runtime\\ne3649207a629: Pull complete\\n5f2c8e7d1b0a: Pull complete\\n0b9d4a6c3e21: Already exists\\nDigest: sha256:aaaa\\n'
    exit 0 ;;
esac
exit 1
`;

const MANIFEST = JSON.stringify([
  {
    Descriptor: { platform: { architecture: 'arm64', os: 'linux' } },
    OCIManifest: {
      layers: [
        { digest: 'sha256:e3649207a629aaaa', size: 29_000_000 },
        { digest: 'sha256:5f2c8e7d1b0aaaaa', size: 210_000_000 },
        { digest: 'sha256:0b9d4a6c3e21aaaa', size: 30_000_000 },
      ],
    },
  },
]);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-fake-docker-'));
  await writeFile(join(dir, 'docker'), FAKE_DOCKER);
  await chmod(join(dir, 'docker'), 0o755);
  vi.stubEnv('PATH', `${dir}${delimiter}${process.env.PATH ?? ''}`);
  vi.stubEnv('FAKE_DOCKER_DIR', dir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pull(image: string): Promise<{ lines: string[]; ms: number; calls: string[] }> {
  const lines: string[] = [];
  const phases = createStartPhases({ emit: (line) => lines.push(line) });
  const started = Date.now();
  const result = await ensureRuntimeImage(image, phases);
  phases.close();
  expect(result).toEqual({ kind: 'ok' });
  const calls = (await readFile(join(dir, 'calls.log'), 'utf8')).trim().split('\n');
  return { lines, ms: Date.now() - started, calls };
}

describe.skipIf(process.platform === 'win32')('the runtime image pull', () => {
  test('a registry that never answers for the manifest: the pull is said and done at once, and the read is given up', async () => {
    const { lines, ms, calls } = await pull('quay.io/acme/runtime:1.0');
    expect(lines[0]).toBe(
      '  ⋯ pulling the runtime image: quay.io/acme/runtime:1.0 (first run only)',
    );
    expect(lines.at(-1)).toMatch(/^ {2}✓ pulled the runtime image in \d+\.\ds$/);
    // The 1s pull, not the manifest read's 15s.
    expect(ms).toBeLessThan(5_000);
    expect(calls).toContain('pull quay.io/acme/runtime:1.0');
    const pid = Number(await readFile(join(dir, 'manifest.pid'), 'utf8'));
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3_000 });
  });

  test('a manifest that answers: the size comes with the progress, and with the end', async () => {
    await writeFile(join(dir, 'manifest.json'), MANIFEST);
    vi.stubEnv('FAKE_MANIFEST', join(dir, 'manifest.json'));
    const { lines, calls } = await pull('quay.io/acme/runtime:1.0');
    expect(calls).toContain('manifest inspect --verbose quay.io/acme/runtime:1.0');
    expect(lines.at(-1)).toMatch(/^ {2}✓ pulled the runtime image: 269 MB in \d+\.\ds$/);
  });

  test('a refused pull: a pull credential from the access page, the login, then kindgi dev again', async () => {
    vi.stubEnv('FAKE_PULL_DENIED', '1');
    const phases = createStartPhases({ emit: () => undefined });
    const result = await ensureRuntimeImage('registry.kindgi.com/acme/runtime:1.0', phases);
    phases.close();
    expect(result.kind).toBe('error');
    const message = result.kind === 'error' ? result.message : '';
    expect(message).toContain('unauthorized');
    expect(message).toContain(
      '  The runtime image needs a pull credential: sign in with GitHub at https://access.kindgi.com for one, log in (kindgi auth registry --username <your robot name>), then run kindgi dev again.',
    );
  });

  test("a refused pull from Kindgi's registry: the license key, the login, then kindgi dev again", async () => {
    vi.stubEnv('FAKE_PULL_DENIED', '1');
    const phases = createStartPhases({ emit: () => undefined });
    const result = await ensureRuntimeImage('registry.kindgi.com/kindgi/runtime:1.0', phases);
    phases.close();
    const message = result.kind === 'error' ? result.message : '';
    expect(message).toMatch(
      /\n {2}The runtime image needs your license key: sign in at https:\/\/access\.kindgi\.com for it, log in \(kindgi auth registry( --registry registry\.kindgi\.com)?\), then run kindgi dev again\.$/,
    );
  });

  test("a Docker Hub image: no manifest read (it would count against Docker Hub's pull limit)", async () => {
    const { lines, calls } = await pull('acme/runtime:1.0');
    expect(calls.some((c) => c.startsWith('manifest'))).toBe(false);
    expect(lines.at(-1)).toMatch(/^ {2}✓ pulled the runtime image in /);
  });
});

describe.skipIf(process.platform === 'win32')(
  'Docker out of reach: said as such, never a pull',
  () => {
    const ensure = async () => {
      const result = await ensureRuntimeImage('quay.io/acme/runtime:1.0');
      const log = await readFile(join(dir, 'calls.log'), 'utf8').catch(() => '');
      return { result, pulled: log.split('\n').some((call) => call.startsWith('pull')) };
    };

    test("an engine that doesn't answer", async () => {
      vi.stubEnv('FAKE_DOCKER_DOWN', '1');
      const { result, pulled } = await ensure();
      expect(pulled).toBe(false);
      expect(result).toEqual({
        kind: 'error',
        message:
          "Docker isn't running, or `kindgi dev` can't reach it: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n  Start Docker Desktop (or the Docker engine), then run this again. If it's running, a coding agent's sandbox may be what keeps it out of reach: run `kindgi dev` in your own terminal instead.",
      });
    });

    test('a socket that refuses this process', async () => {
      vi.stubEnv('FAKE_DOCKER_DENIED', '1');
      const { result, pulled } = await ensure();
      expect(pulled).toBe(false);
      expect(result).toEqual({
        kind: 'error',
        message: expect.stringMatching(
          /^Docker's socket refused `kindgi dev`: permission denied while trying to connect to the Docker daemon socket .*\n {2}If a coding agent runs this, its sandbox is likely what stops it: run `kindgi dev` in your own terminal instead\. Otherwise, your user needs access to Docker \(on Linux, the `docker` group, or rootless Docker\)\.$/,
        ),
      });
    });

    test("a docker this process can't start", async () => {
      // Found, but not runnable: the spawn's own refusal (EACCES), as a sandbox's would be.
      await chmod(join(dir, 'docker'), 0o644);
      vi.stubEnv('PATH', dir);
      const { result, pulled } = await ensure();
      expect(pulled).toBe(false);
      expect(result).toEqual({
        kind: 'error',
        message:
          "`kindgi dev` couldn't start `docker` (spawn docker EACCES).\n  If a coding agent runs this, its sandbox is likely what stops it: run `kindgi dev` in your own terminal instead. Otherwise, check that the `docker` on your PATH can run.",
      });
    });
  },
);
