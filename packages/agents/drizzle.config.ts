// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { defineConfig } from 'drizzle-kit';

// Drizzle-kit is the generator. Migrations are versioned SQL files
// under packages/agents/migrations/ (exported as AGENTS_MIGRATIONS_DIR)
// and applied at runtime by the host's migration runner.
//
// NEVER hand-edit SQL files — always edit src/schema.ts and run
// `pnpm --filter @kindgi/agents db:generate`.
export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  strict: true,
  verbose: true,
});
