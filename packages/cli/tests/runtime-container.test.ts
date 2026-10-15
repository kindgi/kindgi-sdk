// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, test } from 'vitest';

import { attachToRuntimeReal, databaseUrlFrom } from '../src/dev/defaults.js';
import {
  type RuntimeContainerOptions,
  RuntimeStartStopped,
  describeStartupStop,
  dockerFailureDetail,
  logTail,
  pauseUnlessStopped,
  readStoppedLog,
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

/** A boot crash record whose error has 10 frames and a cause with 10 of its own: 22 lines of text. */
function crashRecord(): string {
  const frames = (fn: string) =>
    Array.from(
      { length: 10 },
      (_, i) => `    at ${fn}${i + 1} (file:///app/dist/boot.js:${i + 1}:1)`,
    );
  return JSON.stringify({
    time: '2026-10-15T01:00:00.000Z',
    level: 'error',
    subsystem: 'boot',
    message: 'the runtime stopped while starting',
    err: {
      name: 'Error',
      message: "OpenFGA at http://openfga.acme.example refused the server's call (401)",
      stack: ['Error: OpenFGA refused', ...frames('outer')].join('\n'),
      cause: {
        name: 'TypeError',
        message: 'fetch failed',
        stack: ['TypeError: fetch failed', ...frames('inner')].join('\n'),
      },
    },
  });
}

const CRASH_FIRST_LINE = `01:00:00.000 ERROR [boot] the runtime stopped while starting err="Error: OpenFGA at http://openfga.acme.example refused the server's call (401)"`;

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
    const log = Array.from({ length: 20 }, (_, i) => [`line ${i + 1}`]);
    const text = describeStartupStop(log, { code: 1, oomKilled: false });
    expect(
      text.startsWith(
        'the Kindgi runtime container stopped while starting (exit code 1):\nline 6\n',
      ),
    ).toBe(true);
    expect(text.endsWith('line 20')).toBe(true);
  });

  test('a crash record past 15 lines of text keeps its first line, the one that says why', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const read = readStoppedLog(stdout, stderr);
    stderr.end('kindgi-runtime: starting\n');
    stdout.end(`${crashRecord()}\n`);
    const log = await read;
    // The record's text alone is 22 lines: kept whole, and the line
    // before it, which would pass 15, isn't.
    expect(log.map((text) => text.length)).toEqual([1, 22]);
    const text = describeStartupStop(log, { code: 1, oomKilled: false });
    const [how, first, ...rest] = text.split('\n');
    expect(how).toBe('the Kindgi runtime container stopped while starting (exit code 1):');
    expect(first).toBe(CRASH_FIRST_LINE);
    expect(rest[0]).toBe('    at outer1 (file:///app/dist/boot.js:1:1)');
    expect(rest).toContain('  caused by: TypeError: fetch failed');
    expect(rest.at(-1)).toBe('      at inner10 (file:///app/dist/boot.js:10:1)');
  });

  test('a crash record with a line after it (the other stream, or the runtime) still shows its first line', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const read = readStoppedLog(stdout, stderr);
    stdout.end(`kindgi-runtime: starting\n${crashRecord()}\n`);
    stderr.end('kindgi-runtime: exiting\n');
    const log = await read;
    expect(log.map((text) => text.length)).toEqual([1, 22, 1]);
    const [how, ...lines] = describeStartupStop(log, { code: 1, oomKilled: false }).split('\n');
    expect(how).toBe('the Kindgi runtime container stopped while starting (exit code 1):');
    // 15 lines: the record's first 13, how many it has left, and the last line.
    expect(lines).toHaveLength(15);
    expect(lines[0]).toBe(CRASH_FIRST_LINE);
    expect(lines.at(-2)).toBe('  … (9 more lines)');
    expect(lines.at(-1)).toBe('kindgi-runtime: exiting');
    expect(lines).not.toContain('kindgi-runtime: starting');
  });

  test('a boot record with no lines is nothing printed, never an empty reason', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const read = readStoppedLog(stdout, stderr);
    stdout.end(
      `${JSON.stringify({ time: '2026-10-15T01:00:00.000Z', level: 'info', subsystem: 'boot', message: 'banner', lines: [] })}\n`,
    );
    stderr.end();
    const log = await read;
    expect(log).toEqual([]);
    expect(describeStartupStop(log, { code: 1, oomKilled: false })).toBe(
      'the Kindgi runtime container stopped while starting, before it printed anything (exit code 1).',
    );
  });
});

