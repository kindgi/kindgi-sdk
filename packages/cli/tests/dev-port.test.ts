// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * T218: the runtime's port is checked with real sockets: taken when
 * something listens on it, on `127.0.0.1` or on every address.
 */

import { type Server, createServer } from 'node:net';

import { afterEach, describe, expect, test } from 'vitest';

import { PORT_SEARCH_SPAN, firstFreePort, portInUse } from '../src/dev/port.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

/** A listener on `host`, on a port the OS picks; its port. */
async function listening(host: string): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen({ host, port: 0 }, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

/** A port nothing listens on: one the OS gave, then released. */
async function released(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

describe('portInUse (T218)', () => {
  test('a listener on 127.0.0.1: in use', async () => {
    expect(await portInUse(await listening('127.0.0.1'))).toBe(true);
  });

  test('a listener on every address: in use', async () => {
    expect(await portInUse(await listening('0.0.0.0'))).toBe(true);
  });

  test('nothing on it: free', async () => {
    expect(await portInUse(await released())).toBe(false);
  });
});

describe('firstFreePort (T218)', () => {
  test('the first port the check says is free, from the one given', async () => {
    const taken = new Set([5000, 5001, 5003]);
    expect(await firstFreePort(5000, async (p) => taken.has(p))).toBe(5002);
  });

  test(`none of ${PORT_SEARCH_SPAN} free: undefined`, async () => {
    expect(await firstFreePort(5000, async () => true)).toBeUndefined();
  });

  test('never past 65535', async () => {
    const asked: number[] = [];
    expect(
      await firstFreePort(65534, async (p) => {
        asked.push(p);
        return true;
      }),
    ).toBeUndefined();
    expect(asked).toEqual([65534, 65535]);
  });
});
