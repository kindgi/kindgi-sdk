// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `watchPackReal`: a pack embedded in an app (`kindgi/**`) re-indexes on
 * its own files only — never on the app's files or the dev index the
 * indexer itself writes.
 *
 * Which events count is checked with scripted events: each is handed to
 * the watcher, and the test knows when it has been handled, so "didn't
 * fire" is a fact rather than a wait. The real file system is checked
 * separately, for one thing only: that its events reach the watcher.
 */

import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';

import { type Mock, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type WatchEvents, watchPackReal } from '../src/dev/defaults.js';
import type { WatchHandle } from '../src/dev/runners.js';
import { untilReported } from './fs-events.js';

let dir: string;
let handle: WatchHandle | undefined;
const PATTERNS = ['kindgi/tools/**/*.ts', 'kindgi/agents/**/*.ts'];
const DEBOUNCE_MS = 20;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-watch-'));
  await mkdir(join(dir, 'kindgi', 'tools'), { recursive: true });
  await mkdir(join(dir, 'kindgi', 'agents'), { recursive: true });
  await mkdir(join(dir, 'tools'), { recursive: true }); // the host app's own folder
  await mkdir(join(dir, '.kindgi', 'dev'), { recursive: true });
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scripted events
// ---------------------------------------------------------------------------

type Item = { readonly filename: string | null } | { readonly error: Error };

/**
 * One watched folder's events, handed over by the test one at a time.
 * `deliver` resolves once the watcher has handled the event and asks for
 * the next one. Aborting ends it as `node:fs/promises`'s `watch` does.
 */
class ScriptedEvents implements AsyncIterable<{ readonly filename: string | null }> {
  readonly #items: Item[] = [];
  #wake: (() => void) | undefined;
  #handled: (() => void) | undefined;

  constructor(
    readonly recursive: boolean,
    private readonly signal: AbortSignal,
  ) {
    signal.addEventListener('abort', () => this.#wake?.());
  }

  /** The watcher closed this watch. */
  get closed(): boolean {
    return this.signal.aborted;
  }

  deliver(item: Item): Promise<void> {
    const handled = new Promise<void>((resolve) => {
      this.#handled = resolve;
    });
    this.#items.push(item);
    this.#wake?.();
    return handled;
  }

  /** The watcher is done with the last event handed over. */
  #markHandled(): void {
    this.#handled?.();
    this.#handled = undefined;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<{ readonly filename: string | null }> {
    for (;;) {
      this.#markHandled();
      while (this.#items.length === 0 && !this.signal.aborted) {
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
      }
      if (this.signal.aborted) {
        throw Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' });
      }
      const item = this.#items.shift() as Item;
      if ('error' in item) {
        this.#markHandled();
        throw item.error;
      }
      yield item;
    }
  }
}

function scripted(): {
  readonly watch: WatchEvents;
  readonly watched: Map<string, ScriptedEvents>;
  /** Every folder a watch was opened on, in order (repeats included). */
  readonly opened: string[];
} {
  const watched = new Map<string, ScriptedEvents>();
  const opened: string[] = [];
  return {
    watched,
    opened,
    watch: (path, options) => {
      const events = new ScriptedEvents(options.recursive === true, options.signal);
      watched.set(path, events);
      opened.push(path);
      return events;
    },
  };
}

/**
 * How a pack is watched: one watch on its folder, shared (macOS's
 * default), or one per discovery root plus the env files' folder (the
 * default elsewhere). Both run everywhere, so CI's Linux runs check the
 * macOS shape too.
 */
const MODES = [
  { mode: 'shared', share: true },
  { mode: 'per root', share: false },
] as const;

