// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * One recursive watch per directory, shared by every watcher under it in
 * this process.
 *
 * On macOS every `fs.watch` handle joins one FSEvents stream, and libuv
 * rebuilds that stream on every close but the last, holding the event
 * loop meanwhile. `kindgi dev` watched a pack with five handles (a
 * recursive one per discovery root, one for the env files' folder), and
 * closing them took 5 to 35 s; one handle closes in milliseconds. FSEvents
 * watches a tree of any size at the same cost, so on macOS a pack's
 * watchers share one handle on its directory, each filtering the events
 * itself. Not on Linux by default: there a recursive watch adds an inotify
 * watch per folder, `node_modules` included.
 *
 * `kindgi dev` subscribes once, at boot, for the whole session, so the
 * handle opens and closes once.
 */

import { sep } from 'node:path';

/** A directory's change events, as `node:fs/promises`'s `watch` gives them. */
export type WatchEvents = (
  path: string,
  options: { readonly recursive?: boolean; readonly signal: AbortSignal },
) => AsyncIterable<{ readonly filename?: string | null }>;

export interface DirectoryWatches {
  /**
   * Watch `dir` and everything under it. `onEvent` gets each event's path
   * relative to `dir` (`/`-separated), or `undefined` when the event names
   * no file. `onError` is called once if the watch fails (its folder
   * removed, too many open files); a later `subscribe` opens a new watch.
   * The returned function ends the subscription; the last one closes the
   * watch.
   */
  subscribe(
    dir: string,
    onEvent: (relPath: string | undefined) => void,
    onError: (error: unknown) => void,
  ): () => void;
}

interface Subscriber {
  readonly onEvent: (relPath: string | undefined) => void;
  readonly onError: (error: unknown) => void;
}

interface SharedWatch {
  readonly controller: AbortController;
  readonly subscribers: Set<Subscriber>;
}

/** Whether a pack's watchers share one watch unless told otherwise: on macOS (FSEvents). */
export const SHARE_WATCH_BY_DEFAULT = process.platform === 'darwin';

const registries = new WeakMap<WatchEvents, DirectoryWatches>();

/** The shared watches made with `watch` (one registry per events source, so tests stay apart). */
export function directoryWatches(watch: WatchEvents): DirectoryWatches {
  let registry = registries.get(watch);
  if (registry === undefined) {
    registry = createDirectoryWatches(watch);
    registries.set(watch, registry);
  }
  return registry;
}

function createDirectoryWatches(watch: WatchEvents): DirectoryWatches {
  const open = new Map<string, SharedWatch>();

  /** Hand each event to every subscriber; one that throws never stops the others. */
  const deliver = (shared: SharedWatch, relPath: string | undefined): void => {
    for (const subscriber of [...shared.subscribers]) {
      try {
        subscriber.onEvent(relPath);
      } catch {
        // The subscriber's own failure stays its own.
      }
    }
  };

  /** Every subscriber hears a failure once; the next subscribe opens a new watch. */
  const fail = (dir: string, shared: SharedWatch, error: unknown): void => {
    if (open.get(dir) === shared) open.delete(dir);
    for (const subscriber of [...shared.subscribers]) {
      try {
        subscriber.onError(error);
      } catch {
        // As in `deliver`.
      }
    }
  };

  async function consume(dir: string, shared: SharedWatch): Promise<void> {
    try {
      for await (const evt of watch(dir, { recursive: true, signal: shared.controller.signal })) {
        deliver(shared, slashed(evt.filename));
      }
    } catch (error) {
      if (!shared.controller.signal.aborted) fail(dir, shared, error);
    }
  }

  return {
    subscribe(dir, onEvent, onError) {
      let shared = open.get(dir);
      if (shared === undefined) {
        shared = { controller: new AbortController(), subscribers: new Set() };
        open.set(dir, shared);
        void consume(dir, shared);
      }
      const subscriber: Subscriber = { onEvent, onError };
      shared.subscribers.add(subscriber);
      const joined = shared;
      return () => {
        if (!joined.subscribers.delete(subscriber) || joined.subscribers.size > 0) return;
        if (open.get(dir) === joined) open.delete(dir);
        joined.controller.abort();
      };
    },
  };
}

/** An event's file name, `/`-separated, or `undefined` when it names none. */
function slashed(name: string | null | undefined): string | undefined {
  return name === null || name === undefined ? undefined : name.split(sep).join('/');
}
