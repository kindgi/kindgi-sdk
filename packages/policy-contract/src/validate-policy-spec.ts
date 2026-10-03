// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { validateHitlSpec } from './hitl-spec.js';
import type { PolicyKind } from './index.js';
import { validateToolErrorsSpec } from './tool-errors-spec.js';

export interface PolicySpecIssue {
  /** JSON Pointer into the spec. */
  readonly path: string;
  readonly message: string;
}

/**
 * Check a policy's `spec` against its kind's contract, for the kinds
 * that have one here (`tool-errors`, `hitl`) — so a policy that couldn't
 * be applied is refused when it is written. Other kinds' specs are their
 * runtime consumer's to validate, and pass.
 */
export function validatePolicySpec(kind: PolicyKind, spec: unknown): readonly PolicySpecIssue[] {
  if (kind === 'tool-errors') {
    const checked = validateToolErrorsSpec(spec);
    return checked.kind === 'ok' ? [] : checked.issues;
  }
  if (kind === 'hitl') {
    const checked = validateHitlSpec(spec);
    return checked.kind === 'ok' ? [] : checked.issues;
  }
  return [];
}
