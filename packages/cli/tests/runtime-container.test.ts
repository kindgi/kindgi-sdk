// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { attachToRuntimeReal, databaseUrlFrom } from '../src/dev/defaults.js';
import {
  type RuntimeContainerOptions,
  RuntimeStartStopped,
  describeStartupStop,
  dockerFailureDetail,
  pauseUnlessStopped,
  runtimeContainerName,
  runtimeRunArgs,
} from '../src/dev/runtime-container.js';

const OPTIONS: RuntimeContainerOptions = {
  image: 'quay.io/kindgi/runtime:preview',
  packDir: '/home/dev/acme-pack',
  envFile: '/home/dev/acme-pack/.kindgi/dev/runtime.env',
  network: 'alias',
  hostPort: 4100,
  onLog: () => undefined,
};

describe('runtimeRunArgs', () => {
  test('Docker Desktop: the API on host loopback only, the pack at /pack, the host alias', () => {
    expect(runtimeRunArgs('kindgi-dev-runtime-x', OPTIONS)).toEqual([
      'run',
      // No --rm: a container that stops while starting is read, then removed.
      '--detach',
      '--name',
      'kindgi-dev-runtime-x',
      '--env-file',
      OPTIONS.envFile,
      '--volume',
      '/home/dev/acme-pack:/pack',
      '--publish',
      '127.0.0.1:4100:4000',
      '--add-host',
      'host.docker.internal:host-gateway',
      'quay.io/kindgi/runtime:preview',
      '--console-static-dir',
      '/app/console',
      '--dev-echo-provider',
    ]);
  });

  test('Linux: host networking as the developer, credentials mounted read-only', () => {
    const args = runtimeRunArgs('n', {
      ...OPTIONS,
      network: 'host-network',
      googleCredentials: '/home/dev/.config/gcloud/application_default_credentials.json',
      publicTokenKey: '/home/dev/keys/public-token.pem',
      exportSigningKey: '/home/dev/keys/export-signing.pem',
    });
    expect(args).toContain('--network');
    expect(args[args.indexOf('--network') + 1]).toBe('host');
    expect(args).not.toContain('--publish');
    if (typeof process.getuid === 'function') {
      expect(args[args.indexOf('--user') + 1]).toBe(`${process.getuid()}:${process.getgid?.()}`);
    }
    expect(args).toContain(
      '/home/dev/.config/gcloud/application_default_credentials.json:/run/kindgi/google-credentials.json:ro',
    );
    expect(args).toContain(
      '/home/dev/keys/public-token.pem:/run/kindgi/public-token-signing.pem:ro',
    );
    expect(args).toContain('/home/dev/keys/export-signing.pem:/run/kindgi/export-signing.pem:ro');
  });

  test('one container per pack directory', () => {
    const a = runtimeContainerName('/home/dev/acme-pack');
    expect(a).toMatch(/^kindgi-dev-runtime-[0-9a-f]{12}$/);
    expect(runtimeContainerName('/home/dev/acme-pack')).toBe(a);
    expect(runtimeContainerName('/home/dev/other-pack')).not.toBe(a);
  });
});

describe('databaseUrlFrom', () => {
  test('through the alias, a loopback database host becomes host.docker.internal', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(databaseUrlFrom(`postgres://kindgi:pw@${host}:55432/kindgi`, 'alias')).toBe(
        'postgres://kindgi:pw@host.docker.internal:55432/kindgi',
      );
    }
    expect(databaseUrlFrom('postgres://kindgi:pw@db.internal:5432/kindgi', 'alias')).toBe(
      'postgres://kindgi:pw@db.internal:5432/kindgi',
    );
  });

  test('with host networking, unchanged', () => {
    expect(databaseUrlFrom('postgres://kindgi:pw@127.0.0.1:55432/kindgi', 'host-network')).toBe(
      'postgres://kindgi:pw@127.0.0.1:55432/kindgi',
    );
  });
});

describe('a stop while kindgi dev waits for its runtime (T176)', () => {
  test('pauseUnlessStopped ends early when the stop comes', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const paused = pauseUnlessStopped(10_000, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await paused;
    expect(Date.now() - started).toBeLessThan(2_000);
    // Already stopped: no wait at all.
    const again = Date.now();
    await pauseUnlessStopped(10_000, controller.signal);
    expect(Date.now() - again).toBeLessThan(100);
  });

  test('--runtime-url with nothing serving: a stop ends the wait at once', async () => {
    const packDir = await mkdtemp(join(tmpdir(), 'kindgi-attach-'));
    try {
      const controller = new AbortController();
      const attached = attachToRuntimeReal({
        // Port 9 (discard): nothing serves there.
        runtimeUrl: 'http://127.0.0.1:9',
        port: 9,
        databaseUrl: 'postgres://kindgi@127.0.0.1:5432/acme',
        tenantId: '00000000-0000-4000-8000-000000000001',
        token: 'kgi_bt_test',
        userId: '00000000-0000-4000-8000-000000000002',
        packDir,
        hostEnv: {},
        packService: { url: 'http://127.0.0.1:1', token: 'pack-token' },
        runtimeImage: 'quay.io/kindgi/runtime:test',
        signal: controller.signal,
      });
      const started = Date.now();
      setTimeout(() => controller.abort(), 300);
      await expect(attached).rejects.toBeInstanceOf(RuntimeStartStopped);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await rm(packDir, { recursive: true, force: true });
    }
  });
});

