// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import semver from 'semver';

/**
 * The one rule for picking a version, used wherever Kindgi turns a
 * version range into the version that runs: the in-process registry a
 * turn resolves its tools against, the runtime's registries, `kindgi dev`
 * and the versions an agent version pins at publish. Picks that agree
 * here are what lets a pin match what a run would have picked.
 *
 * - A range picks the highest version it allows, by npm's rule: a
 *   prerelease is picked only when the range names a prerelease of the
 *   same `major.minor.patch`. `^1.0.0` never picks `1.3.0-beta.1`;
 *   `^1.3.0-beta.0` does.
 * - No range picks the latest: the highest version, a prerelease
 *   included.
 *
 * Tool versions are plain `major.minor.patch`, so for tools the
 * prerelease rule never comes up. Strings in `available` that aren't
 * valid semver are skipped.
 */
export type VersionPick =
  | { readonly kind: 'ok'; readonly version: string }
  /** The range isn't valid semver range grammar. */
  | { readonly kind: 'invalid-range' }
  /** The range is valid, but no version in `available` satisfies it. */
  | { readonly kind: 'not-satisfiable' };

/** Pick the version a range (or, with none, "latest") resolves to. */
export function pickVersion(available: readonly string[], range?: string): VersionPick {
  if (range === undefined) {
    const latest = latestVersion(available);
    return latest === undefined ? { kind: 'not-satisfiable' } : { kind: 'ok', version: latest };
  }
  if (semver.validRange(range) === null) return { kind: 'invalid-range' };
  const picked = semver.maxSatisfying([...available], range);
  return picked === null ? { kind: 'not-satisfiable' } : { kind: 'ok', version: picked };
}

/** The highest version in `available`, a prerelease included. */
export function latestVersion(available: readonly string[]): string | undefined {
  return semver.maxSatisfying([...available], '*', { includePrerelease: true }) ?? undefined;
}
