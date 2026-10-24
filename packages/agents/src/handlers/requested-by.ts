// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Principal } from '@kindgi/authz';

/**
 * Who asked for an approval a turn opens: whoever the turn runs for, as
 * `user:<id>`, `service_account:<id>` or `system:<id>`. The run keeps its
 * starter, so a turn resumed by someone else's decision still names the
 * person who asked. An agent acting for someone names that someone; an
 * agent acting on its own, or a turn with no principal, names nobody.
 */
export function requestedBy(principal: Principal | undefined): string | undefined {
  const who = principal?.onBehalfOf ?? principal?.actor;
  if (who === undefined || who.kind === 'agent') return undefined;
  return `${who.kind}:${who.id}`;
}
