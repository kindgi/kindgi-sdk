// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Result, TenantId, Timestamp } from '@kindgi/types';

import type { MemoryError } from './errors.js';
import type { Fact, FactSubject, MemoryScope } from './types.js';

/**
 * What an agent remembers through its `remember` tool: a short text, and
 * optionally the slot (`key`) it fills. A new value for a slot the same
 * agent filled before, for the same type and scope, is that fact's next
 * revision.
 */
export interface RememberedContent {
  readonly text: string;
  readonly key?: string;
}

/** Why a remembered fact waits for a person before any read sees it. */
export type RememberReviewReason =
  /** The declared scope reaches beyond one person (`same-project`, `tenant`). */
  | 'wide-scope'
  /** The text reads like an instruction (always/never/ignore, a URL, a tool name). */
  | 'instruction-like';

/**
 * One `remember` call, as the agent layer builds it from the agent's
 * declaration and the run. The model chooses only the type (among those
 * declared), the text, the slot and how long it's true; never the scope,
 * the trust or whom it's attributed to.
 */
export interface RememberFactInput {
  readonly tenantId: TenantId;
  /** Where it's stored: the declaration's scope, filled from the run. */
  readonly scope: MemoryScope;
  readonly type: string;
  readonly content: RememberedContent;
  /** Whom it's about: the conversation's end user, else the run's user. */
  readonly subjects: readonly FactSubject[];
  /** The agent version that remembered it. */
  readonly agent: { readonly id: string; readonly version: string };
  /**
   * The call that wrote it. A second call with the same run and tool call
   * (a step re-run after a crash) returns the fact the first one wrote.
   */
  readonly generatedBy: {
    readonly runId: string;
    readonly stepId?: string;
    readonly toolCallId: string;
  };
  /** How long it's kept unless a person verifies it (retention `keepDays`). */
  readonly keepDays: number;
  /** When it stops being true in the world, if the model said so. */
  readonly validUntil?: Timestamp;
  /** Present when a person must approve it first; no read sees it until then. */
  readonly review?: { readonly reasons: readonly RememberReviewReason[] };
}

export interface RememberFactResult {
  /** The revision written: `trust: unverified`, `review: pending` while it waits. */
  readonly fact: Fact<RememberedContent>;
  /**
   * `created`: a new fact. `superseded`: the next revision of the fact
   * that held the slot. `replayed`: this call had already written it.
   */
  readonly outcome: 'created' | 'superseded' | 'replayed';
  /** The approval a pending fact waits on. */
  readonly approvalId?: string;
}

/**
 * Agent memory writes (the `remember` tool). Optional on the agent
 * bindings: a host without it offers the tool, and a call says it
 * can't remember.
 */
export interface MemoryRememberBinding {
  remember(input: RememberFactInput): Promise<Result<RememberFactResult, MemoryError>>;
}
