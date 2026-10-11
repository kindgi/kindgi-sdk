// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * One `kindgi dev` per pack: the lock a running one holds, the refusal a
 * second one gives (exit 3, where the first is), and the runtime container
 * a live other `kindgi dev` owns, which is never removed.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  ALREADY_RUNNING_EXIT_CODE,
  alreadyRunning,
  alreadyRunningText,
} from '../src/dev/already-running.js';
import {
  type DevLockProcesses,
  devLockPath,
  isLive,
  osProcesses,
  ownerIsLive,
  ownerOf,
  takeDevLock,
} from '../src/dev/dev-lock.js';
import { runtimePortInUseReal } from '../src/dev/port.js';
import {
  type DockerRunner,
  RuntimeOwnedElsewhere,
  ownedElsewhere,
  runtimeContainerName,
  runtimeRunArgs,
  startRuntimeContainer,
} from '../src/dev/runtime-container.js';

/** Processes as a test says they are: pid → its start time; absent → not running. */
function processes(pid: number, running: Record<number, string>): DevLockProcesses {
  return {
    pid,
    isAlive: (p) => running[p] !== undefined,
    startTime: async (p) => running[p],
    now: () => new Date('2026-10-10T10:02:00Z'),
  };
}

let packDir = '';
beforeEach(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-dev-lock-'));
});
afterEach(async () => {
  await rm(packDir, { recursive: true, force: true });
});

describe('the lock', () => {
  test('the first takes it; a second, while the first runs, finds it held', async () => {
    const running = { 100: 'Fri Oct 10 10:02:00 2026', 200: 'Fri Oct 10 10:05:00 2026' };
    const first = await takeDevLock(packDir, processes(100, running));
    expect(first.kind).toBe('taken');
    const second = await takeDevLock(packDir, processes(200, running));
    expect(second).toEqual({
      kind: 'held',
      holder: {
        pid: 100,
        processStart: 'Fri Oct 10 10:02:00 2026',
        takenAt: '2026-10-10T10:02:00.000Z',
      },
    });
  });

  test('released, it can be taken again', async () => {
    const running = { 100: 'a', 200: 'b' };
    const first = await takeDevLock(packDir, processes(100, running));
    if (first.kind !== 'taken') throw new Error('not taken');
    await first.lock.release();
    expect((await takeDevLock(packDir, processes(200, running))).kind).toBe('taken');
  });

  test('a lock whose process is gone is stale: taken over, and said so', async () => {
    const before = await takeDevLock(packDir, processes(100, { 100: 'a' }));
    expect(before.kind).toBe('taken');
    // 100 died without releasing it (a kill -9).
    const after = await takeDevLock(packDir, processes(200, { 200: 'b' }));
    expect(after).toMatchObject({ kind: 'taken', stale: { pid: 100 } });
  });

  test('a pid the OS reused for another process is stale too: its start time differs', async () => {
    await takeDevLock(packDir, processes(100, { 100: 'Fri Oct 10 10:02:00 2026' }));
    // Pid 100 is alive again, but started later: not the kindgi dev that took the lock.
    const after = await takeDevLock(
      packDir,
      processes(200, { 100: 'Fri Oct 10 11:40:00 2026', 200: 'b' }),
    );
    expect(after.kind).toBe('taken');
  });

  test('where the OS gives no start time, a live pid holds it', async () => {
    const noStart = (pid: number, alive: number[]): DevLockProcesses => ({
      pid,
      isAlive: (p) => alive.includes(p),
      startTime: async () => undefined,
      now: () => new Date(),
    });
    await takeDevLock(packDir, noStart(100, [100]));
    expect((await takeDevLock(packDir, noStart(200, [100, 200]))).kind).toBe('held');
  });

  test("an update says where it serves; release leaves another's lock alone", async () => {
    const running = { 100: 'a', 200: 'b' };
    const first = await takeDevLock(packDir, processes(100, running));
    if (first.kind !== 'taken') throw new Error('not taken');
    await first.lock.update({
      apiUrl: 'http://localhost:4000',
      consoleUrl: 'http://localhost:4000/console/',
    });
    expect(JSON.parse(await readFile(devLockPath(packDir), 'utf8'))).toMatchObject({
      pid: 100,
      apiUrl: 'http://localhost:4000',
      consoleUrl: 'http://localhost:4000/console/',
    });
    // Someone removed it and another kindgi dev took it: the first's release leaves it be.
    await rm(devLockPath(packDir));
    const second = await takeDevLock(packDir, processes(200, running));
    expect(second.kind).toBe('taken');
    await first.lock.release();
    expect(JSON.parse(await readFile(devLockPath(packDir), 'utf8'))).toMatchObject({ pid: 200 });
  });

  test('an unreadable lock is stale', async () => {
    await takeDevLock(packDir, processes(100, { 100: 'a' }));
    await writeFile(devLockPath(packDir), 'not json');
    expect((await takeDevLock(packDir, processes(200, { 100: 'a', 200: 'b' }))).kind).toBe('taken');
  });

  test('two taking over one stale lock: the second finds the first holding it, and its lock stays', async () => {
    // 100 took the lock and died; its pid now runs another process (another start time).
    await takeDevLock(packDir, processes(100, { 100: 'a' }));
    const running = { 100: 'reused', 200: 'b', 300: 'c' };
    // 300 takes the stale lock over while 200 is still deciding it's stale (asking
    // for pid 100's start time), so the lock 200 then moves aside is 300's.
    let third: Awaited<ReturnType<typeof takeDevLock>> | undefined;
    const deciding: DevLockProcesses = {
      ...processes(200, running),
      startTime: async (p) => {
        if (p === 100 && third === undefined) {
          third = await takeDevLock(packDir, processes(300, running));
        }
        return running[p as keyof typeof running];
      },
    };
    const second = await takeDevLock(packDir, deciding);
    expect(third).toMatchObject({ kind: 'taken', stale: { pid: 100 } });
    expect(second).toMatchObject({ kind: 'held', holder: { pid: 300 } });
    // 300's lock is on disk, put back after 200 moved it aside, and nothing else is left.
    expect(JSON.parse(await readFile(devLockPath(packDir), 'utf8'))).toMatchObject({ pid: 300 });
    expect(await readdir(join(packDir, '.kindgi', 'dev'))).toEqual(['dev.lock']);
  });
});

