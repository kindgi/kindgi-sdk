// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `untilReported`'s control (./fs-events.ts), with a scripted `fs.watch`: a
 * folder removed while it read it is no failure, and any other error on it
 * fails the test, so a broken control never passes as a slow machine.
 */

import { describe, expect, test, vi } from 'vitest';

import { untilReported } from './fs-events.js';
import { type ScriptedWatcher, removedWhileRead, watchLimitReached } from './scripted-watch.js';

/** Each control `untilReported` opens, newest last. */
const controls = vi.hoisted(() => [] as ScriptedWatcher[]);

vi.mock('node:fs', async (importOriginal) => {
  const { ScriptedWatcher } = await import('./scripted-watch.js');
  return {
    ...(await importOriginal<typeof import('node:fs')>()),
    watch: (_folder: string, _options: unknown, listener: (...args: unknown[]) => void) => {
      const control = new ScriptedWatcher();
      control.on('change', listener);
      controls.push(control);
      return control;
    },
  };
});

/** A test context whose skip ends the test, as vitest's does. */
const context = () => ({
  skip: vi.fn((): never => {
    throw new Error('skipped');
  }),
});

const watched = { folder: 'pack', recursive: true, name: 'a.py' } as const;

describe('untilReported', () => {
  test('a control that fails fails the test, rather than skipping it', async () => {
    const { skip } = context();
    const until = untilReported(
      { skip },
      watched,
      () => false,
      async () => {
        controls.at(-1)?.emit('error', watchLimitReached('pack/tools'));
      },
    );
    await expect(until).rejects.toThrow(
      "the control watch failed: ENOSPC: System limit for number of file watchers reached, watch 'pack/tools'",
    );
    expect(skip).not.toHaveBeenCalled();
    expect(controls.at(-1)?.closed).toBe(true);
  });

  test('a folder removed while the control read it is no failure', async () => {
    const { skip } = context();
    let passedOn = false;
    let round = 0;
    await untilReported(
      { skip },
      watched,
      () => passedOn,
      async () => {
        const control = controls.at(-1);
        // The error in a round of its own, so that the next one looks at it.
        if (round++ === 0) {
          control?.emit('error', removedWhileRead('pack/tools'));
        } else {
          control?.emit('change', 'rename', 'a.py');
          passedOn = true;
        }
      },
    );
    expect(round).toBe(2);
    expect(skip).not.toHaveBeenCalled();
    expect(controls.at(-1)?.closed).toBe(true);
  });
});
