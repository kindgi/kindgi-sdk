// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pool of long-lived worker threads that render tenants' templates, so
 * no template can hold up the server's own thread: a render that runs
 * past `renderLimitMs` has its worker stopped, wherever liquidjs is in
 * it, and one past the worker's heap stops it too. The pool takes the
 * waiting tenants in turn, so one tenant's renders can't keep another's
 * waiting behind them.
 */

import { type ResourceLimits, Worker } from 'node:worker_threads';

import { type TenantInputBounds, type TenantWork, tenantInputBounds } from '@kindgi/bounds';

import { memoryLimitProblem, renderLimitProblem } from '../liquid.js';
import { admitRender } from '../render-budget.js';
import {
  TemplateRenderError,
  type TemplateRenderInput,
  type TemplateRenderer,
} from '../template-renderer.js';

import type { RenderReply, RenderRequest, RenderWorkerData } from './messages.js';

/**
 * How long past `renderLimitMs` a render's worker is stopped: the time
 * for the render to reach the worker and its answer to come back.
 */
export const STOP_MARGIN_MS = 100;

/** `createWorkerTemplateRenderer`'s options. */
export interface WorkerTemplateRendererOptions {
  /** How many renders run at once, each in a worker thread of its own: 1 or more. */
  readonly workers: number;
  /**
   * Each worker's heap limits (Node's `resourceLimits`), the backstop to
   * the bounds' `memoryLimit`: a render that takes its worker past them
   * fails with the memory limit's message, and the worker is replaced.
   * Node's defaults when unset.
   */
  readonly resourceLimits?: ResourceLimits;
}

/** A `TemplateRenderer` that renders in worker threads, until it's closed. */
export interface WorkerTemplateRenderer extends TemplateRenderer {
  /**
   * Takes no more renders (a later one is refused), lets the ones it has
   * finish, then stops the workers.
   */
  close(): Promise<void>;
}

/** What a render the closed renderer won't take is told. */
export const RENDERER_CLOSED = 'The template renderer is closed.';

interface Job {
  readonly input: TemplateRenderInput;
  /** Its time, charged to the tenant's render budget from when a worker takes it. */
  readonly work: TenantWork;
  readonly resolve: (rendered: string) => void;
  readonly reject: (error: unknown) => void;
}

interface Slot {
  readonly worker: Worker;
  /** The render it's doing: `id` is the one sent to the worker. */
  running: { readonly id: number; readonly job: Job; readonly timer?: NodeJS.Timeout } | undefined;
}

/**
 * The pool, with the worker script it runs: the package's own
 * (`createWorkerTemplateRenderer`), or a test's.
 */
export class WorkerPool implements WorkerTemplateRenderer {
  /** One place per worker: empty once its worker stopped, until a render needs it again. */
  private readonly slots: (Slot | undefined)[];
  /** Each tenant's renders waiting for a worker; the tenants in the order they take turns. */
  private readonly queues = new Map<string, Job[]>();
  private readonly bounds: TenantInputBounds;
  private nextId = 0;
  private closing: Promise<void> | undefined;
  private drained: (() => void) | undefined;

  constructor(
    private readonly script: URL,
    private readonly options: WorkerTemplateRendererOptions,
  ) {
    if (!Number.isInteger(options.workers) || options.workers < 1) {
      throw new RangeError(
        `A worker template renderer needs 1 or more workers, not ${options.workers}.`,
      );
    }
    // The server's bounds, set at boot: its workers render under the same.
    this.bounds = tenantInputBounds();
    this.slots = Array.from({ length: options.workers }, () => this.spawn());
  }

  /**
   * Renders `input` in a worker. Refused with `TemplateRenderBudgetError`,
   * before it waits for one, when the current tenant (`runAsTenant`) has
   * spent its render budget; the render is charged to it from when a
   * worker takes it until it ends.
   */
  render(input: TemplateRenderInput): Promise<string> {
    if (this.closing !== undefined) return Promise.reject(new Error(RENDERER_CLOSED));
    let work: TenantWork;
    try {
      work = admitRender();
    } catch (refusal) {
      return Promise.reject(refusal);
    }
    return new Promise((resolve, reject) => {
      const job: Job = { input, work, resolve, reject };
      const queue = this.queues.get(input.tenantId);
      if (queue === undefined) this.queues.set(input.tenantId, [job]);
      else queue.push(job);
      this.dispatch();
    });
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    if (!this.idle()) {
      await new Promise<void>((resolve) => {
        this.drained = resolve;
      });
    }
    await Promise.all(
      this.slots.map((slot, index) => {
        this.slots[index] = undefined;
        return slot?.worker.terminate();
      }),
    );
  }

