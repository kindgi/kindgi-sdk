// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    // tests/webhook-events.test.ts runs the shapes generator's check, which
    // reads the API's openapi.json by path, so `vitest --changed` runs this
    // suite when either changes.
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      '**/packages/api/openapi.json',
      '**/scripts/gen-webhook-event-shapes.mjs',
    ],
  },
});
