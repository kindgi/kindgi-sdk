// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * How much a model thinks before it answers. A call asks for a level
 * (`ModelCallInput.thinking`: an agent's model settings, or a judge's
 * `lowest`); the model's `ModelInfo.thinking` says which levels it takes.
 * Every adapter asks this one place what to send: a level the model
 * takes goes as asked, any other is rounded to one it does, and the
 * answer carries a warning saying so, instead of failing on the vendor's
 * 400. What a registration may set as a model's `default` is checked
 * against the same levels, so the two never differ.
 */

import type { ModelCallInput, ModelCallWarning, ModelInfo, ModelThinking } from './types.js';

/**
 * The levels, least first. `lowest` is the least the model allows (its
 * `ModelThinking.lowest`); the others are the vendors' own names.
 */
export const THINKING_LEVELS = [
  'lowest',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** The warning code an answer carries when its level was rounded to one the model takes. */
export const THINKING_LEVEL_ADJUSTED = 'thinking-level-adjusted';

/** The warning code an answer carries when it asked for a level and none was sent. */
export const THINKING_UNSUPPORTED = 'thinking-unsupported';

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Every thinking model takes these, whatever its vendor. */
const ASSUMED: readonly ThinkingLevel[] = ['low', 'medium', 'high'];

/**
 * The levels a model takes besides `lowest`, least first: its `levels`,
 * or, without them, the ones every thinking model takes. Those are
 * `low`, `medium` and `high`, plus `minimal` when its `lowest` is
 * `minimal`, minus the ones below its `lowest` when that's `low`,
 * `medium` or `high` (any case).
 */
export function thinkingLevelsOf(
  thinking: Pick<ModelThinking, 'lowest' | 'levels'>,
): readonly ThinkingLevel[] {
  if (thinking.levels !== undefined) return thinking.levels;
  const floor = thinking.lowest.toLowerCase();
  if (floor === 'minimal') return ['minimal', ...ASSUMED];
  const at = ASSUMED.indexOf(floor as ThinkingLevel);
  return at === -1 ? ASSUMED : ASSUMED.slice(at);
}

export interface Thinking {
  /**
   * The level to send: the call's, or the model's `default` when the call
   * asks none. Absent: nothing to send, or the model doesn't think.
   */
  readonly level?: ThinkingLevel;
  /** One warning when the level was rounded, or when one was asked and none can be sent. */
  readonly warnings: readonly ModelCallWarning[];
}

/**
 * What level to send of a call's thinking, for this model. `lowest` and
 * a level the model takes go as asked. Any other goes as the first level
 * the model takes above it, or its highest when there's none above: so
 * below the floor rounds up to it, and above the ceiling rounds down to
 * it. A model with no `thinking` gets nothing.
 */
export function thinkingFor(
  model: Pick<ModelInfo, 'name' | 'thinking'>,
  input: Pick<ModelCallInput, 'thinking'>,
): Thinking {
  const thinking = model.thinking;
  if (thinking === undefined) {
    if (input.thinking === undefined) return { warnings: [] };
    return {
      warnings: [
        {
          code: THINKING_UNSUPPORTED,
          message: `${model.name} doesn't think, or how it thinks isn't known, so the call sent no level (it asked for ${input.thinking}).`,
        },
      ],
    };
  }
  // A registered default is one the model takes (`modelThinkingProblem`), so it's sent as is.
  const asked = input.thinking ?? thinking.default;
  if (asked === undefined) return { warnings: [] };
  if (asked === 'lowest') return { level: 'lowest', warnings: [] };
  const levels = thinkingLevelsOf(thinking);
  if (levels.includes(asked)) return { level: asked, warnings: [] };
  const rank = THINKING_LEVELS.indexOf(asked);
  const level =
    levels.find((l) => THINKING_LEVELS.indexOf(l) > rank) ?? levels[levels.length - 1] ?? 'lowest';
  return {
    level,
    warnings: [
      {
        code: THINKING_LEVEL_ADJUSTED,
        message: `${model.name} doesn't take thinking level ${asked}, so the call sent ${level}.`,
      },
    ],
  };
}

/**
 * What's wrong with a model's `thinking`, or undefined when nothing is:
 * a known mode, a non-empty vendor setting for `lowest`, `levels` as
 * levels of the scale besides `lowest`, each once and least first, and
 * a `default` the model takes (`lowest`, or one of `thinkingLevelsOf`).
 */
export function modelThinkingProblem(value: unknown): string | undefined {
  const shape =
    "must be { mode: 'adaptive' | 'always', lowest: <the vendor's setting>, levels?: <the levels it takes besides lowest, least first>, default?: <a level it takes> }";
  if (typeof value !== 'object' || value === null) return shape;
  const t = value as Record<string, unknown>;
  if (
    !(t.mode === 'adaptive' || t.mode === 'always') ||
    typeof t.lowest !== 'string' ||
    t.lowest.length === 0 ||
    !Object.keys(t).every((k) => ['mode', 'lowest', 'levels', 'default'].includes(k))
  ) {
    return shape;
  }
  if (t.levels !== undefined) {
    const levels = t.levels;
    const ranks = Array.isArray(levels)
      ? levels.map((l) => (isThinkingLevel(l) ? THINKING_LEVELS.indexOf(l) : -1))
      : [];
    if (
      !Array.isArray(levels) ||
      ranks.some((r, i) => r < 1 || (i > 0 && r <= (ranks[i - 1] as number)))
    ) {
      return `levels must be levels besides lowest, each once and least first, from ${THINKING_LEVELS.slice(1).join(', ')}`;
    }
  }
  if (t.default !== undefined) {
    const takes = [
      'lowest',
      ...thinkingLevelsOf({
        lowest: t.lowest,
        ...(t.levels !== undefined && { levels: t.levels as readonly ThinkingLevel[] }),
      }),
    ];
    if (!takes.includes(t.default as string)) {
      return `default ${JSON.stringify(t.default)} isn't a level this model takes: it takes ${takes.join(', ')}`;
    }
  }
  return undefined;
}
