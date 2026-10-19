// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { TenantBudgetError } from '@kindgi/bounds';
import type { TenantId } from '@kindgi/types';

import type { PromptBlockContent } from './blocks.js';
import { liquidProblem, renderTenantTemplate } from './liquid.js';
import { TemplateRenderError, type TemplateRenderer } from './template-renderer.js';
import type { Agent, PromptParameter, PromptRef } from './types.js';

/**
 * Reserved variable namespaces the runtime injects automatically.
 * Callers do not (and cannot) declare these as `PromptParameter`s —
 * they're populated by `renderInstructions` at invoke time.
 *
 *   - `today`         — ISO date string (yyyy-mm-dd) at UTC.
 *   - `now`           — ISO datetime string at UTC.
 *   - `agent.id`      — the invoked agent's id.
 *   - `agent.name`    — display name.
 *   - `agent.version` — semver of the invoked definition.
 *   - `conversation.id`   — current conversation id (undefined for one-shot).
 *   - `conversation.turn` — 1-indexed turn number within this conversation.
 *   - `input`             — the turn's structured input (`InvokeAgentInput.input`),
 *                           e.g. `{{ input.grievance.summary }}`; unset when
 *                           the turn has none.
 *   - `settings`          — the agent's settings blocks' values, by block id:
 *                           `{{ settings["acme.weights"].recency }}` reads
 *                           block `acme.weights`; unset when it has none.
 */
export const AUTO_INJECTED_VARS = [
  'today',
  'now',
  'agent',
  'conversation',
  'input',
  'settings',
] as const;

/**
 * Shape passed to `renderInstructions`. Framework auto-vars are
 * computed inside; the caller supplies parameter values only.
 */
export interface RenderContext {
  /** Caller-supplied parameter values. Keyed by `PromptParameter.name`. */
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
  /** Turn context — used to fill in `conversation.*` and stamp `now`. */
  readonly conversation?: {
    readonly id: string;
    readonly turn: number;
  };
  /** The turn's structured input, rendered as `{{ input.* }}`. */
  readonly input?: unknown;
  /** The agent's settings blocks' values, by block id: `{{ settings["<id>"].<key> }}`. */
  readonly settings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * Optional clock override — tests inject a fixed date. Defaults to
   * `new Date()`.
   */
  readonly clock?: () => Date;
}

export interface RenderResult {
  readonly rendered: string;
  /**
   * The full context the template was rendered against (parameters +
   * auto-vars). Captured for provenance — the auditor sees exactly
   * what values filled the placeholders.
   */
  readonly context: Readonly<Record<string, unknown>>;
}

export type PromptRenderError = MissingParameterError | RenderFailureError;

/**
 * A required parameter has no value at invoke time.
 * `parameterName` is undefined if LiquidJS caught a variable that isn't
 * even declared (typo, or template references a name we didn't validate
 * at define time).
 */
export interface MissingParameterError {
  readonly code: 'missing-parameter';
  readonly message: string;
  readonly parameterName?: string;
}

/** Template failed to render for a reason other than a missing var. */
export interface RenderFailureError {
  readonly code: 'render-failure';
  readonly message: string;
  readonly cause: unknown;
}

/** The result of rendering an agent's instructions. */
export type RenderInstructionsResult =
  | { readonly ok: true; readonly value: RenderResult }
  | { readonly ok: false; readonly error: PromptRenderError };

/**
 * Render an agent's instructions template with the given context.
 * Populates framework auto-vars, merges caller parameter values, and
 * applies defaults for optional parameters. Missing required parameters
 * are surfaced as `missing-parameter` before Liquid ever runs.
 *
 * Renders with `strictVariables: true` (`renderTenantTemplate`'s), so an unresolved `{{ var }}` is an error
 * — never a silent empty string. This is load-bearing for correctness
 * (a system prompt with a missing firm name is worse than a hard fail).
 *
 * When the instructions come from a prompt block, `prompt` is the
 * version the turn runs (its template and declared parameters); an
 * agent whose instructions are a prompt block can't render without it.
 *
 * Throws `TemplateRenderBudgetError` (a `TenantBudgetError`) when the
 * tenant has spent its render budget: that's no fault of the template's.
 */
export function renderInstructions(
  agent: Agent,
  context: RenderContext,
  prompt?: PromptBlockContent,
): RenderInstructionsResult {
  const prepared = prepareInstructions(agent, context, prompt);
  if (!prepared.ok) return prepared;
  const { template, scope } = prepared.value;
  // Under the bounds' limits; `include`, `render` and `layout` fail the render.
  try {
    const rendered = renderTenantTemplate(template, scope);
    return { ok: true, value: { rendered, context: scope } };
  } catch (cause) {
    // A tenant past its render budget: not the template's failure, and
    // retryable. The turn answers for it.
    if (cause instanceof TenantBudgetError) throw cause;
    return { ok: false, error: renderFailure(cause) };
  }
}

/**
 * `renderInstructions`, with the render done by `renderer` (in a worker
 * thread, say): the same checks before it, and the same result or error
 * after. Rejects with `TemplateRenderBudgetError` when the tenant has
 * spent its render budget.
 */
