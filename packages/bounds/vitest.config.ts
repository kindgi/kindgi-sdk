// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 5_000,
    // tests/guard.test.ts reads every package's source by path, not by
    // import, so `vitest --changed` runs this suite when any of it changes.
    forceRerunTriggers: [...configDefaults.forceRerunTriggers, '**/packages/*/src/**'],
  },
});
