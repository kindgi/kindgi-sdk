// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The feedback intake's wire, the CLI's side: Kindgi's intake on
 * access.kindgi.com takes reports from `kindgi feedback submit`, answers
 * `status`, and takes a report back on `withdraw`. All three are
 * unauthenticated JSON POSTs, so a credential is never in a URL.
 *
 * - **`POST /feedback/reports`** takes the client's environment and 1 to 20
 *   entries, and answers each entry's `reportId` (not a credential: it goes
 *   in `FEEDBACK.md`) and `withdrawKey` (the only credential: kept in
 *   `~/.kindgi/feedback/keys.json`, never printed).
 * - **`POST /feedback/reports/status`** takes up to 50 `reportId`s.
 * - **`POST /feedback/reports/withdraw`** takes up to 50 `reportId`s, each
 *   with its `withdrawKey`.
 *
 * The caps here are the service's own, checked before anything is sent,
 * so a report is never cut short and never refused for size after the
 * person said yes. The service checks them again and refuses any other
 * key, so a CLI that sent more would be refused, not stored.
 */

import type { DoctorCheckId } from '../commands/doctor.js';
import type { FeedbackKind, FeedbackSeverity } from './entries.js';

export const FEEDBACK_REPORTS_PATH = '/feedback/reports';
export const FEEDBACK_STATUS_PATH = '/feedback/reports/status';
export const FEEDBACK_WITHDRAW_PATH = '/feedback/reports/withdraw';

/** A request body's limit, in bytes. */
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_ENTRIES = 20;
export const MAX_TITLE_LENGTH = 200;
/** An entry body's limit, in UTF-8 bytes. */
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_CHECKS = 32;
/** How many reports one status or withdraw request asks about. */
export const MAX_REPORT_IDS = 50;

export const REPORT_ID = /^fbr_[A-Za-z0-9_-]{16}$/;
export const WITHDRAW_KEY = /^kgi_fw_[A-Za-z0-9_-]{22}$/;
export const ENTRY_ID = /^\d{4}-\d{2}-\d{2}\.[1-9]\d{0,3}$/;
export const ENTRY_HASH = /^feedback-[0-9a-f]{8}$/;
export const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
export const MAX_VERSION_LENGTH = 64;
export const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export const OS = /^[a-z0-9]{1,16}$/;
export const OS_RELEASE = /^[A-Za-z0-9._+-]{1,64}$/;
export const ARCH = /^[a-z0-9_]{1,16}$/;
export const MAX_ISSUE_URL_LENGTH = 500;
export const MAX_REASON_LENGTH = 200;

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';
export type ProjectLanguage = 'node' | 'python' | 'java' | 'scala';
export type AuthoredBy = 'claude-code' | 'human' | 'mixed';

/** What the CLI says about where it runs: never a path, a URL or a check's text. */
export interface ClientInfo {
  readonly cli: string;
  readonly os: string;
  readonly osRelease: string;
  readonly arch: string;
  readonly node: string;
  readonly language: ProjectLanguage | null;
  readonly checks: readonly { readonly id: DoctorCheckId; readonly status: CheckStatus }[];
}

/** One entry as sent: its title and body after redaction. */
export interface EntryPayload {
  readonly entry: string;
  readonly hash: string;
  readonly title: string;
  readonly kind: FeedbackKind;
  readonly severity: FeedbackSeverity;
  readonly by: AuthoredBy;
  readonly date: string;
  readonly sdk: string;
  readonly cli: string;
  readonly body: string;
}

export interface SubmitPayload {
  readonly client: ClientInfo;
  readonly entries: readonly EntryPayload[];
}

export interface SubmittedReport {
  readonly entry: string;
  readonly reportId: string;
  readonly withdrawKey: string;
}

export const REPORT_STATES = [
  'received',
  'known',
  'fixed',
  'wont-fix',
  'withdrawn',
  'unknown',
] as const;
export type ReportState = (typeof REPORT_STATES)[number];

/** A state the report never leaves: `status` stops asking about it. */
export const FINAL_STATES: ReadonlySet<ReportState> = new Set(['fixed', 'wont-fix', 'withdrawn']);

