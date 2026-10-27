// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    // tests/pack-blocks.test.ts reads the specs' pack index schema by path,
    // not by import, so `vitest --changed` runs this suite when it changes.
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      '**/packages/specs/schemas/pack-index.schema.json',
    ],
  },
});
