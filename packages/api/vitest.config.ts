// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { workspaceSourceAliases } from '../../scripts/workspace-source-aliases.mjs';

export default defineConfig({
  // The workspace packages load from their source, so the tests run the
  // commit's code with no build first.
  resolve: { alias: workspaceSourceAliases(fileURLToPath(new URL('.', import.meta.url))) },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});
