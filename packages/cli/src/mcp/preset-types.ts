// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Types for `kindgi mcp` presets — the curated per-server config bundles
 * that back `kindgi mcp add <kind>`.
 *
 * A preset is a JSON file under `packages/cli/src/mcp/presets/*.json`.
 * At `kindgi mcp add` time, the CLI resolves the preset by `kind`,
 * substitutes `--secret=<name>` into the `$SECRET` placeholder of the
 * envMap template, and writes the fully-resolved launcher argv into
 * `.mcp.json` at the pack root.
 *
 * See `packages/cli/src/mcp/presets/README.md` for the authoring guide.
 */

import type { HostRemap, Runtime } from './launcher.js';

export interface Preset {
  /** Short label, matches the JSON filename stem. Used by `kindgi mcp add <kind>`. */
  readonly kind: string;
  /** One-line human summary shown by `kindgi mcp presets`. */
  readonly description?: string;
  /** Which spawn strategy the launcher uses. */
  readonly runtime: Runtime;
  /** npm package (for `npx`) or Docker image (for `docker`). */
  readonly package: string;
  /**
   * How to route the caller's `--secret=<name>` into the child's env.
   * Every entry has `from: "$SECRET"` today — the placeholder that
   * substitutes with the user-provided secret name at `mcp add` time.
   * Future template forms (e.g. per-secret refs, literal values) can
   * extend this shape without breaking existing presets.
   */
  readonly envMap: readonly PresetEnvMapEntry[];
  /** Passthrough args appended after `--` when spawning the child. */
  readonly defaultArgs: readonly string[];
  /** Docker-Desktop-on-Mac localhost fixup — see launcher's applyHostRemap. */
  readonly hostRemap?: HostRemap;
  /** Per-server audit metadata (who reviewed the server, and when). */
  readonly audit: PresetAudit;
}

export interface PresetEnvMapEntry {
  /** The env-var name in the CHILD process. */
  readonly child: string;
  /**
   * Template that resolves the value. Only `"$SECRET"` today — expands
   * to the caller's `--secret=<name>`.
   */
  readonly from: string;
}

export interface PresetAudit {
  /**
   * Has this preset's server version been verified NOT to echo the
   * resolved secret in its error tool results / debug logs?
   *   - `verified-safe` — a real inspection succeeded at `version`
   *   - `pending` — no inspection yet; assume unsafe
   *   - `known-issue` — inspection found a leak; details in `notes`
   */
  readonly urlLeakInErrors: 'verified-safe' | 'pending' | 'known-issue';
  /** ISO date of the last audit. Null when `urlLeakInErrors === 'pending'`. */
  readonly reviewedAt: string | null;
  /** npm / Docker tag of the version audited. Null when `pending`. */
  readonly version: string | null;
  /** Free-form notes — quirks, links to related issues, etc. */
  readonly notes?: string;
}

/** Slimmer shape for `kindgi mcp presets` list output. */
export interface PresetSummary {
  readonly kind: string;
  readonly runtime: Runtime;
  readonly package: string;
  readonly description?: string;
  readonly audit: PresetAudit;
}
