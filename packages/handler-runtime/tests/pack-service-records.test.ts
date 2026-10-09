// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The pack service's records (`@kindgi/log`, subsystem `pack`): the
 * lifecycle whatever the levels, a record per call with the call's ids and
 * the caller's trace, the handler's `ctx.log` beneath it, and a context
 * that never prints its secrets.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type { Index } from '../src/kindgi-index.js';
import { type RunningPackService, startPackService } from '../src/pack-service/main.js';
import { packServiceLogs } from '../src/pack-service/records.js';
import { PACK_PROTOCOL_VERSION } from '../src/protocol.js';

const TOKEN = 'pack-token';
const SECRET = 's3cret-value-for-acme';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_SPAN = '00f067aa0ba902b7';

const object = (props: Record<string, unknown>) => ({
  type: 'object',
  properties: props,
  additionalProperties: true,
});

const MODULES: Record<string, string> = {
  // Logs through ctx.log, and reports what spreading and serializing its
  // context show, and whether it can still read its secret.
  'tools/logs.mjs': `export async function handler(input, ctx) {
    ctx.log.info('looked up order', { orderId: input.orderId });
    return {
      spread: Object.keys({ ...ctx }).sort(),
      json: Object.keys(JSON.parse(JSON.stringify(ctx))).sort(),
      hasSecret: ctx.secrets?.API_KEY === '${SECRET}',
      hasLog: typeof ctx.log?.info === 'function',
    };
  }`,
};

const INDEX = {
  v: 1,
  packId: 'acme',
  packVersion: '0.1.0',
  artifactVersion: '20261008.1',
  publishedAt: '2026-10-08T00:00:00.000Z',
  tools: [
    {
      id: 'acme.logs',
      version: '1.0.0',
      input: object({ orderId: { type: 'string' } }),
      output: object({}),
      modulePath: 'tools/logs.mjs',
    },
  ],
  guardrails: [],
  agents: [],
  flows: [],
} as unknown as Index;

let dir: string;
let running: RunningPackService;
const lines: string[] = [];
const records = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-pack-records-'));
  for (const [rel, body] of Object.entries(MODULES)) {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), body, 'utf8');
  }
  const indexPath = join(dir, 'index.json');
  await writeFile(indexPath, JSON.stringify(INDEX), 'utf8');
  const built = packServiceLogs({
    env: { KINDGI_LOG_LEVEL: 'debug' },
    write: (line) => lines.push(line),
  });
  if (built.kind === 'err') throw new Error(built.message);
  const started = await startPackService(
    { indexPath, moduleRoot: dir, token: TOKEN, port: 0 },
    built.logs,
  );
  if (started.kind === 'err') throw new Error(started.problems.join('; '));
  running = started.value;
});

afterAll(async () => {
  await running?.stop(1000);
  await rm(dir, { recursive: true, force: true });
});

