// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `thinkingFor`: the level an adapter sends of a call's thinking, for its
 * model; `thinkingLevelsOf`: the levels a model takes; and
 * `modelThinkingProblem`: what a registration may set.
 */

import { describe, expect, test } from 'vitest';

import {
  THINKING_LEVEL_ADJUSTED,
  THINKING_UNSUPPORTED,
  modelThinkingProblem,
  thinkingFor,
  thinkingLevelsOf,
} from '../src/index.js';

describe('thinkingLevelsOf', () => {
  test('a model with levels takes those', () => {
    expect(thinkingLevelsOf({ lowest: 'low', levels: ['low', 'high', 'xhigh', 'max'] })).toEqual([
      'low',
      'high',
      'xhigh',
      'max',
    ]);
    expect(thinkingLevelsOf({ lowest: 'low', levels: [] })).toEqual([]);
  });

  test('without levels: low, medium and high, which every thinking model takes', () => {
    for (const lowest of ['none', 'disabled', 'between_tools', 'low', 'LOW']) {
      expect(thinkingLevelsOf({ lowest }), lowest).toEqual(['low', 'medium', 'high']);
    }
  });

  test('without levels: minimal too when the floor is minimal, in any case', () => {
    expect(thinkingLevelsOf({ lowest: 'MINIMAL' })).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(thinkingLevelsOf({ lowest: 'minimal' })).toEqual(['minimal', 'low', 'medium', 'high']);
  });

  test('without levels: none below a floor of medium or high', () => {
    expect(thinkingLevelsOf({ lowest: 'medium' })).toEqual(['medium', 'high']);
    expect(thinkingLevelsOf({ lowest: 'High' })).toEqual(['high']);
  });
});

describe('thinkingFor', () => {
  const gemini = { name: 'acme-flash', thinking: { mode: 'always' as const, lowest: 'MINIMAL' } };
  const effort = {
    name: 'acme-large',
    thinking: {
      mode: 'adaptive' as const,
      lowest: 'low',
      levels: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
    },
  };

  test('a level the model takes goes as asked, and lowest always does', () => {
    expect(thinkingFor(gemini, { thinking: 'minimal' })).toEqual({
      level: 'minimal',
      warnings: [],
    });
    expect(thinkingFor(effort, { thinking: 'max' })).toEqual({ level: 'max', warnings: [] });
    expect(thinkingFor(effort, { thinking: 'lowest' })).toEqual({ level: 'lowest', warnings: [] });
  });

  test('nothing asked and no default: nothing to send and nothing to say', () => {
    expect(thinkingFor(gemini, {})).toEqual({ warnings: [] });
    expect(thinkingFor({ name: 'acme-small' }, {})).toEqual({ warnings: [] });
  });

  test("nothing asked: the model's default, sent as registered", () => {
    const model = { ...effort, thinking: { ...effort.thinking, default: 'medium' as const } };
    expect(thinkingFor(model, {})).toEqual({ level: 'medium', warnings: [] });
    // The call's level wins over it.
    expect(thinkingFor(model, { thinking: 'high' })).toEqual({ level: 'high', warnings: [] });
  });

  test('below the floor rounds up to it, with the warning', () => {
    const r = thinkingFor(effort, { thinking: 'minimal' });
    expect(r.level).toBe('low');
    expect(r.warnings).toEqual([
      {
        code: THINKING_LEVEL_ADJUSTED,
        message: "acme-large doesn't take thinking level minimal, so the call sent low.",
      },
    ]);
  });

  test('in a gap rounds up to the next level the model takes', () => {
    const model = { name: 'acme-gap', thinking: { mode: 'adaptive' as const, lowest: 'low', levels: ['low', 'high'] as const } };
    const r = thinkingFor(model, { thinking: 'medium' });
    expect(r.level).toBe('high');
    expect(r.warnings.map((w) => w.code)).toEqual([THINKING_LEVEL_ADJUSTED]);
  });

  test('above the ceiling rounds down to it: without levels, xhigh and max go as high', () => {
    for (const thinking of ['xhigh', 'max'] as const) {
      const r = thinkingFor({ name: 'acme-stored', thinking: { mode: 'adaptive', lowest: 'low' } }, { thinking });
      expect(r.level, thinking).toBe('high');
      expect(r.warnings.map((w) => w.code)).toEqual([THINKING_LEVEL_ADJUSTED]);
    }
  });

  test('a floor of medium without levels: low rounds up to medium', () => {
    const r = thinkingFor({ name: 'acme-medium', thinking: { mode: 'always', lowest: 'medium' } }, { thinking: 'low' });
    expect(r.level).toBe('medium');
    expect(r.warnings.map((w) => w.code)).toEqual([THINKING_LEVEL_ADJUSTED]);
  });

  test('a model that takes only lowest: any other level goes as lowest', () => {
    const r = thinkingFor({ name: 'acme-fixed', thinking: { mode: 'always', lowest: 'low', levels: [] } }, { thinking: 'high' });
    expect(r.level).toBe('lowest');
    expect(r.warnings.map((w) => w.code)).toEqual([THINKING_LEVEL_ADJUSTED]);
  });

  test('a model with no thinking: nothing is sent, and the warning says so', () => {
    expect(thinkingFor({ name: 'acme-small' }, { thinking: 'high' })).toEqual({
      warnings: [
        {
          code: THINKING_UNSUPPORTED,
          message:
            "acme-small doesn't think, or how it thinks isn't known, so the call sent no level (it asked for high).",
        },
      ],
    });
  });
});

