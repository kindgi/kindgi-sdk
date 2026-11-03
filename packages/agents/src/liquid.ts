// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The one Liquid engine for the templates agents render (instructions,
 * prompt blocks, drafted templates), and the one check each template
 * passes wherever it comes in: an agent's definition, a prompt block's
 * publish, a drafted template. What the check accepts is what the
 * renderer parses, since both use this engine.
 *
 * The engine takes its limits from the tenant input bounds when it's
 * made, so it's made for each use: a server sets the bounds after this
 * module loads.
 */

import { tenantInputBounds } from '@kindgi/bounds';
import {
  type Context,
  type Emitter,
  type FilterImplOptions,
  Liquid,
  Tag,
  type TagToken,
  type Template,
  type TopLevelToken,
  toValue,
} from 'liquidjs';

import { chargeRender } from './render-budget.js';

/** What a template that uses a partial is told, at a publish and at a render alike. */
export const NO_PARTIALS = "templates can't use include, render or layout";

class NoPartialsError extends Error {}

/** liquidjs's own message for a render over its memory limit. */
const MEMORY_LIMIT_EXCEEDED = 'memory alloc limit exceeded';

/** A filter's function, as liquidjs calls it. */
type FilterHandler = Extract<FilterImplOptions, (...args: never[]) => unknown>;

/** `include`, `render` and `layout`: refused as the template is parsed, at any depth. */
class NoPartials extends Tag {
  constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
    super(token, remain, liquid);
    throw new NoPartialsError(NO_PARTIALS);
  }

  render(): void {
    // Never reached: the constructor throws.
  }
}

/**
 * What a render writes, charged to its `memoryLimit` as it's written:
 * liquidjs charges filters and ranges, not the output, and a capture is
 * output kept. The text is liquidjs's own for a value (its `stringify`).
 */
class ChargedEmitter implements Emitter {
  buffer = '';

  constructor(private readonly ctx: Context) {}

  write(html: unknown): void {
    this.ctx.memoryLimit.use(weigh(this.ctx, html));
    this.buffer += text(html);
  }
}

/**
 * What a value weighs toward `memoryLimit`, before anything is made from
 * it: a string its length, an array 1 plus what its items weigh (each at
 * least 1, for the place it takes), anything else its text's length. Each
 * distinct array is walked once a render (no template can change an array
 * once it's made) and counted every time it's held, so an array that
 * holds the same arrays many times weighs its whole total but takes only
 * its distinct arrays to walk. The walk stops as soon as the total passes
 * the limit, and an array that holds itself is over any limit.
 */
function weigh(ctx: Context, value: unknown): number {
  const root = toValue(value);
  if (!Array.isArray(root)) return flatWeight(root);
  let weighed = weightsByRender.get(ctx);
  if (weighed === undefined) {
    weighed = new WeakMap();
    weightsByRender.set(ctx, weighed);
  }
  const known = weighed.get(root);
  if (known !== undefined) return known;
  const frames: { readonly array: unknown[]; index: number; total: number }[] = [];
  const opened = new Set<unknown[]>();
  let running = 0;
  const add = (frame: { total: number }, weight: number) => {
    frame.total += weight;
    running += weight;
    ctx.memoryLimit.check(running);
  };
  const open = (array: unknown[]) => {
    if (opened.has(array)) throw new Error(MEMORY_LIMIT_EXCEEDED);
    opened.add(array);
    frames.push({ array, index: 0, total: 0 });
    add(frames[frames.length - 1] as { total: number }, 1);
  };
  open(root);
  for (;;) {
    const frame = frames[frames.length - 1] as (typeof frames)[number];
    if (frame.index === frame.array.length) {
      frames.pop();
      opened.delete(frame.array);
      weighed.set(frame.array, frame.total);
      const parent = frames[frames.length - 1];
      if (parent === undefined) return frame.total;
      parent.total += frame.total;
      continue;
    }
    const item = toValue(frame.array[frame.index]);
    frame.index += 1;
    if (!Array.isArray(item)) add(frame, Math.max(1, flatWeight(item)));
    else {
      const known = weighed.get(item);
      if (known !== undefined) add(frame, known);
      else open(item);
    }
  }
}

/** Each render's array weights, by the render's context. */
const weightsByRender = new WeakMap<Context, WeakMap<unknown[], number>>();

/** What a value that isn't an array weighs: the length of its text. */
function flatWeight(item: unknown): number {
  if (typeof item === 'string') return item.length;
  if (item === null || item === undefined) return 0;
  return String(item).length;
}

/** A value as liquidjs writes it out: a string, nothing for nil, an array's items joined. */
function text(value: unknown): string {
  const item = toValue(value);
  if (typeof item === 'string') return item;
  if (item === null || item === undefined) return '';
  if (Array.isArray(item)) return item.map(text).join('');
  return String(item);
}

