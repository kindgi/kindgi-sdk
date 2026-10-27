// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    // tests/pack-blocks.test.ts reads the specs' pack index schema, and
    // tests/kindgi-index.test.ts the Python SDK's define.py, by path, not by
    // import, so `vitest --changed` runs this suite when either changes.
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      '**/packages/specs/schemas/pack-index.schema.json',
      '**/sdks/python/src/kindgi/pack/define.py',
    ],
  },
});
