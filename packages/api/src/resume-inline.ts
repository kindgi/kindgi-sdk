// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { RunId, TenantId } from '@kindgi/types';

import type { RunHandlerBinding, RunTrace } from './handler-binding.js';

/** How the inline resume after a decision or an answer went. */
export type ResumeReport =
  | { readonly kind: 'ok' }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

/**
 * Resume the run a decision (or another system's answer) released, in the
 * same request. A resume that fails is reported, not raised: the decision
 * is durable either way, and the runtime ends a run that can't go on, or
 * resumes it later.
 */
export async function resumeInline(
  runHandler: RunHandlerBinding,
  tenantId: TenantId,
  runId: RunId,
  trace: RunTrace | undefined,
): Promise<ResumeReport> {
  try {
    const outcome = await runHandler.resumeRun({
      tenantId,
      runId,
      ...(trace !== undefined && { trace }),
    });
    return outcome.kind === 'ok'
      ? { kind: 'ok' }
      : { kind: 'failed', code: outcome.error.code, message: outcome.error.message };
  } catch (cause) {
    return {
      kind: 'failed',
      code: 'resume-failed',
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
