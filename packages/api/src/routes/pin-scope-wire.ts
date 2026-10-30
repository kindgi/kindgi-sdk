// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { PinScope } from '@kindgi/types';

import {
  type WireAgentPinScope,
  agentPinScopeToWire,
  parseAgentPinScopeBody,
} from './agent-pin-scope-wire.js';

/** A pin scope on the wire: the pinned scope's tenant, org and project shapes. */
export type WirePinScope = Exclude<WireAgentPinScope, { readonly kind: 'segment' }>;

export function pinScopeToWire(scope: PinScope): WirePinScope {
  return agentPinScopeToWire(scope) as WirePinScope;
}

/**
 * A pin scope from a request body (`scope`): `{kind: 'tenant'}`,
 * `{kind: 'org', orgId}` or `{kind: 'project', projectId}`. A segment
 * scope, whatever its path, is a scope but not a pin scope (`segment`):
 * flows and tools pin per project, org or tenant.
 */
export function parsePinScopeBody(
  raw: unknown,
):
  | { readonly kind: 'ok'; readonly scope: PinScope }
  | { readonly kind: 'segment' }
  | { readonly kind: 'err'; readonly message: string } {
  if (raw !== null && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'segment') {
    return { kind: 'segment' };
  }
  const parsed = parseAgentPinScopeBody(raw);
  if (parsed.kind === 'err') {
    return parsed.message.startsWith('`scope.kind`')
      ? { kind: 'err', message: '`scope.kind` must be one of tenant, org, project' }
      : parsed;
  }
  return parsed.scope.kind === 'segment'
    ? { kind: 'segment' }
    : { kind: 'ok', scope: parsed.scope };
}
