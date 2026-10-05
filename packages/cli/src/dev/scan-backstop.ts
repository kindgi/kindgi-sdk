// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A backstop for `node:fs` watches. FSEvents (macOS) can drop events
 * when fseventsd is under load: on one machine, 18 of 40 `sed -i` edits
 * reported nothing. So `kindgi dev`'s watchers also scan what they watch
 * every so often (each file's path, mtime and size) and fire when that
 * changed. `fs.watch` stays the fast path; a missed event then costs one
 * scan interval, never the edit.
 *
 * The scan walks only what the watcher counts: its folders, skipping the
 * ones it never watches (dependencies, virtualenvs, build output, VCS and
 * dot folders), so it stays cheap on a large pack.
 */

import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** How often a watcher scans, by default. */
export const DEFAULT_SCAN_INTERVAL_MS = 1_000;

/** Folders no watcher counts files in. Dot folders (`.git`, `.venv`, `.kindgi`) are skipped too. */
export const SCAN_SKIPPED_DIRS: readonly string[] = [
  'node_modules',
  '__pycache__',
  'venv',
  'site-packages',
  'dist',
];

export interface ScanSpec {
  /** Folders walked: the absolute path, and the prefix its entries are named by. */
  readonly folders: readonly { readonly abs: string; readonly rel: string }[];
  /** Whether a file counts, by its name (`rel/…`). */
  readonly includes: (relPath: string) => boolean;
  /** Whether a folder is never walked, by its name. Default: dot folders and `SCAN_SKIPPED_DIRS`. */
  readonly skipDir?: (name: string) => boolean;
  /** Single files, absolute; one that doesn't exist yet counts once it does. */
  readonly files?: readonly string[];
}

const defaultSkip = (name: string): boolean =>
  name.startsWith('.') || SCAN_SKIPPED_DIRS.includes(name);

/** What a watcher watches, as one string: it changes when any counted file does. */
export async function scanSignature(spec: ScanSpec): Promise<string> {
  const skip = spec.skipDir ?? defaultSkip;
  const entries: string[] = [];
  for (const folder of spec.folders) {
    await walk(folder.abs, folder.rel, spec.includes, skip, entries);
  }
  for (const file of spec.files ?? []) entries.push(await describe(file, file));
  return entries.sort().join('\n');
}

async function walk(
  abs: string,
  rel: string,
  includes: (relPath: string) => boolean,
  skip: (name: string) => boolean,
  into: string[],
): Promise<void> {
  let names: Dirent[];
  try {
    names = await readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of names) {
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!skip(entry.name)) await walk(join(abs, entry.name), childRel, includes, skip, into);
    } else if (includes(childRel)) {
      into.push(await describe(join(abs, entry.name), childRel));
    }
  }
}

async function describe(abs: string, name: string): Promise<string> {
  const info = await stat(abs).catch(() => undefined);
  return info === undefined ? `${name}:-` : `${name}:${info.mtimeMs}:${info.size}`;
}

export interface ScanBackstop {
  /**
   * Take what the files are now as seen: the watcher calls it as it acts
   * on a change, so the scan doesn't fire again for that same change.
   */
  readonly mark: () => Promise<void>;
  readonly stop: () => void;
}

/** A scan waits at least this many times its own last duration (≤ 2% of a core). */
const COST_FACTOR = 50;
/** However slow the scan, it runs at least this often. */
const MAX_INTERVAL_MS = 5_000;

/**
 * Scan every `intervalMs` (longer on a large tree: at least 50 times the
 * last scan's duration, at most 5 s); when the files changed since the
 * last scan or `mark`, call `onChange` (the watcher's own debounced fire).
 */
export async function startScanBackstop(options: {
  readonly scan: () => Promise<string>;
  readonly intervalMs: number;
  readonly onChange: () => void;
}): Promise<ScanBackstop> {
  let seen = await options.scan();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The scan in flight: `mark` waits for it.
  let inFlight: Promise<void> | undefined;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    const started = Date.now();
    inFlight = options
      .scan()
      .then((now) => {
        if (stopped || now === seen) return;
        seen = now;
        options.onChange();
      })
      .catch(() => undefined);
    await inFlight;
    inFlight = undefined;
    schedule(Date.now() - started);
  };
  const schedule = (lastScanMs: number): void => {
    if (stopped) return;
    const wait = Math.min(MAX_INTERVAL_MS, Math.max(options.intervalMs, lastScanMs * COST_FACTOR));
    timer = setTimeout(() => void tick(), wait);
    timer.unref?.();
  };
  schedule(0);
  return {
    mark: async () => {
      await inFlight;
      const now = await options.scan().catch(() => undefined);
      if (now !== undefined) seen = now;
    },
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
