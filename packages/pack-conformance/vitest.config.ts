// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // tests/platform-env-lists.test.ts reads the Python and Java SDKs' lists
    // by path, not by import, so `vitest --changed` runs this suite when
    // either changes.
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      '**/sdks/python/src/kindgi/pack/env_filter.py',
      '**/sdks/java/kindgi-pack/src/main/java/com/kindgi/pack/PackEnv.java',
    ],
  },
});
