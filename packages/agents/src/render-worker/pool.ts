// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pool of long-lived child processes that render tenants' templates, so
 * no template can hold up the server's own thread: a render that runs past
 * `renderLimitMs` has its worker stopped, wherever liquidjs is in it, and
 * one past the worker's heap stops it too. The pool takes the waiting
 * tenants in turn, so one tenant's renders can't keep another's waiting
 * behind them.
 *
 * A render worker is a child process, not a worker thread: a thread shares
 * the server's heap, so a template that exhausts it takes the whole process
 * down; a child has its own. The fork is explicit — the child inherits only
 * the server's timezone and locale (so a template's dates render there as
 * they would in-process), never the rest of the server's environment with
 * its database URLs, KMS settings and tokens; its `execArgv` is the heap cap
 * alone (so a `--inspect` on the server isn't inherited); and no inherited
 * file descriptors beyond the IPC channel. Its stderr is piped (not shared)
 * so the pool can tell a render that ran out of memory from one that stopped
 * for another reason.
 */

import { type ChildProcess, fork } from 'node:child_process';

import { type TenantInputBounds, type TenantWork, tenantInputBounds } from '@kindgi/bounds';

import { memoryLimitProblem, renderLimitProblem } from '../liquid.js';
import { admitRender } from '../render-budget.js';
import {
  TemplateRenderError,
  type TemplateRenderInput,
  type TemplateRenderer,
} from '../template-renderer.js';

import type { RenderInit, RenderReply, RenderRequest, WorkerMessage } from './messages.js';

/**
 * How long past `renderLimitMs` a render's worker is stopped: the time for
 * the render to reach the worker and its answer to come back.
 */
export const STOP_MARGIN_MS = 100;

/**
 * How long a worker has to stop on SIGTERM before `stop()` escalates to
 * SIGKILL, and how long it then waits for the forced exit before giving up. A
 * worker is only stopped once its render has finished (`close()` lets running
 * renders end first) and it installs no SIGTERM handler, so a healthy one
 * exits at once; this bounds only a worker wedged past stopping, so a stop —
 * and the stop phase of `close()` — settles within 2 × this and never hangs.
 */
export const STOP_SIGKILL_MS = 1_000;

/** How much of a worker's stderr the pool keeps, to read why it stopped. */
const STDERR_TAIL = 4096;

/** V8 prints one of these when a process runs past `--max-old-space-size`. */
const OUT_OF_MEMORY = /JavaScript heap out of memory|Reached heap limit/;

/**
 * The only environment a render worker inherits from the server: the
 * timezone and the locale. liquidjs's `date` filter formats in the local
 * zone and Intl's default locale, both read from these at start-up, so a
 * worker without them would render dates differently from an in-process
 * render. Node resolves the locale from `LC_ALL`, then `LC_MESSAGES`, then
 * `LANG`. Nothing else of the server's — its database URLs, KMS settings or
 * tokens — reaches the process that runs untrusted templates.
 */
const LOCALE_ENV = ['TZ', 'LANG', 'LC_ALL', 'LC_MESSAGES'] as const;

/** `createWorkerTemplateRenderer`'s options. */
export interface WorkerTemplateRendererOptions {
  /** How many renders run at once, each in a child process of its own: 1 or more. */
  readonly workers: number;
  /**
   * Each worker's heap cap in MiB (Node's `--max-old-space-size`), the
   * backstop to the bounds' `memoryLimit`: a render that takes its worker
   * past it fails with the memory limit's message, and the worker is
   * replaced. Node's default when unset.
   */
  readonly maxOldSpaceMb?: number;
}

/** A `TemplateRenderer` that renders in child processes, until it's closed. */
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
  readonly child: ChildProcess;
  /** The tail of the worker's stderr, kept to say why a worker that couldn't start didn't. */
  stderr: string;
  /** Set when V8's out-of-heap message appears on stderr, so an exit after it reads as the memory limit. */
  outOfMemory: boolean;
  /** It has started and said so: only then is it sent renders, so its start-up is never timed or charged. */
  ready: boolean;
  /** The render it's doing: `id` is the one sent to the worker. */
  running: { readonly id: number; readonly job: Job; readonly timer?: NodeJS.Timeout } | undefined;
}

/**
 * The pool, with the worker script it runs: the package's own
 * (`createWorkerTemplateRenderer`), or a test's.
 */
export class WorkerPool implements WorkerTemplateRenderer {
  /**
   * One place per worker. A stopped worker is replaced at once; a place
   * stays empty only after a worker that couldn't start, or while closing,
   * until a render needs it again.
   */
  private readonly slots: (Slot | undefined)[];
  /** Each tenant's renders waiting for a worker; the tenants in the order they take turns. */
  private readonly queues = new Map<string, Job[]>();
  private readonly bounds: TenantInputBounds;
  /** The child's `execArgv`: the heap cap alone, so the server's flags aren't inherited. */
  private readonly execArgv: readonly string[];
  /** The child's environment: the server's timezone and locale, nothing else. */
  private readonly childEnv: Record<string, string>;
  private nextId = 0;
  private closing: Promise<void> | undefined;
  private drained: (() => void) | undefined;

