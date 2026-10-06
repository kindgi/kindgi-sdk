// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type PinChange, type PinSet, pinChanges } from '@kindgi/agents';
import { canonicalize } from '@kindgi/schema';
import { nextVersion } from '@kindgi/tools';
import type { VersionDerivation, VersionDerivationReason } from '@kindgi/types';

/** A version a deploy registers with pins: an agent's or a flow's. */
export interface PinnedDefinition {
  readonly version: string;
  readonly pins?: PinSet;
  readonly pinsDigest?: string;
  readonly derivedFrom?: VersionDerivation;
}

/**
 * How a deploy registered one of its agents or flows, given its pins.
 * A deploy never keeps a version's old pins and never refuses a
 * routine deploy:
 *
 * - `registered`: the definition's version was free, and is now
 *   registered with these pins;
 * - `unchanged`: it's registered with the same definition and pins (or
 *   its project is gone, which a deploy has always left as it is);
 * - `reused`: an earlier deploy already registered this definition and
 *   these pins under another number (`version`), so a redeploy changes
 *   nothing;
 * - `renumbered`: the definition's version is registered with other
 *   pins or other content, and versions never change, so this deploy
 *   registered the next free version in its line (`nextVersion`).
 */
export type DeployedVersionOutcome =
  | { readonly kind: 'registered' | 'unchanged'; readonly version: string }
  | {
      readonly kind: 'reused' | 'renumbered';
      readonly version: string;
      readonly reason: VersionDerivationReason;
      readonly pinChanges?: readonly PinChange[];
    };

/** What registering one version did: stored it, found the number taken, or left it (no project). */
export type PublishOutcome = 'ok' | 'taken' | 'skipped';

export interface DeployVersionInput<T extends PinnedDefinition> {
  /** Names the definition in an error, e.g. `agent "acme.matcher"`. */
  readonly label: string;
  /** The definition as the pack has it, with no pins. */
  readonly definition: T;
  readonly pins: PinSet;
  readonly pinsDigest: string;
  /** Every active version registered under the definition's id. */
  readonly existing: readonly T[];
  /** Register one version. */
  readonly publish: (version: T) => Promise<PublishOutcome>;
}

/** How many versions after the definition's a deploy tries before it gives up. */
const MAX_RENUMBER = 100;

/**
 * Register a deployed agent or flow with its pins (see
 * `DeployedVersionOutcome`): one rule for both, so they can't drift
 * apart. Each definition is registered at most once per deploy, and a
 * new version derives from the definition's version only, never from a
 * version the same deploy created, so a change cascading from a tool
 * through an agent into a flow ends within the one deploy.
 */
export async function deployVersion<T extends PinnedDefinition>(
  input: DeployVersionInput<T>,
): Promise<DeployedVersionOutcome> {
  const { definition, pins, pinsDigest, existing } = input;
  const authored = definition.version;
  const key = definitionKey(definition);
  const same = (v: T) => definitionKey(v) === key && v.pinsDigest === pinsDigest;

  const atAuthored = existing.find((v) => v.version === authored);
  if (atAuthored !== undefined && same(atAuthored)) return { kind: 'unchanged', version: authored };
  if (atAuthored === undefined) {
    const outcome = await input.publish({ ...definition, pins, pinsDigest });
    if (outcome !== 'taken') {
      return { kind: outcome === 'ok' ? 'registered' : 'unchanged', version: authored };
    }
    // Taken with no active version: an unregistered version holds the
    // number. Register the next one.
  }

  const reason = derivationReason(atAuthored, key);
  const changes =
    reason === 'pins-changed' ? { pinChanges: pinChanges(atAuthored?.pins, pins) } : {};
  const earlier = existing.find(same);
  if (earlier !== undefined) {
    return {
      kind: 'reused',
      version: earlier.version,
      // An expert's edit reused by a deploy reports the deploy's own reason.
      reason:
        earlier.derivedFrom !== undefined && earlier.derivedFrom.reason !== 'edited'
          ? earlier.derivedFrom.reason
          : reason,
      ...changes,
    };
  }
  const taken = new Set(existing.map((v) => v.version));
  const version = await registerNextFree(input, reason, taken);
  return version === undefined
    ? { kind: 'unchanged', version: authored }
    : { kind: 'renumbered', version, reason, ...changes };
}

/** Why the definition's version can't be registered as it is. */
function derivationReason(
  atAuthored: PinnedDefinition | undefined,
  key: string,
): VersionDerivationReason {
  if (atAuthored === undefined || definitionKey(atAuthored) !== key) return 'version-taken';
  return atAuthored.pins === undefined ? 'unpinned' : 'pins-changed';
}

/**
 * Register the definition with its pins under the first free version
 * after its own (`nextVersion`), recording where it came from.
 * `undefined` when it was left as it is (its project is gone).
 */
async function registerNextFree<T extends PinnedDefinition>(
  input: DeployVersionInput<T>,
  reason: VersionDerivationReason,
  taken: ReadonlySet<string>,
): Promise<string | undefined> {
  const { definition, pins, pinsDigest } = input;
  const authored = definition.version;
  let candidate = nextVersion(authored);
  for (let tries = 0; candidate !== undefined && tries < MAX_RENUMBER; tries++) {
    if (!taken.has(candidate)) {
      const outcome = await input.publish({
        ...definition,
        version: candidate,
        pins,
        pinsDigest,
        derivedFrom: { version: authored, reason },
      });
      if (outcome === 'ok') return candidate;
      if (outcome === 'skipped') return undefined;
      // Taken: an unregistered version holds this one too.
    }
    candidate = nextVersion(candidate);
  }
  throw new Error(
    `${input.label}: no free version after ${authored} to register its new pins under`,
  );
}

/** A definition: everything but its version and what the runtime sets. */
export function definitionKey(definition: PinnedDefinition): string {
  const { version: _v, pins: _p, pinsDigest: _d, derivedFrom: _f, ...rest } = definition;
  return canonicalize(rest);
}
