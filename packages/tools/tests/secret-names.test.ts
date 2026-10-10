// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { toolSecretNames } from '../src/index.js';

describe('the secrets a tool uses', () => {
  test("its code's declared secrets and an HTTP spec's key, sorted, each once", () => {
    expect(
      toolSecretNames({
        needsSpec: { secrets: { SEARCH_KEY: { type: 'string' }, ACME_TOKEN: { type: 'string' } } },
        spec: {
          kind: 'http',
          method: 'GET',
          urlTemplate: 'https://api.acme.example/search',
          authorization: { kind: 'bearer', secretRef: { envName: 'prod', name: 'RELAY_TOKEN' } },
        } as never,
      }),
    ).toEqual(['ACME_TOKEN', 'RELAY_TOKEN', 'SEARCH_KEY']);
    // Declared and sent: listed once.
    expect(
      toolSecretNames({
        needsSpec: { secrets: { SEARCH_KEY: { type: 'string' } } },
        spec: {
          kind: 'http',
          method: 'GET',
          urlTemplate: 'https://api.acme.example/search',
          authorization: { kind: 'bearer', secretRef: { envName: 'prod', name: 'SEARCH_KEY' } },
        } as never,
      }),
    ).toEqual(['SEARCH_KEY']);
    expect(toolSecretNames({})).toEqual([]);
  });
});
