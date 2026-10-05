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

import { watch } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Mock, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type WatchEvents, watchPackReal } from '../src/dev/defaults.js';
import type { WatchHandle } from '../src/dev/runners.js';

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
} {
  const watched = new Map<string, ScriptedEvents>();
  return {
    watched,
    watch: (path, options) => {
      const events = new ScriptedEvents(options.recursive === true, options.signal);
      watched.set(path, events);
      return events;
    },
  };
}

describe('watchPackReal: which events count', () => {
  let onChange: Mock;
  let events: ReturnType<typeof scripted>;
  const watched = (rel: string): ScriptedEvents => {
    const found = events.watched.get(rel === '' ? dir : join(dir, rel));
    if (found === undefined) throw new Error(`not watched: ${rel}`);
    return found;
  };
  /** Hand over each event in turn, then let the debounce window pass. */
  const deliver = async (on: ScriptedEvents, ...items: Item[]): Promise<void> => {
    for (const item of items) await on.deliver(item);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    onChange = vi.fn();
    events = scripted();
    handle = await watchPackReal(dir, onChange, {
      debounceMs: DEBOUNCE_MS,
      patterns: PATTERNS,
      files: [join(dir, '.env'), join(dir, '.env.local')],
      watch: events.watch,
    });
  });

  test("watches the discovery roots, recursively, and the env files' folder alone", () => {
    const roots = [...events.watched].map(([path, e]) => [path, e.recursive] as const);
    expect(new Map(roots)).toEqual(
      new Map([
        [dir, false],
        [join(dir, 'kindgi', 'agents'), true],
        [join(dir, 'kindgi', 'tools'), true],
      ]),
    );
  });

  test('fires for a file a discovery pattern matches, once per burst', async () => {
    await deliver(watched('kindgi/tools'), { filename: 'echo.ts' }, { filename: 'echo.ts' });
    await deliver(watched('kindgi/agents'), { filename: join('nested', 'helper.ts') });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test("ignores the host app's files, the dev index, test files and other files", async () => {
    // The app's `tools/` and `.kindgi/dev/` aren't under a discovery root: never watched.
    expect(events.watched.has(join(dir, 'tools'))).toBe(false);
    expect(events.watched.has(join(dir, '.kindgi', 'dev'))).toBe(false);
    // The pack root is watched for the env files only.
    await deliver(watched(''), { filename: 'package.json' }, { filename: '.env.example' });
    await deliver(watched('kindgi/tools'), { filename: 'echo.test.ts' }, { filename: 'notes.txt' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("fires when a primitive's folder is moved in or out of the pack (an editor's delete)", async () => {
    await deliver(watched('kindgi/tools'), { filename: 'echo' });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("ignores the event for the watched folder's own creation", async () => {
    // macOS names it after the folder, which has no child of that name.
    await deliver(watched('kindgi/tools'), { filename: 'tools' });
    expect(onChange).not.toHaveBeenCalled();
  });

  test('fires for an event without a file name', async () => {
    await deliver(watched('kindgi/agents'), { filename: null });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('fires when an env file is created or edited', async () => {
    await deliver(watched(''), { filename: '.env' });
    await deliver(watched(''), { filename: '.env.local' });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test('a watcher that fails fires once, so the refresh reports it', async () => {
    const failure = Object.assign(new Error('too many open files'), { code: 'EMFILE' });
    await deliver(watched('kindgi/tools'), { error: failure });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('close() stops: a change still in its debounce window never fires', async () => {
    await watched('kindgi/tools').deliver({ filename: 'echo.ts' });
    await handle?.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The real file system
// ---------------------------------------------------------------------------

/**
 * How long to wait for the system to report a change at all. macOS's event
 * daemon can fall far behind on a busy machine, and drops events when it
 * does, so the change is made again every round until one is reported.
 */
const SYSTEM_REPORTS_WITHIN_MS = 30_000;

/** Once the system has reported the change, how long `watchPackReal` may take to pass it on. */
const PASSED_ON_WITHIN_MS = 10_000;

/**
 * Make `change` every round until `onChange` fires, beside a plain
 * `fs.watch` of the same folder that looks for the change's `name`. That
 * one is the control: once the system has reported the change to it,
 * `watchPackReal` must pass it on. When the system reports nothing at all
 * (its event service far behind, as macOS's gets on a busy machine), the
 * test is skipped and says so: that's the machine, not the watcher.
 */
async function untilReported(
  context: { skip(): void },
  watched: { readonly folder: string; readonly recursive: boolean; readonly name: string },
  onChange: Mock,
  change: () => Promise<void>,
): Promise<void> {
  let reportedAt: number | undefined;
  const control = watch(watched.folder, { recursive: watched.recursive }, (_event, filename) => {
    if (filename === watched.name) reportedAt ??= Date.now();
  });
  const giveUpAt = Date.now() + SYSTEM_REPORTS_WITHIN_MS;
  try {
    while (onChange.mock.calls.length === 0) {
      if (reportedAt !== undefined && Date.now() > reportedAt + PASSED_ON_WITHIN_MS) {
        throw new Error(
          `the system reported ${watched.name} ${Date.now() - reportedAt} ms ago; watchPackReal hasn't`,
        );
      }
      if (reportedAt === undefined && Date.now() > giveUpAt) {
        console.warn(
          `skipped: the system reported no change to ${watched.folder} in ${SYSTEM_REPORTS_WITHIN_MS} ms`,
        );
        context.skip();
      }
      await change();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    control.close();
  }
}

describe('watchPackReal on the real file system', { timeout: 60_000 }, () => {
  test('a file written under a discovery root is reported', async (context) => {
    const onChange = vi.fn();
    handle = await watchPackReal(dir, onChange, { debounceMs: DEBOUNCE_MS, patterns: PATTERNS });
    const tools = join(dir, 'kindgi', 'tools');
    await untilReported(
      context,
      { folder: tools, recursive: true, name: 'echo.ts' },
      onChange,
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
    handle = await watchPackReal(dir, onChange, { debounceMs: DEBOUNCE_MS, patterns: PATTERNS });
    let out = false;
    await untilReported(
      context,
      { folder: tools, recursive: true, name: 'echo' },
      onChange,
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
    });
    await untilReported(context, { folder: dir, recursive: false, name: '.env' }, onChange, () =>
      writeFile(join(dir, '.env'), `X=${Date.now()}\n`),
    );
  });
});
