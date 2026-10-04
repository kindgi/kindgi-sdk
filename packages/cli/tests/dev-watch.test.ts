// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `watchPackReal` against the real filesystem: a pack embedded in an
 * app (`kindgi/**`) re-indexes on its own files only — never on the
 * app's files or the dev index the indexer itself writes.
 */

import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Mock, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { watchPackReal } from '../src/dev/defaults.js';
import type { WatchHandle } from '../src/dev/runners.js';

let dir: string;
let handle: WatchHandle | undefined;
const PATTERNS = ['kindgi/tools/**/*.ts', 'kindgi/agents/**/*.ts'];
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** How long a real filesystem event may take to arrive on a loaded machine. */
const EVENT_TIMEOUT_MS = 15_000;

/** How long without events counts as quiet: late or repeated reports arrive within it. */
const QUIET_MS = 1_500;

/**
 * Wait until the watcher is live: write `probe` (a file it watches) until
 * `onChange` fires, wait until no more events arrive (a write can be
 * reported late, or twice), then forget the calls. A fixed sleep after
 * starting the watcher isn't enough on a loaded machine: macOS's event
 * stream can start late, and a write before then is never reported.
 */
async function untilLive(onChange: Mock, probe: string): Promise<void> {
  await vi.waitFor(
    async () => {
      if (onChange.mock.calls.length === 0) await writeFile(probe, `// ${Date.now()}\n`);
      expect(onChange).toHaveBeenCalled();
    },
    { timeout: EVENT_TIMEOUT_MS, interval: 250 },
  );
  const quietBy = Date.now() + EVENT_TIMEOUT_MS;
  for (let seen = -1; seen !== onChange.mock.calls.length && Date.now() < quietBy; ) {
    seen = onChange.mock.calls.length;
    await settle(QUIET_MS);
  }
  onChange.mockClear();
}

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
  await rm(dir, { recursive: true, force: true });
});

describe('watchPackReal', () => {
  test('fires for a file a discovery pattern matches', async () => {
    const onChange = vi.fn();
    handle = await watchPackReal(dir, onChange, { debounceMs: 20, patterns: PATTERNS });
    await untilLive(onChange, join(dir, 'kindgi', 'agents', 'probe.ts'));
    await writeFile(join(dir, 'kindgi', 'tools', 'echo.ts'), 'export default {};\n');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: EVENT_TIMEOUT_MS });
  });

  test("ignores the host app's files, the dev index, and test files", async () => {
    const onChange = vi.fn();
    handle = await watchPackReal(dir, onChange, { debounceMs: 20, patterns: PATTERNS });
    await untilLive(onChange, join(dir, 'kindgi', 'agents', 'probe.ts'));
    await writeFile(join(dir, 'tools', 'app-script.ts'), '// app\n');
    await writeFile(join(dir, '.kindgi', 'dev', 'index.json'), '{}\n');
    await writeFile(join(dir, 'kindgi', 'tools', 'echo.test.ts'), '// test\n');
    await writeFile(join(dir, 'kindgi', 'tools', 'notes.txt'), 'not a primitive\n');
    await settle(600);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("fires when a primitive's folder is moved out of the pack (an editor's delete)", async () => {
    await mkdir(join(dir, 'kindgi', 'tools', 'echo'), { recursive: true });
    await writeFile(join(dir, 'kindgi', 'tools', 'echo', 'index.ts'), 'export default {};\n');
    const onChange = vi.fn();
    handle = await watchPackReal(dir, onChange, { debounceMs: 20, patterns: PATTERNS });
    await untilLive(onChange, join(dir, 'kindgi', 'agents', 'probe.ts'));
    await rename(join(dir, 'kindgi', 'tools', 'echo'), join(dir, 'trashed-echo'));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: EVENT_TIMEOUT_MS });
  });

  test('fires when an env file is created or edited, not for other root files', async () => {
    const onChange = vi.fn();
    handle = await watchPackReal(dir, onChange, {
      debounceMs: 20,
      patterns: PATTERNS,
      files: [join(dir, '.env'), join(dir, '.env.local')],
    });
    await untilLive(onChange, join(dir, '.env.local'));
    await writeFile(join(dir, 'package.json'), '{}\n');
    await writeFile(join(dir, '.env.example'), 'X=1\n');
    await settle(400);
    expect(onChange).not.toHaveBeenCalled();
    await writeFile(join(dir, '.env'), 'DATABASE_URL=postgres://x\n');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: EVENT_TIMEOUT_MS });
  });

  test('close() stops further events', async () => {
    const onChange = vi.fn();
    handle = await watchPackReal(dir, onChange, { debounceMs: 20, patterns: PATTERNS });
    await handle.close();
    await writeFile(join(dir, 'kindgi', 'agents', 'a.ts'), 'export default {};\n');
    await settle(300);
    expect(onChange).not.toHaveBeenCalled();
  });
});
