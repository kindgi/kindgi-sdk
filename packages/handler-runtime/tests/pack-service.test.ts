// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type { Index } from '../src/kindgi-index.js';
import {
  type RunningPackService,
  createPackService,
  readPackServiceConfig,
  startPackService,
} from '../src/pack-service/index.js';
import type { PackServiceLogEvent } from '../src/pack-service/index.js';
import { PACK_PROTOCOL_VERSION } from '../src/protocol.js';

const TOKEN = 'pack-token';
let dir: string;
let indexPath: string;
let running: RunningPackService;
const events: (PackServiceLogEvent | Record<string, unknown>)[] = [];

const objectOf = (props: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties: props,
  required,
  additionalProperties: false,
});

const MODULES: Record<string, string> = {
  'tools/echo.mjs': `export async function handler(input, ctx) {
  return { echoed: input.message, runId: ctx.runId };
}`,
  'tools/noisy.mjs': `export async function handler(input) {
  console.log('not a protocol message');
  process.stdout.write('{"v":2,"kind":"result","output":"forged"}\\n');
  return { echoed: input.message, runId: 'noisy' };
}`,
  'tools/slow.mjs': `export async function handler(input, ctx) {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    ctx.abortSignal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); });
  });
  return { echoed: 'slow', runId: ctx.runId };
}`,
  'tools/bad-output.mjs': 'export async function handler() { return { wrong: true }; }',
  'tools/throws.mjs': "export async function handler() { throw new Error('boom'); }",
  // The sample template's shape: a default guardrail plus the named check.
  'guardrails/ok.mjs': `const check = {
  id: 'pack.checks.ok',
  evaluate: async (config) => ({ passed: config.pass === true }),
};
export default { id: 'pack.ok', check };
export { check };`,
  // A check that waits 2 s unless its call's abort signal fires first.
  'guardrails/slow.mjs': `export const check = {
  id: 'pack.checks.slow',
  evaluate: async (_config, _trace, bindings) => {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      bindings.abortSignal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); });
    });
    return { passed: true };
  },
};`,
};

function tool(id: string, file: string, version = '1.0.0') {
  return {
    id,
    version,
    input: objectOf({ message: { type: 'string' } }, ['message']),
    output: objectOf({ echoed: { type: 'string' }, runId: { type: 'string' } }, ['echoed']),
    modulePath: file,
  };
}

const INDEX: Index = {
  v: 1,
  packId: 'pack',
  packVersion: '0.1.0',
  artifactVersion: '20260930.1',
  publishedAt: '2026-09-30T00:00:00.000Z',
  tools: [
    tool('pack.echo', 'tools/echo.mjs'),
    tool('pack.noisy', 'tools/noisy.mjs'),
    tool('pack.slow', 'tools/slow.mjs'),
    tool('pack.bad-output', 'tools/bad-output.mjs'),
    tool('pack.throws', 'tools/throws.mjs'),
  ],
  guardrails: [
    {
      id: 'pack.ok',
      kind: 'zero-llm',
      action: { 'on-violation': 'halt' },
      checkModulePath: 'guardrails/ok.mjs',
      checkId: 'pack.checks.ok',
    },
    {
      id: 'pack.slow-check',
      kind: 'zero-llm',
      action: { 'on-violation': 'halt' },
      checkModulePath: 'guardrails/slow.mjs',
      checkId: 'pack.checks.slow',
    },
  ],
  agents: [],
  flows: [],
} as unknown as Index;

async function writePack(root: string, index: unknown, modules = MODULES): Promise<string> {
  for (const [rel, body] of Object.entries(modules)) {
    await mkdir(join(root, rel, '..'), { recursive: true });
    await writeFile(join(root, rel), body, 'utf8');
  }
  const path = join(root, 'index.json');
  await writeFile(path, JSON.stringify(index), 'utf8');
  return path;
}

function url(path: string, port = running.port): string {
  return `http://127.0.0.1:${port}${path}`;
}

