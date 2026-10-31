// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export type * from './agent-pin.js';
export type * from './cloud-secret.js';
export type * from './file.js';
export type * from './filter.js';
export type * from './hash.js';
export type * from './ids.js';
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

// Whether fetch can send a value in a header: a secret is checked by its
// header's name before fetch, whose own error would quote it.
export { bearerValueProblem, headerValueProblem } from './header-value.js';

// A cloud secret's version, by its resource name: the API checks it on
// every write, and the CLI before it sends one.
export { CLOUD_SECRET_FORM, parseCloudSecretVersion } from './cloud-secret.js';

// The fixed item a correction is recorded under, shared by the API, the CLI
// and the console so "one correction per run per expert" holds everywhere.
export { CORRECTION_ITEM } from './correction.js';

// A stored file as a plain JSON value, which several packages pass on;
// its shape check takes no dependency.
export { FILE_NOT_READ_REASONS, FILE_NOT_SHOWN_REASONS, isFileValue } from './file.js';
