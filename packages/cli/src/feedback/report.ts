// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What `kindgi feedback submit` sends: the entries picked from `FEEDBACK.md`,
 * their titles and bodies redacted, and the client's environment, checked
 * against the intake's caps and turned into the exact bytes the person OKs.
 * The digest is the sha256 of those bytes: `--yes=<digest>` sends them only
 * if nothing changed since the preview.
 */

import { createHash } from 'node:crypto';

import type { DoctorReport } from '../commands/doctor.js';
import { AUTHORS, type FeedbackEntry, KINDS, SEVERITIES } from './entries.js';
import {
  ARCH,
  type AuthoredBy,
  type ClientInfo,
  DATE,
  ENTRY_HASH,
  ENTRY_ID,
  type EntryPayload,
  MAX_BODY_BYTES,
  MAX_CHECKS,
  MAX_ENTRIES,
  MAX_REQUEST_BYTES,
  MAX_TITLE_LENGTH,
  OS,
  OS_RELEASE,
  type SubmitPayload,
  isVersion,
} from './protocol.js';
import {
  REDACTION_RULES,
  type RedactionContext,
  type RedactionRule,
  redactForSending,
} from './redact.js';

/** Where the CLI runs, as the payload says it. */
export interface Platform {
  readonly os: string;
  readonly osRelease: string;
  readonly arch: string;
  readonly node: string;
}

/** An entry that can't be sent as it is, and why: named by its id, or its title without one. */
export interface EntryProblem {
  readonly entry: string;
  readonly problem: string;
}

/** The entries to send: those named, or with none named, every one not yet sent and not fixed. */
export function pickEntries(
  entries: readonly FeedbackEntry[],
  selectors: readonly string[],
):
  | { readonly kind: 'ok'; readonly picked: readonly FeedbackEntry[] }
  | { readonly kind: 'unmatched'; readonly selectors: readonly string[] } {
  if (selectors.length === 0) {
    return {
      kind: 'ok',
      picked: entries.filter((e) => e.submissions.length === 0 && !e.fixed),
    };
  }
  const unmatched = selectors.filter(
    (s) => !entries.some((e) => e.fields.id === s || e.fields.hash === s),
  );
  if (unmatched.length > 0) return { kind: 'unmatched', selectors: unmatched };
  return {
    kind: 'ok',
    picked: entries.filter(
      (e) => selectors.includes(e.fields.id ?? '') || selectors.includes(e.fields.hash ?? ''),
    ),
  };
}

/** The client's environment: the doctor's checks as id and status only, never their text. */
export function clientInfo(doctor: DoctorReport, platform: Platform): ClientInfo {
  return {
    cli: isVersion(doctor.cliVersion) ? doctor.cliVersion : 'unknown',
    os: OS.test(platform.os) ? platform.os : 'unknown',
    osRelease: OS_RELEASE.test(platform.osRelease) ? platform.osRelease : 'unknown',
    arch: ARCH.test(platform.arch) ? platform.arch : 'unknown',
    node: platform.node,
    language: doctor.project?.language ?? null,
    checks: doctor.checks.slice(0, MAX_CHECKS).map((c) => ({ id: c.id, status: c.status })),
  };
}

/** One entry as sent, its title and body redacted, or what stops it being sent. */
export function entryPayload(
  entry: FeedbackEntry,
  redaction: RedactionContext,
):
  | {
      readonly kind: 'ok';
      readonly payload: EntryPayload;
      readonly applied: readonly RedactionRule[];
    }
  | { readonly kind: 'problem'; readonly problem: EntryProblem } {
  const f = entry.fields;
  const name = f.id !== undefined && ENTRY_ID.test(f.id) ? f.id : `"${entry.title}"`;
  const bad = (problem: string) => ({
    kind: 'problem' as const,
    problem: { entry: name, problem },
  });
  if (f.id === undefined || !ENTRY_ID.test(f.id))
    return bad('its id line (`- **id:** YYYY-MM-DD.N`) is missing or malformed');
  if (f.hash === undefined || !ENTRY_HASH.test(f.hash))
    return bad('its hash (`feedback-<8 hex>`) is missing or malformed');
  if (!(KINDS as readonly string[]).includes(f.kind ?? ''))
    return bad(`its kind must be one of ${KINDS.join(', ')}`);
  if (!(SEVERITIES as readonly string[]).includes(f.severity ?? '')) {
    return bad(`its severity must be one of ${SEVERITIES.join(', ')}`);
  }
  if (!(AUTHORS as readonly string[]).includes(f.by ?? ''))
    return bad(`its by must be one of ${AUTHORS.join(', ')}`);
  if (f.date === undefined || !DATE.test(f.date))
    return bad('its date must be an ISO 8601 time in UTC, as `feedback write` writes it');
  for (const key of ['sdk', 'cli'] as const) {
    const v = f[key];
    if (v === undefined || !(v === 'unknown' || isVersion(v)))
      return bad(`its ${key} must be a version or unknown`);
  }
  const title = redactForSending(entry.title.trim(), redaction);
  const body = redactForSending(entry.body, redaction);
  if (title.text === '') return bad('its title is empty');
  if (title.text.length > MAX_TITLE_LENGTH) {
    return bad(
      `its title is ${title.text.length} characters; the intake takes at most ${MAX_TITLE_LENGTH}`,
    );
  }
  const bodyBytes = Buffer.byteLength(body.text, 'utf8');
  if (bodyBytes > MAX_BODY_BYTES) {
    return bad(
      `its body is ${bodyBytes} bytes; the intake takes at most ${MAX_BODY_BYTES}: shorten it`,
    );
  }
  return {
    kind: 'ok',
    payload: {
      entry: f.id,
      hash: f.hash,
      title: title.text,
      kind: f.kind as EntryPayload['kind'],
      severity: f.severity as EntryPayload['severity'],
      by: f.by as AuthoredBy,
      date: f.date,
      sdk: f.sdk as string,
      cli: f.cli as string,
      body: body.text,
    },
    applied: REDACTION_RULES.filter((r) => title.applied.includes(r) || body.applied.includes(r)),
  };
}

/** The request body's bytes and their digest. */
export function serialize(payload: SubmitPayload): {
  readonly bytes: string;
  readonly digest: string;
} {
  const bytes = JSON.stringify(payload);
  return { bytes, digest: createHash('sha256').update(bytes, 'utf8').digest('hex') };
}

/**
 * The entries that fit one request: at most 20, at most 64 KiB in all, in
 * the file's order. `held` is how many were left for the next run.
 */
export function fitRequest(
  client: ClientInfo,
  entries: readonly EntryPayload[],
): { readonly entries: readonly EntryPayload[]; readonly held: number } {
  const fitted: EntryPayload[] = [];
  for (const entry of entries) {
    if (fitted.length === MAX_ENTRIES) break;
    const next = [...fitted, entry];
    if (Buffer.byteLength(serialize({ client, entries: next }).bytes, 'utf8') > MAX_REQUEST_BYTES)
      break;
    fitted.push(entry);
  }
  return { entries: fitted, held: entries.length - fitted.length };
}

/** Whether a request with these entries fits: for entries the person named, which are never left out. */
export function fitsOneRequest(client: ClientInfo, entries: readonly EntryPayload[]): boolean {
  return (
    entries.length <= MAX_ENTRIES &&
    Buffer.byteLength(serialize({ client, entries }).bytes, 'utf8') <= MAX_REQUEST_BYTES
  );
}
