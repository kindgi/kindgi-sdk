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
  WorkerPool,
  type WorkerTemplateRendererOptions,
} from '../src/render-worker/pool.js';
import { TemplateRenderError } from '../src/template-renderer.js';

const FAKE = new URL('./fixtures/fake-render-thread.mjs', import.meta.url);

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
): WorkerPool {
  restore?.();
  restore = overrideTenantInputBounds(bounds);
  const pool = new WorkerPool(FAKE, options);
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
    const pool = poolOf(
      { workers: 1, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 } },
      withRenderLimit(30_000),
    );
    const failure = await rejection(render(pool, 'grow'));
    expect(failure).toBeInstanceOf(TemplateRenderError);
    expect(failure).toMatchObject({
      code: 'render-failure',
      message: `Template render failed: the render went over its memory limit of ${HOSTED_BOUNDS.liquid.memoryLimit}`,
    });
    await expect(render(pool, 'after')).resolves.toBe('after');
  });

  test('with no memoryLimit, a render past the worker’s heap says it ran out of the memory its worker may use', async () => {
    const pool = poolOf(
      { workers: 1, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 } },
      SELF_HOSTED_BOUNDS,
    );
    expect(await rejection(render(pool, 'grow'))).toMatchObject({
      message: 'Template render failed: the render ran out of the memory its worker may use',
    });
  });

  test('a worker that crashes or stops fails its render with why, and is replaced', async () => {
    const pool = poolOf({ workers: 1 });
    expect(await rejection(render(pool, 'crash'))).toMatchObject({ message: 'the worker crashed' });
    await expect(render(pool, 'next')).resolves.toBe('next');
    expect(await rejection(render(pool, 'exit'))).toMatchObject({
      message: "The template's render worker stopped (exit code 3).",
    });
    await expect(render(pool, 'next')).resolves.toBe('next');
  });

  test('a scope that can’t be copied to a worker fails its render; the worker takes the next', async () => {
    const pool = poolOf({ workers: 1 });
    const failure = await rejection(
      pool.render({ tenantId: tenantA, template: 'x', scope: { call: () => 1 } }),
    );
    expect((failure as Error).name).toBe('DataCloneError');
    await expect(render(pool, 'next')).resolves.toBe('next');
  });

  test('tenants waiting for a worker take turns', async () => {
    const pool = poolOf({ workers: 1 });
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

  test('needs 1 or more workers', () => {
    restore = overrideTenantInputBounds(HOSTED_BOUNDS);
    for (const workers of [0, -1, 1.5, Number.NaN]) {
      expect(() => new WorkerPool(FAKE, { workers })).toThrow(
        `A worker template renderer needs 1 or more workers, not ${workers}.`,
      );
    }
  });
});