/**
 * A filter with what it returns charged to the render's `memoryLimit`.
 * liquidjs charges most filters by what they're given, so one that gives
 * back more (`escape`, `url_encode`) passed the limit uncharged, and the
 * next filter worked on all of it.
 */
function chargedFilter(filter: FilterImplOptions): FilterImplOptions {
  const { handler, raw } = typeof filter === 'function' ? { handler: filter, raw: false } : filter;
  return {
    raw,
    // liquidjs resolves what a filter yields (a value, a generator or a
    // promise) and sends it back, as it does a filter's own result.
    *handler(this: ThisParameterType<FilterHandler>, value: unknown, ...args: unknown[]) {
      const result: unknown = yield handler.call(this, value, ...args);
      if (typeof result === 'string' || Array.isArray(result)) {
        this.context.memoryLimit.use(weigh(this.context, result));
      }
      return result;
    },
  };
}

/** A Liquid engine under the bounds' limits that resolves no partials. */
export function tenantLiquid(): Liquid {
  const { parseLimit, renderLimitMs, memoryLimit } = tenantInputBounds().liquid;
  const liquid = new Liquid({
    strictVariables: true,
    strictFilters: true,
    // An empty template map, with no prototype (liquidjs takes any member
    // that isn't nil, `constructor` included), behind the refusing tags:
    // no name resolves to a partial.
    templates: Object.create(null),
    parseLimit,
    renderLimit: renderLimitMs,
    memoryLimit,
  });
  for (const name of ['include', 'render', 'layout']) liquid.registerTag(name, NoPartials);
  // Every emitter the renderer makes writes charged: the render's own,
  // and each capture's. One it's given is one of these already.
  const { renderer } = liquid;
  const renderTemplates = renderer.renderTemplates.bind(renderer);
  renderer.renderTemplates = function* (templates: Template[], ctx: Context, emitter?: Emitter) {
    return yield* renderTemplates(templates, ctx, emitter ?? new ChargedEmitter(ctx));
  };
  for (const [name, filter] of Object.entries(liquid.filters)) {
    liquid.registerFilter(name, chargedFilter(filter));
  }
  return liquid;
}

/**
 * A template rendered under the bounds' limits: what its filters and
 * ranges make, and what it writes (its output and its captures), count
 * toward `memoryLimit` as they're made. As a tenant's work, its time
 * counts toward the tenant's `templateRenderBudgetMs`, and a tenant past
 * that is refused with `TemplateRenderBudgetError`.
 */
export function renderTenantTemplate(template: string, scope: object): string {
  return chargeRender(() => tenantLiquid().parseAndRenderSync(template, scope));
}

/**
 * What's wrong with a template, or undefined when nothing is: longer than
 * the bounds allow, a partial, or anything else the renderer won't parse
 * (an unknown filter included).
 */
export function templateProblem(template: string): string | undefined {
  const { parseLimit } = tenantInputBounds().liquid;
  if (template.length > parseLimit) {
    return `the template is ${template.length} characters, over the limit of ${parseLimit}`;
  }
  try {
    tenantLiquid().parse(template);
    return undefined;
  } catch (cause) {
    return liquidProblem(cause) ?? `the template isn't valid Liquid: ${messageOf(cause)}`;
  }
}

/**
 * What a Liquid error means when it's a partial or one of the bounds'
 * limits, or undefined for any other error. liquidjs wraps what a tag or
 * a limit throws in its own error, `originalError` the one thrown.
 */
export function liquidProblem(cause: unknown): string | undefined {
  const { parseLimit, renderLimitMs, memoryLimit } = tenantInputBounds().liquid;
  for (let error = cause; error instanceof Error; error = originalOf(error)) {
    if (error instanceof NoPartialsError) return NO_PARTIALS;
    // A string past the longest V8 makes, under bounds with no memory limit.
    if (error instanceof RangeError && error.message === 'Invalid string length') {
      return Number.isFinite(memoryLimit)
        ? memoryLimitProblem(memoryLimit)
        : 'the render made a string longer than JavaScript allows';
    }
    // liquidjs's own messages for its three limits.
    if (error.message === 'parse length limit exceeded') {
      return `the template is over the limit of ${parseLimit} characters`;
    }
    if (error.message === 'template render limit exceeded') {
      return renderLimitProblem(renderLimitMs);
    }
    if (error.message === MEMORY_LIMIT_EXCEEDED) {
      return memoryLimitProblem(memoryLimit);
    }
  }
  return undefined;
}

/** What a render over `renderLimitMs` is told: liquidjs's check, or a worker stopped at the limit. */
export function renderLimitProblem(renderLimitMs: number): string {
  return `the render took over the limit of ${renderLimitMs} ms`;
}

/** What a render over `memoryLimit` is told: liquidjs's count, or a worker past its heap. */
export function memoryLimitProblem(memoryLimit: number): string {
  return `the render went over its memory limit of ${memoryLimit}`;
}

function originalOf(error: Error): unknown {
  const original = (error as { readonly originalError?: unknown }).originalError;
  return original === error ? undefined : original;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
