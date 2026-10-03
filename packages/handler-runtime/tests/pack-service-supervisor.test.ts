// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The supervisor with the real pack-service entrypoint as its child,
 * called through its front: the environment boundary, restarts that swap
 * code behind one address, a failed boot that keeps the old child, crash
 * recovery, pack output, the front's token and probes, an in-flight call
 * that finishes on the old child, and cancellation.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import { createPackServiceSupervisor } from '../src/pack-service/index.js';
import type {
  PackServiceSupervisor,
  PackServiceSupervisorEvent,
} from '../src/pack-service/index.js';
import { PACK_HEADERS, PACK_PROTOCOL_VERSION } from '../src/protocol.js';

/** vitest has no `import.meta.resolve`; ask Node, from this package (needs the build). */
function resolveEntrypoint(): string {
  const url = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "process.stdout.write(import.meta.resolve('@kindgi/handler-runtime/pack-service-main'))",
    ],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' },
  );
  return fileURLToPath(url);
}

const open = { type: 'object', additionalProperties: true };
let dir: string;
let entrypoint: string;
const supervisors: PackServiceSupervisor[] = [];

async function writePack(modules: Record<string, string>, name = 'index.json'): Promise<string> {
  for (const [file, body] of Object.entries(modules))
    await writeFile(join(dir, file), body, 'utf8');
  const index = {
    v: 1,
    packId: 'local',
    packVersion: '0.1.0',
    artifactVersion: '20260930.1',
    publishedAt: '2026-09-30T00:00:00.000Z',
    tools: Object.keys(modules).map((file) => ({
      id: `local.${file.replace(/\.mjs$/, '')}`,
      version: '1.0.0',
      input: open,
      output: open,
      modulePath: file,
    })),
    guardrails: [],
    agents: [],
    flows: [],
  };
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(index), 'utf8');
  return path;
}

interface Running {
  readonly supervisor: PackServiceSupervisor;
  readonly url: string;
}

async function supervisor(
  env: Record<string, string> = {},
  events: PackServiceSupervisorEvent[] = [],
  logs: string[] = [],
): Promise<Running> {
  const s = createPackServiceSupervisor({
    command: [process.execPath, entrypoint],
    moduleRoot: dir,
    env: async () => ({ PATH: process.env.PATH ?? '', ...env }),
    onEvent: (e) => events.push(e),
    onLog: (line, stream) => logs.push(`${stream}: ${line}`),
    restartDelayMs: 50,
  });
  supervisors.push(s);
  const { url } = await s.listen();
  return { supervisor: s, url };
}

function invoke(
  running: Running,
  tool: string,
  init: { readonly token?: string; readonly signal?: AbortSignal } = {},
): Promise<Response> {
  return fetch(`${running.url}/v1/invoke`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [PACK_HEADERS.token]: init.token ?? running.supervisor.token,
      [PACK_HEADERS.runId]: 'run-1',
    },
    body: JSON.stringify({
      v: PACK_PROTOCOL_VERSION,
      kind: 'invoke',
      tool: { id: `local.${tool}` },
      input: {},
      ctx: { tenantId: 't-1', runId: 'run-1' },
    }),
    ...(init.signal !== undefined && { signal: init.signal }),
  });
}

async function output(running: Running, tool: string): Promise<unknown> {
  const res = await invoke(running, tool);
  const body = (await res.json()) as { kind?: string; output?: unknown };
  if (res.status !== 200 || body.kind !== 'result') {
    throw new Error(`${res.status} ${JSON.stringify(body)}`);
  }
  return body.output;
}

const PID_TOOL = 'export async function handler() { return { pid: process.pid }; }';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pack-service-supervisor-'));
  entrypoint = resolveEntrypoint();
});

