// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/connections/google/mail` — Gmail's mail calls, for a runtime
 * that watches a mailbox for new mail and reads each one for a run
 * (`MailFunctions`, `@kindgi/connections/mail`). The cursor is a history
 * id (developers.google.com/workspace/gmail/api/guides/sync): `start`
 * takes the mailbox's latest from `users.getProfile`, and `changes` reads
 * `users.history.list` from it. Each call is paced by the `google` entry's
 * rate limits, in Gmail's quota units.
 */

import { type AppSend, mailSend } from './app-request.js';
import { type GmailMessage, gmailMessage } from './gmail-mime.js';
import { GMAIL_ID, GmailNotFound, LABEL_ID, gmailJson, query } from './google-api.js';
import { checkBudget, checkMax, mailCalls } from './mail-calls.js';
import {
  MAIL_CLOCK_MARGIN_MS,
  type MailFolder,
  type MailFound,
  type MailFoundMessage,
  type MailFunctions,
  type MailRead,
  type MailThreadBudget,
} from './mail.js';

/**
 * History pages one `changes` reads at most, 500 records each. Past them,
 * the cursor is the last record read, and the next call goes on from it.
 */
const HISTORY_PAGES = 10;
/** A history id: an unsigned 64-bit number, as a string. */
const HISTORY_ID = /^[0-9]{1,20}$/;
/** Labels whose mail is never new mail: sent from the mailbox, unsent, or spam. */
const NOT_NEW: ReadonlySet<string> = new Set(['SENT', 'DRAFT', 'SPAM']);
/** A thread's messages left out of what a run gets: unsent, spam, or deleted. */
const NOT_IN_THREAD: ReadonlySet<string> = new Set(['DRAFT', 'SPAM', 'TRASH']);
/** The most a `since` lists: one page of `users.messages.list`, less the one that shows there are more. */
const SINCE_MAX = 499;

/** Gmail's mail calls. */
export const googleMail: MailFunctions = mailCalls({
  async start(call, input) {
    labelOf(input);
    const profile = (await gmailJson(mailSend(call), 'gmail.profile.get', '/profile')) as {
      readonly historyId?: unknown;
    } | null;
    const historyId = profile?.historyId;
    if (typeof historyId !== 'string' || !HISTORY_ID.test(historyId)) {
      throw new Error("Gmail's profile gave no history id.");
    }
    // Mail already in the mailbox is never new: Gmail starts from now whatever `from` is.
    return { cursor: historyId, messages: [] };
  },

  async changes(call, input) {
    const label = labelOf(input);
    if (!HISTORY_ID.test(input.cursor)) throw new Error("That cursor isn't a Gmail history id.");
    const send = mailSend(call);
    const found = new Map<string, MailFoundMessage>();
    let cursor = input.cursor;
    let pageToken: string | undefined;
    for (let page = 0; page < HISTORY_PAGES; page++) {
      const answer = await historyPage(send, input.cursor, label, pageToken);
      if (answer === 'expired') return { kind: 'cursor-expired' };
      cursor = takeNewMail(answer?.history ?? [], label, found, cursor);
      pageToken = typeof answer?.nextPageToken === 'string' ? answer.nextPageToken : undefined;
      if (pageToken === undefined) {
        // All read: the next call starts at the mailbox's history as of this answer.
        cursor = historyIdOr(answer?.historyId, cursor);
        break;
      }
    }
    return { kind: 'ok', messages: [...found.values()], cursor };
  },

  async since(call, input) {
    const label = labelOf(input);
    checkMax(input.max, SINCE_MAX);
    // Gmail takes a time to the second as epoch seconds (guides/filtering).
    const after = Math.floor((input.from.getTime() - MAIL_CLOCK_MARGIN_MS) / 1000);
    if (!Number.isFinite(after) || after < 0) throw new Error('`from` is not a time Gmail takes.');
    const answer = (await gmailJson(
      mailSend(call),
      'gmail.messages.list',
      `/messages?${query({ labelIds: label, q: `after:${after}`, maxResults: String(input.max + 1) })}`,
    )) as { readonly messages?: unknown } | null;
    // Newest first, as Gmail lists; left out when nothing matches.
    const listed = (Array.isArray(answer?.messages) ? answer.messages : [])
      .map((m: HistoryMessage | null) => foundMessage(m, 'catch-up'))
      .filter((m): m is MailFoundMessage => m !== undefined);
    return { messages: listed.slice(0, input.max), more: listed.length > input.max };
  },

  async read(call, input) {
    if (!GMAIL_ID.test(input.messageId)) throw new Error("That isn't a Gmail message id.");
    if (input.threadId !== undefined && !GMAIL_ID.test(input.threadId)) {
      throw new Error("That isn't a Gmail thread id.");
    }
    checkBudget(input.budget);
    const send = mailSend(call);
    try {
      if (input.threadId !== undefined) {
        const read = await readInThread(send, input.messageId, input.threadId, input.budget);
        if (read !== undefined) return read;
      }
      // Its thread isn't known, or no longer holds it: the message first, then its thread.
      const raw = (await gmailJson(
        send,
        'gmail.messages.get',
        `/messages/${input.messageId}?format=full`,
      )) as GmailMessage;
      const threadId = typeof raw?.threadId === 'string' ? raw.threadId : undefined;
      if (threadId !== undefined && GMAIL_ID.test(threadId) && threadId !== input.threadId) {
        const read = await readInThread(send, input.messageId, threadId, input.budget);
        if (read !== undefined) return read;
      }
      return { kind: 'ok', mail: gmailMessage(raw, input.budget.messageChars, 'turn'), thread: [] };
    } catch (err) {
      if (err instanceof GmailNotFound) return { kind: 'not-found' };
      throw err;
    }
  },
});

