// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { DEFAULT_RUNTIME_IMAGE } from '../src/dev/runtime-image.js';

describe('the runtime image kindgi dev runs', () => {
  test('is pinned by digest, so an older local pull of the same tag is never used', () => {
    expect(DEFAULT_RUNTIME_IMAGE).toMatch(
      /^quay\.io\/kindgi\/runtime:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/,
    );
  });
});