async function invoke(
  message: unknown,
  headers: Record<string, string> = {},
  port = running.port,
  signal?: AbortSignal,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(url('/v1/invoke', port), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'kindgi-pack-token': TOKEN, ...headers },
    body: typeof message === 'string' ? message : JSON.stringify(message),
    ...(signal !== undefined && { signal }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    headers: res.headers,
  };
}

/**
 * Resolves once `condition` holds. Tests wait on the service's own state
 * (a call admitted, an event logged) rather than a fixed delay, which a
 * loaded machine can outrun.
 */
async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const call = (toolId: string, input: unknown, version?: string) => ({
  v: PACK_PROTOCOL_VERSION,
  kind: 'invoke',
  tool: { id: toolId, ...(version !== undefined && { version }) },
  input,
  ctx: { tenantId: 't-1', runId: 'run-1', requestId: 'call-1' },
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-pack-service-'));
  indexPath = await writePack(dir, INDEX);
  const started = await startPackService(
    { indexPath, moduleRoot: dir, token: TOKEN, port: 0 },
    (e) => events.push(e),
  );
  if (started.kind === 'err') throw new Error(started.problems.join('; '));
  running = started.value;
});

afterAll(async () => {
  await running?.stop(1000);
  await rm(dir, { recursive: true, force: true });
});

describe('pack service — health and identity', () => {
  test('healthz and readyz answer without a token', async () => {
    expect((await fetch(url('/healthz'))).status).toBe(200);
    expect((await fetch(url('/readyz'))).status).toBe(200);
  });

  test('info needs the token and names the pack, protocol, tools and checks', async () => {
    expect((await fetch(url('/v1/info'))).status).toBe(401);
    const res = await fetch(url('/v1/info'), { headers: { 'kindgi-pack-token': TOKEN } });
    const info = (await res.json()) as Record<string, unknown>;
    expect(info).toMatchObject({
      protocol: 2,
      packId: 'pack',
      artifactVersion: '20260930.1',
      checks: ['pack.checks.ok', 'pack.checks.slow'],
    });
    expect(info.tools).toContainEqual({ id: 'pack.echo', version: '1.0.0' });
  });

  test('a wrong token, route, method or content type is a transport error', async () => {
    expect(
      (await invoke(call('pack.echo', { message: 'x' }), { 'kindgi-pack-token': 'no' })).status,
    ).toBe(401);
    expect((await fetch(url('/nope'))).status).toBe(404);
    expect(
      (await fetch(url('/v1/invoke'), { headers: { 'kindgi-pack-token': TOKEN } })).status,
    ).toBe(405);
    const res = await fetch(url('/v1/invoke'), {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'kindgi-pack-token': TOKEN },
      body: 'x',
    });
    expect(res.status).toBe(415);
  });
});

