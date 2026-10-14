// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Per-kind classification decision. The retention + signing + export
 * behavior for one event kind. Loaded from a classifier JSON file at
 * deployment boot; consumed by retention cleanup and signed export.
 */
export interface Classification {
  readonly retention: {
    /**
     * Baseline retention in days. Rows older than this are eligible
     * for deletion UNLESS `legalHold` or `kept` is set OR `onDenyDays`
     * is set and applies.
     */
    readonly days: number;
    /**
     * When set, denied/failed variants of this kind are retained
     * longer than the baseline. Security investigations often need
     * denials retained past the operational rows. Only meaningful
     * for kinds that carry a deny signal (authz-decision:
     * `allowed=false`).
     */
    readonly onDenyDays?: number;
    /**
     * When true, retention cleanup NEVER deletes rows of this kind.
     * Legal-hold semantics — deletion requires operator action past
     * this classifier. Overrides `days`.
     */
    readonly legalHold?: boolean;
    /**
     * When true, rows of this kind are kept as long as their tenant exists:
     * retention cleanup never deletes them by age, and they go when the
     * tenant is purged. Overrides `days` and `onDenyDays`. Unlike
     * `legalHold`, an erasure still erases them.
     *
     * A file gives `kept` in place of `days` (`ClassificationSource`), and
     * a loader fills `days` in, so a reader that predates `kept` still
     * finds a number. That number isn't this kind's retention: whatever
     * applies or shows a kind's retention checks `kept` first, and shows
     * "kept".
     */
    readonly kept?: true;
  };
  /**
   * Kinds that get Ed25519-signed at export time when a regulator
   * bundle is generated. Signatures are byte-exact over canonical
   * event bytes; the classifier doesn't hold the key, only the
   * decision to sign.
   */
  readonly signed: boolean;
  /**
   * Kinds included in regulator-facing signed export bundles.
   * Non-exportable kinds stay out of the bundle regardless of
   * signature policy.
   */
  readonly exportable: boolean;
}

/**
 * A kind's classification as a classifier file writes it: `retention`
 * gives `days` (and optionally `onDenyDays`), or `kept: true` with neither
 * `days` nor `onDenyDays`. A loader refuses a retention that gives both,
 * or neither, and makes a `Classification` of it. A `Classification`
 * without `kept` is already a `ClassificationSource`, so existing files
 * and sources still load unchanged.
 */
export interface ClassificationSource {
  readonly retention:
    | {
        readonly days: number;
        readonly onDenyDays?: number;
        readonly legalHold?: boolean;
      }
    | {
        readonly kept: true;
        readonly legalHold?: boolean;
        readonly days?: never;
        readonly onDenyDays?: never;
      };
  readonly signed: boolean;
  readonly exportable: boolean;
}

/**
 * A classifier, every kind with its own classification: what a loader
 * makes of the file (`ComplianceClassifierSource`), and what
 * `LoadedClassifier.file` holds.
 */
export interface ComplianceClassifierFile {
  readonly version: 1;
  /** Default classification for kinds not explicitly listed. */
  readonly default: Classification;
  /** Per-kind overrides. Missing kind → `default`. */
  readonly byKind: Readonly<Record<string, Classification>>;
}

/**
 * The classifier JSON file as written. A kind's entry is its
 * classification, or the name of another kind whose classification it
 * takes (`"secret-rotated": "secret-set"`), so related kinds can't drift
 * apart. A loader resolves the names into a `ComplianceClassifierFile`; a
 * name must be a kind listed with a classification of its own (not another
 * name, nor `default`), or the file is refused.
 */
export interface ComplianceClassifierSource {
  readonly version: 1;
  readonly default: ClassificationSource;
  readonly byKind: Readonly<Record<string, ClassificationSource | string>>;
}

/**
 * Loaded classifier — same shape as the file, but the `resolve` helper
 * returns the correct classification (per-kind or default) in one call.
 *
 * Built from a `ComplianceClassifierFile` by the runtime's loader or by
 * the caller; deployments pass it to `@kindgi/api` as
 * `CreateAppInput.complianceClassifier`. This package only defines the
 * shape.
 */
export interface LoadedClassifier {
  readonly file: ComplianceClassifierFile;
  /** Return the classification for the given event kind. */
  resolve(kind: string): Classification;
}
