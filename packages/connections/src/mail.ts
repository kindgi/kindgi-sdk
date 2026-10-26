// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Mail, one shape for Gmail and Outlook: the message a read tool answers
 * with and a mail-started run gets, and the calls that find new mail in a
 * mailbox. Each app's calls are a {@link MailFunctions} in its own subpath:
 * `googleMail` in `@kindgi/connections/google/mail`, `microsoftMail` in
 * `@kindgi/connections/microsoft/mail`. They call the app with the token
 * and `fetch` they're given and keep nothing: the caller keeps the cursor.
 */

/** A mail address and the name shown with it. */
export interface MailPerson {
  readonly address: string;
  readonly name?: string;
}

/** An attachment's name, type and size. Its content is never read. */
export interface MailAttachment {
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  /**
   * `true` for a part the mail shows in its body rather than attaches: a
   * photo pasted into it, a signature's logo. Still the sender's, and
   * listed like any other. Gmail's `Content-Disposition: inline`, or a
   * `multipart/related` part with a `Content-ID`; Outlook's `isInline`.
   */
  readonly inline?: boolean;
}

export interface MailMessage {
  readonly id: string;
  /** The id the app groups its thread by: Gmail's `threadId`, Outlook's `conversationId`. */
  readonly threadId?: string;
  /** Absent for a draft. */
  readonly from?: MailPerson;
  readonly to: readonly MailPerson[];
  readonly cc: readonly MailPerson[];
  readonly replyTo: readonly MailPerson[];
  readonly subject: string;
  readonly receivedAt: string;
  /**
   * Its body as plain text: the `text/plain` part, else the `text/html`
   * part turned into text. Cut at the reader's budget (50,000 characters
   * for a read tool's message).
   */
  readonly body: string;
  /** True when the body was longer and was cut. */
  readonly bodyCut: boolean;
  readonly attachments: readonly MailAttachment[];
  /** An `Auto-Submitted` header other than `no` (RFC 3834): an out-of-office or other automatic reply. */
  readonly autoSubmitted: boolean;
}

/**
 * How far the mail calls reach back past a time they're given, so a
 * caller's clock running ahead of the app's can't hide new mail: 10
 * minutes. The caller's `since` check allows the same.
 */
export const MAIL_CLOCK_MARGIN_MS = 10 * 60 * 1000;

/** What a mail call is made with. */
export interface MailCall {
  /** The connection's access token, sent as `Authorization: Bearer` and in no error. */
  readonly token: string;
  /** The connection's id: the calls take their costs from the app's rate limits per connection, as `appFetch` does. */
  readonly connectionId: string;
  /** What calls the app: a runtime passes its egress-guarded one. */
  readonly fetch: typeof fetch;
  readonly abortSignal?: AbortSignal;
}

/** Where to look: a Gmail label id, or an Outlook folder id or well-known name. Absent: the inbox. */
export interface MailFolder {
  readonly folder?: string;
}

/** Where a mailbox's changes are read from next: Gmail's `historyId`, Outlook's deltaLink. Kept as given. */
export type MailCursor = string;

/**
 * How the poll found a message. `added`: a Gmail `messagesAdded` record.
 * `labelled`: a Gmail `labelsAdded` record that added the watched label.
 * `delta`: an Outlook item, which can be mail moved into the folder.
 * `catch-up`: listed by `since`. Only `added` shows by itself that the
 * mail is new; the caller checks the others' received time.
 */
export type MailFound = 'added' | 'labelled' | 'delta' | 'catch-up';

export interface MailFoundMessage {
  readonly messageId: string;
  readonly threadId?: string;
  readonly found: MailFound;
  /** When the app received it, where the answer says: Outlook's items and `since`'s, not Gmail's history. */
  readonly receivedAt?: string;
}

export interface MailStartInput extends MailFolder {
  /**
   * Outlook: the delta takes mail received from this time, less
   * {@link MAIL_CLOCK_MARGIN_MS}. Gmail starts at the mailbox's latest
   * history whatever it is.
   */
  readonly from: Date;
}

export interface MailStart {
  readonly cursor: MailCursor;
  /**
   * The first round's mail: Outlook's items from `from` on, none on Gmail.
   * The caller fires them or not: a new watch doesn't, a re-seed or a
   * catch-up does.
   */
  readonly messages: readonly MailFoundMessage[];
}

export interface MailChangesInput extends MailFolder {
  readonly cursor: MailCursor;
}

export type MailChanges =
  | {
      readonly kind: 'ok';
      /** Each message once, in the app's order. On Gmail, only mail that still has the label and isn't `SENT`, `DRAFT` or `SPAM`. */
      readonly messages: readonly MailFoundMessage[];
      readonly cursor: MailCursor;
    }
  /** The app no longer knows the cursor (Gmail's 404; Outlook's 410 or `syncStateNotFound`): catch up. */
  | { readonly kind: 'cursor-expired' };

export interface MailSinceInput extends MailFolder {
  /** Mail received from this time, less {@link MAIL_CLOCK_MARGIN_MS}. */
  readonly from: Date;
  /** The newest this many at most. */
  readonly max: number;
}

