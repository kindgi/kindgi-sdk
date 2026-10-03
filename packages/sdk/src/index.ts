// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/sdk` — public developer facade.
 *
 * Flat barrel that re-exports the three sub-paths for callers who prefer
 * a single import: `import { defineTool, createClient, type RunId } from
 * '@kindgi/sdk'`.
 *
 * Sub-paths are the primary developer-facing shape (`@kindgi/sdk/define`,
 * `@kindgi/sdk/client`, `@kindgi/sdk/types`); this barrel is a
 * convenience alias.
 *
 * @module @kindgi/sdk
 */

export * from './define.js';
export * from './client.js';
export * from './types.js';
