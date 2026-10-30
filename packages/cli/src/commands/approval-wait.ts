// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `--wait[=<duration>]` on the commands that pin an agent version
 * through its scope's release gate (`kindgi agents pin`,
 * `kindgi promote --make-live`): read a pin that waits for an
 * approval until a reviewer decides it, or until the wait runs out.
 *
 * The wait never withdraws the approval. Once it's approved, the version
 * is pinned whether or not anything still waits.
 */

import type { Pin } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { callWaitingOutRateLimits } from '../rate-limit-wait.js';
import type { ParseArgsOption } from './types.js';

/** A test seam for the wait's clock and pauses. Production leaves it undefined. */
export interface ApprovalWaitSeam {
  /** Milliseconds since the epoch. Default: `Date.now`. */
  readonly now?: () => number;
  /** The pause between reads of a pin. Default: a timer the stop signal cuts short. */
  readonly pause?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** How often a wait reads the pin. */
export const APPROVAL_POLL_MS = 5_000;

/** How long a bare `--wait` waits. */
export const DEFAULT_APPROVAL_WAIT_MS = 60 * 60 * 1_000;

/**
 * Reads in a row that may fail before a wait gives up, as `kindgi deploy`'s
 * wait for its pack service does: a wait reads the pin up to 720
 * times an hour, so one failed read mustn't end it.
 */
export const APPROVAL_READ_TRIES = 3;

const WAIT_RE = /^(\d+)([smh])$/;
const UNIT_MS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000 };

export const WAIT_FLAG: Readonly<Record<string, ParseArgsOption>> = {
  wait: {
    type: 'string',
    optionalValue: true,
    description:
      'When a version waits for an approval, wait until a reviewer decides: at most the duration given (90s, 30m, 2h), 1h when none is. Exits 0 once it is pinned, and 3 when it is rejected, its approval expires, it is superseded or the wait runs out, and 1 when 3 reads of the pin in a row fail. An approval stays open after the wait.',
  },
};

/** `--wait` in milliseconds: `undefined` when it isn't given, an hour when it's bare. */
export function waitFlag(ctx: CommandContext): number | undefined {
  const raw = ctx.options.wait;
  if (raw === undefined) return undefined;
  if (raw === '') return DEFAULT_APPROVAL_WAIT_MS;
  const span = typeof raw === 'string' ? WAIT_RE.exec(raw) : null;
  const ms = span === null ? 0 : Number(span[1]) * (UNIT_MS[span[2] as string] as number);
  if (ms <= 0) throw new UsageError(`--wait must be like 90s, 30m or 2h, got "${String(raw)}"`);
  return ms;
}

