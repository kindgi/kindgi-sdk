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
  type TopLevelToken,
} from 'liquidjs';

/** What a template that uses a partial is told, at a publish and at a render alike. */
export const NO_PARTIALS = "templates can't use include, render or layout";

class NoPartialsError extends Error {}

/** A render whose output is longer than `memoryLimit` characters. */
class OutputOverLimitError extends Error {}

/** A tag class as liquidjs's tag map holds it. */
type TagClass = Liquid['tags'][string];

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
 * liquidjs's `{% capture %}`, with the string it keeps charged to the
 * render's `memoryLimit`. liquidjs charges filters and ranges but not a
 * capture, so a capture that doubles itself in a loop grew past any limit.
 */
function chargedCapture(capture: TagClass): TagClass {
  const { render } = (capture as unknown as { readonly prototype: Tag }).prototype;
  return class ChargedCapture extends capture {
    *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
      yield* render.call(this, ctx, emitter) as Generator<unknown, unknown, unknown>;
      const { variable } = this as unknown as { readonly variable: string };
      const kept: unknown = (ctx.bottom() as Readonly<Record<string, unknown>>)[variable];
      if (typeof kept === 'string') ctx.memoryLimit.use(kept.length);
    }
  };
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
        this.context.memoryLimit.use(result.length);
      }
      return result;
    },
  };
}

/**
 * A Liquid engine under the bounds' limits that resolves no partials.
 * It parses; a render goes through `renderTenantTemplate`, which also
 * bounds the output.
 */
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
  const capture = liquid.tags.capture;
  if (capture === undefined) throw new Error('liquidjs has no capture tag');
  liquid.registerTag('capture', chargedCapture(capture));
  for (const [name, filter] of Object.entries(liquid.filters)) {
    liquid.registerFilter(name, chargedFilter(filter));
  }
  return liquid;
}

/**
 * A template rendered under the bounds' limits. What its filters, ranges
 * and captures make is charged to `memoryLimit` (`tenantLiquid`); its
 * output isn't, so the output may be no longer than `memoryLimit`
 * characters either.
 */
export function renderTenantTemplate(template: string, scope: object): string {
  const { memoryLimit } = tenantInputBounds().liquid;
  const rendered: string = tenantLiquid().parseAndRenderSync(template, scope);
  // `length` doesn't flatten the string the render built, however long.
  if (rendered.length > memoryLimit) throw new OutputOverLimitError();
  return rendered;
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
    if (error instanceof OutputOverLimitError) {
      return `the render went over its memory limit of ${memoryLimit}`;
    }
    // A string past the longest V8 makes, before the output's check could run.
    if (error instanceof RangeError && error.message === 'Invalid string length') {
      return Number.isFinite(memoryLimit)
        ? `the render went over its memory limit of ${memoryLimit}`
        : 'the render made a string longer than JavaScript allows';
    }
    // liquidjs's own messages for its three limits.
    if (error.message === 'parse length limit exceeded') {
      return `the template is over the limit of ${parseLimit} characters`;
    }
    if (error.message === 'template render limit exceeded') {
      return `the render took over the limit of ${renderLimitMs} ms`;
    }
    if (error.message === 'memory alloc limit exceeded') {
      return `the render went over its memory limit of ${memoryLimit}`;
    }
  }
  return undefined;
}

function originalOf(error: Error): unknown {
  const original = (error as { readonly originalError?: unknown }).originalError;
  return original === error ? undefined : original;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
