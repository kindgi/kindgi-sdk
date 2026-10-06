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