describe('logTail: the end of the runtime log, its lines whole', () => {
  const line = (name: string, size: number) =>
    Array.from({ length: size }, (_, i) => (i === 0 ? name : `${name} frame ${i}`));

  test('whole lines from the end, up to 15 lines of text', () => {
    // 3 + 6 + 6 = 15 fit; the 2 before them would pass 15.
    const tail = logTail([line('a', 2), line('b', 3), line('c', 6), line('d', 6)]).split('\n');
    expect(tail).toHaveLength(15);
    expect(tail[0]).toBe('b');
    expect(tail).not.toContain('a frame 1');
  });

  test("one that doesn't fit shows its first lines and how many more it has, and the tail ends there", () => {
    // 6 fit; b gets the 9 left: its first 8 and the count, and a, which
    // would fit, isn't shown, so nothing is skipped over.
    const tail = logTail([line('a', 1), line('b', 10), line('c', 6)]).split('\n');
    expect(tail).toHaveLength(15);
    expect(tail.slice(0, 9)).toEqual([...line('b', 8), '  … (2 more lines)']);
    expect(tail[9]).toBe('c');
    expect(tail).not.toContain('a');
  });

  test('with room for one line, its first line alone, then the rest', () => {
    const tail = logTail([line('a', 3), line('b', 14)]).split('\n');
    expect(tail).toEqual(['a', ...line('b', 14)]);
  });

  test('with room for two or more: its first lines, then how many more it has', () => {
    const tail = logTail([line('a', 4), line('b', 12)]).split('\n');
    expect(tail).toEqual(['a', 'a frame 1', '  … (2 more lines)', ...line('b', 12)]);
  });

  test('nothing logged: no text', () => {
    expect(logTail([])).toBe('');
  });
});

describe('readStoppedLog: a stopped container log, both streams, as text', () => {
  test('a runtime that logs JSON: its boot error record as the line a person reads, never raw', async () => {
    const record = JSON.stringify({
      time: '2026-10-15T01:00:00.000Z',
      level: 'error',
      subsystem: 'boot',
      message: 'KINDGI_TENANCY must be one of single, multi. Got "many".',
    });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const read = readStoppedLog(stdout, stderr);
    // The record arrives split between two chunks, and the other stream
    // writes a line while it's half sent; a line that isn't a record stays
    // as it is, and `docker logs`' own error isn't the runtime's.
    stdout.write(record.slice(0, 40));
    stderr.write('kindgi-runtime: starting\n');
    stdout.write(`${record.slice(40)}\n`);
    stderr.end('Error response from daemon: can not get logs from container which is dead\n');
    stdout.end();
    expect(describeStartupStop(await read, { code: 2, oomKilled: false })).toBe(
      [
        'the Kindgi runtime container stopped while starting (exit code 2):',
        'kindgi-runtime: starting',
        '01:00:00.000 ERROR [boot] KINDGI_TENANCY must be one of single, multi. Got "many".',
      ].join('\n'),
    );
  });

  test('a character split between chunks stays whole, and a last line without a line break is kept', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const read = readStoppedLog(stdout, stderr);
    const bytes = Buffer.from('  Pack service: http://127.0.0.1:4101 — acme\n');
    const dash = bytes.indexOf(Buffer.from('—'));
    stdout.write(bytes.subarray(0, dash + 1));
    stdout.write(bytes.subarray(dash + 1));
    stdout.end('kindgi-runtime: exiting');
    stderr.end();
    expect(await read).toEqual([
      ['  Pack service: http://127.0.0.1:4101 — acme'],
      ['kindgi-runtime: exiting'],
    ]);
  });

  test('no streams at all: nothing read, at once', async () => {
    expect(await readStoppedLog(null, null)).toEqual([]);
  });

  test('a stream that fails ends its part: what it wrote is kept', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const read = readStoppedLog(stdout, stderr);
    stdout.write('kindgi-runtime: starting\n');
    stdout.destroy(new Error('read EPIPE'));
    stderr.end();
    expect(await read).toEqual([['kindgi-runtime: starting']]);
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
