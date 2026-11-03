// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    // tests/ajv-guard.test.ts reads every package's source, and
    // tests/bounded.test.ts and tests/specs-integration.test.ts the specs'
    // JSON schemas, by path, not by import, so `vitest --changed` runs this
    // suite when any of them changes.
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      '**/packages/*/src/**',
      '**/packages/specs/schemas/**',
    ],
  },
});
