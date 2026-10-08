// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The pack-service conformance suite — what any language's pack service and
 * indexer must do, checked from the outside: the index it writes
 * (`pack-index.schema.json`), the process contract (arguments, environment,
 * the `listening` / `boot-failed` lines, SIGTERM drain) and every route,
 * status and message of pack protocol v2 (`pack-protocol.schema.json`).
 *
 * A target names how to index the fixture pack (`FIXTURE.md`) and how to
 * start its service; the suite does the rest:
 *
 *   describePackServiceConformance({
 *     name: 'python',
 *     packDir: fixturePackDir('python-pack'),
 *     buildIndex: (out, pins) => …,
 *     command: [python, '-m', 'kindgi.pack', 'serve'],
 *   });
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import type { ValidateFunction } from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

/** Values the suite pins so two index builds can be compared byte for byte. */
export interface IndexPins {
  readonly artifactVersion: string;
  readonly publishedAt: string;
}

export interface PackServiceTarget {
  /** Shown in the test names. */
  readonly name: string;
  /** The fixture pack's root — also the service's module root. */
  readonly packDir: string;
  /** Index the fixture pack into `outputPath` with the given pins. */
  buildIndex(outputPath: string, pins: IndexPins): Promise<void>;
  /** The argv that starts the service; the suite appends `--index`, `--module-root`, `--host`. */
  readonly command: readonly string[];
  /** Extra environment for the service process. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Parts of the contract this target doesn't implement yet: their cases
   * are skipped (and say so) until the target drops the entry.
   */
  readonly unsupported?: readonly ConformanceFeature[];
}

/**
 * A part of the contract a target can roll out separately.
 * - `pack-env`: the index's declared process env (`env.required`) gates
 *   readiness under `KINDGI_PACK_ENV_CHECK`, and `/v1/info` lists `missingEnv`.
 */
export type ConformanceFeature = 'pack-env';

/** Root of a fixture pack shipped with this package (`node-pack`, `python-pack`). */
export function fixturePackDir(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', name);
}

export const FIXTURE_PACK_ID = 'conformance';
export const FIXTURE_TOOL_IDS = [
  'conformance.bad-output',
  'conformance.context',
  'conformance.defaults',
  'conformance.echo',
  'conformance.hold',
  'conformance.noisy',
  'conformance.process-env',
  'conformance.sleep',
  'conformance.throws',
] as const;
export const FIXTURE_CHECK_IDS = [
  'conformance.checks.min-length',
  'conformance.checks.throws',
] as const;

const PINS: IndexPins = { artifactVersion: '20261001.7', publishedAt: '2026-10-01T12:00:00.000Z' };
const PROTOCOL_ID = 'https://kindgi.com/schemas/v1/pack-protocol.schema.json';
const CTX = { tenantId: 't-conformance', runId: 'run-conformance' } as const;

// ---------------------------------------------------------------------------
// Spec validators
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const addFormats = ((addFormatsModule as { default?: unknown }).default ??
  addFormatsModule) as unknown as (ajv: Ajv2020) => void;

function specValidators(): {
  readonly index: ValidateFunction;
  readonly response: ValidateFunction;
  readonly info: ValidateFunction;
  readonly compile: (schema: object) => ValidateFunction;
} {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: false });
  addFormats(ajv);
  const load = (name: string): object =>
    JSON.parse(
      readFileSync(require.resolve(`@kindgi/specs/${name}.schema.json`), 'utf8'),
    ) as object;
  ajv.addSchema(load('pack-protocol'));
  const index = ajv.compile(load('pack-index'));
  const get = (fragment: string): ValidateFunction => {
    const fn = ajv.getSchema(`${PROTOCOL_ID}#/$defs/${fragment}`);
    if (fn === undefined) throw new Error(`pack-protocol.schema.json has no $defs/${fragment}`);
    return fn;
  };
  const loose = new Ajv2020({ strict: false, allErrors: true });
  addFormats(loose);
  return {
    index,
    response: get('response'),
    info: get('info'),
    compile: (schema) => loose.compile(schema),
  };
}