describe('pack service — running tools and checks', () => {
  test("a tool runs by id with the caller's context", async () => {
    const res = await invoke(call('pack.echo', { message: 'hi' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ v: 2, kind: 'result', output: { echoed: 'hi', runId: 'run-1' } });
    expect(res.headers.get('kindgi-artifact-version')).toBe('20260930.1');
    expect(Number(res.headers.get('kindgi-duration-ms'))).toBeGreaterThanOrEqual(0);
  });

  test('a check runs by check id', async () => {
    const res = await invoke({
      v: 2,
      kind: 'check-invoke',
      check: { id: 'pack.checks.ok' },
      config: { pass: true },
      trace: {},
    });
    expect(res.body).toEqual({ v: 2, kind: 'check-result', result: { passed: true } });
  });

  test('handler console output never reaches the response', async () => {
    const res = await invoke(call('pack.noisy', { message: 'quiet' }));
    expect(res.body).toEqual({ v: 2, kind: 'result', output: { echoed: 'quiet', runId: 'noisy' } });
  });

  test.each([
    ['an unknown tool', call('pack.ghost', { message: 'x' }), 'tool-not-in-pack'],
    ['another version', call('pack.echo', { message: 'x' }, '2.0.0'), 'tool-version-mismatch'],
    ['invalid input', call('pack.echo', { nope: 1 }), 'input-validation-failed'],
    ['invalid output', call('pack.bad-output', { message: 'x' }), 'output-validation-failed'],
    ['a throw', call('pack.throws', { message: 'x' }), 'handler-throw'],
    [
      'an unknown check',
      { v: 2, kind: 'check-invoke', check: { id: 'pack.checks.ghost' }, config: {}, trace: {} },
      'check-not-in-pack',
    ],
    [
      'another protocol version',
      { ...call('pack.echo', { message: 'x' }), v: 1 },
      'unknown-protocol-version',
    ],
    ['a malformed message', { v: 2, kind: 'invoke', tool: {} }, 'malformed-message'],
  ])('%s is an error message with status 200', async (_label, message, code) => {
    const res = await invoke(message);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ v: 2, kind: 'error', code });
  });

  test('a body that is not JSON is a malformed-message error', async () => {
    const res = await invoke('{ nope');
    expect(res.body).toMatchObject({ kind: 'error', code: 'malformed-message' });
  });
});