/** A page of the label's history from `startHistoryId`, or `'expired'` when Gmail no longer keeps it. */
async function historyPage(
  send: AppSend,
  startHistoryId: string,
  label: string,
  pageToken: string | undefined,
): Promise<HistoryPage | null | 'expired'> {
  try {
    return (await gmailJson(
      send,
      'gmail.history.list',
      `/history?${query({
        startHistoryId,
        historyTypes: ['messageAdded', 'labelAdded'],
        labelId: label,
        maxResults: '500',
        ...(pageToken !== undefined && { pageToken }),
      })}`,
    )) as HistoryPage | null;
  } catch (err) {
    // "If you receive an HTTP 404 error response, your application should perform a full sync" (users.history/list).
    if (err instanceof GmailNotFound) return 'expired';
    throw err;
  }
}

/** Adds the records' new mail to `found`, each message once; the last record's id, else `cursor`. */
function takeNewMail(
  records: readonly (HistoryRecord | null)[],
  label: string,
  found: Map<string, MailFoundMessage>,
  cursor: string,
): string {
  let last = cursor;
  for (const record of records) {
    for (const message of newMail(record, label)) {
      if (!found.has(message.messageId)) found.set(message.messageId, message);
    }
    last = historyIdOr(record?.id, last);
  }
  return last;
}

/** `value` when it's a history id, else `otherwise`. */
function historyIdOr(value: unknown, otherwise: string): string {
  return typeof value === 'string' && HISTORY_ID.test(value) ? value : otherwise;
}

/** One page of `users.history.list`: only the fields read here. */
interface HistoryPage {
  readonly history?: readonly HistoryRecord[] | null;
  readonly nextPageToken?: unknown;
  /** The mailbox's current history id. */
  readonly historyId?: unknown;
}

interface HistoryRecord {
  readonly id?: unknown;
  readonly messagesAdded?: readonly ({ readonly message?: HistoryMessage | null } | null)[] | null;
  readonly labelsAdded?:
    | readonly ({
        readonly message?: HistoryMessage | null;
        /** The labels this change added. */
        readonly labelIds?: readonly unknown[] | null;
      } | null)[]
    | null;
}

/** A message as history records and `users.messages.list` give it: ids, and in history its labels now. */
interface HistoryMessage {
  readonly id?: unknown;
  readonly threadId?: unknown;
  readonly labelIds?: readonly unknown[] | null;
}

