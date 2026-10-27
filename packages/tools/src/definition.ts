// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A tool's definition: what its author declares, as against what a
 * deploy derives. A tool's version numbers are single-use, so a version
 * a registry holds already is the same tool only with the same
 * definition (`sameToolDefinition`). A changed definition takes a new
 * version.
 */

import type { ToolManifest } from './types.js';

/**
 * Each field of a tool's manifest, by who sets it. `declared` fields are
 * set by its author, and compared. `derived` ones are set by a deploy,
 * and never compared. Of `codeArtifactRef`, a deploy derives the image
 * and the artifact version, which every new image changes. Its module
 * path is the author's (`modulePath` in a definition). The map is typed
 * over every field, so a field a later release adds fails the typecheck
 * here until it's classified.
 */
const TOOL_FIELDS: { readonly [K in keyof ToolManifest]-?: 'declared' | 'derived' } = {
  id: 'declared',
  description: 'declared',
  version: 'declared',
  input: 'declared',
  output: 'declared',
  needs: 'declared',
  effects: 'declared',
  transport: 'declared',
  mcpEndpoint: 'declared',
  metadata: 'declared',
  mutating: 'declared',
  needsApprovalWhenUnattended: 'declared',
  pauses: 'declared',
  storesFiles: 'declared',
  resultIsOutsideData: 'declared',
  sandbox: 'declared',
  limits: 'declared',
  network: 'declared',
  needsSpec: 'declared',
  codeArtifactRef: 'derived',
  spec: 'declared',
};

const DECLARED_FIELDS = (Object.keys(TOOL_FIELDS) as (keyof ToolManifest)[]).filter(
  (field) => TOOL_FIELDS[field] === 'declared',
);

/**
 * A tool's definition: its declared fields, in manifest order, and
 * `modulePath`, where its code lives in its pack. An absent field is
 * `undefined`. A record a registry reads (with its project, say) gives
 * the same definition as the manifest it was published from.
 */
export function toolDefinition(tool: ToolManifest): Readonly<Record<string, unknown>> {
  const definition: Record<string, unknown> = {};
  for (const field of DECLARED_FIELDS) definition[field] = tool[field];
  definition.modulePath = tool.codeArtifactRef?.modulePath;
  return definition;
}

/**
 * The fields of a tool's definition (`toolDefinition`) where two
 * manifests differ, in manifest order; none for the same definition.
 * Each field is compared as JSON, with an object's keys in any order (a
 * registry may store it as jsonb) and an absent field the same as an
 * `undefined` one.
 */
export function changedToolFields(a: ToolManifest, b: ToolManifest): readonly string[] {
  const was = toolDefinition(a);
  const now = toolDefinition(b);
  return Object.keys(was).filter((field) => canonical(was[field]) !== canonical(now[field]));
}

/** The same tool definition: `changedToolFields` finds no field that differs. */
export function sameToolDefinition(a: ToolManifest, b: ToolManifest): boolean {
  return changedToolFields(a, b).length === 0;
}

/** JSON with every object's keys sorted, and absent and `undefined` alike. */
function canonical(value: unknown): string {
  return JSON.stringify(JSON.parse(JSON.stringify(value) ?? 'null'), (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v,
  );
}
