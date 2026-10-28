// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    // tests/shared-cost.test.ts reads the CLI's provider presets by path, not
    // by import, so `vitest --changed` runs this suite when one changes.
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      '**/packages/cli/src/providers/presets/**',
    ],
  },
});
