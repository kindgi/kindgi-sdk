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
import { Liquid, Tag, type TagToken, type TopLevelToken } from 'liquidjs';

/** What a template that uses a partial is told, at a publish and at a render alike. */
export const NO_PARTIALS = "templates can't use include, render or layout";

class NoPartialsError extends Error {}

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
  return liquid;
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
