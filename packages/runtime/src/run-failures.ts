// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Timestamp } from '@kindgi/types';

/**
 * Failed runs grouped by cause and version, from server counts (`RunBinding.failureGroups`):
 * the error groups a console shows, and "which version broke it".
 */

/** Whose runs a group counts: an agent's turns, or a flow's runs. */
export interface FailureSubject {
  readonly kind: 'agent' | 'flow';
  readonly id: string;
}

/** What failures are grouped by: the cause, the version, or both (the default). */
export interface FailureGrouping {
  readonly code: boolean;
  readonly version: boolean;
}

export interface FailureGroupsInput {
  readonly tenantId: string;
  readonly projectId: string;
  /** Runs that failed at or after `from` and before `to`. */
  readonly from: Timestamp;
  readonly to: Timestamp;
  /** One agent's or one flow's runs only; absent: every subject in the project. */
  readonly subject?: FailureSubject;
  readonly groupBy: FailureGrouping;
  /** The most groups per list (`groups`, `outcomes`, `unrecorded`), the most failures first. */
  readonly limit: number;
}

/** One group of failed runs. */
export interface FailureGroup {
  /** The failure's code (`Run.failure.code`); absent when not grouped by code. */
  readonly code?: string;
  /** The failure's reason (`Run.failure.reason`), when it gives one: a `hitl-*` outcome's. */
  readonly reason?: string;
  readonly subject: FailureSubject;
  /** The agent's or flow's version; absent when not grouped by version, or not recorded. */
  readonly version?: string;
  readonly count: number;
  readonly firstSeen: Timestamp;
  readonly lastSeen: Timestamp;
  /** The group's most recent run. */
  readonly exampleRunId: string;
}

export interface FailureGroups {
  /** The failures: anything that went wrong. */
  readonly groups: readonly FailureGroup[];
  /** People's decisions, never errors: `hitl-*` codes (an approval rejected, cancelled, timed out). */
  readonly outcomes: readonly FailureGroup[];
  /**
   * Runs that failed before their cause was recorded (a runtime from before
   * this): by subject and version only, never by code.
   */
  readonly unrecorded: readonly FailureGroup[];
  /** Every failed run the window holds, in all three lists. */
  readonly total: number;
}
