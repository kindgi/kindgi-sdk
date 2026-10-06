// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { PolicyKind } from './index.js';
import { retentionSpecDoc, validateRetentionSpec } from './retention-spec.js';

/**
 * The scope a policy holds alone, for the kinds where two policies can't
 * both apply to one thing, or `undefined` when its kind holds none (any
 * number of its policies coexist). Scopes are compared within a kind.
 *
 * A `retention` policy holds its domain, and `'*'`, the tenant-wide
 * default, is a scope of its own: a tenant has one retention policy per
 * domain, so no precedence rule decides between two.
 *
 * Every version of a policy id holds the same scope, so unregistering or
 * reinstating a version never moves a policy onto a scope another one
 * holds. `PolicyRegistryBinding.publish` and `reinstateVersion` enforce
 * both (`scope-taken`, `scope-changed`); calling this keeps the binding
 * kind-neutral.
 */
export function policyScope(policy: {
  readonly kind: PolicyKind;
  readonly spec: unknown;
}): string | undefined {
  if (policy.kind !== 'retention') return undefined;
  const checked = validateRetentionSpec(retentionSpecDoc(policy.spec));
  return checked.kind === 'ok' ? checked.value.domain : undefined;
}
