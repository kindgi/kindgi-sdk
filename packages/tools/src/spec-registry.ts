// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ToolContext, ToolSpec } from './types.js';

/**
 * A synthesizer takes a declarative `ToolSpec` variant and returns
 * the runtime handler that satisfies its semantics. Framework core
 * ships the `'http'` synthesizer (see `./http.ts` for the impl).
 * Third-party kinds (SQL, MCP, webhook, ...) register their own via
 * `registerToolSpecSynthesizer(kind, fn)` at module load.
 *
 * The synthesizer receives the fully-validated spec (author-time
 * validation has already run) and returns a handler with the
 * standard `(input, ctx) => Promise<output>` signature. Any
 * per-invoke correctness bits (URL substitution, abort chaining,
 * secret resolution) live inside the handler the synthesizer
 * returns.
 */
/** What the runtime gives a synthesized handler. */
export interface ToolSpecSynthesizerOptions {
  /**
   * The fetch for requests to the hosts a spec names. The runtime passes
   * one that refuses the hosts its deployment forbids
   * (`KINDGI_TENANT_HOST_ACCESS`: the cloud metadata endpoints and the
   * server's own host). Absent: the global `fetch`.
   */
  readonly fetch?: typeof fetch;
}

export type ToolSpecSynthesizer<TSpec extends ToolSpec = ToolSpec> = (
  spec: TSpec,
  toolId: string,
  options?: ToolSpecSynthesizerOptions,
) => (input: unknown, ctx: ToolContext) => Promise<unknown>;

// Registry keyed by the spec's `kind` discriminant. Populated by
// side-effect imports of first-party synthesizer packages (`./http.js`
// registers `'http'`) or third-party equivalents.
const registry = new Map<string, ToolSpecSynthesizer>();

/**
 * Register a synthesizer for a given `spec.kind`. First-party kinds
 * register at framework load; third-party kinds register when their
 * package's module runs. Overwriting an existing kind throws — kind
 * ownership must be explicit to avoid silent shadowing.
 */
export function registerToolSpecSynthesizer<TSpec extends ToolSpec>(
  kind: TSpec['kind'],
  synthesizer: ToolSpecSynthesizer<TSpec>,
): void {
  if (registry.has(kind)) {
    throw new Error(
      `ToolSpec synthesizer for kind "${kind}" is already registered. Multiple registrations for the same kind indicate shadowing — unregister first if replacement is intended.`,
    );
  }
  registry.set(kind, synthesizer as ToolSpecSynthesizer);
}

/**
 * Look up the synthesizer for a `ToolSpec`. Returns `undefined` when
 * no synthesizer is registered for the spec's `kind` — callers
 * (typically `defineTool`) surface this as a clear "no synthesizer
 * for kind X" error at define time.
 */
export function getToolSpecSynthesizer(kind: string): ToolSpecSynthesizer | undefined {
  return registry.get(kind);
}

/**
 * Test-only helper. Removes a registered synthesizer so tests can
 * verify the "no synthesizer registered" error path without process
 * teardown. Not exported from the package barrel — call it via
 * direct import in tests only.
 */
export function _unregisterToolSpecSynthesizer(kind: string): void {
  registry.delete(kind);
}
