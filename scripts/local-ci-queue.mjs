// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A machine-wide queue for `local-ci`: at most `KINDGI_LOCAL_CI_SLOTS`
 * runs at once (default 2), across every checkout and worktree of every
 * repository that uses it. Runs share one machine; past two at a time they
 * only slow each other down and make container-based tests flaky.
 *
 * A slot is a directory, `~/.cache/kindgi-local-ci/slot-<n>`, created with
 * `mkdir` (atomic) and holding `owner.json` (pid, repo, commit, start). A
 * slot whose process is gone, or older than six hours, is taken over, so a
 * killed run never blocks the queue. Each run appends one line to
 * `history.jsonl` (waited, duration, result) for comparing runs over time.
 */

import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), '.cache', 'kindgi-local-ci');
const SLOTS = Math.max(1, Number.parseInt(process.env.KINDGI_LOCAL_CI_SLOTS ?? '2', 10) || 2);
const STALE_MS = 6 * 60 * 60_000;
const POLL_MS = 5_000;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function owner(slot) {
  try {
    return JSON.parse(readFileSync(join(slot, 'owner.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Remove a slot whose run is gone or too old; true when it was removed. */
function reclaimIfStale(slot) {
  let created;
  try {
    created = statSync(slot).mtimeMs;
  } catch {
    return false;
  }
  const o = owner(slot);
  // No owner.json yet: another run is between mkdir and write. Give it a moment.
  const stale =
    o === undefined
      ? Date.now() - created > 30_000
      : !alive(o.pid) || Date.now() - o.startedAt > STALE_MS;
  if (stale) rmSync(slot, { recursive: true, force: true });
  return stale;
}

/**
 * Wait for a free slot and take it. `onWait(holders)` is called once when
 * the run has to wait, with who holds the slots. Returns `release()` (also
 * called on exit) and the time spent waiting.
 */
export function acquireSlot({ repo, sha, onWait }) {
  mkdirSync(DIR, { recursive: true });
  const queuedAt = Date.now();
  let told = false;
  for (;;) {
    for (let n = 0; n < SLOTS; n += 1) {
      const slot = join(DIR, `slot-${n}`);
      try {
        mkdirSync(slot);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        if (reclaimIfStale(slot)) n -= 1; // retry this slot
        continue;
      }
      writeFileSync(
        join(slot, 'owner.json'),
        JSON.stringify({ pid: process.pid, repo, sha, startedAt: Date.now() }),
      );
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const o = owner(slot);
        if (o?.pid === process.pid) rmSync(slot, { recursive: true, force: true });
      };
      process.on('exit', release);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(signal, () => {
          release();
          process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1));
        });
      }
      return { release, waitedMs: Date.now() - queuedAt };
    }
    if (!told) {
      told = true;
      const holders = [];
      for (let n = 0; n < SLOTS; n += 1) {
        const o = owner(join(DIR, `slot-${n}`));
        if (o !== undefined) holders.push(`${o.repo} ${String(o.sha).slice(0, 8)} (pid ${o.pid})`);
      }
      onWait?.(holders);
    }
    sleep(POLL_MS);
  }
}

/** Append one run to `history.jsonl`. Never fails the run. */
export function recordRun(entry) {
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(
      join(DIR, 'history.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    );
  } catch {
    // history is a convenience
  }
}