describe.each(MODES)('watchPackReal ($mode): which events count', ({ share }) => {
  let onChange: Mock;
  let onWatchFailed: Mock;
  let events: ReturnType<typeof scripted>;
  const watched = (rel: string): ScriptedEvents => {
    const found = events.watched.get(rel === '' ? dir : join(dir, rel));
    if (found === undefined) throw new Error(`not watched: ${rel}`);
    return found;
  };
  /** The watch an event about `rel` (relative to the pack) arrives on, and its name there. */
  const route = (rel: string): readonly [ScriptedEvents, string] => {
    if (share) return [watched(''), rel.split('/').join(sep)];
    const root = ['kindgi/tools', 'kindgi/agents'].find((r) => rel.startsWith(`${r}/`));
    if (root === undefined) return [watched(''), rel];
    return [
      watched(root),
      rel
        .slice(root.length + 1)
        .split('/')
        .join(sep),
    ];
  };
  /** Hand over an event about each path in turn, then let the debounce window pass. */
  const deliver = async (...rels: string[]): Promise<void> => {
    for (const rel of rels) {
      const [on, filename] = route(rel);
      await on.deliver({ filename });
    }
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
  };
  /** The watch a failure or a nameless event arrives on. */
  const discoveryWatch = (): ScriptedEvents => watched(share ? '' : 'kindgi/tools');

  beforeEach(async () => {
    vi.useFakeTimers();
    onChange = vi.fn();
    onWatchFailed = vi.fn();
    events = scripted();
    handle = await watchPackReal(dir, onChange, {
      debounceMs: DEBOUNCE_MS,
      patterns: PATTERNS,
      files: [join(dir, '.env'), join(dir, '.env.local')],
      watch: events.watch,
      share,
      onWatchFailed,
      // The scan never sees a change: only the events decide here.
      scan: async () => 'unchanged',
    });
  });

  test('watches what this mode watches', () => {
    const opened = [...events.watched].map(([path, e]) => [path, e.recursive] as const);
    expect(new Map(opened)).toEqual(
      share
        ? // The pack's folder, once, recursively: the env files come with it.
          new Map([[dir, true]])
        : // The discovery roots, recursively, and the env files' folder alone.
          new Map([
            [dir, false],
            [join(dir, 'kindgi', 'agents'), true],
            [join(dir, 'kindgi', 'tools'), true],
          ]),
    );
  });

  test('fires for a file a discovery pattern matches, once per burst', async () => {
    await deliver('kindgi/tools/echo.ts', 'kindgi/tools/echo.ts');
    await deliver('kindgi/agents/nested/helper.ts');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test("ignores the host app's files, the dev index, dependencies, test files and other files", async () => {
    if (!share) {
      // The app's `tools/` and `.kindgi/dev/` aren't under a discovery root: never watched.
      expect(events.watched.has(join(dir, 'tools'))).toBe(false);
      expect(events.watched.has(join(dir, '.kindgi', 'dev'))).toBe(false);
    }
    await deliver('package.json', '.env.example', 'kindgi/.env');
    await deliver('tools/echo.ts', 'tools', '.kindgi/dev/index.json', 'node_modules/acme/index.ts');
    await deliver('kindgi/tools/echo.test.ts', 'kindgi/tools/notes.txt');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("fires when a primitive's folder is moved in or out of the pack (an editor's delete)", async () => {
    await deliver('kindgi/tools/echo');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("ignores the event for the watched folder's own creation", async () => {
    // macOS names it after the folder, which has no child of that name.
    if (share) await watched('').deliver({ filename: basename(dir) });
    else await watched('kindgi/tools').deliver({ filename: 'tools' });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('fires for an event without a file name', async () => {
    await discoveryWatch().deliver({ filename: null });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('fires when an env file is created or edited', async () => {
    await deliver('.env');
    await deliver('.env.local');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test('a watcher that fails says so, and fires once, so the refresh looks', async () => {
    const failure = Object.assign(new Error('too many open files'), { code: 'EMFILE' });
    await discoveryWatch().deliver({ error: failure });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onWatchFailed.mock.calls).toEqual([[failure]]);
  });

  test('close() stops: a change still in its debounce window never fires', async () => {
    const [on, filename] = route('kindgi/tools/echo.ts');
    await on.deliver({ filename });
    await handle?.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('watchPackReal (shared): one watch on the pack, whoever watches it', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  test('watchers of one pack share one watch; it closes with the last of them', async () => {
    const events = scripted();
    const onCode = vi.fn();
    const onEnv = vi.fn();
    const options = {
      debounceMs: DEBOUNCE_MS,
      watch: events.watch,
      share: true,
      scan: async () => '',
    };
    const code = await watchPackReal(dir, onCode, { ...options, patterns: PATTERNS });
    const env = await watchPackReal(dir, onEnv, {
      ...options,
      patterns: [],
      files: [join(dir, '.env')],
    });
    expect(events.opened).toEqual([dir]);
    const shared = events.watched.get(dir) as ScriptedEvents;

    await shared.deliver({ filename: '.env' });
    await shared.deliver({ filename: join('kindgi', 'tools', 'echo.ts') });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect([onCode.mock.calls.length, onEnv.mock.calls.length]).toEqual([1, 1]);

    await code.close();
    expect(shared.closed).toBe(false);
    await shared.deliver({ filename: '.env' });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect([onCode.mock.calls.length, onEnv.mock.calls.length]).toEqual([1, 2]);

    await env.close();
    expect(shared.closed).toBe(true);
  });

  test('an env file outside the pack folder gets its own watch, of its folder alone', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kindgi-watch-env-'));
    try {
      const events = scripted();
      const onChange = vi.fn();
      handle = await watchPackReal(dir, onChange, {
        debounceMs: DEBOUNCE_MS,
        patterns: PATTERNS,
        files: [join(dir, '.env'), join(outside, '.env.shared')],
        watch: events.watch,
        share: true,
        scan: async () => '',
      });
      const opened = [...events.watched].map(([path, e]) => [path, e.recursive] as const);
      expect(new Map(opened)).toEqual(
        new Map([
          [dir, true],
          [outside, false],
        ]),
      );
      await events.watched.get(outside)?.deliver({ filename: '.env.shared' });
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('a shared watch that fails: each watcher fires once, and a new watcher opens a new watch', async () => {
    const events = scripted();
    const first = vi.fn();
    const second = vi.fn();
    const options = {
      debounceMs: DEBOUNCE_MS,
      watch: events.watch,
      share: true,
      scan: async () => '',
    };
    const a = await watchPackReal(dir, first, { ...options, patterns: PATTERNS });
    const b = await watchPackReal(dir, second, { ...options, patterns: PATTERNS });
    const failure = Object.assign(new Error('no such folder'), { code: 'ENOENT' });
    await events.watched.get(dir)?.deliver({ error: failure });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 1]);

    const c = await watchPackReal(dir, vi.fn(), { ...options, patterns: PATTERNS });
    expect(events.opened).toEqual([dir, dir]);
    await Promise.all([a.close(), b.close(), c.close()]);
  });

  test('a discovery root made after the start counts, once, though the scan sees it too', async () => {
    const events = scripted();
    const onChange = vi.fn();
    let files = '';
    handle = await watchPackReal(dir, onChange, {
      debounceMs: DEBOUNCE_MS,
      // `kindgi/flows` doesn't exist yet.
      patterns: [...PATTERNS, 'kindgi/flows/**/*.ts'],
      watch: events.watch,
      share: true,
      scanIntervalMs: 1_000,
      scan: async () => files,
    });
    files = 'kindgi/flows/intake.ts:1:10';
    await events.watched.get(dir)?.deliver({ filename: join('kindgi', 'flows', 'intake.ts') });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('watchPackReal: the scan behind the events (FSEvents can drop them)', () => {
  test('a change no event reports fires once; nothing more while the files stay so', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const events = scripted();
    let files = 'kindgi/tools/echo.ts:1:10';
    handle = await watchPackReal(dir, onChange, {
      debounceMs: DEBOUNCE_MS,
      patterns: PATTERNS,
      watch: events.watch,
      scanIntervalMs: 1_000,
      scan: async () => files,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onChange).not.toHaveBeenCalled();
    files = 'kindgi/tools/echo.ts:2:12';
    await vi.advanceTimersByTimeAsync(1_000 + DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('a change an event reported is not reported again by the scan', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const events = scripted();
    let files = 'kindgi/tools/echo.ts:1:10';
    handle = await watchPackReal(dir, onChange, {
      debounceMs: DEBOUNCE_MS,
      patterns: PATTERNS,
      watch: events.watch,
      share: false,
      scanIntervalMs: 1_000,
      scan: async () => files,
    });
    files = 'kindgi/tools/echo.ts:2:12';
    const tools = events.watched.get(join(dir, 'kindgi', 'tools'));
    await tools?.deliver({ filename: 'echo.ts' });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('close() stops the scan too', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    let files = 'a';
    handle = await watchPackReal(dir, onChange, {
      debounceMs: DEBOUNCE_MS,
      patterns: PATTERNS,
      watch: scripted().watch,
      scanIntervalMs: 1_000,
      scan: async () => files,
    });
    await handle.close();
    files = 'b';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The real file system
// ---------------------------------------------------------------------------

describe.each(MODES)(
  'watchPackReal ($mode) on the real file system',
  ({ share }) => {
    test('a file written under a discovery root is reported', async (context) => {
      const onChange = vi.fn();
      handle = await watchPackReal(dir, onChange, {
        debounceMs: DEBOUNCE_MS,
        patterns: PATTERNS,
        share,
      });
      const tools = join(dir, 'kindgi', 'tools');
      await untilReported(
        context,
        { folder: tools, recursive: true, name: 'echo.ts' },
        () => onChange.mock.calls.length > 0,
        () => writeFile(join(tools, 'echo.ts'), `export default {}; // ${Date.now()}\n`),
      );
    });

    test("a primitive's folder moved out of the pack, or back, is reported", async (context) => {
      const tools = join(dir, 'kindgi', 'tools');
      const inPack = join(tools, 'echo');
      const trashed = join(dir, 'trashed-echo');
      await mkdir(inPack);
      await writeFile(join(inPack, 'index.ts'), 'export default {};\n');
      const onChange = vi.fn();
      handle = await watchPackReal(dir, onChange, {
        debounceMs: DEBOUNCE_MS,
        patterns: PATTERNS,
        share,
      });
      let out = false;
      await untilReported(
        context,
        { folder: tools, recursive: true, name: 'echo' },
        () => onChange.mock.calls.length > 0,
        async () => {
          await (out ? rename(trashed, inPack) : rename(inPack, trashed));
          out = !out;
        },
      );
    });

    test('an env file written in the pack root is reported', async (context) => {
      const onChange = vi.fn();
      handle = await watchPackReal(dir, onChange, {
        debounceMs: DEBOUNCE_MS,
        patterns: PATTERNS,
        files: [join(dir, '.env')],
        share,
      });
      await untilReported(
        context,
        { folder: dir, recursive: false, name: '.env' },
        () => onChange.mock.calls.length > 0,
        () => writeFile(join(dir, '.env'), `X=${Date.now()}\n`),
      );
    });
  },
  60_000,
);
