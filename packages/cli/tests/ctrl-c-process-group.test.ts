// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A terminal's Ctrl+C, for real: SIGINT to the whole foreground process
 * group (`kindgi dev`, its pack child, and the package manager that may
 * wrap it), plus what the wrapper sends on. One clean stop: no forced
 * exit (that left the runtime's container running), no pack child
 * restarted mid-shutdown. Needs the build (the stand-in runs the built CLI).
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const STAND_IN = fileURLToPath(new URL('./fixtures/ctrl-c-dev.mjs', import.meta.url));
const WRAPPER = fileURLToPath(new URL('./fixtures/ctrl-c-wrapper.mjs', import.meta.url));
const open = { type: 'object', additionalProperties: true };

let dir: string;
let indexPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ctrl-c-dev-'));
  await writeFile(
    join(dir, 'pid.mjs'),
    'export async function handler() { return { pid: process.pid }; }',
    'utf8',
  );
  indexPath = join(dir, 'index.json');
  const index = {
    v: 1,
    packId: 'local',
    packVersion: '0.1.0',
    artifactVersion: '20261006.1',
    publishedAt: '2026-10-06T00:00:00.000Z',
    tools: [
      { id: 'local.pid', version: '1.0.0', input: open, output: open, modulePath: 'pid.mjs' },
    ],
    guardrails: [],
    agents: [],
    flows: [],
  };
  await writeFile(indexPath, JSON.stringify(index), 'utf8');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Line {
  readonly kind: string;
  readonly [key: string]: unknown;
}

async function lines(report: string): Promise<Line[]> {
  const text = await readFile(report, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Line);
}

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`not within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const WRAPPERS = [
  { name: 'run directly', wrap: [] },
  { name: 'under a wrapper that forwards SIGINT (npx, pnpm run)', wrap: [WRAPPER, 'forward'] },
  { name: 'under a wrapper that SIGTERMs it and exits (pnpm exec)', wrap: [WRAPPER, 'exec'] },
] as const;

describe.skipIf(process.platform === 'win32')('Ctrl+C in a terminal', () => {
  test.each(WRAPPERS)('$name: one clean stop', async ({ name, wrap }) => {
    const report = join(dir, `${name.split(' ').join('-')}.jsonl`);
    const args = [...wrap, ...(wrap.length > 0 ? [process.execPath] : [])];
    // `detached`: its own process group, as a terminal's foreground job.
    const group = spawn(process.execPath, [...args, STAND_IN, dir, indexPath, report], {
      detached: true,
      stdio: 'ignore',
    });
    const ready = await until(async () => (await lines(report)).find((l) => l.kind === 'ready'));
    const { pid, packPid } = ready as Line & { pid: number; packPid: number };

    process.kill(-(group.pid as number), 'SIGINT');
    await until(async () => (alive(pid) ? undefined : true));

    const after = await lines(report);
    expect(after.slice(after.findIndex((l) => l.kind === 'ready') + 1)).toEqual([
      { kind: 'stopping' },
      { kind: 'stopped' },
      { kind: 'exit', code: 0 },
    ]);
    expect(alive(packPid)).toBe(false);
  });
});
