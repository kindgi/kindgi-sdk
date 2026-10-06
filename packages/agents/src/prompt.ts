// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Liquid } from 'liquidjs';

import type { PromptBlockContent } from './blocks.js';
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

/**
 * Render an agent's instructions template with the given context.
 * Populates framework auto-vars, merges caller parameter values, and
 * applies defaults for optional parameters. Missing required parameters
 * are surfaced as `missing-parameter` before Liquid ever runs.
 *
 * Uses `strictVariables: true` so an unresolved `{{ var }}` is an error
 * — never a silent empty string. This is load-bearing for correctness
 * (a system prompt with a missing firm name is worse than a hard fail).
 *
 * When the instructions come from a prompt block, `prompt` is the
 * version the turn runs (its template and declared parameters); an
 * agent whose instructions are a prompt block can't render without it.
 */
export function renderInstructions(
  agent: Agent,
  context: RenderContext,
  prompt?: PromptBlockContent,
):
  | { readonly ok: true; readonly value: RenderResult }
  | { readonly ok: false; readonly error: PromptRenderError } {
  const template = prompt?.template ?? (typeof agent.instructions === 'string' ? agent.instructions : undefined);
  if (template === undefined) {
    const ref = agent.instructions as PromptRef;
    return {
      ok: false,
      error: {
        code: 'render-failure',
        message: `The instructions come from prompt block "${ref.prompt}" (${ref.version}), which wasn't loaded`,
        cause: null,
      },
    };
  }
  const declared = prompt !== undefined ? (prompt.parameters ?? []) : (agent.parameters ?? []);
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

  const merged = mergeContext(agent, declared, context);
  const liquid = new Liquid({ strictVariables: true, strictFilters: true });
  try {
    const rendered = liquid.parseAndRenderSync(template, merged);
    return { ok: true, value: { rendered, context: merged } };
  } catch (cause) {
    // LiquidJS throws UndefinedVariableError for unresolved refs — surface
    // as missing-parameter so callers get one consistent error code.
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes('undefined variable')) {
      const nameMatch = /undefined variable: ([\w.]+)/.exec(message);
      return {
        ok: false,
        error: {
          code: 'missing-parameter',
          message: `Template references an unresolved variable: ${nameMatch?.[1] ?? '?'}`,
          ...(nameMatch?.[1] !== undefined && { parameterName: nameMatch[1] }),
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'render-failure',
        message: `Template render failed: ${message}`,
        cause,
      },
    };
  }
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
