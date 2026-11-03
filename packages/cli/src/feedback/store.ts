// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What the CLI keeps about sent reports, outside the pack, in
 * `~/.kindgi/feedback/` (0700):
 * - `keys.json` (0600): each report's `withdrawKey`, the only credential.
 *   `FEEDBACK.md` may be committed, so it holds just the `reportId`, and a
 *   withdraw needs the machine that sent the report.
 * - `status.json` (0600): the last answer `status` had for each report and
 *   when, so a session-start `status` asks at most once a day, and the pack's
 *   `FEEDBACK.md` doesn't churn.
 *
 * Each change is a read, a change and an atomic replace (`replacePrivateFile`)
 * under a lock file, so two commands at once never lose a key. The replace
 * is a rename on Windows too: a read takes no lock, so it must never see a
 * half-written file. A file that isn't what this module wrote is refused,
 * never overwritten.
 */

import { chmod, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { KEYS_DIR_MODE, PRIVATE_KEY_FILE_MODE } from '../key/paths.js';
import { replacePrivateFile } from '../private-file.js';
import type { ReportStatus } from './protocol.js';

export const FEEDBACK_SUBDIR = ['.kindgi', 'feedback'] as const;

export interface FeedbackFiles {
  readonly dir: string;
  readonly keys: string;
  readonly status: string;
}

export interface KeyRecord {
  readonly withdrawKey: string;
  readonly entry: string;
  readonly submittedAt: string;
}

export interface StatusRecord extends Omit<ReportStatus, 'reportId'> {
  readonly askedAt: string;
}

export type Keys = Record<string, KeyRecord>;
export type Statuses = Record<string, StatusRecord>;

/** How long a lock is waited for, and when one is left over from a command that died. */
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

export function feedbackFiles(home: string): FeedbackFiles {
  const dir = join(home, ...FEEDBACK_SUBDIR);
  return { dir, keys: join(dir, 'keys.json'), status: join(dir, 'status.json') };
}

export async function readKeys(files: FeedbackFiles): Promise<Keys> {
  return (await readRecords(files.keys)) as Keys;
}

export async function readStatuses(files: FeedbackFiles): Promise<Statuses> {
  return (await readRecords(files.status)) as Statuses;
}

/** Change `keys.json` under the lock; `change` edits the records in place. */
export async function updateKeys(
  files: FeedbackFiles,
  change: (keys: Keys) => void,
): Promise<void> {
  await update(files, files.keys, (records) => change(records as Keys));
}

export async function updateStatuses(
  files: FeedbackFiles,
  change: (statuses: Statuses) => void,
): Promise<void> {
  await update(files, files.status, (records) => change(records as Statuses));
}

async function update(
  files: FeedbackFiles,
  path: string,
  change: (records: Record<string, unknown>) => void,
): Promise<void> {
  await mkdir(files.dir, { recursive: true, mode: KEYS_DIR_MODE });
  await chmod(files.dir, KEYS_DIR_MODE);
  await withLock(join(files.dir, '.lock'), async () => {
    const records = await readRecords(path);
    change(records);
    await replacePrivateFile(path, `${JSON.stringify({ reports: records }, null, 2)}\n`);
  });
}

async function readRecords(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const reports = (parsed as { reports?: unknown } | undefined)?.reports;
  if (typeof reports !== 'object' || reports === null || Array.isArray(reports)) {
    throw new Error(
      `${path} isn't a file this CLI wrote (no "reports" object), so it was left as it is. Move it aside to start a new one.`,
    );
  }
  return { ...(reports as Record<string, unknown>) };
}

/** Run `fn` holding `lock` (a file made with `wx`); a lock older than 30 s is a dead command's. */
async function withLock<T>(lock: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lock, 'wx', PRIVATE_KEY_FILE_MODE);
      await handle.close();
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS) {
        await unlink(lock).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Another kindgi feedback command holds ${lock}. Try again when it's done (or remove the file if none is running).`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => undefined);
  }
}
