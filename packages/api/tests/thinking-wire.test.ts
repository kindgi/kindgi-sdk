// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A model's thinking and a call's, on the wire: `ModelThinking` takes the
 * levels a model takes and its default, and `ModelCallThinking` what a
 * call asked and sent. Their enums are exactly the capabilities' levels.
 */

import { THINKING_LEVELS } from '@kindgi/capabilities';
import { describe, expect, test } from 'vitest';

import { ModelCallThinkingSchema, ModelThinkingSchema } from '../src/openapi/schemas.js';
import { validateAgainst } from './support/openapi-schema.js';

type Props = Record<string, { enum?: readonly string[]; items?: { enum?: readonly string[] } }>;

describe('ModelThinking', () => {
  test('takes levels and a default', () => {
    expect(
      validateAgainst('ModelThinking', {
        mode: 'adaptive',
        lowest: 'low',
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        default: 'xhigh',
      }),
    ).toEqual([]);
    expect(validateAgainst('ModelThinking', { mode: 'always', lowest: 'MINIMAL' })).toEqual([]);
  });

  test('refuses lowest among the levels, a level twice, and a default off the scale', () => {
    for (const bad of [
      { mode: 'adaptive', lowest: 'low', levels: ['lowest', 'low'] },
      { mode: 'adaptive', lowest: 'low', levels: ['low', 'low'] },
      { mode: 'adaptive', lowest: 'low', default: 'none' },
    ]) {
      expect(validateAgainst('ModelThinking', bad), JSON.stringify(bad)).not.toEqual([]);
    }
  });

  test("its enums are the capabilities' levels", () => {
    const props = ModelThinkingSchema.properties as Props;
    expect(props.default?.enum).toEqual([...THINKING_LEVELS]);
    expect(props.levels?.items?.enum).toEqual(THINKING_LEVELS.slice(1));
  });
});

describe('ModelCallThinking', () => {
  test('takes what a call asked, the level sent and the vendor fields', () => {
    expect(
      validateAgainst('ModelCallThinking', {
        asked: 'minimal',
        level: 'low',
        sent: { 'thinking.type': 'between_tools', 'output_config.effort': 'low' },
      }),
    ).toEqual([]);
    expect(validateAgainst('ModelCallThinking', { asked: 'high' })).toEqual([]);
    expect(validateAgainst('ModelCallThinking', { sent: { effort: 3 } })).not.toEqual([]);
  });

  test("its enums are the capabilities' levels", () => {
    const props = ModelCallThinkingSchema.properties as Props;
    expect(props.asked?.enum).toEqual([...THINKING_LEVELS]);
    expect(props.level?.enum).toEqual([...THINKING_LEVELS]);
  });
});