  constructor(
    private readonly script: URL,
    options: WorkerTemplateRendererOptions,
  ) {
    if (!Number.isInteger(options.workers) || options.workers < 1) {
      throw new RangeError(
        `A worker template renderer needs 1 or more workers, not ${options.workers}.`,
      );
    }
    if (
      options.maxOldSpaceMb !== undefined &&
      (!Number.isInteger(options.maxOldSpaceMb) || options.maxOldSpaceMb < 1)
    ) {
      // 0 would start the worker uncapped (Node reads --max-old-space-size=0
      // as unset), and a fraction, a negative or NaN makes every worker fail
      // to start, seen only per render — so refuse it here, as with workers.
      throw new RangeError(
        `A worker template renderer's maxOldSpaceMb must be a positive whole number of MiB, not ${options.maxOldSpaceMb}.`,
      );
    }
    this.execArgv =
      options.maxOldSpaceMb !== undefined ? [`--max-old-space-size=${options.maxOldSpaceMb}`] : [];
    // The server's bounds, set at boot: its workers render under the same.
    this.bounds = tenantInputBounds();
    // The server's timezone and locale, so a worker renders dates as in-process.
    this.childEnv = localeEnv();
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
    // Each stop() holds the event loop with a ref'd timer while it waits, so a
    // plain `await close()` can't let the loop drain and the process exit
    // before the workers' exit settles this promise.
    await Promise.all(
      this.slots.map((slot, index) => {
        this.slots[index] = undefined;
        return slot === undefined ? undefined : stop(slot.child);
      }),
    );
  }

  /**
   * Hands waiting renders to the ready workers that have none. While
   * renders wait, a worker still starting keeps the process running.
   */
  private dispatch(): void {
    for (let index = 0; index < this.slots.length; index += 1) {
      if (this.queues.size === 0) break;
      let slot = this.slots[index];
      if (slot === undefined) {
        slot = this.spawn();
        this.slots[index] = slot;
      }
      if (!slot.ready) {
        refWorker(slot.child);
        continue;
      }
      while (slot.running === undefined) {
        const job = this.next();
        if (job === undefined) break;
        this.start(slot, index, job);
      }
    }
    this.checkDrained();
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
      slot.child.send(request);
    } catch (cause) {
      // A scope that can't be serialized to the child (a function in it, say).
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
    refWorker(slot.child);
  }

