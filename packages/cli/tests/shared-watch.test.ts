// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `directoryWatches`: one watch per folder, shared. Its subscribers each
 * get every event, by path relative to the folder; one that throws never
 * stops the others; a failure reaches each once; the last to leave closes
 * the watch.
 */

import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import { type WatchEvents, directoryWatches } from '../src/dev/shared-watch.js';

/** A watch whose events the test pushes; it ends as `node:fs/promises`'s does when aborted. */
function pushed(): {
  readonly watch: WatchEvents;
  readonly opened: {
    readonly path: string;
    readonly recursive: boolean;
    readonly signal: AbortSignal;
  }[];
  push(event: { readonly filename: string | null } | { readonly error: Error }): Promise<void>;
} {
  const opened: { path: string; recursive: boolean; signal: AbortSignal }[] = [];
  let queue: ({ readonly filename: string | null } | { readonly error: Error })[] = [];
  let wake: (() => void) | undefined;
  return {
    opened,
    async push(event) {
      queue.push(event);
      wake?.();
      // Let the consumer take it.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    watch: (path, options) => {
      opened.push({ path, recursive: options.recursive === true, signal: options.signal });
      queue = [];
      options.signal.addEventListener('abort', () => wake?.());
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (queue.length === 0 && !options.signal.aborted) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
            if (options.signal.aborted) {
              throw Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' });
            }
            const event = queue.shift() as
              | { readonly filename: string | null }
              | { readonly error: Error };
            if ('error' in event) throw event.error;
            yield event;
          }
        },
      };
    },
  };
}

describe('directoryWatches', () => {
  test('one recursive watch per folder; each subscriber gets every event, `/`-separated', async () => {
    const events = pushed();
    const watches = directoryWatches(events.watch);
    const a = vi.fn();
    const b = vi.fn();
    watches.subscribe('/pack', a, vi.fn());
    watches.subscribe('/pack', b, vi.fn());
    expect(events.opened.map((o) => [o.path, o.recursive])).toEqual([['/pack', true]]);

    await events.push({ filename: join('kindgi', 'tools', 'echo.ts') });
    await events.push({ filename: null });
    expect(a.mock.calls).toEqual([['kindgi/tools/echo.ts'], [undefined]]);
    expect(b.mock.calls).toEqual(a.mock.calls);
    expect(sep === '/' || !a.mock.calls[0]?.[0].includes(sep)).toBe(true);
  });

  test('a subscriber that throws never stops the others', async () => {
    const events = pushed();
    const watches = directoryWatches(events.watch);
    const after = vi.fn();
    watches.subscribe(
      '/pack',
      () => {
        throw new Error('a bug in one watcher');
      },
      vi.fn(),
    );
    watches.subscribe('/pack', after, vi.fn());
    await events.push({ filename: 'a.ts' });
    await events.push({ filename: 'b.ts' });
    expect(after.mock.calls).toEqual([['a.ts'], ['b.ts']]);
  });

  test('the watch closes with its last subscriber, not before', async () => {
    const events = pushed();
    const watches = directoryWatches(events.watch);
    const leaveA = watches.subscribe('/pack', vi.fn(), vi.fn());
    const leaveB = watches.subscribe('/pack', vi.fn(), vi.fn());
    const signal = events.opened[0]?.signal as AbortSignal;
    leaveA();
    leaveA(); // twice is once
    expect(signal.aborted).toBe(false);
    leaveB();
    expect(signal.aborted).toBe(true);
    // A new subscriber opens a new watch.
    watches.subscribe('/pack', vi.fn(), vi.fn());
    expect(events.opened).toHaveLength(2);
  });

  test('a failure reaches each subscriber once; the next subscriber opens a new watch', async () => {
    const events = pushed();
    const watches = directoryWatches(events.watch);
    const failedA = vi.fn();
    const failedB = vi.fn();
    watches.subscribe('/pack', vi.fn(), failedA);
    watches.subscribe('/pack', vi.fn(), failedB);
    const failure = Object.assign(new Error('too many open files'), { code: 'EMFILE' });
    await events.push({ error: failure });
    expect([failedA.mock.calls, failedB.mock.calls]).toEqual([[[failure]], [[failure]]]);

    watches.subscribe('/pack', vi.fn(), vi.fn());
    expect(events.opened).toHaveLength(2);
  });

  test('folders and event sources stay apart', () => {
    const one = pushed();
    const other = pushed();
    directoryWatches(one.watch).subscribe('/a', vi.fn(), vi.fn());
    directoryWatches(one.watch).subscribe('/b', vi.fn(), vi.fn());
    directoryWatches(other.watch).subscribe('/a', vi.fn(), vi.fn());
    expect(one.opened.map((o) => o.path)).toEqual(['/a', '/b']);
    expect(other.opened.map((o) => o.path)).toEqual(['/a']);
  });

  test('a watch that ends without an error (its folder removed) is a failure too', async () => {
    const opened: string[] = [];
    // FSEvents can end the iteration when the watched folder goes away.
    const ending: WatchEvents = (path) => {
      opened.push(path);
      return {
        async *[Symbol.asyncIterator]() {},
      };
    };
    const watches = directoryWatches(ending);
    const failed = vi.fn();
    watches.subscribe('/pack', vi.fn(), failed);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    expect(String(failed.mock.calls[0]?.[0])).toContain('ended');
    watches.subscribe('/pack', vi.fn(), vi.fn());
    expect(opened).toEqual(['/pack', '/pack']);
  });

  test('one folder, however it is spelled, has one watch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kindgi-shared-watch-'));
    try {
      const events = pushed();
      const watches = directoryWatches(events.watch);
      // On macOS the temp folder is under /var, which is /private/var.
      watches.subscribe(dir, vi.fn(), vi.fn());
      watches.subscribe(`${realpathSync(dir)}${sep}`, vi.fn(), vi.fn());
      watches.subscribe(join(dir, '.'), vi.fn(), vi.fn());
      expect(events.opened).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