/**
 * A record's new mail in the label: a message added (`added`), or one the
 * label was added to (`labelled`, which mail rescued from spam or labelled
 * late by a filter is). Either way it still has the label, and it isn't
 * sent from the mailbox, a draft or spam. A message without its labels
 * given is taken: the request asked for the label's history alone.
 */
function* newMail(record: HistoryRecord | null, label: string): Generator<MailFoundMessage> {
  const candidates: [HistoryMessage | null | undefined, MailFound][] = [
    ...(record?.messagesAdded ?? []).map((a): [HistoryMessage | null | undefined, MailFound] => [
      a?.message,
      'added',
    ]),
    ...(record?.labelsAdded ?? [])
      .filter((l) => Array.isArray(l?.labelIds) && l.labelIds.includes(label))
      .map((l): [HistoryMessage | null | undefined, MailFound] => [l?.message, 'labelled']),
  ];
  for (const [message, how] of candidates) {
    const labels = message?.labelIds;
    if (
      Array.isArray(labels) &&
      (!labels.includes(label) || labels.some((l) => typeof l === 'string' && NOT_NEW.has(l)))
    ) {
      continue;
    }
    const found = foundMessage(message, how);
    if (found !== undefined) yield found;
  }
}

function foundMessage(
  message: HistoryMessage | null | undefined,
  found: MailFound,
): MailFoundMessage | undefined {
  const id = message?.id;
  if (typeof id !== 'string' || !GMAIL_ID.test(id)) return undefined;
  const threadId = message?.threadId;
  return {
    messageId: id,
    ...(typeof threadId === 'string' && GMAIL_ID.test(threadId) && { threadId }),
    found,
  };
}

/**
 * The message and the earlier messages of its thread, from one
 * `users.threads.get`. `undefined` when the thread is gone or doesn't hold
 * the message, so the caller reads the message by itself.
 */
async function readInThread(
  send: AppSend,
  messageId: string,
  threadId: string,
  budget: MailThreadBudget,
): Promise<MailRead | undefined> {
  let thread: { readonly messages?: unknown } | null;
  try {
    thread = (await gmailJson(
      send,
      'gmail.threads.get',
      `/threads/${threadId}?format=full`,
    )) as typeof thread;
  } catch (err) {
    if (err instanceof GmailNotFound) return undefined;
    throw err;
  }
  const messages = (Array.isArray(thread?.messages) ? thread.messages : []) as GmailMessage[];
  const at = messages.findIndex((m) => m?.id === messageId);
  if (at === -1) return undefined;
  // Earlier by when each came, not by place: the reference gives no order
  // for a thread's messages. Two that came in the same millisecond keep it.
  const own = dateOf(messages[at]);
  const earlier = messages
    .map((m, i) => ({ m, i, date: dateOf(m) }))
    .filter(
      ({ m, i, date }) =>
        (date < own || (date === own && i < at)) &&
        !(m?.labelIds ?? []).some((l) => typeof l === 'string' && NOT_IN_THREAD.has(l)),
    )
    .sort((a, b) => b.date - a.date || b.i - a.i)
    .slice(0, budget.earlier);
  return {
    kind: 'ok',
    mail: gmailMessage(messages[at] as GmailMessage, budget.messageChars, 'turn'),
    thread: earlier.map(({ m }) => gmailMessage(m, budget.earlierChars, 'turn')),
  };
}

/**
 * A message's `internalDate` in milliseconds: when Gmail received it.
 * `NaN` when it has none, which no time is before or after.
 */
function dateOf(m: GmailMessage | null | undefined): number {
  const date = m?.internalDate;
  return typeof date === 'string' && /^\d{1,16}$/.test(date) ? Number(date) : Number.NaN;
}

/** The folder as a Gmail label id: the inbox unless given. */
function labelOf(input: MailFolder): string {
  const label = input.folder ?? 'INBOX';
  if (!LABEL_ID.test(label)) throw new Error(`"${label}" isn't a Gmail label id.`);
  return label;
}
