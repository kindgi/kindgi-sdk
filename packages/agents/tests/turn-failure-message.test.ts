// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { type InvokeAgentError, parseFailureMessage, turnFailureMessage } from '../src/index.js';

describe('turnFailureMessage', () => {
  test("is a run failure message that reads back as the turn's typed error", () => {
    const error = {
      code: 'tool-version-unresolvable',
      message: 'this turn started with version 0.1.0 of tool "acme.post-update"',
      toolId: 'acme.post-update',
    } as unknown as InvokeAgentError;
    expect(parseFailureMessage(turnFailureMessage(error))).toEqual(error);
  });
});
