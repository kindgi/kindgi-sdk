// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export type * from './filter.js';
export type * from './hash.js';
export type * from './ids.js';
export type * from './live.js';
export type * from './pinned.js';
export type * from './refs.js';
export type * from './result.js';
export type * from './secret-scope.js';
export type * from './temporal.js';
export type * from './version.js';
export type * from './webhook.js';

// Runtime factories on branded IDs (validated construction). Kept as a
// separate value re-export so the `export type *` barrels above stay
// pure-type — value exports live only where explicitly listed.
export { makeEnvName } from './ids.js';

// The slug rules the API checks and the CLI and the console check before
// they send one.
export {
  SLUG,
  SLUG_MAX,
  SLUG_RULE,
  TENANT_SLUG,
  TENANT_SLUG_MAX,
  isSlug,
  isTenantSlug,
  slugOf,
} from './slug.js';

// Whether fetch can send a value in a header: a secret is checked by its
// header's name before fetch, whose own error would quote it.
export { bearerValueProblem, headerValueProblem } from './header-value.js';

// The fixed item a correction is recorded under, shared by the API, the CLI
// and the console so "one correction per run per expert" holds everywhere.
export { CORRECTION_ITEM } from './correction.js';