export interface MailSince {
  readonly messages: readonly MailFoundMessage[];
  /** True when more than `max` were there. */
  readonly more: boolean;
}

/** How much of a message and its thread a read takes. */
export interface MailThreadBudget {
  /** The message's own body, in characters. */
  readonly messageChars: number;
  /** Earlier messages of its thread, newest first. */
  readonly earlier: number;
  /** Each earlier message's body, in characters: on Outlook its `uniqueBody`, what that message added. */
  readonly earlierChars: number;
}

/** A mail-started run's budget. */
export const MAIL_THREAD_BUDGET: MailThreadBudget = {
  messageChars: 50_000,
  earlier: 5,
  earlierChars: 5_000,
};

export interface MailReadInput {
  readonly messageId: string;
  /** Read with the message when it's known, to spare a call. */
  readonly threadId?: string;
  readonly budget: MailThreadBudget;
}

export type MailRead =
  | {
      readonly kind: 'ok';
      readonly mail: MailMessage;
      /** Up to `budget.earlier` earlier messages, newest first: never a draft, nor one deleted or in spam. */
      readonly thread: readonly MailMessage[];
    }
  /** Gone from the mailbox, or moved out of reach, before it was read. */
  | { readonly kind: 'not-found' };

const MAIL_CALL_ERROR = Symbol.for('kindgi.connections.mail-call-error');

/**
 * The app answered a mail call with a status its result doesn't cover
 * (a 404 a read answers `not-found` to is covered, and so is an expired
 * cursor). Its message names the status and the reason, never the token
 * or the mail's text.
 *
 * - A missing scope: {@link isMailScopeMissing}.
 * - The app being busy or down is a 429 or a 5xx that the call's own
 *   tries didn't get past.
 *
 * Recognized by a registered symbol, not `instanceof`, so a runtime and
 * the calls that load different copies of this package still agree.
 */
export class MailCallError extends Error {
  readonly [MAIL_CALL_ERROR] = true;

  /**
   * @param status The app's HTTP status.
   * @param reason Gmail's `error.errors[0].reason` (else the `reason` of
   *   its `error.details` ErrorInfo), or Graph's `error.code`, when the
   *   answer has one.
   */
  constructor(
    readonly status: number,
    readonly reason?: string,
  ) {
    super(`the mail call failed with ${status}${reason === undefined ? '' : ` (${reason})`}`);
    this.name = 'MailCallError';
  }
}

/** Is `value` a {@link MailCallError} (from any copy of this package)? */
export function isMailCallError(value: unknown): value is MailCallError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly [MAIL_CALL_ERROR]?: unknown })[MAIL_CALL_ERROR] === true
  );
}

/** The reasons a 403 gives when the connection's token lacks a scope the call needs. */
const SCOPE_MISSING_REASONS: ReadonlySet<string> = new Set([
  // Gmail: `error.errors[0].reason`, and its ErrorInfo's.
  'insufficientPermissions',
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  // Graph: `error.code`.
  'ErrorAccessDenied',
]);

/**
 * Did the app refuse a mail call because the connection lacks a scope it
 * needs? A 403 with Gmail's `insufficientPermissions` (its ErrorInfo's
 * `ACCESS_TOKEN_SCOPE_INSUFFICIENT`) or Graph's `ErrorAccessDenied`.
 * Trying again won't help; connecting again with the scope does.
 */
export function isMailScopeMissing(value: unknown): boolean {
  return (
    isMailCallError(value) &&
    value.status === 403 &&
    value.reason !== undefined &&
    SCOPE_MISSING_REASONS.has(value.reason)
  );
}

/**
 * One app's mail calls.
 *
 * - **Tries:** a call the app is busy for is tried again by this package's
 *   own rule for every app call (`appFetch`'s, through its loop): a 429,
 *   Google's rate-limit 403s and a 503 to a GET, up to 3 tries in all,
 *   after `Retry-After`, else 1 s, then 2 s, and never a wait asked past
 *   30 s. The caller tries no more.
 * - **Refused:** a 401 throws `ConnectionRejectedError` (from
 *   `@kindgi/tools`), so the caller renews the token once and calls again.
 * - **Failed:** any other answer the result doesn't cover throws
 *   {@link MailCallError}.
 * - **Cut off:** a call stopped by `abortSignal` rejects with the signal's
 *   reason, as `fetch` does: the platform's `TimeoutError` for
 *   `AbortSignal.timeout()`. It's no `MailCallError`, since no answer came.
 */
export interface MailFunctions {
  /** A fresh cursor. A catch-up calls it before `since`, so mail that comes in between is in one or the other. */
  start(call: MailCall, input: MailStartInput): Promise<MailStart>;
  /** What's new since the cursor, and the next cursor. */
  changes(call: MailCall, input: MailChangesInput): Promise<MailChanges>;
  /** The folder's mail received from a time: the catch-up's list. */
  since(call: MailCall, input: MailSinceInput): Promise<MailSince>;
  /** A message and the earlier messages of its thread, within the budget. */
  read(call: MailCall, input: MailReadInput): Promise<MailRead>;
}
