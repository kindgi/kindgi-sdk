// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { toolOptionalSecretNames, toolRequiredEnvNames } from '../src/index.js';

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

describe('the secrets a tool runs without', () => {
  test("those whose schema says it accepts null, as the runtime reads it, sorted; an unconstrained one doesn't say so", () => {
    expect(
      toolOptionalSecretNames({
        needsSpec: {
          secrets: {
            ACME_NULLABLE: { type: ['string', 'null'] },
            ACME_REQUIRED: { type: 'string' },
            ACME_ANY_OF: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            ACME_UNCONSTRAINED: {},
            ACME_ENUM: { enum: ['x', null] },
            ACME_ONE_OF: { oneOf: [{ const: null }, { type: 'string' }] },
            ACME_NULL: { type: 'null' },
          },
        },
      }),
    ).toEqual(['ACME_ANY_OF', 'ACME_ENUM', 'ACME_NULL', 'ACME_NULLABLE', 'ACME_ONE_OF']);
    expect(toolOptionalSecretNames({})).toEqual([]);
    expect(
      toolOptionalSecretNames({ needsSpec: { env: { ACME_HOST: { type: ['string', 'null'] } } } }),
    ).toEqual([]);
  });

  test("one that names null but refuses it, or that doesn't compile, is required, as at run time", () => {
    expect(
      toolOptionalSecretNames({
        needsSpec: {
          secrets: {
            // `null` isn't in the enum.
            ACME_ENUM_NO_NULL: { type: ['string', 'null'], enum: ['a', 'b'] },
            // `null` matches both branches, and `oneOf` takes exactly one.
            ACME_ONE_OF_BOTH: { oneOf: [{ type: 'null' }, { type: ['string', 'null'] }] },
            ACME_BROKEN: { type: ['string', 'null'], pattern: '(' },
            ACME_NULLABLE: { type: ['string', 'null'] },
          },
        },
      }),
    ).toEqual(['ACME_NULLABLE']);
  });
});