export async function renderInstructionsWith(
  renderer: TemplateRenderer,
  tenantId: TenantId,
  agent: Agent,
  context: RenderContext,
  prompt?: PromptBlockContent,
): Promise<RenderInstructionsResult> {
  const prepared = prepareInstructions(agent, context, prompt);
  if (!prepared.ok) return prepared;
  const { template, scope } = prepared.value;
  try {
    const rendered = await renderer.render({ tenantId, template, scope });
    return { ok: true, value: { rendered, context: scope } };
  } catch (cause) {
    if (cause instanceof TenantBudgetError) throw cause;
    if (cause instanceof TemplateRenderError && cause.code === 'missing-parameter') {
      return {
        ok: false,
        error: {
          code: 'missing-parameter',
          message: cause.message,
          ...(cause.parameterName !== undefined && { parameterName: cause.parameterName }),
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'render-failure',
        message:
          cause instanceof TemplateRenderError
            ? cause.message
            : `Template render failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      },
    };
  }
}

/** The template a turn renders and what it renders against, once the parameters are checked. */
export interface PreparedInstructions {
  readonly template: string;
  /** The parameters (with their defaults) and the auto-injected variables. */
  readonly scope: Readonly<Record<string, unknown>>;
}

/**
 * What `renderInstructions` does before it renders: the template (the
 * prompt block's or the agent's own), its required parameters checked,
 * and the scope it renders against.
 */
export function prepareInstructions(
  agent: Agent,
  context: RenderContext,
  prompt?: PromptBlockContent,
):
  | { readonly ok: true; readonly value: PreparedInstructions }
  | { readonly ok: false; readonly error: PromptRenderError } {
  const source = instructionsSource(agent, prompt);
  if (!source.ok) return source;
  const { template, declared } = source.value;
  const missing = requiredMissing(declared, context.parameters);
  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        code: 'missing-parameter',
        message: `Required parameter${missing.length === 1 ? '' : 's'} missing: ${missing.join(', ')}`,
        ...(missing.length === 1 && missing[0] !== undefined && { parameterName: missing[0] }),
      },
    };
  }
  return { ok: true, value: { template, scope: mergeContext(agent, declared, context) } };
}

/**
 * What a render that threw comes to, as `renderInstructions` reports it.
 * LiquidJS throws UndefinedVariableError for unresolved refs: that's
 * `missing-parameter`, so callers get one consistent error code.
 */
export function renderFailure(cause: unknown): PromptRenderError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes('undefined variable')) {
    const nameMatch = /undefined variable: ([^,\s]+)/.exec(message);
    return {
      code: 'missing-parameter',
      message: `Template references an unresolved variable: ${nameMatch?.[1] ?? '?'}`,
      ...(nameMatch?.[1] !== undefined && { parameterName: nameMatch[1] }),
    };
  }
  return {
    code: 'render-failure',
    message: `Template render failed: ${liquidProblem(cause) ?? message}`,
    cause,
  };
}

/** The template to render and the parameters it declares: the prompt block's, or the agent's own. */
function instructionsSource(
  agent: Agent,
  prompt: PromptBlockContent | undefined,
):
  | {
      readonly ok: true;
      readonly value: { readonly template: string; readonly declared: readonly PromptParameter[] };
    }
  | { readonly ok: false; readonly error: PromptRenderError } {
  if (prompt !== undefined) {
    return { ok: true, value: { template: prompt.template, declared: prompt.parameters ?? [] } };
  }
  if (typeof agent.instructions === 'string') {
    return { ok: true, value: { template: agent.instructions, declared: agent.parameters ?? [] } };
  }
  const ref: PromptRef = agent.instructions;
  return {
    ok: false,
    error: {
      code: 'render-failure',
      message: `The instructions come from prompt block "${ref.prompt}" (${ref.version}), which wasn't loaded`,
      cause: null,
    },
  };
}

function requiredMissing(
  declared: readonly PromptParameter[],
  supplied: Readonly<Record<string, unknown>>,
): string[] {
  const missing: string[] = [];
  for (const p of declared) {
    const isRequired = p.required !== false;
    if (!isRequired) continue;
    if (p.default !== undefined) continue;
    if (!(p.name in supplied) || supplied[p.name] === undefined) missing.push(p.name);
  }
  return missing;
}

function mergeContext(
  agent: Agent,
  declared: readonly PromptParameter[],
  context: RenderContext,
): Record<string, unknown> {
  const clock = context.clock ?? (() => new Date());
  const at = clock();
  const today = at.toISOString().slice(0, 10);
  const now = at.toISOString();

  // Start with declared defaults, layer caller-supplied on top so
  // callers can override defaults explicitly.
  const values: Record<string, unknown> = {};
  for (const p of declared) {
    if (p.default !== undefined) values[p.name] = p.default;
  }
  for (const [k, v] of Object.entries(context.parameters)) values[k] = v;

  values.today = today;
  values.now = now;
  values.agent = {
    id: agent.id,
    name: agent.name,
    version: agent.version,
  };
  if (context.conversation !== undefined) {
    values.conversation = {
      id: context.conversation.id,
      turn: context.conversation.turn,
    };
  }
  if (context.input !== undefined) values.input = context.input;
  if (context.settings !== undefined) values.settings = context.settings;
  return values;
}
