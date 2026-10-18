// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { toolRequiredEnvNames } from '../src/index.js';

describe('the env values a tool needs set', () => {
  test('the names its code declares with no default, sorted', () => {
    expect(
      toolRequiredEnvNames({
        needsSpec: {
          env: {
            ACME_TIER: { type: 'string' },
            ACME_REGION: { type: 'string', default: 'eu' },
            ACME_HOST: { type: 'string', format: 'hostname' },
          },
        },
      }),
    ).toEqual(['ACME_HOST', 'ACME_TIER']);
    // A default that isn't a string is none: a run would refuse the call.
    expect(
      toolRequiredEnvNames({
        needsSpec: { env: { ACME_PORT: { type: 'string', default: 8080 } } },
      }),
    ).toEqual(['ACME_PORT']);
    expect(toolRequiredEnvNames({})).toEqual([]);
    expect(toolRequiredEnvNames({ needsSpec: { secrets: { ACME_TOKEN: {} } } })).toEqual([]);
  });
});
