// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the directory holding every canonical
 * `<name>.schema.json` shipped with `@kindgi/specs`.
 *
 * For one schema, import or resolve it by name instead
 * (`@kindgi/specs/flow.schema.json`); this directory is for consumers that
 * enumerate the whole set (spec registries, validators, codegen).
 *
 * Resolved from this module's own URL, so it is correct in every layout
 * the package can be installed in (workspace checkout, linked
 * workspace package, `node_modules`) — from both `src/` and `dist/`.
 */
export const SPECS_SCHEMAS_DIR: string = fileURLToPath(new URL('../schemas/', import.meta.url));

/**
 * Absolute path to the example fixtures
 * (`<schema-name>.example.<label>.json`), each of which validates against
 * its schema. Also importable by name as `@kindgi/specs/examples/<file>`.
 */
export const SPECS_EXAMPLES_DIR: string = fileURLToPath(new URL('../examples/', import.meta.url));
