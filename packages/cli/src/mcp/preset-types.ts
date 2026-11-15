// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Types for `kindgi mcp` presets — the curated per-server config bundles
 * that back `kindgi mcp add <kind>`.
 *
 * A preset is a JSON file under `packages/cli/src/mcp/presets/*.json`,
 * of one of two kinds:
 *
 *   - A launched preset (`LaunchedPreset`): at `kindgi mcp add` time, the
 *     CLI substitutes `--secret=<name>` into the `$SECRET` placeholder of
 *     the envMap template, and writes the fully-resolved launcher argv
 *     into `.mcp.json` at the pack root.
 *   - A connection preset (`ConnectionPreset`): a vendor's own remote MCP
 *     server, which signs in as a connection to an app's entry. `kindgi
 *     mcp add` registers it at the runtime the CLI points at and writes
 *     nothing to `.mcp.json`.
 *
 * See `packages/cli/src/mcp/presets/README.md` for the authoring guide.
 */

import type { HostRemap, Runtime } from './launcher.js';

export type Preset = LaunchedPreset | ConnectionPreset;

/** A server the CLI's launcher runs locally, from `.mcp.json`. */
export interface LaunchedPreset {
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

/**
 * A vendor's own remote MCP server that signs in as a connection: its
 * endpoint is registered with `auth: { scheme: 'connection', app, as }`
 * over `streamable-http`, and lists its tools with the registrant's own
 * connection to `app` (`--as person`) or the company's (`--as company`).
 */
export interface ConnectionPreset {
  /** Short label, matches the JSON filename stem. Used by `kindgi mcp add <kind>`. */
  readonly kind: string;
  /** One-line human summary shown by `kindgi mcp presets`. */
  readonly description?: string;
  /** Marks a connection preset. A launched preset has no `auth`. */
  readonly auth: 'connection';
  /** The app's entry id in `@kindgi/connections`: `hubspot`. */
  readonly app: string;
  /** The endpoint's name at the runtime: `HubSpot`. */
  readonly name: string;
  /** The server's https URL, on an origin the app's entry lists in `mcpServers`. */
  readonly url: string;
}

export function isConnectionPreset(preset: Preset): preset is ConnectionPreset {
  return 'auth' in preset && preset.auth === 'connection';
}

/** Slimmer shape for `kindgi mcp presets` list output. */
export type PresetSummary = LaunchedPresetSummary | ConnectionPresetSummary;

export interface LaunchedPresetSummary {
  readonly kind: string;
  readonly runtime: Runtime;
  readonly package: string;
  readonly description?: string;
  readonly audit: PresetAudit;
}

export interface ConnectionPresetSummary {
  readonly kind: string;
  readonly auth: 'connection';
  readonly app: string;
  readonly url: string;
  readonly description?: string;
}
