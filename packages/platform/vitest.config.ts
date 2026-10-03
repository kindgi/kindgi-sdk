// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    // Binding-conformance suite + per-adapter wire-up tests.
    // `passWithNoTests` intentionally disabled — a missing test file
    // is a signal, not a shrug.
    passWithNoTests: false,
  },
});
