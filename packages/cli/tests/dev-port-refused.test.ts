// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The runtime port's check when `127.0.0.1` refuses this process any port
 * (`listen EPERM`, as a sandbox does): it says so, rather than calling
 * every port taken. `node:net` stands in for such a system.
 */

import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, test, vi } from 'vitest';

const refusal = vi.hoisted(() => ({ code: 'EPERM' }));

vi.mock('node:net', () => {
  const fail = (emitter: EventEmitter, syscall: string) =>
    queueMicrotask(() =>
      emitter.emit(
        'error',
        Object.assign(new Error(`${syscall} ${refusal.code}`), { code: refusal.code, syscall }),
      ),
    );
  return {
    connect: () => {
      const socket = Object.assign(new EventEmitter(), {
        setTimeout: () => undefined,
        destroy: () => undefined,
      });
      fail(socket, 'connect');
      return socket;
    },
    createServer: () => {
      const server = Object.assign(new EventEmitter(), {
        listen: () => fail(server, 'listen'),
        close: (done: () => void) => done(),
      });
      return server;
    },
  };
});

const { LocalPortsRefused } = await import('../src/dev/blocked.js');
const { portInUse } = await import('../src/dev/port.js');

afterEach(() => {
  refusal.code = 'EPERM';
});

describe('portInUse, where no port can be had', () => {
  test('listen EPERM: refused, not taken', async () => {
    await expect(portInUse(4000)).rejects.toEqual(new LocalPortsRefused(4000, 'EPERM'));
  });

  test('a port that is only taken still reads as taken', async () => {
    refusal.code = 'EADDRINUSE';
    await expect(portInUse(4000)).resolves.toBe(true);
  });
});
