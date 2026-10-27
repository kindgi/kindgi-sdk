// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    // tests/webhook-events.test.ts runs the repo's
    // scripts/gen-webhook-event-shapes.mjs by path, not by import, so
    // `vitest --changed` runs this suite when it changes.
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      '**/scripts/gen-webhook-event-shapes.mjs',
    ],
  },
});