describe('describeStartupStop', () => {
  test('a container that stopped before printing anything says so, with how it exited', () => {
    expect(describeStartupStop([], { code: 139, oomKilled: false })).toBe(
      'the Kindgi runtime container stopped while starting, before it printed anything (exit code 139: it crashed (a segmentation fault)).',
    );
    expect(describeStartupStop([], { code: 137, oomKilled: true })).toContain(
      '(exit code 137: killed, out of memory)',
    );
    expect(describeStartupStop([], { code: 137, oomKilled: false })).toContain(
      '(exit code 137: killed)',
    );
    expect(
      describeStartupStop([], { code: 127, oomKilled: false, error: 'exec: "kindgi": not found' }),
    ).toContain('(exit code 127: its command couldn\'t run; docker: exec: "kindgi": not found)');
    expect(describeStartupStop([], { code: 0, oomKilled: false })).toContain(
      'before it printed anything (exit code 0).',
    );
    // How it exited couldn't be read: still never an empty reason.
    expect(describeStartupStop([], {})).toBe(
      'the Kindgi runtime container stopped while starting, before it printed anything.',
    );
  });

  test('otherwise its last 15 lines, after how it exited', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const text = describeStartupStop(lines, { code: 1, oomKilled: false });
    expect(
      text.startsWith(
        'the Kindgi runtime container stopped while starting (exit code 1):\nline 6\n',
      ),
    ).toBe(true);
    expect(text.endsWith('line 20')).toBe(true);
  });
});

describe("dockerFailureDetail: why docker failed, without a pull's progress (T230)", () => {
  const DIGEST = 'sha256:0f73770b2d1a00fa47492a86b194f70b4f3e855f5c5ef5680993b742453792a9';
  const IMAGE = `quay.io/kindgi/runtime@${DIGEST}`;
  // The shape of rc.0's amd64 proof: the error, then the pull's progress went on.
  const pulling = [
    `Unable to find image '${IMAGE}' locally`,
    `${IMAGE}: Pulling from kindgi/runtime`,
    'e3649207a629: Pulling fs layer',
    'a1b2c3d4e5f6: Pulling fs layer',
    `docker: cannot overwrite digest ${DIGEST}`,
    'a1b2c3d4e5f6: Waiting',
    'e3649207a629: Downloading',
    'e3649207a629: Verifying Checksum',
    'e3649207a629: Download complete',
    'e3649207a629: Extracting',
    'e3649207a629: Pull complete',
    'a1b2c3d4e5f6: Already exists',
    `Digest: ${DIGEST}`,
    `Status: Downloaded newer image for ${IMAGE}`,
    '',
    "Run 'docker run --help' for more information",
  ].join('\n');

  test("the error a pull's progress buried", () => {
    expect(dockerFailureDetail(pulling)).toBe(`docker: cannot overwrite digest ${DIGEST}`);
  });

  test('an auth error, and a daemon error, keep their lines', () => {
    const auth = [
      `Unable to find image '${IMAGE}' locally`,
      'docker: Error response from daemon: unauthorized: access to the requested resource is not authorized.',
      "Run 'docker run --help' for more information",
    ].join('\n');
    expect(dockerFailureDetail(auth)).toBe(
      'docker: Error response from daemon: unauthorized: access to the requested resource is not authorized.',
    );
    const disk = `${IMAGE}: Pulling from kindgi/runtime\ne3649207a629: Extracting\nfailed to register layer: write /usr/lib/x: no space left on device`;
    expect(dockerFailureDetail(disk)).toBe(
      'failed to register layer: write /usr/lib/x: no space left on device',
    );
  });

  test('progress redrawn in place (\\r) counts as progress; the last 5 other lines are kept', () => {
    const redrawn = 'e3649207a629: Downloading\re3649207a629: Download complete\nboom';
    expect(dockerFailureDetail(redrawn)).toBe('boom');
    const many = ['one', 'two', 'three', 'four', 'five', 'six', 'e3649207a629: Pull complete'].join(
      '\n',
    );
    expect(dockerFailureDetail(many)).toBe('two\nthree\nfour\nfive\nsix');
  });

  test('all progress and nothing else: the plain tail, so the message is never empty', () => {
    const onlyProgress = 'e3649207a629: Pull complete\nDigest: sha256:abc';
    expect(dockerFailureDetail(onlyProgress)).toBe(onlyProgress);
  });
});