  private spawn(): Slot {
    const child = fork(this.script, [], {
      // Explicit: only the server's timezone and locale (so dates render as
      // in-process), never the rest of its environment (database URLs, KMS,
      // tokens) beside untrusted templates; no inherited flags; no shared fds
      // but the IPC channel; and the structured clone that carries the
      // bounds' Infinity and the render scope as a worker thread's
      // `postMessage` would.
      env: { ...this.childEnv },
      execArgv: [...this.execArgv],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const slot: Slot = { child, stderr: '', outOfMemory: false, ready: false, running: undefined };
    child.stderr?.on('data', (chunk: Buffer) => {
      slot.stderr = (slot.stderr + chunk.toString()).slice(-STDERR_TAIL);
      // Catch V8's out-of-heap message as it arrives: the long native stack
      // trace after it would push it out of the kept tail before the exit.
      if (OUT_OF_MEMORY.test(slot.stderr)) slot.outOfMemory = true;
    });
    child.on('message', (message: WorkerMessage) => {
      if ('ready' in message) {
        slot.ready = true;
        this.dispatch();
        if (slot.running === undefined) unrefWorker(slot.child);
      } else {
        this.replied(slot, message);
      }
    });
    child.on('error', (error) => this.retire(slot, this.slots.indexOf(slot), error));
    // 'close', not 'exit': the worker's stderr is fully read by then, so the
    // pool can tell a render out of memory from a worker stopped otherwise,
    // and can say why one couldn't start.
    child.on('close', (code, signal) =>
      this.retire(slot, this.slots.indexOf(slot), this.exitError(slot, code, signal)),
    );
    // The bounds first: the worker configures them, then says it's ready.
    child.send({ bounds: this.bounds } satisfies RenderInit);
    // Idle from the start: the 'message' listener just refed the channel, so
    // unref the channel and stderr as well, or the pool holds the process up.
    unrefWorker(child);
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
   * gone): its render fails with `error`, and it's stopped.
   * - **One that had started** is replaced at once, so the next render
   *   doesn't wait for a worker to start (none while closing: a render
   *   still waiting then starts one).
   * - **One that couldn't start** fails the renders waiting, with why, and
   *   its place stays empty until the next render: a broken install
   *   doesn't start workers without end.
   */
  private retire(slot: Slot, index: number, error: unknown): void {
    // Already retired: the exit that follows a crash, or a stop.
    if (index === -1 || this.slots[index] !== slot) return;
    const running = slot.running;
    if (running !== undefined) {
      this.finish(slot);
      running.job.reject(error);
    }
    slot.child.kill();
    if (slot.ready) {
      this.slots[index] = this.closing === undefined ? this.spawn() : undefined;
    } else {
      this.slots[index] = undefined;
      // Why it couldn't start is on its stderr (a broken install names the
      // module); the spawn error is the fallback when it wrote nothing.
      const reason = slot.stderr.trim();
      this.rejectWaiting(
        new Error("The template's render worker couldn't start.", {
          cause: reason.length > 0 ? reason : error,
        }),
      );
    }
    this.dispatch();
  }

  /** Fails every render waiting for a worker with `error`. */
  private rejectWaiting(error: unknown): void {
    const waiting = [...this.queues.values()].flat();
    this.queues.clear();
    for (const job of waiting) {
      job.work.end();
      job.reject(error);
    }
  }

  /**
   * What a worker's exit means for its render: the memory limit when it ran
   * out of heap (V8 says so on the stderr the pool kept), else that the
   * worker stopped, with the exit code or signal.
   */
  private exitError(slot: Slot, code: number | null, signal: NodeJS.Signals | null): unknown {
    if (slot.outOfMemory) {
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
    const how = signal !== null ? `signal ${signal}` : `exit code ${code}`;
    const reason = slot.stderr.trim();
    return new Error(`The template's render worker stopped (${how}).`, {
      // What it last wrote, when it wrote anything: the reason it stopped.
      ...(reason.length > 0 && { cause: reason }),
    });
  }

  /** The worker's render is over: its timer cleared, its time charged. */
  private finish(slot: Slot): void {
    const running = slot.running;
    if (running === undefined) return;
    slot.running = undefined;
    clearTimeout(running.timer);
    running.job.work.end();
    unrefWorker(slot.child);
  }

  private idle(): boolean {
    return this.queues.size === 0 && this.slots.every((slot) => slot?.running === undefined);
  }

  private checkDrained(): void {
    if (this.drained !== undefined && this.idle()) this.drained();
  }
}

/**
 * Stops a worker and waits for it to go, holding the event loop with a ref'd
 * timer meanwhile — idle workers are unref'd, and the child's own handles can
 * drop their refs on the same turn that delivers 'exit', so re-reffing the
 * child doesn't reliably hold the loop; without the timer a plain
 * `await close()` could let the loop drain and the process exit with close()
 * unsettled. A worker already gone settles at once; otherwise SIGTERM, then
 * SIGKILL after `STOP_SIGKILL_MS` if it hasn't stopped, then give up one grace
 * later — so a stop settles within 2 × `STOP_SIGKILL_MS` and can never hang on
 * a wedged worker. Exported for the pool's tests.
 */
export function stop(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    // A worker already gone won't emit 'exit' again — its exitCode or
    // signalCode is set — so settle at once. Nothing can exit between this
    // check and the listener below: both run in this one synchronous frame,
    // and Node delivers 'exit' only on a later turn.
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    // A ref'd timer holds the loop for as long as the stop is pending. SIGTERM
    // first; if the worker hasn't gone within the grace, SIGKILL and wait one
    // more grace for its exit, then give up — a wedged worker can't hold the
    // loop, or close(), open.
    let deadline = setTimeout(() => {
      child.kill('SIGKILL');
      deadline = setTimeout(resolve, STOP_SIGKILL_MS);
    }, STOP_SIGKILL_MS);
    child.once('exit', () => {
      clearTimeout(deadline);
      resolve();
    });
    child.kill();
  });
}

/** The server's timezone and locale, the only environment a worker inherits. */
function localeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of LOCALE_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Lets an idle worker not keep the process running. `child.unref()` alone
 * doesn't: the IPC channel (a `message` listener refs it) and the piped
 * stderr each hold the event loop, so unref those too.
 */
function unrefWorker(child: ChildProcess): void {
  child.unref();
  child.channel?.unref();
  // stderr is a Socket at runtime (it has ref/unref); the stdio type is Readable.
  (child.stderr as { unref?(): void } | null)?.unref?.();
}

/** A render in flight keeps the process running: the handle, its IPC channel and its stderr. */
function refWorker(child: ChildProcess): void {
  child.ref();
  child.channel?.ref();
  (child.stderr as { ref?(): void } | null)?.ref?.();
}
