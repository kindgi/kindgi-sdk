// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The usage ledger's vocabulary: what a runtime that meters usage
 * (`KINDGI_USAGE_METERING=on`) counts, and the class each counted run is
 * in. The runtime writes one record per counted thing, in the same
 * transaction as the change it counts, unique per counted id, so each is
 * counted exactly once. `/v1/cost/*` reads a tenant's own records by
 * these kinds.
 */

/**
 * The class a counted run is in, fixed when the run is created:
 * - `production`: an ordinary run in a project that's in production;
 * - `staging`: an ordinary run in a project that isn't;
 * - `dry-run`, `replay`, `eval`: a dry run, a replay of a run, a run of an
 *   eval suite, wherever it runs;
 * - `child`: a run started inside another run, which counts as part of it.
 */
export const USAGE_CLASSES = [
  'production',
  'staging',
  'dry-run',
  'replay',
  'eval',
  'child',
] as const;

export type UsageClass = (typeof USAGE_CLASSES)[number];

/**
 * What the ledger counts (a record's `resourceKind`):
 * - `run.started` when a run is created, and `run.ended` when it reaches a
 *   terminal status (its quantity, the wall time in milliseconds);
 * - `approval.requested` and `approval.decided`;
 * - `llm.inference` and `llm.embedding`, a model call;
 * - `project.production`, a project put in production or taken out
 *   (`on` or `off`).
 */
export const USAGE_KINDS = [
  'run.started',
  'run.ended',
  'approval.requested',
  'approval.decided',
  'llm.inference',
  'llm.embedding',
  'project.production',
] as const;

export type UsageKind = (typeof USAGE_KINDS)[number];