describe('modelThinkingProblem', () => {
  test('a mode and the vendor setting, with or without levels and a default it takes', () => {
    for (const ok of [
      { mode: 'adaptive', lowest: 'between_tools' },
      { mode: 'always', lowest: 'MINIMAL', levels: ['minimal', 'low', 'medium', 'high'] },
      { mode: 'always', lowest: 'low', levels: [] },
      { mode: 'adaptive', lowest: 'low', levels: ['low', 'xhigh', 'max'], default: 'max' },
      { mode: 'adaptive', lowest: 'none', default: 'lowest' },
      { mode: 'adaptive', lowest: 'none', default: 'medium' },
    ]) {
      expect(modelThinkingProblem(ok), JSON.stringify(ok)).toBeUndefined();
    }
  });

  test('levels outside the scale, lowest, twice or out of order are refused', () => {
    for (const levels of [['low', 'extreme'], ['lowest', 'low'], ['low', 'low'], ['high', 'low'], 'low']) {
      expect(modelThinkingProblem({ mode: 'always', lowest: 'low', levels }), JSON.stringify(levels)).toBe(
        'levels must be levels besides lowest, each once and least first, from minimal, low, medium, high, xhigh, max',
      );
    }
  });

  test('a default the model doesn\'t take is refused, naming the levels it takes', () => {
    // Without levels, the ones every thinking model takes.
    expect(modelThinkingProblem({ mode: 'adaptive', lowest: 'low', default: 'max' })).toBe(
      'default "max" isn\'t a level this model takes: it takes lowest, low, medium, high',
    );
    expect(
      modelThinkingProblem({ mode: 'always', lowest: 'low', levels: ['low', 'high'], default: 'medium' }),
    ).toBe('default "medium" isn\'t a level this model takes: it takes lowest, low, high');
    // Outside the scale.
    expect(modelThinkingProblem({ mode: 'adaptive', lowest: 'low', default: 'none' })).toBe(
      'default "none" isn\'t a level this model takes: it takes lowest, low, medium, high',
    );
  });

  test('anything else is refused with the shape', () => {
    for (const bad of [
      { mode: 'sometimes', lowest: 'low' },
      { mode: 'always', lowest: '' },
      { mode: 'always' },
      { mode: 'always', lowest: 'low', budget: 0 },
      'low',
      null,
    ]) {
      expect(modelThinkingProblem(bad), JSON.stringify(bad)).toMatch(/^must be \{ mode: /);
    }
  });
});
