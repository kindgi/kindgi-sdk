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

/**
 * One mail. Each person in `from`, `to`, `cc` and `replyTo` has the
 * address cut at 254 characters and the name at 200. The lists are what
 * the agent sees: a mail it sends to the people in them reaches only
 * those listed, and the counts say how many more there are.
 */
export interface MailMessage {
  readonly id: string;
  /** The id the app groups its thread by: Gmail's `threadId`, Outlook's `conversationId`. */
  readonly threadId?: string;
  /** Absent for a draft. */
  readonly from?: MailPerson;
  /** Its first 20 people. */
  readonly to: readonly MailPerson[];
  /** How many people its To has past those 20. Absent when none. */
  readonly toLeftOut?: number;
  /** Its first 20 people. */
  readonly cc: readonly MailPerson[];
  /** How many people its Cc has past those 20. Absent when none. */
  readonly ccLeftOut?: number;
  /** Its first 20 people. */
  readonly replyTo: readonly MailPerson[];
  /** How many people its Reply-To has past those 20. Absent when none. */
  readonly replyToLeftOut?: number;
  readonly subject: string;
  readonly receivedAt: string;
  /**
   * Its body as plain text: the `text/plain` part, else the `text/html`
   * part turned into text, cut at 50,000 characters. In a mail turn's
   * read, the mail's own text: Outlook's `uniqueBody`, Gmail's with the
   * earlier mail it quotes cut.
   */
  readonly body: string;
  /** True when the body was longer and was cut. */
  readonly bodyCut: boolean;
  /** Its first 20 attachments, in the app's order, each name and type cut at 200 characters. */
  readonly attachments: readonly MailAttachment[];
  /** How many attachments it has past those 20. Absent when none. */
  readonly attachmentsLeftOut?: number;
  /** An `Auto-Submitted` header other than `no` (RFC 3834): an out-of-office or other automatic reply. */
  readonly autoSubmitted: boolean;
  /**
   * The mark a reply the agent sent carries, its one `X-Reply-Ref` header
   * ({@link REPLY_REF_HEADER}), so the runtime knows the agent's own
   * replies in a thread. Gmail only: Outlook's replies carry none. Absent
   * when the mail has no such header, more than one, or one not in a
   * mark's form ({@link isReplyRef}). Anyone can set the header on mail
   * they send: a mark counts only on the mailbox's own sent mail.
   */
  readonly replyRef?: string;
  /**
   * `true` for the mailbox's own sent mail, in a mail turn's read: Gmail's
   * `SENT` label, or Outlook's Sent Items. Absent otherwise.
   */
  readonly sent?: boolean;
}

/** The header a reply the agent sends carries its mark in. */
export const REPLY_REF_HEADER = 'X-Reply-Ref';

export { mailTurn, replyRefOf } from './mail-turn.js';

/** Whether a header's value is in a reply mark's form (`replyRefOf`'s): 32 lowercase hex characters. */
export function isReplyRef(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
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
  /** When the app received it, where the answer says: Outlook's items and both apps' `since`, not Gmail's history. */
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
   * The first round's mail: Outlook's items from `from` on, oldest first
   * as `changes` gives them, none on Gmail.
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
      /**
       * Each message once, oldest first within this answer. Outlook's by
       * `receivedAt`, ties by id; one without a time sorts with the one before it. A
       * later answer can still hold older mail: Microsoft doesn't say in
       * what order delta pages come. Gmail's in its history's order, the
       * order the mailbox got them, and only mail that still has the
       * label and isn't `SENT`, `DRAFT` or `SPAM`.
       */
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
  /**
   * The newest `max` at most, oldest first by `receivedAt`, ties by id.
   * On Gmail, which mails are taken when there are more than `max`
   * follows Gmail's list (newest first in practice, not documented), and
   * their order is by `internalDate`, from one minimal get each. One
   * without a date sorts with the mail next to it in the list.
   */
  readonly messages: readonly MailFoundMessage[];
  /** True when more than `max` were there. */
  readonly more: boolean;
}

/** How much a mail-started turn reads and carries. */
export interface MailTurnBudget {
  /** Each mail's own text, in characters. */
  readonly mailChars: number;
  /** All the turn's mail together, in characters. */
  readonly turnChars: number;
  /** The most mails a read takes: the thread's first and the newest rest. */
  readonly threadMails: number;
}

/** A mail-started turn's budget. */
export const MAIL_TURN_BUDGET: MailTurnBudget = {
  mailChars: 50_000,
  turnChars: 60_000,
  threadMails: 100,
};

export interface MailReadInput {
  readonly messageId: string;
  /** Read with the message when it's known, to spare a call. */
  readonly threadId?: string;
  readonly budget: MailTurnBudget;
}

export type MailRead =
  | {
      readonly kind: 'ok';
      readonly mail: MailMessage;
      /**
       * The thread, oldest first in the app's order, `mail` among them: the
       * first, the newest `threadMails - 1`, and `mail` when it isn't one of
       * those. No drafts, trash or spam.
       */
      readonly thread: readonly MailMessage[];
      /** How many more mails the thread holds than the read took. */
      readonly notRead: number;
    }
  /** Gone from the mailbox, or moved out of reach, before it was read. */
  | { readonly kind: 'not-found' };

/** What a mail-started turn is made from: the read, and what its conversation has had. */
export interface MailTurnInput {
  readonly read: Extract<MailRead, { kind: 'ok' }>;
  /** `linked` when the turn continues the thread's conversation. */
  readonly conversation: 'new' | 'linked';
  /** The message ids this conversation was given: its record. Empty for a new one. */
  readonly given: ReadonlySet<string>;
  /** The ids of this conversation's runs, whose marked replies are dropped. Empty for a new one. */
  readonly runIds: readonly string[];
  /**
   * The mailbox's own address. Its sent mail is shown as "(this mailbox)",
   * and other mail from it as "(this mailbox's address, not its sent mail)".
   */
  readonly mailbox: string;
  readonly budget: MailTurnBudget;
}

/** A mail-started turn: the agent's message, a flow target's input, and what it covered. */
export interface MailTurn {
  /** The agent's turn message: the thread as text, oldest first, the new mail last. */
  readonly text: string;
  /** A flow target's input. `thread` is the carried mail before `mail`, oldest first. */
  readonly input: {
    readonly mail: MailMessage;
    readonly thread: readonly MailMessage[];
    /** How many mails were left out, as the text's line says. */
    readonly leftOut: number;
  };
  /**
   * Every message id the turn covered: carried, left out over the budget,
   * or dropped as the agent's own. None of `given`, and none newer than
   * the new mail. The fire's start records each.
   */
  readonly covered: readonly string[];
}

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
  /** A message and its thread, within the budget. */
  read(call: MailCall, input: MailReadInput): Promise<MailRead>;
}
