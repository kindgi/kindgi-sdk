// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { validateHitlSpec } from './hitl-spec.js';
import type { PolicyKind } from './index.js';
import {
  RETENTION_DOMAINS,
  type RetentionSpecValidationError,
  retentionSpecDoc,
  validateRetentionSpec,
} from './retention-spec.js';
import { validateToolErrorsSpec } from './tool-errors-spec.js';

export interface PolicySpecIssue {
  /** JSON Pointer into the spec. */
  readonly path: string;
  readonly message: string;
}

/**
 * Check a policy's `spec` against its kind's contract, for the kinds
 * that have one here (`tool-errors`, `hitl`, `retention`) — so a policy
 * that couldn't be applied is refused when it is written. Other kinds'
 * specs are their runtime consumer's to validate, and pass.
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
  if (kind === 'retention') return retentionSpecIssues(spec);
  return [];
}

/**
 * A `retention` spec, wrapped in its `{ v: 1, doc }` envelope or bare:
 * an unknown domain, a mode other than `purge` (`archive` isn't
 * implemented) or a bad grace is refused rather than stored and skipped
 * by every sweep.
 */
function retentionSpecIssues(spec: unknown): readonly PolicySpecIssue[] {
  const wrapped = typeof spec === 'object' && spec !== null && 'doc' in spec;
  const at = wrapped ? '/doc' : '';
  if (wrapped) {
    const envelope = spec as { readonly v?: unknown; readonly doc: unknown };
    if (envelope.v !== undefined && envelope.v !== 1) {
      return [{ path: '/v', message: 'must be 1' }];
    }
    if (typeof envelope.doc !== 'object' || envelope.doc === null) {
      return [{ path: '/doc', message: 'must be an object' }];
    }
  }
  const checked = validateRetentionSpec(retentionSpecDoc(spec));
  return checked.kind === 'ok' ? [] : [retentionIssue(checked.error, at)];
}

function retentionIssue(error: RetentionSpecValidationError, at: string): PolicySpecIssue {
  switch (error.code) {
    case 'missing-field':
      return { path: `${at}/${error.field}`, message: 'is required' };
    case 'invalid-domain':
      return {
        path: `${at}/domain`,
        message: `must be one of: ${RETENTION_DOMAINS.join(', ')} (got ${JSON.stringify(error.value)})`,
      };
    case 'invalid-grace':
      return {
        path: `${at}/graceSeconds`,
        message: `must be 0 or more seconds, or -1 to keep forever (got ${JSON.stringify(error.value)})`,
      };
    case 'invalid-mode':
      return {
        path: `${at}/mode`,
        message: `must be "purge" (got ${JSON.stringify(error.value)})`,
      };
    case 'unsupported-mode':
      return { path: `${at}/mode`, message: 'can\'t be "archive" yet: use "purge"' };
  }
}
