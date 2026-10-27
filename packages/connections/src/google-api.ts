// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Gmail's API as the Google tools and mail functions call it: its address
 * and ids, a GET's answer, and Google's errors in its own words. Not a
 * package subpath.
 */

import { AppRefused, type AppSend } from './app-request.js';
import { google } from './google.js';

/** The connected mailbox's API: `me` is whoever signed in, the person or the company's mailbox. */
export const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** Message and thread ids as Gmail gives them. */
export const GMAIL_ID = /^[A-Za-z0-9_-]{1,256}$/;
/** A label's id: a system one (`INBOX`, `CATEGORY_UPDATES`) or one of the mailbox's own (`Label_12`). */
export const LABEL_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Gmail found nothing at the path: a message deleted, or a history id it no longer keeps. */
export class GmailNotFound extends AppRefused {}

/**
 * A GET in the mailbox, its JSON answer, or an error in Google's words.
 * `toolId` is the call's own name (`gmail.messages.list`), whatever id the
 * pack gave the tool: the entry's rate limit charges by it.
 */
export async function gmailJson(send: AppSend, toolId: string, path: string): Promise<unknown> {
  const res = await send({ entry: google, connection: 'mail', toolId, url: `${GMAIL}${path}` });
  if (res.ok) return res.json();
  const { reason, says } = googleErrorOf(await res.text(), res.status);
  if (res.status === 404) {
    throw new GmailNotFound(
      404,
      reason,
      `Gmail found nothing at ${path.split('?')[0]} in the mailbox. (${says})`,
    );
  }
  throw new AppRefused(res.status, reason, `Gmail refused the call (HTTP ${res.status}): ${says}`);
}

/** What Google's error says (its status and message), else the HTTP status. */
export async function googleSays(res: Response): Promise<string> {
  return googleErrorOf(await res.text(), res.status).says;
}

interface GoogleError {
  readonly status?: unknown;
  readonly message?: unknown;
  readonly errors?: unknown;
  readonly details?: unknown;
}

/** The ErrorInfo among an error's `details`, which names its reason. */
const ERROR_INFO = 'type.googleapis.com/google.rpc.ErrorInfo';

/**
 * An error answer's reason (`error.errors[0].reason`, else its ErrorInfo's
 * `reason`), and what it says (its status and message, else the HTTP status).
 */
export function googleErrorOf(
  text: string,
  status: number,
): { readonly reason?: string; readonly says: string } {
  let e: GoogleError | undefined;
  try {
    e = (JSON.parse(text) as { error?: GoogleError } | null)?.error;
  } catch {
    // Not JSON: the status says enough.
  }
  const reason = reasonOf(e);
  const says =
    typeof e?.message === 'string'
      ? typeof e.status === 'string'
        ? `${e.status}: ${e.message}`
        : e.message
      : `HTTP ${status}`;
  return { ...(reason !== undefined && { reason }), says };
}

function reasonOf(e: GoogleError | undefined): string | undefined {
  const first: unknown = Array.isArray(e?.errors) ? e.errors[0] : undefined;
  const reason = (first as { reason?: unknown } | null | undefined)?.reason;
  if (typeof reason === 'string' && reason !== '') return reason;
  const info: unknown = Array.isArray(e?.details)
    ? e.details.find((d: { '@type'?: unknown } | null) => d?.['@type'] === ERROR_INFO)
    : undefined;
  const infoReason = (info as { reason?: unknown } | undefined)?.reason;
  return typeof infoReason === 'string' && infoReason !== '' ? infoReason : undefined;
}

/** The query string: each value encoded, a list as the parameter repeated. */
export function query(options: Readonly<Record<string, string | readonly string[]>>): string {
  return Object.entries(options)
    .flatMap(([name, value]) =>
      (typeof value === 'string' ? [value] : value).map((v) => `${name}=${encodeURIComponent(v)}`),
    )
    .join('&');
}

/** Gmail's `internalDate` (milliseconds since the epoch, as a string) in ISO 8601; an empty string when it has none. */
export function receivedAt(internalDate: unknown): string {
  const ms = typeof internalDate === 'string' ? Number(internalDate) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}
