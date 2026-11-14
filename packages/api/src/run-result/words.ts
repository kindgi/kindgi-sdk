// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { RunStatus } from '@kindgi/runtime';

/** A run's status in words: one set, used everywhere a run's status shows. */
export const RUN_STATUS_WORDS = {
  pending: 'Waiting to start',
  running: 'Running',
  suspended: 'Waiting',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
} as const satisfies Record<RunStatus, string>;
