// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { hostPortOf } from '../src/dev/defaults.js';

describe('hostPortOf', () => {
  test.each([
    ['0.0.0.0:51741\n', 51741],
    ['[::]:51741\n', 51741],
    ['0.0.0.0:51741\n[::]:51741\n', 51741],
    ['127.0.0.1:5432', 5432],
  ])('%j → %d', (output, port) => {
    expect(hostPortOf(output)).toBe(port);
  });

  test.each([[''], ['\n'], ['no port here'], [':0']])('%j → undefined', (output) => {
    expect(hostPortOf(output)).toBeUndefined();
  });
});
