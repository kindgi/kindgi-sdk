// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { FEATURES, FEATURE_DESCRIPTIONS } from '../src/index.js';

describe('FEATURE_DESCRIPTIONS', () => {
  it('describes every feature in a sentence, and nothing else', () => {
    expect(Object.keys(FEATURE_DESCRIPTIONS).sort()).toEqual([...FEATURES].sort());
    for (const f of FEATURES) {
      expect(FEATURE_DESCRIPTIONS[f]).toMatch(/^[A-Z].{10,}\.$/);
    }
  });
});
