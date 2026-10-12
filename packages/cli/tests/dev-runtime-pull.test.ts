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
  image) echo "Error response from daemon: No such image: $5" >&2; exit 1 ;;
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
    const result = await ensureRuntimeImage('quay.io/acme/runtime:1.0', phases);
    phases.close();
    expect(result.kind).toBe('error');
    const message = result.kind === 'error' ? result.message : '';
    expect(message).toContain('unauthorized');
    expect(message).toContain(
      '  The runtime image needs a pull credential: sign in with GitHub at https://access.kindgi.com for one, log in (kindgi auth registry --username <your robot name>), then run kindgi dev again.',
    );
  });

  test("a Docker Hub image: no manifest read (it would count against Docker Hub's pull limit)", async () => {
    const { lines, calls } = await pull('acme/runtime:1.0');
    expect(calls.some((c) => c.startsWith('manifest'))).toBe(false);
    expect(lines.at(-1)).toMatch(/^ {2}✓ pulled the runtime image in /);
  });
});
