// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Result, Unbranded } from '@kindgi/types';

import type { FlowError } from './errors.js';
import { loadFlow } from './loader.js';
import type { Flow } from './types.js';

/**
 * The author-facing spec accepted by `defineFlow`: the shape of the runtime
 * `Flow` — an object literal conforming to `flow.schema.json` — with its
 * ids as plain strings. An author writes `id: 'acme.review'`, a node
 * `id: 'parse'`, an edge `from: 'parse'`, with no `as FlowId` / `as NodeId`
 * / `as EdgeId` casts; branded ids still fit. `defineFlow` returns the
 * validated `Flow`, branded, ready for the kernel or a registry.
 */
export type FlowSpec = Unbranded<Flow>;

/**
 * Build a validated `Flow` from a user-supplied definition.
 *
 * Thin wrapper over `loadFlow` — same validation gauntlet, same error
 * surface, same `Result<Flow, FlowError>` envelope. The distinction is
 * ergonomic: `defineFlow` is the author-facing primitive that mirrors
 * `defineTool` / `defineCheck` / `defineAgent`, so pack authors reach for
 * one consistent shape when declaring workspace primitives. `loadFlow`
 * remains the wire-form entry point for JSON coming off disk / network.
 *
 * Validates (fail-fast, in `loadFlow` order):
 *   1. JSON-schema conformance against `flow.schema.json`.
 *   2. Reserved-id / duplicate-id / unknown-node-reference checks.
 *   3. Predicate + edge-policy + loop / fanout / subgraph well-formedness,
 *      data-flow mappings and the flow `output.schema`.
 *   4. Start-edge check and cycle detection (outer + every loop body at
 *      every nesting level).
 *
 * The returned `Flow` is byte-identical to `loadFlow(spec).value` on
 * success; consumers can treat the two entry points as interchangeable
 * modulo authoring intent.
 */
export function defineFlow(spec: FlowSpec): Result<Flow, FlowError> {
  return loadFlow(spec);
}
