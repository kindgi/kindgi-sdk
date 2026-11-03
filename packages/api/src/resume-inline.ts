// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Logger } from '@kindgi/log';
import type { RunId, TenantId } from '@kindgi/types';

import type { RunHandlerBinding, RunTrace } from './handler-binding.js';

/** How the inline resume after a decision or an answer went. */
export type ResumeReport =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'failed';
      readonly code: string;
      readonly message: string;
      /**
       * `run-lease-lost` from a resume that never took the run, as another
       * executor held it (`RunLeaseLostError.held`). For the log only:
       * `resumeAnswer` leaves it out.
       */
      readonly held?: true;
    };

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
    if (outcome.kind === 'ok') return { kind: 'ok' };
    const { code, message, details } = outcome.error;
    return {
      kind: 'failed',
      code,
      message,
      ...(code === 'run-lease-lost' && details?.held === true && { held: true as const }),
    };
  } catch (cause) {
    return {
      kind: 'failed',
      code: 'resume-failed',
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * Log a resume, after a wait's answer, that didn't go. A resume that found
 * the run held (`held`) is a timing, not trouble: an executor still held
 * the run when the answer came. Most often it's the one that parked the
 * run, which reads the answer and goes on; if that one has stopped, the
 * runtime's sweep resumes the run once its lease ends. So that is `info`.
 * Every other failure is a warning, a lease this resume took and then lost
 * among them.
 */
export function logResumeAfterAnswer(log: Logger, runId: RunId, resumed: ResumeReport): void {
  if (resumed.kind === 'ok') return;
  if (resumed.held === true) {
    log.info('resume after a wait token answer: the run is still held, and goes on there', {
      runId,
      code: resumed.code,
    });
    return;
  }
  log.warn('resume after a wait token answer failed', { runId, code: resumed.code });
}

/** The report as an answer carries it (an approval's `resume`): `held` is for the log. */
export function resumeAnswer(report: ResumeReport): ResumeReport {
  return report.kind === 'ok'
    ? report
    : { kind: 'failed', code: report.code, message: report.message };
}
