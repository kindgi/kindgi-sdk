// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The OpenAPI run status lists exactly the runtime's `RunStatus` values.
 * It once said `queued` where the server sends `pending`, so every
 * validating client refused a run started with `options.wait: false`.
 */

import type { RunStatus } from '@kindgi/runtime';
import { describe, expect, test } from 'vitest';

import { RunStatusSchema } from '../src/openapi/schemas.js';

/** Every `RunStatus`, checked by the compiler: adding one to the runtime breaks this record. */
const RUN_STATUSES: Record<RunStatus, true> = {
  pending: true,
  running: true,
  suspended: true,
  completed: true,
  failed: true,
  cancelled: true,
};

describe('RunStatusSchema', () => {
  test("lists exactly the runtime's run statuses", () => {
    expect([...(RunStatusSchema.enum as readonly string[])].sort()).toEqual(
      Object.keys(RUN_STATUSES).sort(),
    );
  });
});