  /** Hands waiting renders to the workers that have none. */
  private dispatch(): void {
    for (let index = 0; index < this.slots.length; index += 1) {
      while (this.slots[index]?.running === undefined) {
        const job = this.next();
        if (job === undefined) {
          this.checkDrained();
          return;
        }
        let slot = this.slots[index];
        if (slot === undefined) {
          slot = this.spawn();
          this.slots[index] = slot;
        }
        this.start(slot, index, job);
      }
    }
  }

  /** The next render: the first waiting of the tenant whose turn it is, who then goes last. */
  private next(): Job | undefined {
    for (const [tenant, queue] of this.queues) {
      const job = queue.shift();
      this.queues.delete(tenant);
      if (queue.length > 0) this.queues.set(tenant, queue);
      return job;
    }
    return undefined;
  }

  private start(slot: Slot, index: number, job: Job): void {
    const id = this.nextId;
    this.nextId += 1;
    const request: RenderRequest = { id, template: job.input.template, scope: job.input.scope };
    try {
      slot.worker.postMessage(request);
    } catch (cause) {
      // A scope that can't be copied to another thread (a function in it, say).
      job.work.end();
      job.reject(cause);
      return;
    }
    job.work.start();
    const limitMs = this.bounds.liquid.renderLimitMs;
    slot.running = {
      id,
      job,
      ...(Number.isFinite(limitMs) && {
        timer: setTimeout(() => {
          this.retire(
            slot,
            index,
            new TemplateRenderError({
              code: 'render-failure',
              message: `Template render failed: ${renderLimitProblem(limitMs)}`,
            }),
          );
        }, limitMs + STOP_MARGIN_MS),
      }),
    };
    // A render in flight keeps the process running; an idle pool doesn't.
    slot.worker.ref();
  }

  private spawn(): Slot {
    const workerData: RenderWorkerData = { bounds: this.bounds };
    const worker = new Worker(this.script, {
      workerData,
      ...(this.options.resourceLimits !== undefined && {
        resourceLimits: this.options.resourceLimits,
      }),
    });
    const slot: Slot = { worker, running: undefined };
    worker.on('message', (reply: RenderReply) => this.replied(slot, reply));
    worker.on('messageerror', (error) => this.retire(slot, this.slots.indexOf(slot), error));
    worker.on('error', (error) => this.retire(slot, this.slots.indexOf(slot), this.crashed(error)));
    worker.on('exit', (code) =>
      this.retire(
        slot,
        this.slots.indexOf(slot),
        new Error(`The template's render worker stopped (exit code ${code}).`),
      ),
    );
    // After the listeners: a 'message' listener refs the worker's port again.
    worker.unref();
    return slot;
  }

  private replied(slot: Slot, reply: RenderReply): void {
    const running = slot.running;
    // An answer to a render already settled: one stopped at its limit.
    if (running === undefined || running.id !== reply.id) return;
    this.finish(slot);
    if ('rendered' in reply) running.job.resolve(reply.rendered);
    else running.job.reject(new TemplateRenderError(reply.error));
    this.dispatch();
  }

  /**
   * A worker done for (stopped at the render limit, out of memory, or
   * gone): its render fails with `error`, it's stopped, and its place is
   * empty until a render needs it.
   */
  private retire(slot: Slot, index: number, error: unknown): void {
    // Already retired: the exit that follows a crash, or a stop.
    if (index === -1 || this.slots[index] !== slot) return;
    this.slots[index] = undefined;
    const running = slot.running;
    if (running !== undefined) {
      this.finish(slot);
      running.job.reject(error);
    }
    void slot.worker.terminate();
    this.dispatch();
  }

  /** What a worker's crash means for its render: the memory limit, when it ran out of heap. */
  private crashed(error: unknown): unknown {
    if ((error as { readonly code?: unknown }).code !== 'ERR_WORKER_OUT_OF_MEMORY') return error;
    const { memoryLimit } = this.bounds.liquid;
    return new TemplateRenderError({
      code: 'render-failure',
      message: `Template render failed: ${
        Number.isFinite(memoryLimit)
          ? memoryLimitProblem(memoryLimit)
          : 'the render ran out of the memory its worker may use'
      }`,
    });
  }

  /** The worker's render is over: its timer cleared, its time charged. */
  private finish(slot: Slot): void {
    const running = slot.running;
    if (running === undefined) return;
    slot.running = undefined;
    clearTimeout(running.timer);
    running.job.work.end();
    slot.worker.unref();
  }

  private idle(): boolean {
    return this.queues.size === 0 && this.slots.every((slot) => slot?.running === undefined);
  }

  private checkDrained(): void {
    if (this.drained !== undefined && this.idle()) this.drained();
  }
}
