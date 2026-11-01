// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * One `kindgi dev` per pack. A second one in the same pack used to take
 * the first's runtime container (both use the pack's container name) and
 * point `.kindgirc.json` at its own port, then take both with it when it
 * stopped. Now the first holds `.kindgi/dev/dev.lock`, and a second
 * refuses, saying where the first is.
 *
 * - **Taken** with an exclusive create, before anything starts; released
 *   on every way out.
 * - **Held** while its process lives. A process is the same one when its
 *   pid is alive and its start time matches the lock's, so a pid the OS
 *   reused for another process doesn't keep a dead `kindgi dev`'s lock.
 * - **Stale** otherwise (a crash, a `kill -9`): the next `kindgi dev`
 *   takes it over. Two that find the same stale lock can't both take it:
 *   each moves it aside with `rename()`, which only one can do, and puts
 *   back a lock it moved that wasn't the stale one.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { programPath } from '../program-path.js';

/** What a running `kindgi dev` says about itself in its lock. */
export interface DevLockRecord {
  readonly pid: number;
  /** The process's start time as the OS reports it; absent where it can't be read. */
  readonly processStart?: string;
  /** When it took the lock (ISO 8601). */
  readonly takenAt: string;
  /** Once its runtime serves: where. */
  readonly apiUrl?: string;
  readonly consoleUrl?: string;
}

/** How a lock checks a process: the OS's view of pids. Injected in tests. */
export interface DevLockProcesses {
  readonly pid: number;
  /** Whether a process with this pid exists (a signal-0 probe). */
  isAlive(pid: number): boolean;
  /** The process's start time, or `undefined` where the OS won't say. */
  startTime(pid: number): Promise<string | undefined>;
  now(): Date;
}

export const DEV_LOCK_FILE = join('.kindgi', 'dev', 'dev.lock');

export function devLockPath(packDir: string): string {
  return join(packDir, DEV_LOCK_FILE);
}

/** The `owner` a runtime container is labeled with: `<pid>@<process start>`. */
export function ownerOf(record: Pick<DevLockRecord, 'pid' | 'processStart'>): string {
  return `${record.pid}@${record.processStart ?? ''}`;
}

export interface HeldDevLock {
  readonly record: DevLockRecord;
  /** The container label value that names this `kindgi dev`. */
  readonly owner: string;
  /** Adds where its runtime serves, once it does. */
  update(fields: Pick<DevLockRecord, 'apiUrl' | 'consoleUrl'>): Promise<void>;
  /** Removes the lock, if it's still this process's. */
  release(): Promise<void>;
}

export type DevLockOutcome =
  | {
      readonly kind: 'taken';
      readonly lock: HeldDevLock;
      /** A lock left by a `kindgi dev` that ended without removing it, taken over. */
      readonly stale?: DevLockRecord;
    }
  | { readonly kind: 'held'; readonly holder: DevLockRecord };

/** Whether `record`'s process is still the one that took the lock. */
export async function isLive(
  record: Pick<DevLockRecord, 'pid' | 'processStart'>,
  processes: DevLockProcesses,
): Promise<boolean> {
  if (!processes.isAlive(record.pid)) return false;
  // Where the OS can't say when it started, a live pid is taken at its word.
  if (record.processStart === undefined) return true;
  const now = await processes.startTime(record.pid);
  return now === undefined || now === record.processStart;
}

/** Whether a container's `owner` label names a live `kindgi dev` (`ownerOf`). */
export async function ownerIsLive(owner: string, processes: DevLockProcesses): Promise<boolean> {
  const at = owner.indexOf('@');
  const pid = Number(at === -1 ? owner : owner.slice(0, at));
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const start = at === -1 ? '' : owner.slice(at + 1);
  return isLive({ pid, ...(start !== '' && { processStart: start }) }, processes);
}