afterEach(async () => {
  for (const s of supervisors.splice(0)) await s.close();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('createPackServiceSupervisor — children', () => {
  test('pack code sees exactly the environment it is given — not the service token', async () => {
    process.env.PARENT_SENTINEL = 'must-not-leak';
    try {
      const index = await writePack({
        'env.mjs':
          'export async function handler() { return { names: Object.keys(process.env).sort() }; }',
      });
      const running = await supervisor({ DATABASE_URL: 'postgres://pack-db' });
      expect((await running.supervisor.start(index)).kind).toBe('ok');
      const { names } = (await output(running, 'env')) as { names: string[] };
      expect(names).toContain('DATABASE_URL');
      expect(names).not.toContain('PARENT_SENTINEL');
      // The token authenticates the service's callers; the service takes
      // it out of the environment before it loads the pack's code.
      expect(names.filter((n) => n.startsWith('KINDGI_'))).toEqual([]);
    } finally {
      Reflect.deleteProperty(process.env, 'PARENT_SENTINEL');
    }
  });

  test('start again swaps in the new code behind the same address, and the old child stops', async () => {
    const events: PackServiceSupervisorEvent[] = [];
    const index = await writePack({
      'version.mjs': 'export async function handler() { return { v: 1, pid: process.pid }; }',
    });
    const running = await supervisor({}, events);
    await running.supervisor.start(index);
    const first = (await output(running, 'version')) as { v: number; pid: number };
    expect(first.v).toBe(1);

    await writePack({
      'version.mjs': 'export async function handler() { return { v: 2, pid: process.pid }; }',
    });
    expect((await running.supervisor.start(index)).kind).toBe('ok');
    const second = (await output(running, 'version')) as { v: number; pid: number };
    expect(second.v).toBe(2);
    expect(second.pid).not.toBe(first.pid);
    expect(alive(first.pid)).toBe(false);
    expect((await running.supervisor.listen()).url).toBe(running.url);
    const started = events.filter((e) => e.kind === 'started');
    expect(started).toHaveLength(2);
  });

  test('a failed boot keeps the running child serving', async () => {
    const good = await writePack({ 'pid.mjs': PID_TOOL });
    const running = await supervisor();
    await running.supervisor.start(good);
    const before = (await output(running, 'pid')) as { pid: number };

    const bad = await writePack(
      { 'pid.mjs': PID_TOOL, 'broken.mjs': 'export async function handler( {' },
      'bad-index.json',
    );
    const failed = await running.supervisor.start(bad);
    expect(failed.kind).toBe('err');
    expect(failed.kind === 'err' && failed.error.problems.join(' ')).toMatch(/local\.broken/);

    expect(await output(running, 'pid')).toEqual(before);
  });

  test('a child that crashes is restarted', async () => {
    const events: PackServiceSupervisorEvent[] = [];
    const index = await writePack({
      'crash.mjs': 'export async function handler() { process.exit(3); }',
      'pid.mjs': PID_TOOL,
    });
    const running = await supervisor({}, events);
    await running.supervisor.start(index);
    const before = (await output(running, 'pid')) as { pid: number };

    // Delivered, then the child died: the front says so (502), not "retry".
    const crashed = await invoke(running, 'crash');
    expect(crashed.status).toBe(502);
    await until(() => events.filter((e) => e.kind === 'started').length === 2);
    const after = (await output(running, 'pid')) as { pid: number };
    expect(after.pid).not.toBe(before.pid);
    expect(events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['exited', 'restarting', 'started']),
    );
  });

  test("pack code's output reaches onLog; the service's own lines arrive as events", async () => {
    const events: PackServiceSupervisorEvent[] = [];
    const logs: string[] = [];
    const index = await writePack({
      'noisy.mjs':
        "export async function handler() { console.log('hello from a tool'); console.error('and stderr'); return {}; }",
    });
    const running = await supervisor({}, events, logs);
    await running.supervisor.start(index);
    await output(running, 'noisy');
    await until(() => logs.length >= 2);
    expect(logs).toEqual(
      expect.arrayContaining(['stdout: hello from a tool', 'stderr: and stderr']),
    );
    await until(() => events.some((e) => e.kind === 'log'));
    expect(events.find((e) => e.kind === 'log')).toMatchObject({ event: { kind: 'call' } });
  });
});

describe('createPackServiceSupervisor — the front', () => {
  test('answers 503 with Retry-After while no child serves; probes need no token', async () => {
    const running = await supervisor();
    const res = await invoke(running, 'pid');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect((await fetch(`${running.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${running.url}/readyz`)).status).toBe(503);

    await running.supervisor.start(await writePack({ 'pid.mjs': PID_TOOL }));
    expect((await fetch(`${running.url}/readyz`)).status).toBe(200);
  });

  test('rejects a missing or wrong token; forwards /v1/info', async () => {
    const running = await supervisor();
    await running.supervisor.start(await writePack({ 'pid.mjs': PID_TOOL }));
    expect((await invoke(running, 'pid', { token: 'not-the-token' })).status).toBe(401);
    expect((await fetch(`${running.url}/v1/info`)).status).toBe(401);
    const info = await fetch(`${running.url}/v1/info`, {
      headers: { [PACK_HEADERS.token]: running.supervisor.token },
    });
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ packId: 'local' });
  });

  test("a supervisor given the previous one's token and port answers the same caller", async () => {
    const first = await supervisor();
    await first.supervisor.start(await writePack({ 'pid.mjs': PID_TOOL }));
    const { port } = await first.supervisor.listen();
    const token = first.supervisor.token;
    await first.supervisor.close();

    const again = createPackServiceSupervisor({
      command: [process.execPath, entrypoint],
      moduleRoot: dir,
      env: async () => ({ PATH: process.env.PATH ?? '' }),
      port,
      token,
    });
    supervisors.push(again);
    const { url } = await again.listen();
    expect(url).toBe(first.url);
    expect(again.token).toBe(token);
    await again.start(await writePack({ 'pid.mjs': PID_TOOL }));
    expect((await invoke({ supervisor: again, url }, 'pid', { token })).status).toBe(200);
  });

  test('a token that is too short or not URL-safe is refused', () => {
    for (const token of ['short', `${'a'.repeat(31)}`, `${'a'.repeat(40)}+/`]) {
      expect(() =>
        createPackServiceSupervisor({
          command: [process.execPath, entrypoint],
          moduleRoot: dir,
          env: async () => ({}),
          token,
        }),
      ).toThrow('at least 32 URL-safe base64 characters');
    }
  });

  test('listens on loopback by default', async () => {
    const running = await supervisor();
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('a call in flight during a swap finishes on the old child', async () => {
    const index = await writePack({
      'slow.mjs':
        'export async function handler() { await new Promise((r) => setTimeout(r, 400)); return { v: 1 }; }',
    });
    const running = await supervisor();
    await running.supervisor.start(index);
    const inFlight = output(running, 'slow');
    await new Promise((r) => setTimeout(r, 100));

    await writePack({ 'slow.mjs': 'export async function handler() { return { v: 2 }; }' });
    expect((await running.supervisor.start(index)).kind).toBe('ok');

    expect(await inFlight).toEqual({ v: 1 });
    expect(await output(running, 'slow')).toEqual({ v: 2 });
  });

  test("a long call during a swap is not cut off: the kill waits past the child's drain", async () => {
    const index = await writePack({
      'long.mjs':
        'export async function handler() { await new Promise((r) => setTimeout(r, 6000)); return { v: 1 }; }',
    });
    const running = await supervisor();
    await running.supervisor.start(index);
    const inFlight = invoke(running, 'long');
    await new Promise((r) => setTimeout(r, 200));

    await writePack({ 'long.mjs': 'export async function handler() { return { v: 2 }; }' });
    expect((await running.supervisor.start(index)).kind).toBe('ok');

    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: 'result', output: { v: 1 } });
  }, 15_000);

  test('a caller that disconnects cancels the call in the child', async () => {
    const events: PackServiceSupervisorEvent[] = [];
    const index = await writePack({
      'wait.mjs':
        'export async function handler(_input, ctx) { await new Promise((r) => { const t = setTimeout(r, 5000); ctx.abortSignal?.addEventListener("abort", () => { clearTimeout(t); r(); }); }); return {}; }',
    });
    const running = await supervisor({}, events);
    await running.supervisor.start(index);
    const controller = new AbortController();
    const call = invoke(running, 'wait', { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    await expect(call).rejects.toThrow();
    await until(() =>
      events.some(
        (e) => e.kind === 'log' && e.event.kind === 'call' && e.event.outcome === 'cancelled',
      ),
    );
    // The child the caller left behind stops at once, not after a stale connection times out.
    const stopping = Date.now();
    await running.supervisor.stop();
    expect(Date.now() - stopping).toBeLessThan(1500);
  });

  test('after stop the front answers 503; after close it is gone', async () => {
    const running = await supervisor();
    await running.supervisor.start(await writePack({ 'pid.mjs': PID_TOOL }));
    const { pid } = (await output(running, 'pid')) as { pid: number };
    await running.supervisor.stop();
    expect(alive(pid)).toBe(false);
    expect((await invoke(running, 'pid')).status).toBe(503);

    await running.supervisor.close();
    await expect(invoke(running, 'pid')).rejects.toThrow();
  });
});

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