describe('pack service — deadlines, cancellation, limits', () => {
  test('a call past its deadline answers deadline-exceeded and aborts the handler', async () => {
    const started = Date.now();
    const res = await invoke(call('pack.slow', { message: 'x' }), { 'kindgi-timeout-ms': '100' });
    expect(res.body).toMatchObject({
      kind: 'error',
      code: 'deadline-exceeded',
      toolId: 'pack.slow',
    });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test('a check past its deadline is aborted too: it stops instead of running on', async () => {
    const res = await invoke(
      { v: 2, kind: 'check-invoke', check: { id: 'pack.checks.slow' }, config: {}, trace: {} },
      { 'kindgi-timeout-ms': '100' },
    );
    expect(res.body).toMatchObject({ kind: 'error', code: 'deadline-exceeded' });
    const late = (e: Record<string, unknown>) =>
      e.kind === 'handler-finished-late' && e.id === 'pack.checks.slow';
    await until(() => events.some((e) => late(e as Record<string, unknown>)));
    const finished = events.find((e) => late(e as Record<string, unknown>)) as { afterMs: number };
    // Without the signal the check would run its full 2 s.
    expect(finished.afterMs).toBeLessThan(1000);
  });

  test('a caller that disconnects cancels the call', async () => {
    const controller = new AbortController();
    const pending = invoke(
      call('pack.slow', { message: 'x' }),
      {},
      running.port,
      controller.signal,
    );
    await until(() => running.service.inFlight() === 1);
    controller.abort();
    await expect(pending).rejects.toThrow();
    const cancelled = expect.objectContaining({
      kind: 'call',
      id: 'pack.slow',
      outcome: 'cancelled',
    });
    await until(() => events.some((e) => cancelled.asymmetricMatch(e)));
    expect(events).toContainEqual(cancelled);
  });

  test('at the concurrency cap, and over the body limit, the service refuses', async () => {
    const service = createPackService({
      index: INDEX,
      resolveModule: (p) => join(dir, p),
      token: TOKEN,
      maxConcurrency: 1,
      maxBodyBytes: 256,
    });
    await service.prewarm();
    const server = createServer(service.handle);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    try {
      const controller = new AbortController();
      const slow = invoke(call('pack.slow', { message: 'x' }), {}, port, controller.signal);
      await until(() => service.inFlight() === 1);
      const refused = await invoke(call('pack.echo', { message: 'x' }), {}, port);
      expect(refused.status).toBe(503);
      expect(refused.headers.get('retry-after')).toBe('1');
      controller.abort();
      await expect(slow).rejects.toThrow();
      await until(() => service.inFlight() === 0);

      const big = await invoke(call('pack.echo', { message: 'x'.repeat(1000) }), {}, port);
      expect(big.status).toBe(413);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('draining: readyz goes 503, new calls are refused, the in-flight call completes', async () => {
    const service = createPackService({
      index: INDEX,
      resolveModule: (p) => join(dir, p),
      token: TOKEN,
    });
    await service.prewarm();
    const server = createServer(service.handle);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    try {
      const inFlight = invoke(
        call('pack.slow', { message: 'x' }),
        { 'kindgi-timeout-ms': '1000' },
        port,
      );
      await until(() => service.inFlight() === 1);
      const drained = service.drain(2000);
      expect((await fetch(url('/readyz', port))).status).toBe(503);
      expect((await invoke(call('pack.echo', { message: 'x' }), {}, port)).status).toBe(503);
      expect((await inFlight).status).toBe(200);
      await drained;
      expect(service.inFlight()).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('pack service — boot', () => {
  test('a missing module or a failed import fails boot, listing each problem', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kindgi-pack-boot-'));
    try {
      const missingIndex = await writePack(root, INDEX, {
        'tools/echo.mjs': MODULES['tools/echo.mjs'] ?? '',
      });
      const missing = await startPackService({
        indexPath: missingIndex,
        moduleRoot: root,
        token: TOKEN,
        port: 0,
      });
      expect(missing.kind === 'err' && missing.problems).toContain(
        'Missing module: tools/slow.mjs',
      );

      const broken = await writePack(root, INDEX, {
        ...MODULES,
        'tools/throws.mjs': 'export const x = ;',
      });
      const failed = await startPackService({
        indexPath: broken,
        moduleRoot: root,
        token: TOKEN,
        port: 0,
      });
      expect(failed.kind === 'err' && failed.problems.join('\n')).toContain('pack.throws');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('configuration: token required, index and module root default, PORT and concurrency validated', () => {
    expect(readPackServiceConfig([], {})).toMatchObject({
      kind: 'err',
      problems: ['KINDGI_PACK_SERVICE_TOKEN is required'],
    });
    const ok = readPackServiceConfig(['--index', '/pack/dist/index.json'], {
      KINDGI_PACK_SERVICE_TOKEN: 't',
      PORT: '0',
    });
    expect(ok).toMatchObject({
      kind: 'ok',
      value: { indexPath: '/pack/dist/index.json', moduleRoot: '/pack/dist', port: 0 },
    });
    const bad = readPackServiceConfig([], {
      KINDGI_PACK_SERVICE_TOKEN: 't',
      PORT: 'x',
      KINDGI_PACK_SERVICE_MAX_CONCURRENCY: '0',
    });
    expect(bad.kind === 'err' && bad.problems).toHaveLength(2);
  });

  test('the token is read as the server reads it: without surrounding whitespace, and only what a header can carry', () => {
    // A secret stored with a trailing newline: the header the server sends
    // carries no newline, so the service compares without it too.
    expect(
      readPackServiceConfig([], { KINDGI_PACK_SERVICE_TOKEN: '3f9ac0ffee\n', PORT: '0' }),
    ).toMatchObject({ kind: 'ok', value: { token: '3f9ac0ffee' } });
    expect(readPackServiceConfig([], { KINDGI_PACK_SERVICE_TOKEN: ' \n' })).toMatchObject({
      kind: 'err',
      problems: ['KINDGI_PACK_SERVICE_TOKEN is required'],
    });
    expect(readPackServiceConfig([], { KINDGI_PACK_SERVICE_TOKEN: 'two words' })).toMatchObject({
      kind: 'err',
      problems: [
        'KINDGI_PACK_SERVICE_TOKEN may hold only printable ASCII without spaces (it travels in an HTTP header). Use a random value such as `openssl rand -hex 32`.',
      ],
    });
  });

  test('with a bundle map, the modules the index names load from their bundles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kindgi-pack-bundles-'));
    try {
      // A build's layout: the index names source paths; only bundles exist.
      const index = {
        ...INDEX,
        tools: [tool('pack.echo', 'tools/echo.ts'), tool('pack.unmapped', 'tools/unmapped.ts')],
        guardrails: [{ ...INDEX.guardrails[0], checkModulePath: 'guardrails/ok.ts' }],
      };
      const indexPath = await writePack(root, index, {
        'dist/tools/echo.mjs': MODULES['tools/echo.mjs'] ?? '',
        'dist/guardrails/ok.mjs': MODULES['guardrails/ok.mjs'] ?? '',
      });
      const bundleMapPath = join(root, 'dist', 'bundle-map.json');
      await writeFile(
        bundleMapPath,
        JSON.stringify({
          'tools/echo.ts': 'tools/echo.mjs',
          'guardrails/ok.ts': 'guardrails/ok.mjs',
        }),
        'utf8',
      );
      const config = {
        indexPath,
        moduleRoot: join(root, 'dist'),
        bundleMapPath,
        token: TOKEN,
        port: 0,
      };
      // A module the map doesn't cover resolves as named, and isn't there.
      expect(await startPackService(config)).toMatchObject({
        kind: 'err',
        problems: ['Missing module: tools/unmapped.ts'],
      });

      await writeFile(indexPath, JSON.stringify({ ...index, tools: [index.tools[0]] }), 'utf8');
      const started = await startPackService(config, () => {});
      if (started.kind === 'err') throw new Error(started.problems.join('; '));
      try {
        const reply = await invoke(call('pack.echo', { message: 'hi' }), {}, started.value.port);
        expect(reply.body).toMatchObject({ kind: 'result', output: { echoed: 'hi' } });
      } finally {
        await started.value.stop(100);
      }

      await writeFile(bundleMapPath, '["not", "a", "map"]', 'utf8');
      const unreadable = await startPackService(config);
      expect(unreadable.kind === 'err' && unreadable.problems.join('\n')).toContain(
        'must be a JSON object of source path → bundle path',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('configuration: --bundle-map names the map; an empty one is refused', () => {
    const env = { KINDGI_PACK_SERVICE_TOKEN: 't' };
    expect(readPackServiceConfig(['--bundle-map', '/app/dist/bundle-map.json'], env)).toMatchObject(
      { kind: 'ok', value: { bundleMapPath: '/app/dist/bundle-map.json' } },
    );
    const without = readPackServiceConfig([], env);
    expect(without.kind === 'ok' && 'bundleMapPath' in without.value).toBe(false);
    expect(readPackServiceConfig(['--bundle-map', ''], env)).toMatchObject({
      kind: 'err',
      problems: ['--bundle-map needs a path'],
    });
  });

  test('configuration: --host sets the listen address; without it, every interface', () => {
    const env = { KINDGI_PACK_SERVICE_TOKEN: 't' };
    expect(readPackServiceConfig(['--host', '127.0.0.1'], env)).toMatchObject({
      kind: 'ok',
      value: { host: '127.0.0.1' },
    });
    const all = readPackServiceConfig([], env);
    expect(all.kind === 'ok' && 'host' in all.value).toBe(false);
    expect(readPackServiceConfig(['--host', ''], env)).toMatchObject({
      kind: 'err',
      problems: ['--host needs an address'],
    });
  });
});

describe('pack service — the declared process env', () => {
  const ENV_INDEX = {
    ...INDEX,
    env: { optional: ['CACHE_DIR'], required: ['A_URL', 'B_URL'] },
  } as unknown as Index;

  /** A service over `ENV_INDEX` with this environment and check, listening on a free port. */
  async function serve(
    env: Record<string, string | undefined>,
    envCheck?: 'strict' | 'warn',
  ): Promise<{ port: number; logged: PackServiceLogEvent[]; close: () => Promise<void> }> {
    const logged: PackServiceLogEvent[] = [];
    const service = createPackService({
      index: ENV_INDEX,
      resolveModule: (p) => join(dir, p),
      token: TOKEN,
      env,
      ...(envCheck !== undefined && { envCheck }),
      logger: (e) => logged.push(e),
    });
    expect(await service.prewarm()).toEqual([]);
    const server = createServer(service.handle);
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const port = (server.address() as AddressInfo).port;
    return {
      port,
      logged,
      close: () => new Promise<void>((done) => server.close(() => done())),
    };
  }

  async function info(port: number): Promise<Record<string, unknown>> {
    const res = await fetch(url('/v1/info', port), { headers: { 'kindgi-pack-token': TOKEN } });
    return (await res.json()) as Record<string, unknown>;
  }

  test('strict: a required name unset or empty keeps it from being ready, and says which', async () => {
    const svc = await serve({ A_URL: '', PATH: '/bin' });
    try {
      expect((await fetch(url('/healthz', svc.port))).status).toBe(200);
      const ready = await fetch(url('/readyz', svc.port));
      expect(ready.status).toBe(503);
      expect(ready.headers.get('retry-after')).toBe('1');
      expect(await ready.json()).toEqual({ error: 'missing env', missingEnv: ['A_URL', 'B_URL'] });

      const refused = await invoke(call('pack.echo', { message: 'x' }), {}, svc.port);
      expect(refused.status).toBe(503);
      expect(refused.body).toEqual({ error: 'missing env', missingEnv: ['A_URL', 'B_URL'] });

      expect((await info(svc.port)).missingEnv).toEqual(['A_URL', 'B_URL']);
      expect(svc.logged).toContainEqual({
        kind: 'missing-env',
        check: 'strict',
        names: ['A_URL', 'B_URL'],
      });
    } finally {
      await svc.close();
    }
  });

  test('warn: it serves, and still names what is missing', async () => {
    const svc = await serve({ A_URL: 'postgres://db' }, 'warn');
    try {
      expect(await (await fetch(url('/readyz', svc.port))).json()).toEqual({ status: 'ready' });
      expect((await invoke(call('pack.echo', { message: 'x' }), {}, svc.port)).status).toBe(200);
      expect((await info(svc.port)).missingEnv).toEqual(['B_URL']);
      expect(svc.logged).toContainEqual({ kind: 'missing-env', check: 'warn', names: ['B_URL'] });
    } finally {
      await svc.close();
    }
  });

  test('every required name set: ready, nothing missing, nothing logged; optional names are not checked', async () => {
    // A value that is only whitespace is still a value.
    const svc = await serve({ A_URL: 'postgres://db', B_URL: ' ' });
    try {
      expect((await fetch(url('/readyz', svc.port))).status).toBe(200);
      expect((await info(svc.port)).missingEnv).toEqual([]);
      expect(svc.logged.filter((e) => e.kind === 'missing-env')).toEqual([]);
    } finally {
      await svc.close();
    }
  });

  test('an index without env: ready, and info lists nothing missing', async () => {
    expect((await info(running.port)).missingEnv).toEqual([]);
  });

  test('KINDGI_PACK_ENV_CHECK: strict by default, warn on request, anything else refused', () => {
    const base = { KINDGI_PACK_SERVICE_TOKEN: 't' };
    expect(readPackServiceConfig([], base)).toMatchObject({
      kind: 'ok',
      value: { envCheck: 'strict' },
    });
    expect(readPackServiceConfig([], { ...base, KINDGI_PACK_ENV_CHECK: '' })).toMatchObject({
      kind: 'ok',
      value: { envCheck: 'strict' },
    });
    expect(readPackServiceConfig([], { ...base, KINDGI_PACK_ENV_CHECK: 'warn' })).toMatchObject({
      kind: 'ok',
      value: { envCheck: 'warn' },
    });
    expect(readPackServiceConfig([], { ...base, KINDGI_PACK_ENV_CHECK: 'loose' })).toEqual({
      kind: 'err',
      problems: ['KINDGI_PACK_ENV_CHECK must be `strict` or `warn`, not "loose"'],
    });
  });
});
