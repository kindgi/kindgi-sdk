// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where a turn renders its agent's instructions when it doesn't render
 * them itself: a renderer the turn awaits (`InvokeAgentBindings`'
 * `templateRenderer`), so a template's render can run off the thread that
 * runs the turn. `@kindgi/agents/render-worker` makes one that renders in
 * child processes. A turn without one renders in-process, as
 * `renderInstructions` does.
 */

import type { TenantId } from '@kindgi/types';

/** What a renderer renders: one tenant's template, against its scope. */
export interface TemplateRenderInput {
  /** Whose template it is: a renderer that queues renders takes tenants in turn. */
  readonly tenantId: TenantId;
  /** The Liquid template. */
  readonly template: string;
  /**
   * What it renders against: the turn's parameters, input and settings,
   * and the variables the runtime injects (`AUTO_INJECTED_VARS`).
   */
  readonly scope: Readonly<Record<string, unknown>>;
}

/**
 * Renders a turn's instructions under the bounds' limits, as
 * `renderInstructions` would in-process: the same output, and the same
 * failures.
 */
export interface TemplateRenderer {
  /**
   * The rendered template. Rejects with:
   * - `TemplateRenderError` for the template's own failure (a variable it
   *   names that the scope doesn't have, Liquid that doesn't parse, a
   *   partial, one of the bounds' limits);
   * - `TemplateRenderBudgetError` when the tenant has spent its render
   *   budget, which the turn answers as a retryable refusal.
   *
   * Any other rejection fails the render with its message.
   */
  render(input: TemplateRenderInput): Promise<string>;
}

/** What a `TemplateRenderError` says went wrong. */
export interface TemplateRenderErrorInit {
  /**
   * `missing-parameter`: the template names a variable the scope doesn't
   * have. `render-failure`: anything else.
   */
  readonly code: 'missing-parameter' | 'render-failure';
  /** What `renderInstructions` says about it, word for word. */
  readonly message: string;
  /** The variable, for `missing-parameter`. */
  readonly parameterName?: string;
}

/** A template's own failure, as a `TemplateRenderer` rejects with it. */
export class TemplateRenderError extends Error {
  readonly code: TemplateRenderErrorInit['code'];
  readonly parameterName: string | undefined;

  constructor(init: TemplateRenderErrorInit) {
    super(init.message);
    this.name = 'TemplateRenderError';
    this.code = init.code;
    this.parameterName = init.parameterName;
  }
}
