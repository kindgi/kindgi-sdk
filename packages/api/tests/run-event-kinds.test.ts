// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The run stream lists only the kinds it sends: `RUN_EVENT_KINDS`, which
 * `RunEvent.kind` is (`RunEventSchema`, mirrored by
 * `@kindgi/specs/run-event.schema.json`), holds exactly the kinds a kernel
 * journal kind is sent as (`KERNEL_TO_WIRE`). A kind goes on the list with
 * the mapping that sends it, and comes off with it.
 */

import { describe, expect, test } from 'vitest';

import { KERNEL_TO_WIRE, RUN_EVENT_KINDS } from '../src/routes/sse.js';

describe('the run stream lists only the kinds it sends', () => {
  test('every listed kind is one a journal kind is sent as, and every one sent is listed', () => {
    const sent = [...new Set(Object.values(KERNEL_TO_WIRE))].sort();
    expect([...RUN_EVENT_KINDS].sort()).toEqual(sent);
  });

  test('each kind is listed once', () => {
    expect(new Set(RUN_EVENT_KINDS).size).toBe(RUN_EVENT_KINDS.length);
  });
});