export async function takeDevLock(
  packDir: string,
  processes: DevLockProcesses = osProcesses(),
): Promise<DevLockOutcome> {
  const path = devLockPath(packDir);
  await mkdir(dirname(path), { recursive: true });
  const processStart = await processes.startTime(processes.pid);
  const mine: DevLockRecord = {
    pid: processes.pid,
    ...(processStart !== undefined && { processStart }),
    takenAt: processes.now().toISOString(),
  };
  let stale: DevLockRecord | undefined;
  // A few times at most: a stale lock is moved aside, then the create is
  // tried again.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(mine)}\n`);
      } finally {
        await file.close();
      }
      return {
        kind: 'taken',
        lock: heldLock(path, mine),
        ...(stale !== undefined && { stale }),
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    }
    const found = await readLockText(path);
    if (found === undefined) continue;
    const holder = parseLock(found);
    if (holder !== undefined && (await isLive(holder, processes))) {
      return { kind: 'held', holder };
    }
    if (await takeOver(path, found, processes.pid)) stale = holder;
  }
  const holder = await readLock(path);
  if (holder !== undefined) return { kind: 'held', holder };
  throw new Error(
    `${DEV_LOCK_FILE} keeps coming back unreadable: remove it, then run kindgi dev again`,
  );
}

function heldLock(path: string, initial: DevLockRecord): HeldDevLock {
  let record = initial;
  const owner = ownerOf(initial);
  const stillMine = async () => {
    const now = await readLock(path);
    return now !== undefined && ownerOf(now) === owner;
  };
  return {
    get record() {
      return record;
    },
    owner,
    async update(fields) {
      if (!(await stillMine())) return;
      record = { ...record, ...fields };
      // Written whole and renamed into place: a reader never sees half.
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      await rename(temp, path);
    },
    async release() {
      if (await stillMine()) await unlink(path).catch(() => undefined);
    },
  };
}

/**
 * Remove the stale lock whose text is `found`, if it's still the one
 * there. It's moved aside first, under a name of this process's own:
 * of two `kindgi dev` taking the same stale lock over, only one moves
 * it. A lock moved that isn't the stale one (another took it over and
 * wrote its own in between) is put back, unless yet another is there by
 * then. Whether this one removed the stale lock.
 */
async function takeOver(path: string, found: string, pid: number): Promise<boolean> {
  const aside = `${path}.${pid}.${randomUUID()}.stale`;
  try {
    await rename(path, aside);
  } catch (cause) {
    // Gone already: another took it over. The create, tried again, says who.
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
  const moved = await readLockText(aside);
  if (moved !== found) await link(aside, path).catch(() => undefined);
  await unlink(aside).catch(() => undefined);
  return moved === found;
}

async function readLockText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

function parseLock(text: string): DevLockRecord | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<DevLockRecord>;
    if (typeof parsed.pid !== 'number' || typeof parsed.takenAt !== 'string') return undefined;
    return parsed as DevLockRecord;
  } catch {
    return undefined;
  }
}

async function readLock(path: string): Promise<DevLockRecord | undefined> {
  const text = await readLockText(path);
  return text === undefined ? undefined : parseLock(text);
}

/** The OS's processes: a signal-0 probe, and `ps` for a start time (not on Windows). */
export function osProcesses(): DevLockProcesses {
  return {
    pid: process.pid,
    isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (cause) {
        // EPERM: it exists, under another user.
        return (cause as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    async startTime(pid) {
      if (process.platform === 'win32') return undefined;
      // In one locale and time zone, whatever the shell's: a `kindgi dev`
      // started from another terminal (another TZ or LANG, an agent's
      // `LC_ALL=C`) reads the same start time, so a live one stays live.
      const env = { ...process.env, LC_ALL: 'C', TZ: 'UTC' };
      // The ps on PATH, never one in this folder.
      const ps = await programPath('ps', env).catch(() => undefined);
      if (ps === undefined) return undefined;
      return new Promise((resolve) => {
        execFile(
          ps,
          ['-o', 'lstart=', '-p', String(pid)],
          { timeout: 2_000, env },
          (err, stdout) => {
            const at = err === null ? stdout.trim() : '';
            resolve(at === '' ? undefined : at);
          },
        );
      });
    },
    now: () => new Date(),
  };
}
