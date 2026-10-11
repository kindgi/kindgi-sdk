// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `samplingFor`: what an adapter sends of a call's temperature, for its model. */

import { describe, expect, test } from 'vitest';

import { SAMPLING_UNSUPPORTED, samplingFor } from '../src/index.js';

describe('samplingFor', () => {
  test('a model that takes sampling gets the temperature as set, and no warning', () => {
    expect(samplingFor({ name: 'acme-small' }, { temperature: 0.2 })).toEqual({
      temperature: 0.2,
      warnings: [],
    });
    expect(samplingFor({ name: 'acme-small', sampling: true }, { temperature: 0 })).toEqual({
      temperature: 0,
      warnings: [],
    });
  });

  test('no temperature set: nothing to send and nothing to say, whatever the model', () => {
    expect(samplingFor({ name: 'acme-small', sampling: false }, {})).toEqual({ warnings: [] });
  });

  test('sampling: false: the call goes without it, and the warning says so', () => {
    expect(samplingFor({ name: 'acme-large', sampling: false }, { temperature: 0.2 })).toEqual({
      warnings: [
        {
          code: SAMPLING_UNSUPPORTED,
          message:
            "acme-large doesn't take a temperature, so the call went without one (it asked for 0.2).",
        },
      ],
    });
    expect(SAMPLING_UNSUPPORTED).toBe('sampling-unsupported');
  });
});
