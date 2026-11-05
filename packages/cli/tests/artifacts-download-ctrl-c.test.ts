// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi artifacts download` and a real Ctrl+C: one SIGINT to the built
 * CLI, part way through a download that's still coming, ends it at once,
 * with exit 130, no file and no partial, and the connection closed. A
 * download that didn't watch the stop went on until a second Ctrl+C
 * forced the exit. Needs the build (it runs the built CLI).
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, expect, test } from 'vitest';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

let cwd: string;
let home: string;
let server: Server | undefined;
let child: ChildProcess | undefined;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-download-ctrl-c-'));
  home = await mkdtemp(join(tmpdir(), 'kindgi-download-ctrl-c-home-'));
});
// Even after a timeout: the CLI is ended, and the server with it.
afterEach(async () => {
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  child = undefined;
  server?.closeAllConnections();
  server?.close();
  server = undefined;
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test('one SIGINT ends a download part way: exit 130, no file, the connection closed', async () => {
  let sent: () => void = () => {};
  const firstChunk = new Promise<void>((resolve) => {
    sent = resolve;
  });
  let closed: () => void = () => {};
  const connectionClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  // Headers for a whole MiB, three bytes of it, then nothing more.
  server = createServer((req, res) => {
    req.socket.on('close', () => closed());
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': String(1024 * 1024),
      'X-Kindgi-Blob-Name': 'report.pdf',
      'X-Kindgi-Blob-Hash': 'a'.repeat(64),
    });
    res.write('hel', () => sent());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const cli = spawn(
    process.execPath,
    [CLI, 'artifacts', 'download', 'b-1', `--url=http://127.0.0.1:${port}`, '--token=t'],
    { cwd, env: { PATH: process.env.PATH ?? '', HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child = cli;
  let stderr = '';
  cli.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = once(cli, 'exit');
  await firstChunk;
  cli.kill('SIGINT');
  const [code] = (await exited) as [number | null];
  expect(code, stderr).toBe(130);
  expect(stderr).toContain('kindgi artifacts download stopped: no file was written.');
  await connectionClosed;
  expect(await readdir(cwd)).toEqual([]);
});
