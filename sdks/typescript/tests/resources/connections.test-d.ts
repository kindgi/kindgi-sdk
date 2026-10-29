// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expectTypeOf, it } from 'vitest';

import type { ConnectFinish, ConnectInput } from '../../src/index.js';

describe('connections — the connection a connect reconnects', () => {
  it('a connect may name the connection it reconnects', () => {
    expectTypeOf<ConnectInput>().toHaveProperty('reconnects').toEqualTypeOf<string | undefined>();
  });

  it('the finish answer may say it reconnected, and the name it was to get', () => {
    expectTypeOf<ConnectFinish>()
      .toHaveProperty('reconnected')
      .toEqualTypeOf<boolean | undefined>();
    expectTypeOf<ConnectFinish>().toHaveProperty('labelTaken').toEqualTypeOf<string | undefined>();
  });
});
