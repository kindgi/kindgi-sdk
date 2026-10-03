// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { EventEmitter } from 'node:events';

import { describe, expect, test, vi } from 'vitest';

import { createStopSignal } from '../src/stop-signal.js';

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

  test('a second signal forces exit 130', () => {
    const proc = new EventEmitter();
    const exit = vi.fn();
    createStopSignal(proc as never, exit);
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    expect(exit).toHaveBeenCalledWith(130);
  });
});