describe.skipIf(process.platform === 'win32')("a process's start time, from ps", () => {
  const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('the same in any time zone or locale, so a live kindgi dev stays live from another terminal', async () => {
    const os = osProcesses();
    process.env.TZ = 'America/New_York';
    process.env.LC_ALL = 'de_DE.UTF-8';
    const recorded = await os.startTime(process.pid);
    if (recorded === undefined) throw new Error('ps gave no start time');
    process.env.TZ = 'Asia/Tokyo';
    process.env.LC_ALL = 'C';
    expect(await os.startTime(process.pid)).toBe(recorded);
    expect(await isLive({ pid: process.pid, processStart: recorded }, os)).toBe(true);
  });
});

describe('the refusal: exit 3, and where the running one is', () => {
  const holder = {
    pid: 41237,
    processStart: 'x',
    takenAt: '2026-10-10T10:02:00Z',
    apiUrl: 'http://localhost:4000',
    consoleUrl: 'http://localhost:4000/console/',
  };

  test('its runtime answers: the console and the API, and how to restart it', async () => {
    const text = alreadyRunningText(holder, true);
    expect(text).toMatch(
      /^kindgi dev: kindgi dev is already running for this pack \(pid 41237, since /,
    );
    expect(text).toContain('  Console  http://localhost:4000/console/');
    expect(text).toContain('  API      http://localhost:4000   (.kindgirc.json points here)');
    expect(text).toContain("so you don't need a second one");
    expect(text).toMatch(
      /stop that one first \(Ctrl\+C in its terminal, or `(kill|taskkill \/PID) 41237`\)/,
    );
  });

  test("its runtime doesn't answer: said, with how to stop it", () => {
    expect(alreadyRunningText(holder, false)).toMatch(
      /but its runtime isn't answering at http:\/\/localhost:4000\.\nStop it/,
    );
  });

  test('still starting (no address yet)', () => {
    const { apiUrl: _a, consoleUrl: _c, ...starting } = holder;
    expect(alreadyRunningText(starting, undefined)).toContain('  It is still starting.');
  });

  test('exit 3; the facts as JSON when a format was asked for, nothing on stdout otherwise', async () => {
    const answers = (async () => new Response('ok')) as unknown as typeof fetch;
    const json = await alreadyRunning(holder, {
      fetch: answers,
      format: 'json',
      formatRequested: true,
    });
    expect(ALREADY_RUNNING_EXIT_CODE).toBe(3);
    expect(json).toMatchObject({ kind: 'ok', exitCode: 3 });
    if (json.kind !== 'ok') throw new Error('not ok');
    expect(JSON.parse(json.rendered.stdout)).toEqual({
      running: {
        pid: 41237,
        since: '2026-10-10T10:02:00Z',
        apiUrl: 'http://localhost:4000',
        consoleUrl: 'http://localhost:4000/console/',
        answering: true,
      },
    });
    const refused = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const plain = await alreadyRunning(holder, {
      fetch: refused,
      format: 'json',
      formatRequested: false,
    });
    if (plain.kind !== 'ok') throw new Error('not ok');
    expect(plain.rendered.stdout).toBe('');
    expect(plain.rendered.stderr).toContain("isn't answering");
  });
});

describe("the runtime container: never another live kindgi dev's", () => {
  // Start times as `ps -o lstart=` gives them: with spaces, as the label carries them.
  const A = 'Sat Oct 10 19:45:37 2026';
  const C = 'Sat Oct 10 19:45:57 2026';
  const live = processes(100, { 100: A, 300: C });
  const self = {
    owner: ownerOf({ pid: 100, processStart: A }),
    ownerIsLive: (o: string) => ownerIsLive(o, live),
  };

  test('labeled with the kindgi dev that starts it', () => {
    const args = runtimeRunArgs('kindgi-dev-runtime-x', {
      image: 'img',
      packDir: '/p',
      envFile: '/p/.kindgi/dev/runtime.env',
      network: 'alias',
      hostPort: 4000,
      onLog: () => undefined,
      owner: `100@${A}`,
    });
    expect(args.slice(0, 8)).toEqual([
      'run',
      '--detach',
      '--name',
      'kindgi-dev-runtime-x',
      '--env-file',
      '/p/.kindgi/dev/runtime.env',
      '--label',
      `kindgi.dev.owner=100@${A}`,
    ]);
  });

  test("another live kindgi dev's: kept, and its owner named, running or not", async () => {
    expect(await ownedElsewhere(`300@${C}\n`, self)).toBe(`300@${C}`);
  });

  test('replaced otherwise: its owner gone or restarted, unlabeled, or its own', async () => {
    expect(await ownedElsewhere(`400@${C}`, self)).toBeUndefined();
    expect(await ownedElsewhere('300@Sat Oct 10 19:44:00 2026', self)).toBeUndefined();
    expect(await ownedElsewhere('<no value>', self)).toBeUndefined();
    expect(await ownedElsewhere('', self)).toBeUndefined();
    expect(await ownedElsewhere(`100@${A}`, self)).toBeUndefined();
  });

  /** A docker that answers `inspect` with `inspected` (or "no such container"), and records every call. */
  function fakeDocker(inspected: string | undefined): { run: DockerRunner; calls: string[][] } {
    const calls: string[][] = [];
    const run: DockerRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === 'inspect') {
        return inspected === undefined
          ? { code: 1, stdout: '', stderr: 'Error: No such object' }
          : { code: 0, stdout: `${inspected}\n`, stderr: '' };
      }
      if (args[0] === 'run') return { code: 1, stdout: '', stderr: 'docker run failed here' };
      return { code: 0, stdout: '', stderr: '' };
    };
    return { run, calls };
  }
  const ID = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
  const name = runtimeContainerName('/p');
  const startOptions = (run: DockerRunner) => ({
    image: 'img',
    packDir: '/p',
    envFile: '/p/.kindgi/dev/runtime.env',
    network: 'alias' as const,
    hostPort: 4000,
    onLog: () => undefined,
    ...self,
    docker: run,
  });

  describe.each([
    [
      'the port check',
      (run: DockerRunner) => runtimePortInUseReal({ packDir: '/p', port: 0, ...self }, run),
    ],
    ['the start', (run: DockerRunner) => startRuntimeContainer(startOptions(run))],
  ])('%s', (_where, call) => {
    test("another live kindgi dev's container: refused, and nothing removed", async () => {
      const docker = fakeDocker(`${ID} 300@${C}`);
      await expect(call(docker.run)).rejects.toBeInstanceOf(RuntimeOwnedElsewhere);
      expect(docker.calls.map((c) => c[0])).toEqual(['inspect']);
    });

    test.each([
      ['its owner gone', `${ID} 400@${C}`],
      ['unlabeled', `${ID} <no value>`],
      ['its own', `${ID} 100@${A}`],
    ])('%s: removed by the id it checked, never by name', async (_case, inspected) => {
      const docker = fakeDocker(inspected);
      await call(docker.run).catch(() => undefined);
      // Its id and owner label, whether it runs or not.
      expect(docker.calls[0]).toEqual([
        'inspect',
        '--format',
        '{{.Id}} {{index .Config.Labels "kindgi.dev.owner"}}',
        name,
      ]);
      expect(docker.calls[1]).toEqual(['rm', '--force', ID]);
    });

    test('none there: nothing removed', async () => {
      const docker = fakeDocker(undefined);
      await call(docker.run).catch(() => undefined);
      expect(docker.calls.filter((c) => c[0] === 'rm')).toEqual([]);
    });
  });
});
