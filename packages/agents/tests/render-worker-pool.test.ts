// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The render pool, with a stand-in worker that does what each template's
 * name asks: a render past the limit has its worker stopped while the
 * server's own thread stays free, a worker past its heap fails its render
 * with the memory limit's message, a worker that crashes or stops is
 * replaced, tenants waiting take turns, renders count toward the tenant's
 * budget, and closing lets what's taken finish. The real worker's renders
 * are `render-worker.test.ts`'s.
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import {
  HOSTED_BOUNDS,
  SELF_HOSTED_BOUNDS,
  TenantBudgetError,
  type TenantInputBounds,
  runAsTenant,
} from '@kindgi/bounds';
import { overrideTenantInputBounds } from '@kindgi/bounds/testing';
import type { TenantId } from '@kindgi/types';
import { afterEach, describe, expect, test } from 'vitest';

import { TemplateRenderBudgetError } from '../src/render-budget.js';
import {
  RENDERER_CLOSED,
  STOP_MARGIN_MS,
  STOP_SIGKILL_MS,
  WorkerPool,
  type WorkerTemplateRendererOptions,
  stop,
} from '../src/render-worker/pool.js';
import { TemplateRenderError } from '../src/template-renderer.js';

const FAKE = new URL('./fixtures/fake-render-worker.mjs', import.meta.url);
const SLOW_START = new URL('./fixtures/slow-start-render-worker.mjs', import.meta.url);
const FAILED_START = new URL('./fixtures/failed-start-render-worker.mjs', import.meta.url);
const REPORT_ENV = new URL('./fixtures/report-env-render-worker.mjs', import.meta.url);
const IGNORES_SIGTERM = new URL('./fixtures/ignores-sigterm-render-worker.mjs', import.meta.url);

let restore: (() => void) | undefined;
const pools: WorkerPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  restore?.();
  restore = undefined;
});

/** A pool of stand-in workers, under `bounds` (the hosted ones with a short render limit unless set). */
function poolOf(
  options: WorkerTemplateRendererOptions,
  bounds: TenantInputBounds = withRenderLimit(200),
  script: URL = FAKE,
): WorkerPool {
  restore?.();
  restore = overrideTenantInputBounds(bounds);
  const pool = new WorkerPool(script, options);
  pools.push(pool);
  return pool;
}

function withRenderLimit(renderLimitMs: number): TenantInputBounds {
  return { ...HOSTED_BOUNDS, liquid: { ...HOSTED_BOUNDS.liquid, renderLimitMs } };
}

const tenantA = 'tenant-a' as TenantId;
const tenantB = 'tenant-b' as TenantId;

function render(pool: WorkerPool, template: string, tenantId: TenantId = tenantA) {
  return pool.render({ tenantId, template, scope: {} });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('not rejected');
}

/** The longest any 5 ms timer on this thread waited past its time while `promise` was pending. */
async function longestLag(promise: Promise<unknown>): Promise<number> {
  let longest = 0;
  let expected = performance.now() + 5;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - expected);
    expected = now + 5;
  }, 5);
  try {
    await promise.catch(() => undefined);
  } finally {
    clearInterval(timer);
  }
  return longest;
}