async function invokeLogs(): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${running.port}/v1/invoke`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'kindgi-pack-token': TOKEN,
      traceparent: `00-${TRACE_ID}-${PARENT_SPAN}-01`,
    },
    body: JSON.stringify({
      v: PACK_PROTOCOL_VERSION,
      kind: 'invoke',
      tool: { id: 'acme.logs' },
      input: { orderId: 'o-42' },
      ctx: {
        tenantId: 't-1',
        runId: 'run-1',
        requestId: 'call-1',
        secrets: { API_KEY: SECRET },
      },
    }),
  });
  const body = (await res.json()) as { output: Record<string, unknown> };
  return body.output;
}

describe('pack service records', () => {
  test('listening: a record whatever the levels, with the port; `kind` too, for an older supervisor', () => {
    const listening = records().find((r) => r.event === 'listening');
    expect(listening).toMatchObject({
      level: 'info',
      severity: 'INFO',
      subsystem: 'pack',
      kind: 'listening',
      port: running.port,
      packId: 'acme',
      artifactVersion: '20261008.1',
    });
    expect(typeof listening?.time).toBe('string');
  });

  test("a call: one record with the call's ids and the caller's trace; ctx.log beneath it", async () => {
    lines.length = 0;
    const output = await invokeLogs();
    expect(output.hasLog).toBe(true);
    const call = records().find((r) => r.event === 'call');
    expect(call).toMatchObject({
      level: 'info',
      subsystem: 'pack',
      kind: 'call',
      tenantId: 't-1',
      runId: 'run-1',
      requestId: 'call-1',
      traceId: TRACE_ID,
      target: 'tool',
      toolId: 'acme.logs',
      outcome: 'ok',
      packId: 'acme',
    });
    // This call's own span, whose parent is the caller's.
    expect(call?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(call?.spanId).not.toBe(PARENT_SPAN);
    expect(call?.message).toMatch(/^tool acme\.logs ok \d+ms$/);

    const authored = records().find((r) => r.message === 'looked up order');
    expect(authored).toMatchObject({
      level: 'info',
      subsystem: 'pack.tool',
      orderId: 'o-42',
      tenantId: 't-1',
      runId: 'run-1',
      traceId: TRACE_ID,
      toolId: 'acme.logs',
    });
    expect(authored).not.toHaveProperty('event');
  });

  test('the context never shows its secrets: not spread, not serialized, not logged; the handler still reads them', async () => {
    lines.length = 0;
    const output = await invokeLogs();
    expect(output.hasSecret).toBe(true);
    expect(output.spread).not.toContain('secrets');
    expect(output.json).not.toContain('secrets');
    expect(output.spread).not.toContain('log');
    expect(output.spread).toEqual(expect.arrayContaining(['tenantId', 'runId', 'abortSignal']));
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});

describe('the pack service logs', () => {
  test("the lifecycle is written at any level; the calls' records follow KINDGI_LOG_LEVEL", () => {
    const out: string[] = [];
    const built = packServiceLogs({
      env: { KINDGI_LOG_LEVEL: 'error' },
      write: (l) => out.push(l),
    });
    if (built.kind === 'err') throw new Error(built.message);
    built.logs.log.info('a call', { event: 'call', kind: 'call' });
    built.logs.event('listening', 'Listening on port 1', { port: 1 });
    expect(out.map((l) => JSON.parse(l).event)).toEqual(['listening']);
  });

  test('JSON for a supervisor, even in dev mode; pretty only on a terminal', () => {
    const out: string[] = [];
    const dev = packServiceLogs({ env: { KINDGI_DEV: 'true' }, write: (l) => out.push(l) });
    if (dev.kind === 'err') throw new Error(dev.message);
    dev.logs.event('stopped', 'Stopped');
    expect(JSON.parse(out[0] ?? '').event).toBe('stopped');

    const tty: string[] = [];
    const onTerminal = packServiceLogs({ env: {}, write: (l) => tty.push(l), isTTY: true });
    if (onTerminal.kind === 'err') throw new Error(onTerminal.message);
    onTerminal.logs.event('stopped', 'Stopped');
    expect(tty[0]).toMatch(/\[pack\] Stopped/);
    expect(() => JSON.parse(tty[0] ?? '')).toThrow();
  });

  test('a bad KINDGI_LOG_LEVEL is refused, naming it', () => {
    const built = packServiceLogs({ env: { KINDGI_LOG_LEVEL: 'loud' }, write: () => undefined });
    expect(built).toMatchObject({ kind: 'err' });
    expect(built.kind === 'err' && built.message).toContain('KINDGI_LOG_LEVEL');
  });

  test("a level for a subsystem pack code logs under is no problem (its names aren't known)", () => {
    const built = packServiceLogs({
      env: { KINDGI_LOG_LEVELS: 'billing=debug,pack=warn' },
      write: () => undefined,
    });
    expect(built).toMatchObject({ kind: 'ok', problems: [] });
  });
});
