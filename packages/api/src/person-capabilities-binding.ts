// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TenantId, UserId } from '@kindgi/types';

/**
 * The capabilities a person holds (`env:write`, `secrets:write`,
 * `signing-keys:write`, …): what the writes that need one check, on top of
 * the caller's role. An API key carries those it was minted with. A
 * sign-in session carries its person's, read here on each request, so one
 * taken away stops at once.
 *
 * The runtime decides who holds what, for example the first admin a tenant
 * is created with. A person puts what they hold on the keys they mint:
 * `POST /v1/tokens` grants only capabilities the minter holds.
 *
 * A system capability (`kindgi:system` or `system:*`) is never a person's:
 * one this returns is dropped.
 */
export interface PersonCapabilitiesBinding {
  /** What `userId` holds in `tenantId`: an empty list when nothing. */
  held(person: {
    readonly tenantId: TenantId;
    readonly userId: UserId;
  }): Promise<readonly string[]>;
}
