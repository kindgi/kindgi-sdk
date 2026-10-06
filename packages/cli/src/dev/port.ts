// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The runtime's port on `127.0.0.1`, checked before `kindgi dev` starts
 * anything: a second `kindgi dev` (another worktree), or anything else
 * already on the port, would otherwise fail only once the runtime's
 * container starts, after the database and the bundle.
 */

import { connect, createServer } from 'node:net';

import { docker, runtimeContainerName } from './runtime-container.js';

const HOST = '127.0.0.1';

/**
 * How many ports from the default one `kindgi dev` tries before asking
 * for `--port`.
 */
export const PORT_SEARCH_SPAN = 100;

/**
 * Whether something holds `port` on `127.0.0.1`: it accepts a connection
 * (a listener on any address, Docker's published ports included), or the
 * port can't be bound.
 */
export async function portInUse(port: number): Promise<boolean> {
  return (await accepts(port)) || !(await canListen(port));
}

function accepts(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port });
    const done = (accepted: boolean) => {
      socket.destroy();
      resolve(accepted);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: HOST, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * The first port from `from` up (`PORT_SEARCH_SPAN` of them) that
 * `inUse` says is free, or `undefined`.
 */
export async function firstFreePort(
  from: number,
  inUse: (port: number) => Promise<boolean>,
): Promise<number | undefined> {
  for (let port = from; port < from + PORT_SEARCH_SPAN && port <= 65535; port += 1) {
    if (!(await inUse(port))) return port;
  }
  return undefined;
}

/**
 * {@link portInUse} for the runtime of the pack at `packDir`. This pack's
 * runtime container from an earlier boot (a crashed session) is removed
 * first: starting the runtime replaces it anyway, so the port it holds
 * is this boot's.
 */
export async function runtimePortInUseReal(input: {
  readonly packDir: string;
  readonly port: number;
}): Promise<boolean> {
  await docker(['rm', '--force', runtimeContainerName(input.packDir)]);
  return portInUse(input.port);
}
