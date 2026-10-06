// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { EventEmitter } from 'node:events';

import { describe, expect, test, vi } from 'vitest';

import { REPEAT_SIGNAL_WINDOW_MS, createStopSignal } from '../src/stop-signal.js';
import type { StopSignalClock } from '../src/stop-signal.js';

/** A clock the test moves: time, and the event loop's turns. */
function fakeClock(): StopSignalClock & { advance(ms: number): void; turn(): void } {
  let now = 1_000;
  let queued: (() => void)[] = [];
  return {
    now: () => now,
    nextTurn: (fn) => {
      queued.push(fn);
    },
    advance(ms) {
      now += ms;
    },
    turn() {
      const due = queued;
      queued = [];
      for (const fn of due) fn();
    },
  };
}

describe('createStopSignal', () => {
  test('first signal aborts; the listener stays registered so signal-exit does not re-kill', () => {
    const proc = new EventEmitter();
    const exit = vi.fn();
    const signal = createStopSignal(proc as never, exit);
    // signal-exit v3's check, registered after ours: re-raise when it is
    // the only listener left.
    let reRaised = false;
    proc.on('SIGINT', () => {
      if (proc.listeners('SIGINT').length === 1) reRaised = true;
    });
    proc.emit('SIGINT');
    expect(signal.aborted).toBe(true);
    expect(reRaised).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  test('a second Ctrl+C forces exit 130', () => {
    const proc = new EventEmitter();
    const exit = vi.fn();
    const clock = fakeClock();
    createStopSignal(proc as never, exit, clock);
    proc.emit('SIGTERM');
    clock.turn();
    clock.turn();
    clock.advance(REPEAT_SIGNAL_WINDOW_MS);
    proc.emit('SIGINT');
    expect(exit).toHaveBeenCalledWith(130);
  });

  test('a signal that comes with the first is the same Ctrl+C, forwarded by a wrapper', () => {
    const proc = new EventEmitter();
    const exit = vi.fn();
    const clock = fakeClock();
    const signal = createStopSignal(proc as never, exit, clock);
    // The terminal signals the process group; `npx` forwards it too.
    proc.emit('SIGINT');
    clock.advance(5);
    proc.emit('SIGINT');
    expect(signal.aborted).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });

  test('one handled late because the stop held the event loop is still the same Ctrl+C', () => {
    const proc = new EventEmitter();
    const exit = vi.fn();
    const clock = fakeClock();
    createStopSignal(proc as never, exit, clock);
    proc.emit('SIGINT');
    // Closing a recursive watcher on macOS held the loop past the window;
    // the forwarded signal, here since, is read on the next turn.
    clock.advance(1_500);
    clock.turn();
    proc.emit('SIGINT');
    expect(exit).not.toHaveBeenCalled();
    // Once the loop has turned again, Ctrl+C forces the exit.
    clock.turn();
    proc.emit('SIGINT');
    expect(exit).toHaveBeenCalledWith(130);
  });

  test("a SIGTERM never forces the exit: it asks for the stop that's under way", () => {
    const proc = new EventEmitter();
    const exit = vi.fn();
    const clock = fakeClock();
    createStopSignal(proc as never, exit, clock);
    // `pnpm exec` SIGTERMs its child on Ctrl+C, then exits at once.
    proc.emit('SIGINT');
    proc.emit('SIGTERM');
    clock.turn();
    clock.turn();
    clock.advance(10_000);
    proc.emit('SIGTERM');
    expect(exit).not.toHaveBeenCalled();
  });
});