describe('the render pool', () => {
  test('renders, and answers with what the worker gives back', async () => {
    const pool = poolOf({ workers: 2 });
    await expect(
      pool.render({ tenantId: tenantA, template: 'Hi', scope: { suffix: '!' } }),
    ).resolves.toBe('Hi!');
    const failure = await rejection(render(pool, 'fail'));
    expect(failure).toBeInstanceOf(TemplateRenderError);
    expect(failure).toMatchObject({
      code: 'render-failure',
      message: 'Template render failed: as asked',
    });
  });

  test('a render past renderLimitMs has its worker stopped, and this thread stays free meanwhile', async () => {
    const pool = poolOf({ workers: 1 });
    const started = performance.now();
    const stalled = render(pool, 'spin');
    const lag = await longestLag(stalled);
    const failure = await rejection(stalled);
    const tookMs = performance.now() - started;
    expect(failure).toBeInstanceOf(TemplateRenderError);
    expect(failure).toMatchObject({
      code: 'render-failure',
      message: 'Template render failed: the render took over the limit of 200 ms',
    });
    expect(tookMs).toBeGreaterThanOrEqual(200 + STOP_MARGIN_MS - 5);
    expect(tookMs).toBeLessThan(2_000);
    // Had the render held this thread, a timer would have waited the whole 300 ms.
    expect(lag).toBeLessThan(150);
    // A new worker takes the next render.
    await expect(render(pool, 'after')).resolves.toBe('after');
  });

  test('other renders go on in the other workers while one stalls', async () => {
    const pool = poolOf({ workers: 2 });
    const stalled = render(pool, 'spin');
    const others = await Promise.all([render(pool, 'a'), render(pool, 'b', tenantB)]);
    expect(others).toEqual(['a', 'b']);
    await rejection(stalled);
  });

  test('a render past the worker’s heap fails with the memory limit’s message; the pool goes on', async () => {
    const pool = poolOf({ workers: 1, maxOldSpaceMb: 32 }, withRenderLimit(30_000));
    const failure = await rejection(render(pool, 'grow'));
    expect(failure).toBeInstanceOf(TemplateRenderError);
    expect(failure).toMatchObject({
      code: 'render-failure',
      message: `Template render failed: the render went over its memory limit of ${HOSTED_BOUNDS.liquid.memoryLimit}`,
    });
    await expect(render(pool, 'after')).resolves.toBe('after');
  });

  test('with no memoryLimit, a render past the worker’s heap says it ran out of the memory its worker may use', async () => {
    // A tenant whose bounds name no memory limit of their own: the message
    // can't quote a number, so it says the worker ran out of the memory it may use.
    const noMemoryLimit: TenantInputBounds = {
      ...SELF_HOSTED_BOUNDS,
      liquid: { ...SELF_HOSTED_BOUNDS.liquid, memoryLimit: Number.POSITIVE_INFINITY },
    };
    const pool = poolOf({ workers: 1, maxOldSpaceMb: 32 }, noMemoryLimit);
    expect(await rejection(render(pool, 'grow'))).toMatchObject({
      message: 'Template render failed: the render ran out of the memory its worker may use',
    });
  });

  test('a worker that crashes or stops fails its render with why, and is replaced', async () => {
    const pool = poolOf({ workers: 1 });
    const crashed = await rejection(render(pool, 'crash'));
    expect(crashed).toMatchObject({
      message: "The template's render worker stopped (exit code 1).",
    });
    // The worker's own stderr, as it crashed, says why it stopped.
    expect((crashed as Error).cause).toMatch(/the worker crashed/);
    await expect(render(pool, 'next')).resolves.toBe('next');
    expect(await rejection(render(pool, 'exit'))).toMatchObject({
      message: "The template's render worker stopped (exit code 3).",
    });
    await expect(render(pool, 'next')).resolves.toBe('next');
  });

  test('a worker’s start-up isn’t timed against the render limit, or charged to the tenant', async () => {
    // Its worker takes 500 ms to start: past the 200 ms limit and its margin, and past the budget.
    const pool = poolOf(
      { workers: 1 },
      { ...withRenderLimit(200), templateRenderBudgetMs: 100 },
      SLOW_START,
    );
    await expect(runAsTenant(tenantA, () => render(pool, 'first'))).resolves.toBe('first');
    await expect(runAsTenant(tenantA, () => render(pool, 'second'))).resolves.toBe('second');
  });

  test('a stopped worker is replaced at once, so the next render doesn’t wait for one to start', async () => {
    const pool = poolOf({ workers: 1 }, withRenderLimit(200), SLOW_START);
    await rejection(render(pool, 'spin'));
    // Long enough for a worker started at the stop to be ready (500 ms), with room for a busy machine.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const started = performance.now();
    await expect(render(pool, 'next')).resolves.toBe('next');
    // A worker started only now would take 500 ms at least.
    expect(performance.now() - started).toBeLessThan(450);
  });

  test('a worker that can’t start fails the renders waiting for it, and the next render tries again', async () => {
    const pool = poolOf({ workers: 1 }, withRenderLimit(200), FAILED_START);
    for (const template of ['first', 'second']) {
      const failure = await rejection(render(pool, template));
      expect(failure).toMatchObject({
        message: "The template's render worker couldn't start.",
      });
      // Its stderr says why — the error it threw as it loaded.
      expect((failure as Error).cause).toMatch(/the worker could not load/);
    }
  });

  test('a scope that can’t be copied to a worker fails its render; the worker takes the next', async () => {
    const pool = poolOf({ workers: 1 });
    const failure = await rejection(
      pool.render({ tenantId: tenantA, template: 'x', scope: { call: () => 1 } }),
    );
    // The structured clone that carries the scope to the child can't copy a
    // function (what a worker thread's postMessage reported too).
    expect((failure as Error).message).toMatch(/could not be cloned/);
    await expect(render(pool, 'next')).resolves.toBe('next');
  });

  test('tenants waiting for a worker take turns', async () => {
    const pool = poolOf({ workers: 1 });
    // The worker started, so the first render goes straight to it.
    await render(pool, 'warm');
    const done: string[] = [];
    const queued = [
      ['busy:50', tenantA],
      ['a2', tenantA],
      ['a3', tenantA],
      ['b1', tenantB],
      ['b2', tenantB],
    ].map(([template, tenant]) =>
      render(pool, template as string, tenant as TenantId).then((out) => done.push(out)),
    );
    await Promise.all(queued);
    // The first went straight to the worker; then tenant a's next, b's first, and so on.
    expect(done).toEqual(['busy:50', 'a2', 'b1', 'a3', 'b2']);
  });

  test('a render counts toward the tenant’s budget, and past it the next is refused before it waits', async () => {
    const pool = poolOf({ workers: 1 }, { ...HOSTED_BOUNDS, templateRenderBudgetMs: 0.001 });
    await expect(runAsTenant(tenantA, () => render(pool, 'busy:2'))).resolves.toBe('busy:2');
    const refusal = await rejection(runAsTenant(tenantA, () => render(pool, 'x')));
    expect(refusal).toBeInstanceOf(TemplateRenderBudgetError);
    expect(refusal).toBeInstanceOf(TenantBudgetError);
    expect(refusal).toMatchObject({ limit: 'template-render-time', budgetMs: 0.001 });
    // Another tenant's budget is its own, and outside any tenant's scope nothing counts.
    await expect(runAsTenant(tenantB, () => render(pool, 'x'))).resolves.toBe('x');
    for (let i = 0; i < 3; i += 1) await expect(render(pool, 'x')).resolves.toBe('x');
  });

  test('a render stopped at the limit counts toward the budget too', async () => {
    const pool = poolOf({ workers: 1 }, { ...withRenderLimit(50), templateRenderBudgetMs: 100 });
    await rejection(runAsTenant(tenantA, () => render(pool, 'spin')));
    // 50 ms plus the margin, past the 100 ms budget.
    expect(await rejection(runAsTenant(tenantA, () => render(pool, 'x')))).toBeInstanceOf(
      TemplateRenderBudgetError,
    );
  });

  test('closing lets the renders it took finish, then refuses more', async () => {
    const pool = poolOf({ workers: 1 });
    const running = render(pool, 'busy:50');
    const waiting = render(pool, 'waiting');
    const closed = pool.close();
    expect(pool.close()).toBe(closed);
    expect(await rejection(render(pool, 'late'))).toMatchObject({ message: RENDERER_CLOSED });
    await expect(running).resolves.toBe('busy:50');
    await expect(waiting).resolves.toBe('waiting');
    await closed;
  });

  test('a worker that won’t stop on SIGTERM is SIGKILL’d after the grace, so close() still settles', async () => {
    const pool = poolOf({ workers: 1 }, withRenderLimit(200), IGNORES_SIGTERM);
    // Render once, so the worker has fully started and its SIGTERM trap is in place.
    await expect(render(pool, 'up')).resolves.toBe('up');
    const started = performance.now();
    await pool.close();
    const tookMs = performance.now() - started;
    // SIGTERM is ignored, so close() can only settle once the SIGKILL
    // escalation fires after the grace — without it, close() would wait on an
    // 'exit' that never comes. It settles after the grace, not before it (not
    // an immediate SIGKILL) and not never (not a hang).
    expect(tookMs).toBeGreaterThanOrEqual(STOP_SIGKILL_MS - 50);
    expect(tookMs).toBeLessThan(STOP_SIGKILL_MS + 2_000);
  });

  test('stop() gives up a bounded time after SIGKILL when a worker never exits', async () => {
    // A stand-in child that ignores both signals and never emits 'exit' — the
    // one case the SIGTERM-trapping worker above can't reach, since a real
    // process does exit on SIGKILL. stop() must still settle: SIGKILL after the
    // grace, then give up one grace later, so close() can never hang.
    const signals: (NodeJS.Signals | number | undefined)[] = [];
    const neverExits = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: (signal?: NodeJS.Signals | number) => {
        signals.push(signal);
        return true;
      },
    }) as unknown as ChildProcess;
    const started = performance.now();
    await stop(neverExits);
    const tookMs = performance.now() - started;
    expect(signals).toContain('SIGKILL');
    expect(tookMs).toBeGreaterThanOrEqual(2 * STOP_SIGKILL_MS - 100);
    expect(tookMs).toBeLessThan(2 * STOP_SIGKILL_MS + 1_000);
  });

  test('needs 1 or more workers', () => {
    restore = overrideTenantInputBounds(HOSTED_BOUNDS);
    for (const workers of [0, -1, 1.5, Number.NaN]) {
      expect(() => new WorkerPool(FAKE, { workers })).toThrow(
        `A worker template renderer needs 1 or more workers, not ${workers}.`,
      );
    }
  });

  test('a maxOldSpaceMb that isn’t a positive whole number is refused', () => {
    restore = overrideTenantInputBounds(HOSTED_BOUNDS);
    // 0 would run the worker uncapped (Node reads --max-old-space-size=0 as
    // unset); a fraction, a negative or NaN would make every worker fail to
    // start, seen only when a render is attempted. Refuse it at construction,
    // as with workers.
    for (const maxOldSpaceMb of [0, -5, 1.5, Number.NaN]) {
      expect(() => new WorkerPool(FAKE, { workers: 1, maxOldSpaceMb })).toThrow(
        `A worker template renderer's maxOldSpaceMb must be a positive whole number of MiB, not ${maxOldSpaceMb}.`,
      );
    }
  });
});