export interface ReportStatus {
  readonly reportId: string;
  readonly state: ReportState;
  readonly issueUrl?: string;
  readonly fixedIn?: string;
  readonly reason?: string;
}

export interface WithdrawAnswer {
  readonly withdrawn: readonly string[];
  readonly refused: readonly string[];
}

/** A version as the wire takes it: semver, at most 64 characters. */
export function isVersion(value: string): boolean {
  return value.length <= MAX_VERSION_LENGTH && VERSION.test(value);
}

/**
 * The submit answer, checked against what was sent: one report per entry,
 * in the request's order, each with a well-formed id and key. Anything
 * else is `undefined`, and nothing is written.
 */
export function readSubmitAnswer(
  body: unknown,
  sent: readonly EntryPayload[],
): readonly SubmittedReport[] | undefined {
  const reports = recordOf(body)?.reports;
  if (!Array.isArray(reports) || reports.length !== sent.length) return undefined;
  const out: SubmittedReport[] = [];
  for (const [i, raw] of reports.entries()) {
    const r = recordOf(raw);
    const entry = sent[i]?.entry;
    if (
      r === undefined ||
      entry === undefined ||
      r.entry !== entry ||
      typeof r.reportId !== 'string' ||
      !REPORT_ID.test(r.reportId) ||
      typeof r.withdrawKey !== 'string' ||
      !WITHDRAW_KEY.test(r.withdrawKey)
    ) {
      return undefined;
    }
    out.push({ entry, reportId: r.reportId, withdrawKey: r.withdrawKey });
  }
  return new Set(out.map((r) => r.reportId)).size === out.length ? out : undefined;
}

/** The status answer: one per id asked, in order, each with the fields its state allows. */
export function readStatusAnswer(
  body: unknown,
  asked: readonly string[],
): readonly ReportStatus[] | undefined {
  const reports = recordOf(body)?.reports;
  if (!Array.isArray(reports) || reports.length !== asked.length) return undefined;
  const out: ReportStatus[] = [];
  for (const [i, raw] of reports.entries()) {
    const r = recordOf(raw);
    const reportId = asked[i];
    if (r === undefined || reportId === undefined || r.reportId !== reportId) return undefined;
    const state = r.state;
    if (typeof state !== 'string' || !(REPORT_STATES as readonly string[]).includes(state)) {
      return undefined;
    }
    const status: { -readonly [K in keyof ReportStatus]: ReportStatus[K] } = {
      reportId,
      state: state as ReportState,
    };
    if (r.issueUrl !== undefined) {
      if ((state !== 'known' && state !== 'fixed') || !isIssueUrl(r.issueUrl)) return undefined;
      status.issueUrl = r.issueUrl;
    }
    if (r.fixedIn !== undefined) {
      if (state !== 'fixed' || typeof r.fixedIn !== 'string' || !isVersion(r.fixedIn)) {
        return undefined;
      }
      status.fixedIn = r.fixedIn;
    }
    if (r.reason !== undefined) {
      if (
        state !== 'wont-fix' ||
        typeof r.reason !== 'string' ||
        r.reason.length === 0 ||
        r.reason.length > MAX_REASON_LENGTH
      ) {
        return undefined;
      }
      status.reason = r.reason;
    }
    out.push(status);
  }
  return out;
}

/** The withdraw answer: every id asked in exactly one of the two lists. */
export function readWithdrawAnswer(
  body: unknown,
  asked: readonly string[],
): WithdrawAnswer | undefined {
  const r = recordOf(body);
  const withdrawn = r?.withdrawn;
  const refused = r?.refused;
  if (!isStringList(withdrawn) || !isStringList(refused)) return undefined;
  const answered = [...withdrawn, ...refused];
  const want = new Set(asked);
  if (answered.length !== want.size || new Set(answered).size !== answered.length) return undefined;
  if (!answered.every((id) => want.has(id))) return undefined;
  return { withdrawn, refused };
}

function isIssueUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_ISSUE_URL_LENGTH) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
