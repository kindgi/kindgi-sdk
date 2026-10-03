// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { assertType, describe, expectTypeOf, test } from 'vitest';
import type { AgentId, Brand, TenantId, ToolId, UserId } from './ids.js';

describe('branded IDs', () => {
  test('a branded id is assignable from a cast, not from a bare string', () => {
    const raw = 'abc';
    // A cast is the sanctioned way to construct a branded id.
    const tenant: TenantId = raw as TenantId;
    expectTypeOf(tenant).toEqualTypeOf<TenantId>();
    // A bare string is NOT assignable to a branded id (compile error).
    // @ts-expect-error — bare string cannot be assigned to a branded id.
    const _bad: TenantId = raw;
  });

  test('two different branded ids are not interchangeable', () => {
    const tenant = 'abc' as TenantId;
    // TenantId is not assignable to UserId, and vice versa.
    // @ts-expect-error — TenantId is not a UserId.
    const _asUser: UserId = tenant;
    // @ts-expect-error — a UserId literal isn't automatically a TenantId either.
    const _asTenant: TenantId = 'u1' as UserId;
  });

  test('branded ids still behave structurally as strings', () => {
    const tool = 'acme.verify-citation' as ToolId;
    // String operations preserve the underlying primitive.
    expectTypeOf(tool.length).toEqualTypeOf<number>();
    expectTypeOf(tool.toString()).toEqualTypeOf<string>();
    // But the operation result is NOT branded (any string producer drops the brand).
    expectTypeOf(`${tool}`).toEqualTypeOf<string>();
  });

  test('Brand utility composes cleanly for pack-scoped ids', () => {
    type MatterId = Brand<string, 'MatterId'>;
    const matter = 'm-42' as MatterId;
    expectTypeOf(matter).toEqualTypeOf<MatterId>();
    // Pack-scoped ids don't collide with framework ids.
    // @ts-expect-error — MatterId is not an AgentId.
    const _agent: AgentId = matter;
  });

  test('assertType negative: passing wrong id shape must fail at call site', () => {
    function useTenant(t: TenantId): void {
      assertType<TenantId>(t);
    }
    const tenant = 'abc' as TenantId;
    useTenant(tenant);
    // @ts-expect-error — a UserId cannot be passed where TenantId is expected.
    useTenant('u1' as UserId);
  });
});
