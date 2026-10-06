// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import { canonicalize } from '@kindgi/schema';

/**
 * The exact version of each block an agent version runs: its lockfile.
 *
 * An agent names its tools by range (`{ id: 'acme.lookup', version:
 * '^1.0.0' }`), like `package.json`. When a version of the agent is
 * published, the runtime resolves each range once, and every run of that
 * version uses the versions recorded here. So a new tool version reaches
 * an agent only through a new agent version, and two runs of one agent
 * version always run the same blocks.
 *
 * Set by the runtime at publish, never authored. A version published
 * before pins existed has none and resolves its ranges per run.
 */
export interface AgentPins {
  /** Tool id → the exact version this agent version runs. */
  readonly tools: Readonly<Record<string, string>>;
  /** Prompt block id → exact version. Empty until the agent references prompt blocks. */
  readonly prompts: Readonly<Record<string, string>>;
  /** Settings block id → exact version. Empty until the agent references settings blocks. */
  readonly settings: Readonly<Record<string, string>>;
}

/**
 * One string naming a set of pins: `sha256:<hex>` of the pins'
 * canonical JSON (keys sorted, no whitespace). Two agent versions with
 * the same digest run the same blocks; the digest is what a comparison
 * of versions, or a gate, records and compares. The Python SDK's
 * `pins_digest` computes the same string.
 */
export function pinsDigest(pins: AgentPins): string {
  const canonical = canonicalize({
    tools: pins.tools,
    prompts: pins.prompts,
    settings: pins.settings,
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/**
 * Why the runtime registered an agent version under another number
 * than the one its definition names:
 *
 * - `pins-changed`: the definition's version is registered with other
 *   pins (a tool it uses has a new version in range), and a version's
 *   pins never change;
 * - `unpinned`: the definition's version was published before pins
 *   existed, so it has none;
 * - `version-taken`: the definition's version is registered with other
 *   content.
 */
export type AgentDerivationReason = 'pins-changed' | 'unpinned' | 'version-taken';

/** The version an agent version was registered in place of, and why. */
export interface AgentDerivation {
  /** The version the agent's definition names. */
  readonly version: string;
  readonly reason: AgentDerivationReason;
}

/** One pin that differs between two agent versions. */
export interface PinChange {
  readonly kind: 'tool' | 'prompt' | 'setting';
  readonly id: string;
  /** The earlier version's pin; absent when it didn't pin this block. */
  readonly from?: string;
  /** The later version's pin; absent when it doesn't pin this block. */
  readonly to?: string;
}

const PIN_KINDS = [
  ['tools', 'tool'],
  ['prompts', 'prompt'],
  ['settings', 'setting'],
] as const;

/**
 * The pins that differ from `before` to `after`, by kind then id. With
 * no `before` (a version published before pins), every pin of `after`
 * is a change.
 */
export function pinChanges(before: AgentPins | undefined, after: AgentPins): PinChange[] {
  const changes: PinChange[] = [];
  for (const [key, kind] of PIN_KINDS) {
    const was = before?.[key] ?? {};
    const now = after[key];
    for (const id of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()) {
      const from = was[id];
      const to = now[id];
      if (from === to) continue;
      changes.push({
        kind,
        id,
        ...(from !== undefined && { from }),
        ...(to !== undefined && { to }),
      });
    }
  }
  return changes;
}
