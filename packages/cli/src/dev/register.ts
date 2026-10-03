// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Registration bridge — reports the four pack primitives from the
 * parsed `index.json` produced by `runIndexer`. This is a pure
 * read-side reporter: the api-server's disk bindings serve
 * tool / agent / guardrail / flow manifests directly from disk, so
 * the CLI doesn't need to POST anything for these primitives.
 *
 * Kept as a boundary so `dev.ts` still gets a `RegistrationReport`
 * shape for boot + watch-tick summaries. Prod deploy path (when
 * `kindgi deploy` lands) will bring back the transformation +
 * POST loop this file used to contain, likely in a dedicated
 * server-side helper rather than the CLI.
 */

import type { KindgiClient } from '@kindgi/client';
import type { AgentId, FlowId, GuardrailId, Semver, ToolId } from '@kindgi/types';

export interface RegistrationOutcome {
  readonly kind: 'tool' | 'guardrail' | 'agent' | 'flow';
  readonly id: string;
  readonly ok: boolean;
  readonly message?: string;
  /**
   * Non-fatal advisory the CLI surfaces even when `ok === true`.
   * Currently unused: it used to carry the "bump version to
   * publish local edits" nudge on `already-registered` outcomes,
   * but the authoring-tools skill (v0.3.0) explicitly
   * teaches "don't bump on save" — the advice contradicted itself
   * and fired every watch tick regardless of whether the primitive
   * had actually changed. Kept on the interface for future
   * drift-detection use (compare stored vs. local hash → warn only
   * on real drift).
   */
  readonly warning?: string;
}

export interface RegistrationReport {
  readonly registered: RegistrationOutcome[];
  readonly failed: RegistrationOutcome[];
}

export interface RegisterInputs {
  readonly index: unknown;
  readonly apiUrl: string;
  readonly token: string;
  readonly client: KindgiClient;
  readonly fetchImpl: typeof fetch;
  /**
   * Tenant's Default project id, resolved by `kindgi dev` from
   * `RunningApiServer.defaultProjectId`. Included in every POST body
   * because tools/agents/guardrails/flows routes require it.
   * Without this, all registrations fail with
   * `bad-input: projectId is required`.
   */
  readonly projectId: string;
  /**
   * Absolute path to the pack root. Used to resolve indexer-emitted
   * relative `modulePath` / `checkModulePath` into absolute paths
   * before they land in `codeArtifactRef.modulePath` — the sandbox
   * worker imports them by absolute path, so relative-to-pack won't
   * resolve after the api-server process (a different cwd) picks
   * them up.
   */
  readonly packDir: string;
}

interface IndexShape {
  readonly tools?: readonly Record<string, unknown>[];
  readonly guardrails?: readonly Record<string, unknown>[];
  readonly agents?: readonly Record<string, unknown>[];
  readonly flows?: readonly Record<string, unknown>[];
}

/**
 * Register every primitive in the parsed index into the running
 * api-server. Never throws; per-primitive failures land in
 * `report.failed`. Idempotent-friendly: `409 tool-already-registered`
 * outcomes are treated as success — dev mode is meant to be safe to
 * re-run after a save.
 */
export async function registerFromIndex(inputs: RegisterInputs): Promise<RegistrationReport> {
  const idx = (inputs.index ?? {}) as IndexShape;
  const registered: RegistrationOutcome[] = [];
  const failed: RegistrationOutcome[] = [];

  // All four pack primitives are served from disk in dev — the api-
  // server's disk bindings (tools, agents, guardrails, flows) read
  // `index.json` directly. POSTing them
  // here would round-trip to read-only endpoints. Reporting as
  // `from-disk` `ok` outcomes so the boot / watch-tick summary line
  // still shows accurate counts.
  for (const rawTool of idx.tools ?? []) {
    registered.push({
      kind: 'tool',
      id: String(rawTool.id ?? '(unknown-tool)'),
      ok: true,
      message: 'from-disk',
    });
  }
  for (const rawInv of idx.guardrails ?? []) {
    registered.push({
      kind: 'guardrail',
      id: String(rawInv.id ?? '(unknown-guardrail)'),
      ok: true,
      message: 'from-disk',
    });
  }
  for (const rawAgent of idx.agents ?? []) {
    registered.push({
      kind: 'agent',
      id: String(rawAgent.id ?? '(unknown-agent)'),
      ok: true,
      message: 'from-disk',
    });
  }
  for (const rawGraph of idx.flows ?? []) {
    registered.push({
      kind: 'flow',
      id: String(rawGraph.id ?? '(unknown-flow)'),
      ok: true,
      message: 'from-disk',
    });
  }

  return { registered, failed };
}

// Branded-id re-exports so downstream types line up cleanly without
// requiring the register bridge's consumers to import from
// `@kindgi/types` directly.
export type { AgentId, FlowId, GuardrailId, Semver, ToolId };
