// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the SQL migrations shipped with `@kindgi/agents`.
 *
 * Resolved from this module's own URL, so it is correct in every layout
 * the package can be installed in (workspace checkout, a workspace in
 * another repository, `node_modules`, `pnpm deploy` output) — from both
 * `src/` and `dist/`. Migration runners use this instead of computing
 * package-relative paths themselves.
 */
export const AGENTS_MIGRATIONS_DIR: string = fileURLToPath(
  new URL('../migrations/', import.meta.url),
);
