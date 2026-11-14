// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A run whose turn a tool failed on purpose (`ToolFailure`) reads back as
 * `tool-failed`: the tool's code as `reason`, its words, its details whole,
 * and the tool as `cause`.
 */

import { describe, expect, test } from 'vitest';

import { turnFailureMessage } from '@kindgi/agents';

import { runFailure } from '../src/run-failure.js';

const failed = (failureMessage: string) => ({ runId: 'run-1', status: 'failed', failureMessage });

describe('runFailure — tool-failed', () => {
  test("has the tool's code as reason, its words, its details whole, and the tool as cause", () => {
    const failure = runFailure(
      failed(
        turnFailureMessage({
          code: 'tool-failed',
          message: 'No order Z-9',
          toolId: 'acme.get-order',
          reason: 'order-not-found',
          details: { orderId: 'Z-9', lookedIn: ['live', 'archive'] },
          toolRetries: 1,
        }),
      ),
    );
    expect(failure).toStrictEqual({
      code: 'tool-failed',
      message: 'No order Z-9',
      cause: { toolId: 'acme.get-order' },
      reason: 'order-not-found',
      details: { orderId: 'Z-9', lookedIn: ['live', 'archive'] },
    });
  });

  test('has no details when the tool gave none', () => {
    const failure = runFailure(
      failed(
        turnFailureMessage({
          code: 'tool-failed',
          message: 'No order Z-9',
          toolId: 'acme.get-order',
          reason: 'order-not-found',
        }),
      ),
    );
    expect(failure).toStrictEqual({
      code: 'tool-failed',
      message: 'No order Z-9',
      cause: { toolId: 'acme.get-order' },
      reason: 'order-not-found',
    });
  });
});