describe('the fork is isolated from the server', () => {
  test('the worker gets only the server’s timezone and locale, and no Node flags', async () => {
    // A secret-like value beside the server, as a database URL or a token is.
    const MARKER = 'KINDGI_RENDER_WORKER_MARKER';
    const savedMarker = process.env[MARKER];
    process.env[MARKER] = 'parent-only-secret';
    try {
      const pool = poolOf({ workers: 1, maxOldSpaceMb: 64 }, HOSTED_BOUNDS, REPORT_ENV);
      const report = JSON.parse(await render(pool, 'report')) as {
        readonly envKeys: readonly string[];
        readonly marker: string | null;
        readonly execArgv: readonly string[];
      };
      // The fork forwards only the server's timezone and locale, so the
      // server's secrets (a database URL, a token) stay out of the worker: it
      // can't read the marker. Were `env` dropped from the fork call, the
      // worker would inherit the whole environment and this would fail.
      expect(report.marker).toBeNull();
      expect(report.envKeys).not.toContain(MARKER);
      // Every variable the worker does see is in the locale allowlist, or one
      // the OS adds to any child itself (macOS: __CF_USER_TEXT_ENCODING).
      const ALLOWED = new Set(['TZ', 'LANG', 'LC_ALL', 'LC_MESSAGES']);
      const unexpected = report.envKeys.filter(
        (key) => !ALLOWED.has(key) && !key.startsWith('__CF'),
      );
      expect(unexpected).toEqual([]);
      // The fork's `execArgv` is the heap cap alone: a `--inspect` on the
      // server, or a coverage flag, isn't inherited.
      expect(report.execArgv).toEqual(['--max-old-space-size=64']);
    } finally {
      if (savedMarker === undefined) delete process.env[MARKER];
      else process.env[MARKER] = savedMarker;
    }
  });
});