function expectValid(validate: ValidateFunction, value: unknown): void {
  expect(validate(value) ? [] : validate.errors).toEqual([]);
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

interface ServiceEvent {
  readonly kind: string;
  readonly [key: string]: unknown;
}

interface RunningService {
  readonly url: string;
  readonly token: string;
  readonly events: ServiceEvent[];
  readonly stdout: string[];
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  terminate(): Promise<{ readonly code: number | null; readonly signal: string | null }>;
}

function serviceArgs(target: PackServiceTarget, indexPath: string): string[] {
  const [, ...rest] = target.command;
  return [...rest, '--index', indexPath, '--module-root', target.packDir, '--host', '127.0.0.1'];
}

function serviceEnv(
  target: PackServiceTarget,
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = { PORT: '0' };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  return { ...env, ...target.env, ...extra };
}

function spawnService(
  target: PackServiceTarget,
  indexPath: string,
  env: Readonly<Record<string, string>>,
): {
  readonly child: ChildProcess;
  readonly events: ServiceEvent[];
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const command = target.command[0];
  if (command === undefined) throw new Error(`${target.name}: empty command`);
  const child = spawn(command, serviceArgs(target, indexPath), {
    env: serviceEnv(target, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events: ServiceEvent[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  if (child.stdout !== null) {
    createInterface({ input: child.stdout }).on('line', (line) => stdout.push(line));
  }
  if (child.stderr !== null) {
    createInterface({ input: child.stderr }).on('line', (line) => {
      stderr.push(line);
      const event = parseEvent(line);
      if (event !== undefined) events.push(event);
    });
  }
  return { child, events, stdout, stderr };
}

function parseEvent(line: string): ServiceEvent | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === 'object' &&
      value !== null &&
      typeof (value as ServiceEvent).kind === 'string'
      ? (value as ServiceEvent)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The process's exit, once its stdout and stderr are closed too (`close`,
 * not `exit`): every line it wrote has been read by then.
 */
function exitOf(
  child: ChildProcess,
): Promise<{ readonly code: number | null; readonly signal: string | null }> {
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function startService(
  target: PackServiceTarget,
  indexPath: string,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<RunningService> {
  const token = randomBytes(18).toString('base64url');
  const { child, events, stdout, stderr } = spawnService(target, indexPath, {
    KINDGI_PACK_SERVICE_TOKEN: token,
    ...extraEnv,
  });
  const exited = exitOf(child);
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setInterval(() => {
      const listening = events.find((e) => e.kind === 'listening');
      if (listening !== undefined && typeof listening.port === 'number') {
        clearInterval(timer);
        resolve(listening.port);
      }
    }, 20);
    void exited.then(({ code, signal }) => {
      clearInterval(timer);
      reject(
        new Error(
          `${target.name}: the service exited (${signal ?? code}) before listening:\n${stderr.join('\n')}`,
        ),
      );
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    events,
    stdout,
    exited,
    async terminate() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      return exited;
    },
  };
}

async function runToExit(
  target: PackServiceTarget,
  indexPath: string,
  env: Readonly<Record<string, string>>,
): Promise<{ readonly code: number | null; readonly events: ServiceEvent[] }> {
  const { child, events } = spawnService(target, indexPath, env);
  const { code } = await exitOf(child);
  return { code, events };
}

/**
 * How long to wait for something the service does (a line it writes, an
 * answer), on a busy machine. A wait ends as soon as it happens.
 */
const SERVICE_WAIT_MS = 15_000;

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly json: Record<string, unknown>;
}

async function call(
  service: RunningService,
  path: string,
  init: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    token?: string | null;
  } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { ...init.headers };
  const token = init.token === undefined ? service.token : init.token;
  if (token !== null) headers['kindgi-pack-token'] = token;
  const response = await fetch(`${service.url}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined && { body: init.body }),
    ...(init.signal !== undefined && { signal: init.signal }),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { unparsed: text };
  }
  return { status: response.status, headers: response.headers, json };
}

function invoke(
  service: RunningService,
  message: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Answer> {
  return call(service, '/v1/invoke', {
    method: 'POST',
    body: typeof message === 'string' ? message : JSON.stringify(message),
    headers: { 'content-type': 'application/json', ...headers },
    ...(signal !== undefined && { signal }),
  });
}

/**
 * Wait until a `conformance.hold` call is running: its handler has printed
 * its line, so the service took the call. It runs until `release` exists.
 */
function untilHeld(service: RunningService, release: string): Promise<string> {
  return waitFor(
    () => service.stdout.find((line) => line === `hold: ${release}`),
    SERVICE_WAIT_MS,
    `the held call (${release}) to start`,
  );
}

function toolCall(
  id: string,
  input: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { v: 2, kind: 'invoke', tool: { id }, input, ctx: CTX, ...extra };
}

function checkCall(
  id: string,
  config: Record<string, unknown>,
  output: string,
): Record<string, unknown> {
  return {
    v: 2,
    kind: 'check-invoke',
    check: { id },
    config,
    trace: { ...CTX, output, toolCalls: [], toolResults: [], modelCalls: [], mode: 'runtime' },
  };
}

function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v === null || typeof v !== 'object') return v;
    const rec = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(rec)
        .sort()
        .map((k) => [k, sort(rec[k])]),
    );
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

/** Register the conformance suite for one target (vitest `describe` blocks). */
export function describePackServiceConformance(target: PackServiceTarget): void {
  const spec = specValidators();

  describe(`pack service conformance — ${target.name}`, () => {
    let workDir = '';
    let indexPath = '';
    let indexText = '';
    let index: Record<string, unknown> & {
      tools: Record<string, unknown>[];
      guardrails: Record<string, unknown>[];
      agents: Record<string, unknown>[];
      flows: Record<string, unknown>[];
    };
    let service: RunningService;

    const response = (answer: Answer): Record<string, unknown> => {
      expect(answer.status).toBe(200);
      expectValid(spec.response, answer.json);
      return answer.json;
    };

    beforeAll(async () => {
      workDir = await mkdtemp(join(tmpdir(), 'kindgi-conformance-'));
      indexPath = join(workDir, 'index.json');
      await target.buildIndex(indexPath, PINS);
      indexText = await readFile(indexPath, 'utf8');
      index = JSON.parse(indexText) as typeof index;
      service = await startService(target, indexPath);
    });

    afterAll(async () => {
      await service?.terminate();
      if (workDir !== '') await rm(workDir, { recursive: true, force: true });
    });

    describe('index', () => {
      test('matches pack-index.schema.json', () => {
        expectValid(spec.index, index);
      });

      test('lists the fixture pack, every list sorted by id', () => {
        expect(index.packId).toBe(FIXTURE_PACK_ID);
        expect(index.packVersion).toBe('1.0.0');
        expect(index.artifactVersion).toBe(PINS.artifactVersion);
        expect(index.publishedAt).toBe(PINS.publishedAt);
        expect(index.tools.map((t) => t.id)).toEqual([...FIXTURE_TOOL_IDS]);
        expect(index.tools.every((t) => t.version === '1.0.0')).toBe(true);
        expect(index.guardrails.map((g) => g.checkId ?? g.id).sort()).toEqual([
          ...FIXTURE_CHECK_IDS,
        ]);
        expect(index.guardrails.map((g) => g.id)).toEqual([
          'conformance.check-throws',
          'conformance.min-length',
        ]);
        expect(index.agents.map((a) => a.id)).toEqual(['conformance.echo-agent']);
        expect(index.agents[0]?.tools).toEqual([{ id: 'conformance.echo', version: '1.0.0' }]);
        expect(index.flows.map((f) => f.id)).toEqual(['conformance.echo-flow']);
        expect(index.flows[0]?.kernelPayloadVersion).toBe(1);
      });

      test('is canonical: keys sorted, two-space indent, trailing newline', () => {
        expect(indexText).toBe(canonical(index));
      });

      test('the same source indexes to the same bytes', async () => {
        const again = join(workDir, 'index-again.json');
        await target.buildIndex(again, PINS);
        expect(await readFile(again, 'utf8')).toBe(indexText);
      });

      test("a tool's schemas accept and reject what the fixture says", () => {
        const echo = index.tools.find((t) => t.id === 'conformance.echo');
        const input = spec.compile(echo?.input as object);
        expect(input({ message: 'hi' })).toBe(true);
        expect(input({})).toBe(false);
        expect(input({ message: '' })).toBe(false);
        expect(input({ message: 'hi', extra: 1 })).toBe(false);
        const minLength = index.guardrails.find((g) => g.id === 'conformance.min-length');
        const config = spec.compile(minLength?.configSchema as object);
        expect(config({ minLength: 2 })).toBe(true);
        expect(config({ minLength: -1 })).toBe(false);
      });
    });

    describe('process', () => {
      test('writes a listening line with its port and pack', () => {
        const listening = service.events.find((e) => e.kind === 'listening');
        expect(listening).toMatchObject({ kind: 'listening', packId: FIXTURE_PACK_ID });
        expect(typeof listening?.port).toBe('number');
      });

      test('without a token: exit 1 with a config-invalid line', async () => {
        const { code, events } = await runToExit(target, indexPath, {
          KINDGI_PACK_SERVICE_TOKEN: '',
        });
        expect(code).toBe(1);
        expect(events.map((e) => e.kind)).toContain('config-invalid');
      });

      test('a token stored with a trailing newline: a call with the token itself is accepted', async () => {
        // The server's header never carries the newline (HTTP drops
        // surrounding whitespace), so the service compares without it.
        const token = randomBytes(18).toString('base64url');
        const padded = await startService(target, indexPath, {
          KINDGI_PACK_SERVICE_TOKEN: `${token}\n`,
        });
        try {
          expect((await call(padded, '/v1/info', { token })).status).toBe(200);
          expect((await call(padded, '/v1/info', { token: `${token}x` })).status).toBe(401);
        } finally {
          await padded.terminate();
        }
      });

      test("a token a header can't carry: exit 1 with a config-invalid line", async () => {
        const { code, events } = await runToExit(target, indexPath, {
          KINDGI_PACK_SERVICE_TOKEN: 'two words',
        });
        expect(code).toBe(1);
        expect(events.map((e) => e.kind)).toContain('config-invalid');
      });

      test('a module the index names is missing: exit 1 with a boot-failed line', async () => {
        const broken = JSON.parse(indexText) as typeof index;
        const first = broken.tools[0] as Record<string, unknown>;
        const ext = String(first.modulePath).split('.').pop();
        first.modulePath = `tools/does-not-exist.${ext}`;
        const brokenPath = join(workDir, 'broken-index.json');
        await writeFile(brokenPath, JSON.stringify(broken), 'utf8');
        const { code, events } = await runToExit(target, brokenPath, {
          KINDGI_PACK_SERVICE_TOKEN: 'x',
        });
        expect(code).toBe(1);
        const failed = events.find((e) => e.kind === 'boot-failed');
        expect(failed?.problems).toContain(`Missing module: tools/does-not-exist.${ext}`);
      });

      test('an unreadable index: exit 1 with a boot-failed line', async () => {
        const { code, events } = await runToExit(target, join(workDir, 'nope.json'), {
          KINDGI_PACK_SERVICE_TOKEN: 'x',
        });
        expect(code).toBe(1);
        const failed = events.find((e) => e.kind === 'boot-failed');
        expect(String((failed?.problems as string[] | undefined)?.[0])).toMatch(
          /^Cannot read the pack index/,
        );
      });

      // The in-flight call is one the test holds open: the drain lasts until
      // the test has checked readyz and a new call, then releases it.
      test('SIGTERM: in-flight calls finish, readyz and new calls answer 503, exit 0', async () => {
        const draining = await startService(target, indexPath);
        const release = join(workDir, 'release-sigterm');
        try {
          const held = invoke(draining, toolCall('conformance.hold', { release }));
          await untilHeld(draining, release);
          const exited = draining.terminate();
          await waitFor(
            () => draining.events.find((e) => e.kind === 'draining'),
            SERVICE_WAIT_MS,
            'draining',
          );
          const ready = await call(draining, '/readyz', { token: null });
          expect(ready.status).toBe(503);
          expect(ready.headers.get('retry-after')).not.toBeNull();
          const refused = await invoke(draining, toolCall('conformance.echo', { message: 'late' }));
          expect(refused.status).toBe(503);
          await writeFile(release, '');
          expect(response(await held).output).toEqual({ released: true });
          const { code } = await exited;
          expect(code).toBe(0);
          expect(draining.events.map((e) => e.kind)).toContain('stopped');
        } finally {
          await writeFile(release, '');
          await draining.terminate();
        }
      });

      test('at the concurrency cap: 503 with Retry-After (the call did not run)', async () => {
        const capped = await startService(target, indexPath, {
          KINDGI_PACK_SERVICE_MAX_CONCURRENCY: '1',
        });
        const release = join(workDir, 'release-cap');
        try {
          const busy = invoke(capped, toolCall('conformance.hold', { release }));
          await untilHeld(capped, release);
          const second = await invoke(capped, toolCall('conformance.echo', { message: 'hi' }));
          expect(second.status).toBe(503);
          expect(second.headers.get('retry-after')).not.toBeNull();
          await writeFile(release, '');
          expect(response(await busy).kind).toBe('result');
        } finally {
          await writeFile(release, '');
          await capped.terminate();
        }
      });
    });

    describe.skipIf(target.unsupported?.includes('pack-env') === true)('declared env', () => {
      const DECLARED = {
        optional: ['CONFORMANCE_OPTIONAL'],
        required: ['CONFORMANCE_A', 'CONFORMANCE_B'],
      };

      /** The fixture index with `env` declared, written beside it. */
      async function envIndexPath(): Promise<string> {
        const declared = { ...(JSON.parse(indexText) as typeof index), env: DECLARED };
        expectValid(spec.index, declared);
        const path = join(workDir, 'env-index.json');
        await writeFile(path, JSON.stringify(declared), 'utf8');
        return path;
      }

      test('strict: a required name unset or empty keeps readyz and calls at 503, naming it', async () => {
        const strict = await startService(target, await envIndexPath(), { CONFORMANCE_A: '' });
        try {
          const health = await call(strict, '/healthz', { token: null });
          expect(health.status).toBe(200);
          const ready = await call(strict, '/readyz', { token: null });
          expect([ready.status, ready.json]).toEqual([
            503,
            { error: 'missing env', missingEnv: ['CONFORMANCE_A', 'CONFORMANCE_B'] },
          ]);
          expect(ready.headers.get('retry-after')).not.toBeNull();
          const refused = await invoke(strict, toolCall('conformance.echo', { message: 'hi' }));
          expect([refused.status, refused.json]).toEqual([
            503,
            { error: 'missing env', missingEnv: ['CONFORMANCE_A', 'CONFORMANCE_B'] },
          ]);
          const info = await call(strict, '/v1/info');
          expectValid(spec.info, info.json);
          expect(info.json.missingEnv).toEqual(['CONFORMANCE_A', 'CONFORMANCE_B']);
        } finally {
          await strict.terminate();
        }
      });

      test('warn: it serves, and /v1/info still names what is missing', async () => {
        const warn = await startService(target, await envIndexPath(), {
          KINDGI_PACK_ENV_CHECK: 'warn',
          CONFORMANCE_A: 'set',
        });
        try {
          const ready = await call(warn, '/readyz', { token: null });
          expect([ready.status, ready.json]).toEqual([200, { status: 'ready' }]);
          expect(
            response(await invoke(warn, toolCall('conformance.echo', { message: 'hi' }))).kind,
          ).toBe('result');
          expect((await call(warn, '/v1/info')).json.missingEnv).toEqual(['CONFORMANCE_B']);
        } finally {
          await warn.terminate();
        }
      });

      test('every required name set (optional ones need not be): ready, nothing missing', async () => {
        const full = await startService(target, await envIndexPath(), {
          CONFORMANCE_A: 'a',
          CONFORMANCE_B: ' ',
        });
        try {
          expect((await call(full, '/readyz', { token: null })).status).toBe(200);
          expect((await call(full, '/v1/info')).json.missingEnv).toEqual([]);
        } finally {
          await full.terminate();
        }
      });

      test('an index without env: /v1/info lists nothing missing', async () => {
        expect((await call(service, '/v1/info')).json.missingEnv).toEqual([]);
      });

      test('KINDGI_PACK_ENV_CHECK other than strict or warn: exit 1 with a config-invalid line', async () => {
        const { code, events } = await runToExit(target, indexPath, {
          KINDGI_PACK_SERVICE_TOKEN: 'x',
          KINDGI_PACK_ENV_CHECK: 'loose',
        });
        expect(code).toBe(1);
        expect(events.map((e) => e.kind)).toContain('config-invalid');
      });
    });

    describe('routes', () => {
      test('GET /healthz and /readyz need no token', async () => {
        const health = await call(service, '/healthz', { token: null });
        expect([health.status, health.json]).toEqual([200, { status: 'ok' }]);
        const ready = await call(service, '/readyz', { token: null });
        expect([ready.status, ready.json]).toEqual([200, { status: 'ready' }]);
      });

      test('GET /v1/info lists the pack', async () => {
        const info = await call(service, '/v1/info');
        expect(info.status).toBe(200);
        expectValid(spec.info, info.json);
        expect(info.json).toMatchObject({
          protocol: 2,
          packId: FIXTURE_PACK_ID,
          artifactVersion: PINS.artifactVersion,
        });
        expect(info.json.tools).toContainEqual({ id: 'conformance.echo', version: '1.0.0' });
        expect([...(info.json.checks as string[])].sort()).toEqual([...FIXTURE_CHECK_IDS]);
      });

      test('401 without the token, or with a wrong one', async () => {
        expect((await call(service, '/v1/info', { token: null })).status).toBe(401);
        expect((await call(service, '/v1/info', { token: 'wrong' })).status).toBe(401);
        const message = JSON.stringify(toolCall('conformance.echo', { message: 'hi' }));
        const noToken = await call(service, '/v1/invoke', {
          method: 'POST',
          body: message,
          headers: { 'content-type': 'application/json' },
          token: null,
        });
        expect(noToken.status).toBe(401);
      });

      test('404 for an unknown route, 405 for the wrong method', async () => {
        expect((await call(service, '/v1/nope')).status).toBe(404);
        expect((await call(service, '/v1/invoke')).status).toBe(405);
      });

      test('415 when the body is not application/json', async () => {
        const answer = await call(service, '/v1/invoke', {
          method: 'POST',
          body: JSON.stringify(toolCall('conformance.echo', { message: 'hi' })),
          headers: { 'content-type': 'text/plain' },
        });
        expect(answer.status).toBe(415);
      });

      test('413 when the body is over 10 MiB', async () => {
        const big = JSON.stringify(
          toolCall('conformance.echo', { message: 'x'.repeat(10 * 1024 * 1024) }),
        );
        expect((await invoke(service, big)).status).toBe(413);
      });
    });

    describe('tools', () => {
      test('a call returns the output, with duration and artifact-version headers', async () => {
        const answer = await invoke(service, toolCall('conformance.echo', { message: 'hi' }));
        expect(response(answer)).toEqual({ v: 2, kind: 'result', output: { message: 'hi' } });
        expect(Number(answer.headers.get('kindgi-duration-ms'))).toBeGreaterThanOrEqual(0);
        expect(answer.headers.get('kindgi-artifact-version')).toBe(PINS.artifactVersion);
      });

      test('a call is logged as a JSON line on stderr', async () => {
        await invoke(service, toolCall('conformance.echo', { message: 'logged' }));
        const logged = await waitFor(
          () =>
            service.events.find(
              (e) => e.kind === 'call' && e.id === 'conformance.echo' && e.outcome === 'ok',
            ),
          3_000,
          'the call line',
        );
        expect(logged).toMatchObject({ target: 'tool' });
        expect(typeof logged.durationMs).toBe('number');
      });

      test('a named version must match the indexed one', async () => {
        const ok = await invoke(
          service,
          toolCall(
            'conformance.echo',
            { message: 'hi' },
            { tool: { id: 'conformance.echo', version: '1.0.0' } },
          ),
        );
        expect(response(ok).kind).toBe('result');
        const wrong = response(
          await invoke(
            service,
            toolCall(
              'conformance.echo',
              { message: 'hi' },
              { tool: { id: 'conformance.echo', version: '9.9.9' } },
            ),
          ),
        );
        expect(wrong).toMatchObject({
          kind: 'error',
          code: 'tool-version-mismatch',
          toolId: 'conformance.echo',
        });
      });

      test('an unknown tool: tool-not-in-pack', async () => {
        const answer = response(await invoke(service, toolCall('conformance.nope', {})));
        expect(answer).toMatchObject({
          kind: 'error',
          code: 'tool-not-in-pack',
          toolId: 'conformance.nope',
        });
      });

      test('invalid input: input-validation-failed with Ajv-shaped issues', async () => {
        const missing = response(await invoke(service, toolCall('conformance.echo', {})));
        expect(missing).toMatchObject({
          kind: 'error',
          code: 'input-validation-failed',
          toolId: 'conformance.echo',
        });
        expect(missing.issues).toContainEqual(
          expect.objectContaining({
            instancePath: '',
            keyword: 'required',
            params: { missingProperty: 'message' },
          }),
        );
        const extra = response(
          await invoke(service, toolCall('conformance.echo', { message: 'hi', extra: 1 })),
        );
        expect(extra.issues).toContainEqual(
          expect.objectContaining({
            instancePath: '',
            keyword: 'additionalProperties',
            params: { additionalProperty: 'extra' },
          }),
        );
        const wrongType = response(
          await invoke(service, toolCall('conformance.echo', { message: 7 })),
        );
        expect(wrongType.issues).toContainEqual(
          expect.objectContaining({ instancePath: '/message', keyword: 'type' }),
        );
      });

      test('output that breaks the output schema: output-validation-failed', async () => {
        const answer = response(await invoke(service, toolCall('conformance.bad-output', {})));
        expect(answer).toMatchObject({
          kind: 'error',
          code: 'output-validation-failed',
          toolId: 'conformance.bad-output',
        });
        expect(answer.issues).toContainEqual(
          expect.objectContaining({ instancePath: '/message', keyword: 'type' }),
        );
      });

      test('a throw: handler-throw with the cause', async () => {
        const answer = response(await invoke(service, toolCall('conformance.throws', {})));
        expect(answer).toMatchObject({
          kind: 'error',
          code: 'handler-throw',
          toolId: 'conformance.throws',
        });
        expect(String(answer.message)).toContain('boom');
        expect(String((answer.cause as { message?: unknown }).message)).toContain('boom');
      });

      test("the handler receives its input with the schema's defaults filled in", async () => {
        const filled = response(
          await invoke(service, toolCall('conformance.defaults', { name: 'Ada' })),
        );
        expect(filled.output).toEqual({ name: 'Ada', greeting: 'Hello', options: { loud: false } });
        const given = response(
          await invoke(
            service,
            toolCall('conformance.defaults', { name: 'Ada', greeting: 'Hi', options: {} }),
          ),
        );
        expect(given.output).toEqual({ name: 'Ada', greeting: 'Hi', options: { loud: false } });
      });

      test('the handler receives the call context', async () => {
        const ctx = {
          ...CTX,
          requestId: 'req-1',
          projectId: 'project-1',
          orgId: 'org-1',
          env: { REGION: 'eu' },
          secrets: { API_KEY: 's3cret' },
          config: { mode: 'fast' },
          settings: { 'acme.weights': { recency: 0.7 } },
        };
        const answer = response(
          await invoke(service, toolCall('conformance.context', {}, { ctx })),
        );
        expect(answer.output).toEqual(ctx);
      });

      test('a call from a run whose project has no org: the handler gets no org', async () => {
        const ctx = { ...CTX, projectId: 'project-1' };
        const answer = response(
          await invoke(service, toolCall('conformance.context', {}, { ctx })),
        );
        expect(answer.output).toMatchObject({ projectId: 'project-1' });
        expect(answer.output).not.toHaveProperty('orgId');
      });

      test("pack code doesn't see the service token", async () => {
        // The token authenticates the service's callers. A dependency of
        // the pack's code that could read it could call the pack's tools
        // around the runtime: the service takes it out of its process
        // environment before it loads the pack's code.
        const answer = response(await invoke(service, toolCall('conformance.process-env', {})));
        expect(answer.output).toMatchObject({ names: expect.any(Array) });
        expect((answer.output as { names: string[] }).names).not.toContain(
          'KINDGI_PACK_SERVICE_TOKEN',
        );
      });

      test('what a handler prints never reaches the response', async () => {
        const answer = response(await invoke(service, toolCall('conformance.noisy', {})));
        expect(answer.output).toEqual({ ok: true });
        await waitFor(
          () => service.stdout.find((l) => l.includes('noisy: a line on stdout')),
          3_000,
          'stdout',
        );
      });

      test('malformed requests are answered with error messages', async () => {
        expect(response(await invoke(service, 'not json'))).toMatchObject({
          code: 'malformed-message',
        });
        expect(
          response(await invoke(service, { ...toolCall('conformance.echo', {}), v: 1 })),
        ).toMatchObject({
          code: 'unknown-protocol-version',
        });
        expect(
          response(await invoke(service, { ...toolCall('conformance.echo', {}), kind: 'bogus' })),
        ).toMatchObject({
          code: 'unexpected-message-kind',
        });
        expect(
          response(
            await invoke(service, toolCall('conformance.echo', {}, { ctx: { tenantId: 't' } })),
          ),
        ).toMatchObject({ code: 'malformed-message' });
        expect(
          response(await invoke(service, toolCall('conformance.echo', {}, { tool: {} }))),
        ).toMatchObject({
          code: 'malformed-message',
        });
      });

      test('past kindgi-timeout-ms: deadline-exceeded, promptly', async () => {
        const started = Date.now();
        const answer = response(
          await invoke(service, toolCall('conformance.sleep', { ms: 5_000 }), {
            'kindgi-timeout-ms': '300',
          }),
        );
        expect(answer).toMatchObject({
          kind: 'error',
          code: 'deadline-exceeded',
          toolId: 'conformance.sleep',
        });
        expect(Date.now() - started).toBeLessThan(3_000);
      });

      test('a caller that disconnects: the call ends as cancelled', async () => {
        const controller = new AbortController();
        const release = join(workDir, 'release-disconnect');
        const pending = invoke(
          service,
          toolCall('conformance.hold', { release }),
          {},
          controller.signal,
        ).catch(() => undefined);
        try {
          await untilHeld(service, release);
          controller.abort();
          await pending;
          await waitFor(
            () =>
              service.events.find(
                (e) =>
                  e.kind === 'call' && e.id === 'conformance.hold' && e.outcome === 'cancelled',
              ),
            SERVICE_WAIT_MS,
            'a cancelled call line',
          );
        } finally {
          await writeFile(release, '');
        }
      });
    });

    describe('checks', () => {
      test('a passing and a failing verdict', async () => {
        const passed = response(
          await invoke(
            service,
            checkCall('conformance.checks.min-length', { minLength: 2 }, 'hello'),
          ),
        );
        expect(passed).toMatchObject({ kind: 'check-result', result: { passed: true } });
        const failed = response(
          await invoke(service, checkCall('conformance.checks.min-length', { minLength: 3 }, 'a')),
        );
        expect(failed).toMatchObject({
          kind: 'check-result',
          result: { passed: false, reason: 'too short' },
        });
      });

      test("a config that breaks the check's configSchema: input-validation-failed, and the check doesn't run", async () => {
        const negative = response(
          await invoke(service, checkCall('conformance.checks.min-length', { minLength: -1 }, 'x')),
        );
        // The message names the first issue: a runtime reports a check's error
        // by its code and message alone.
        expect(negative).toMatchObject({
          kind: 'error',
          code: 'input-validation-failed',
          checkId: 'conformance.checks.min-length',
          message:
            'Check "conformance.checks.min-length" config failed validation at /minLength: must be >= 0',
        });
        expect(negative.issues).toContainEqual(
          expect.objectContaining({ instancePath: '/minLength', keyword: 'minimum' }),
        );
        const wrongType = response(
          await invoke(
            service,
            checkCall('conformance.checks.min-length', { minLength: 'three' }, 'x'),
          ),
        );
        expect(wrongType).toMatchObject({ kind: 'error', code: 'input-validation-failed' });
        expect(wrongType.issues).toContainEqual(
          expect.objectContaining({ instancePath: '/minLength', keyword: 'type' }),
        );
      });

      test('an unknown check: check-not-in-pack', async () => {
        const answer = response(
          await invoke(service, checkCall('conformance.checks.nope', {}, 'x')),
        );
        expect(answer).toMatchObject({
          kind: 'error',
          code: 'check-not-in-pack',
          checkId: 'conformance.checks.nope',
        });
      });

      test('a check that throws: handler-throw', async () => {
        const answer = response(
          await invoke(service, checkCall('conformance.checks.throws', {}, 'x')),
        );
        expect(answer).toMatchObject({
          kind: 'error',
          code: 'handler-throw',
          checkId: 'conformance.checks.throws',
        });
        expect(String(answer.message)).toContain('check boom');
      });
    });
  });
}

/**
 * A pack service built with an older SDK, called by a newer runtime: the
 * call context and the check trace carry fields the older service has no
 * name for (`projectId`, `orgId`, pack protocol 2.3.0). It answers them as
 * before. A pack service checks only the envelope's `v` and the context's
 * `tenantId` and `runId`, so an added optional field never fails a call:
 * a TypeScript service passes it to the handler, a Python one drops it.
 * Run it against a released pack service (`target`), with the fixture pack
 * indexed by that release's indexer.
 */
export function describeCallContextCompatibility(target: PackServiceTarget): void {
  const spec = specValidators();
  const newer = {
    ...CTX,
    projectId: 'project-1',
    orgId: 'org-1',
    settings: { 'acme.weights': { recency: 0.7 } },
  };

  describe(`an older pack service, called by a newer runtime — ${target.name}`, () => {
    let workDir = '';
    let service: RunningService | undefined;

    beforeAll(async () => {
      workDir = await mkdtemp(join(tmpdir(), 'kindgi-conformance-compat-'));
      const indexPath = join(workDir, 'index.json');
      await target.buildIndex(indexPath, PINS);
      service = await startService(target, indexPath);
    }, 120_000);

    afterAll(async () => {
      await service?.terminate();
      if (workDir !== '') await rm(workDir, { recursive: true, force: true });
    });

    test('a tool call whose context has the project and org: answered', async () => {
      if (service === undefined) throw new Error('the service did not start');
      const answer = await invoke(
        service,
        toolCall('conformance.echo', { message: 'hi' }, { ctx: newer }),
      );
      expect(answer.status).toBe(200);
      expectValid(spec.response, answer.json);
      expect(answer.json).toMatchObject({ kind: 'result', output: { message: 'hi' } });
    });

    test('a check whose trace has the project and org: answered', async () => {
      if (service === undefined) throw new Error('the service did not start');
      const message = checkCall('conformance.checks.min-length', { minLength: 2 }, 'hello');
      const trace = { ...(message.trace as Record<string, unknown>), ...newer };
      const answer = await invoke(service, { ...message, trace });
      expect(answer.status).toBe(200);
      expectValid(spec.response, answer.json);
      expect(answer.json).toMatchObject({ kind: 'check-result', result: { passed: true } });
    });
  });
}
