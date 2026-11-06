// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expectTypeOf, it } from 'vitest';

import type {
  CapabilitiesClient,
  LegacyCapabilitiesProvider,
  Provider,
  ProviderSpec,
  ProvidersClient,
  RegisterProviderInput,
} from '../../src/index.js';

type LegacyProviders = CapabilitiesClient['providers'];

describe('capabilities.providers (deprecated) — typed as client.providers answers', () => {
  it('the deprecated provider name is the provider the API sends', () => {
    expectTypeOf<LegacyCapabilitiesProvider>().toEqualTypeOf<Provider>();
    expectTypeOf<LegacyCapabilitiesProvider>().toHaveProperty('models');
  });

  it('get and list answer what client.providers answers', () => {
    expectTypeOf<Awaited<ReturnType<LegacyProviders['get']>>>().toEqualTypeOf<
      Awaited<ReturnType<ProvidersClient['get']>>
    >();
    expectTypeOf<Awaited<ReturnType<LegacyProviders['list']>>['data']>().toEqualTypeOf<
      readonly Provider[]
    >();
  });

  it('configure takes the register body, not the flat spec', () => {
    expectTypeOf<
      Parameters<LegacyProviders['configure']>[0]
    >().toEqualTypeOf<RegisterProviderInput>();
    expectTypeOf<ProviderSpec>().not.toMatchTypeOf<RegisterProviderInput>();
  });
});