/** `ms` as a `--wait` value says it: `1h`, `30m` or `90s`. */
export function waitWords(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.ceil(ms / 1_000)}s`;
}

/** How a wait ended. `P` is the pin as last read: `undefined` when none was. */
export type ApprovalWaited<P extends Pin | undefined = Pin> =
  /** A reviewer decided it, or it ended another way: `pin.status` says how. */
  | { readonly kind: 'decided'; readonly pin: Pin }
  /** The wait ran out with the pin still waiting. */
  | { readonly kind: 'still-waiting'; readonly pin: P }
  /** The person stopped the wait (Ctrl-C). */
  | { readonly kind: 'stopped'; readonly pin: P }
  /** `APPROVAL_READ_TRIES` reads in a row failed: `message` says why the last one did. */
  | { readonly kind: 'unreadable'; readonly pin: P; readonly message: string };

/** When a wait of `ms` from now ends, by the seam's clock. */
export function waitDeadline(ctx: CommandContext, ms: number): number {
  return (ctx.approvalWaitSeam?.now ?? Date.now)() + ms;
}

/**
 * Read a pin with `read` until it no longer waits for an approval,
 * until `deadline`, or until the person stops the wait. `pin` is
 * the pin as last read; without it, the wait reads it first. A read
 * the server answers with a rate limit is sent again once the limit says
 * so. A read that fails is tried again at the next read, and the wait
 * gives up only when `APPROVAL_READ_TRIES` fail in a row.
 */
export function waitForApproval(
  ctx: CommandContext,
  pin: Pin,
  read: () => Promise<Pin>,
  deadline: number,
): Promise<ApprovalWaited>;
export function waitForApproval(
  ctx: CommandContext,
  pin: undefined,
  read: () => Promise<Pin>,
  deadline: number,
): Promise<ApprovalWaited<Pin | undefined>>;
export async function waitForApproval(
  ctx: CommandContext,
  pin: Pin | undefined,
  read: () => Promise<Pin>,
  deadline: number,
): Promise<ApprovalWaited<Pin | undefined>> {
  let current = pin;
  for (let failedReads = 0; ; ) {
    if (current !== undefined && current.status !== 'pending-approval') {
      return { kind: 'decided', pin: current };
    }
    // Nothing to wait for before the first read of a pin not yet read.
    if (current !== undefined || failedReads > 0) {
      const ended = await pauseBeforeRead(ctx, current, deadline);
      if (ended !== undefined) return ended;
    }
    const answer = await readOnce(ctx, read);
    if ('pin' in answer) {
      current = answer.pin;
      failedReads = 0;
      continue;
    }
    failedReads += 1;
    if (failedReads >= APPROVAL_READ_TRIES) {
      return { kind: 'unreadable', pin: current, message: answer.message };
    }
  }
}

/** The pause before the next read; how the wait ends, when it runs out or is stopped first. */
async function pauseBeforeRead<P extends Pin | undefined>(
  ctx: CommandContext,
  current: P,
  deadline: number,
): Promise<ApprovalWaited<P> | undefined> {
  const seam = ctx.approvalWaitSeam ?? {};
  const left = deadline - (seam.now ?? Date.now)();
  if (left <= 0) return { kind: 'still-waiting', pin: current };
  await (seam.pause ?? pauseUnlessStopped)(Math.min(APPROVAL_POLL_MS, left), ctx.stopSignal);
  return ctx.stopSignal?.aborted === true ? { kind: 'stopped', pin: current } : undefined;
}

/** One read, with a rate limit waited out: the pin, or why the read failed. */
async function readOnce(
  ctx: CommandContext,
  read: () => Promise<Pin>,
): Promise<{ readonly pin: Pin } | { readonly message: string }> {
  try {
    return { pin: await callWaitingOutRateLimits(ctx, read) };
  } catch (err) {
    return { message: err instanceof Error ? err.message : String(err) };
  }
}

/** A version that waits for an approval, as a line names it: a pin, or a carried version. */
export interface WaitingVersion {
  readonly agentId: string;
  /** `null` only on an unpin, which never waits. */
  readonly toVersion: string | null;
  readonly approvalId?: string | undefined;
  readonly status?: string | undefined;
  readonly checks?: readonly { readonly name: string; readonly message: string }[] | undefined;
}

/** The agent and the version, as the lines name them. */
function versionWords(pin: WaitingVersion): string {
  return pin.toVersion === null ? pin.agentId : `${pin.agentId} ${pin.toVersion}`;
}

/** The line a wait starts with: what it waits for, and the command that approves it. */
export function waitingLine(pin: WaitingVersion, ms: number): string {
  const what = versionWords(pin);
  return pin.approvalId !== undefined
    ? `Waiting up to ${waitWords(ms)} for approval ${pin.approvalId} of ${what}: \`kindgi approvals complete ${pin.approvalId} --decision=approve\` approves it.`
    : `Waiting up to ${waitWords(ms)} for an approval of ${what}.`;
}

/** What a pin that still waits says: the approval stays open. */
export function stillOpenLine(pin: WaitingVersion): string {
  const which = pin.approvalId !== undefined ? `Approval ${pin.approvalId}` : 'Its approval';
  return `${which} stays open: once it's approved, ${versionWords(pin)} is pinned.`;
}

/** What a wait that couldn't read the pin says: why, and that its approval stays open. */
export function unreadableLine(pin: WaitingVersion, message: string): string {
  return `Couldn't read the pin of ${versionWords(pin)} ${APPROVAL_READ_TRIES} times in a row (${message}). ${stillOpenLine(pin)}`;
}

/** What a pin that ended without being pinned says: how it ended. */
export function endedLine(pin: WaitingVersion): string {
  const what = versionWords(pin);
  const approval = pin.approvalId !== undefined ? `Approval ${pin.approvalId}` : 'Its approval';
  switch (pin.status) {
    case 'rejected':
      return `${approval} was rejected: ${what} doesn't get pinned.`;
    case 'expired':
      return `${approval} expired undecided: ${what} doesn't get pinned.`;
    case 'superseded': {
      const reason = recheckMessage(pin);
      return reason !== undefined
        ? `${what} was superseded: ${reason} Pin it again to ask again.`
        : `${what} was approved, but superseded: something its check measured changed before the approval. Pin it again to ask again.`;
    }
    default:
      return `${what} ended ${pin.status ?? 'without a status'}: it doesn't get pinned.`;
  }
}

/**
 * Why the server superseded a pin: its `approval.recheck` check, which
 * the approval adds when something the check measured has changed by then.
 */
function recheckMessage(pin: WaitingVersion): string | undefined {
  return pin.checks?.find((check) => check.name === 'approval.recheck')?.message;
}

function pauseUnlessStopped(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
