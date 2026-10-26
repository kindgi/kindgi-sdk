// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/connections/microsoft/mail` — Outlook's mail calls, for a
 * runtime that watches a mailbox for new mail and reads each one for a run
 * (`MailFunctions`, `@kindgi/connections/mail`). The cursor is a folder's
 * delta link (learn.microsoft.com/en-us/graph/delta-query-messages):
 * `start` reads the folder's new mail from a time and keeps the
 * `@odata.deltaLink`; `changes` reads it. Each call is paced by the
 * `microsoft` entry's rate limits, and none counts against sends.
 */

import { AppRefused, type AppSend, mailSend } from './app-request.js';
import {
  AS_TEXT,
  ATTACHMENTS,
  GRAPH,
  GRAPH_ID,
  GraphNotFound,
  IMMUTABLE_IDS,
  MESSAGE_FIELDS,
  type RawMessage,
  graphErrorOf,
  graphJson,
  graphRefusal,
  outlookMessage,
  query,
} from './graph-api.js';
import { checkBudget, checkMax, mailCalls, pickThread } from './mail-calls.js';
import {
  MAIL_CLOCK_MARGIN_MS,
  type MailChanges,
  type MailFolder,
  type MailFoundMessage,
  type MailFunctions,
  type MailMessage,
  type MailRead,
  type MailTurnBudget,
} from './mail.js';
import { microsoft } from './microsoft.js';

/**
 * Delta pages one `start` or `changes` reads at most. Past them, the
 * cursor is the next page's link, and the next call goes on from it.
 */
const DELTA_PAGES = 20;
/** The items a delta page holds at most. */
const PAGE_SIZE = 100;
const DELTA_PREFER = `${IMMUTABLE_IDS}, odata.maxpagesize=${PAGE_SIZE}`;
/**
 * Microsoft's codes for a delta link it no longer knows, in lower case:
 * "a 40X-series error with error codes such as syncStateNotFound"
 * (learn.microsoft.com/en-us/graph/delta-query-overview), and a 410.
 */
const CURSOR_EXPIRED: ReadonlySet<string> = new Set([
  'syncstatenotfound',
  'syncstateinvalid',
  'resyncrequired',
]);
/** A conversation's id, as it goes into a `$filter`'s quoted string: base64. */
const CONVERSATION_ID = /^[A-Za-z0-9+/=_-]{1,1024}$/;
/** The most a `since` lists: one page of `$top` (1,000), less the one that shows there are more. */
const SINCE_MAX = 999;
/** The folders a thread's read looks up by their well-known names: deleted and spam (left out), and sent. */
const THREAD_FOLDERS = ['deleteditems', 'junkemail', 'sentitems'] as const;
type ThreadFolder = (typeof THREAD_FOLDERS)[number];
/** How many more messages a conversation's read asks for than the budget, for those left out. */
const LEFT_OUT_ROOM = 10;
/** What a thread's message is read with: its fields, what it added, and where it is. */
const THREAD_FIELDS = `${MESSAGE_FIELDS},uniqueBody,isDraft,parentFolderId`;
/** A time before any mail, so a conversation's filter can start with `receivedDateTime` to order by it. */
const ANY_TIME = '1900-01-01T00:00:00Z';

/** Outlook's mail calls. */
export const microsoftMail: MailFunctions = mailCalls({
  async start(call, input) {
    const url = `${GRAPH}/me/mailFolders/${folderOf(input)}/messages/delta?${query({
      changeType: 'created',
      $select: 'id,receivedDateTime,conversationId',
      // The delta link keeps this filter for good: the margin keeps a caller's
      // clock running ahead of Microsoft's from hiding mail received now.
      $filter: `receivedDateTime ge ${graphTime(input.from)}`,
    })}`;
    const read = await readDelta(mailSend(call), url);
    if (read.kind === 'cursor-expired') {
      throw new Error("Outlook didn't start a delta for the folder.");
    }
    return { cursor: read.cursor, messages: read.messages };
  },

  async changes(call, input) {
    // The delta link names its folder.
    folderOf(input);
    return readDelta(mailSend(call), graphLink(input.cursor, 'That cursor'));
  },

  async since(call, input) {
    checkMax(input.max, SINCE_MAX);
    const url = `${GRAPH}/me/mailFolders/${folderOf(input)}/messages?${query({
      $filter: `receivedDateTime ge ${graphTime(input.from)}`,
      $orderby: 'receivedDateTime desc',
      $top: String(input.max + 1),
      $select: 'id,receivedDateTime,conversationId',
    })}`;
    const answer = (await graphJson(
      mailSend(call),
      'outlook.messages.list',
      url,
      IMMUTABLE_IDS,
    )) as {
      readonly value?: unknown;
    } | null;
    if (!Array.isArray(answer?.value)) throw new Error("Outlook's message list wasn't a list.");
    const listed = (answer.value as (DeltaItem | null)[])
      .map((item) => foundMessage(item, 'catch-up'))
      .filter((m): m is MailFoundMessage => m !== undefined);
    return {
      messages: await withThreadIds(mailSend(call), listed.slice(0, input.max)),
      more: listed.length > input.max,
    };
  },

  async read(call, input) {
    if (!GRAPH_ID.test(input.messageId)) throw new Error("That isn't an Outlook message id.");
    if (input.threadId !== undefined && !CONVERSATION_ID.test(input.threadId)) {
      throw new Error("That isn't an Outlook conversation id.");
    }
    checkBudget(input.budget);
    const send = mailSend(call);
    const raw = await messageOf(send, input.messageId);
    if (raw === undefined) return { kind: 'not-found' };
    // The message's own conversation: it's read anyway, and it's current.
    const conversation =
      typeof raw.conversationId === 'string' && raw.conversationId !== ''
        ? raw.conversationId
        : input.threadId;
    return readThread(send, raw, conversation, input.budget);
  },
});

/** An item of a delta page or a message list: a message's ids and when it came, or a removal. */
interface DeltaItem {
  readonly id?: unknown;
  readonly receivedDateTime?: unknown;
  readonly conversationId?: unknown;
  readonly '@removed'?: unknown;
}

interface DeltaPage {
  readonly value?: readonly (DeltaItem | null)[] | null;
  readonly '@odata.nextLink'?: unknown;
  readonly '@odata.deltaLink'?: unknown;
}

/**
 * The delta's new mail from `url` on, page by page, each message once,
 * and the link to read next: the delta link once the last page is read,
 * else the next page's.
 */
async function readDelta(send: AppSend, url: string): Promise<MailChanges> {
  const found = new Map<string, MailFoundMessage>();
  let link = url;
  for (let page = 0; page < DELTA_PAGES; page++) {
    const answer = await deltaPage(send, link);
    if (answer === 'expired') return { kind: 'cursor-expired' };
    for (const item of answer?.value ?? []) {
      const message = foundMessage(item, 'delta');
      if (message !== undefined && !found.has(message.messageId)) {
        found.set(message.messageId, message);
      }
    }
    const delta = answer?.['@odata.deltaLink'];
    if (typeof delta === 'string') {
      return {
        kind: 'ok',
        messages: await withThreadIds(send, [...found.values()]),
        cursor: graphLink(delta, "Outlook's delta link"),
      };
    }
    const next = answer?.['@odata.nextLink'];
    if (typeof next !== 'string') {
      throw new Error("Outlook's delta page gave neither a next page nor a delta link.");
    }
    link = graphLink(next, "Outlook's next page link");
  }
  // More pages than one call reads: the next call goes on from the next page.
  return { kind: 'ok', messages: await withThreadIds(send, [...found.values()]), cursor: link };
}

/**
 * Each found message with its conversation's id: one that came without
 * it is read for it, its metadata only. Still without one when Graph has
 * none, or the message is gone: the caller refuses its fire.
 */
async function withThreadIds(
  send: AppSend,
  found: readonly MailFoundMessage[],
): Promise<MailFoundMessage[]> {
  const messages: MailFoundMessage[] = [];
  for (const m of found) {
    messages.push(
      m.threadId === undefined ? { ...m, ...(await threadIdOf(send, m.messageId)) } : m,
    );
  }
  return messages;
}

async function threadIdOf(send: AppSend, id: string): Promise<{ readonly threadId?: string }> {
  try {
    const raw = (await graphJson(
      send,
      'outlook.messages.get',
      `${GRAPH}/me/messages/${encodeURIComponent(id)}?${query({ $select: 'conversationId' })}`,
      IMMUTABLE_IDS,
    )) as { readonly conversationId?: unknown } | null;
    const conversation = raw?.conversationId;
    return typeof conversation === 'string' && conversation !== ''
      ? { threadId: conversation }
      : {};
  } catch (err) {
    if (err instanceof GraphNotFound) return {};
    throw err;
  }
}

/** One delta page, or `'expired'` when Microsoft no longer knows the link. */
async function deltaPage(send: AppSend, url: string): Promise<DeltaPage | null | 'expired'> {
  const res = await send({
    entry: microsoft,
    connection: 'mail',
    toolId: 'outlook.messages.delta',
    url,
    headers: { prefer: DELTA_PREFER },
  });
  if (res.ok) return (await res.json()) as DeltaPage | null;
  const error = graphErrorOf(await res.text(), res.status);
  if (res.status === 410) return 'expired';
  if (
    res.status >= 400 &&
    res.status < 500 &&
    error.code !== undefined &&
    CURSOR_EXPIRED.has(error.code.toLowerCase())
  ) {
    return 'expired';
  }
  throw graphRefusal(res.status, error, url);
}

function foundMessage(
  item: DeltaItem | null | undefined,
  found: 'delta' | 'catch-up',
): MailFoundMessage | undefined {
  // A removal (`@removed`) isn't new mail; `changeType=created` asks for none.
  if (item === null || item === undefined || item['@removed'] !== undefined) return undefined;
  const { id, receivedDateTime, conversationId } = item;
  if (typeof id !== 'string' || !GRAPH_ID.test(id)) return undefined;
  return {
    messageId: id,
    ...(typeof conversationId === 'string' &&
      conversationId !== '' && { threadId: conversationId }),
    found,
    ...(typeof receivedDateTime === 'string' && { receivedAt: receivedDateTime }),
  };
}

/** A message with its thread's fields, else undefined when it's gone. */
async function messageOf(send: AppSend, id: string): Promise<RawMessage | undefined> {
  try {
    return (await graphJson(
      send,
      'outlook.messages.get',
      `${GRAPH}/me/messages/${encodeURIComponent(id)}?${query({
        $select: THREAD_FIELDS,
        $expand: ATTACHMENTS,
      })}`,
      `${AS_TEXT}, ${IMMUTABLE_IDS}`,
    )) as RawMessage;
  } catch (err) {
    if (err instanceof GraphNotFound) return undefined;
    throw err;
  }
}

/**
 * The message and its conversation, oldest first, each its `uniqueBody`
 * (what it added). Drafts, and messages in Deleted Items or Junk Email,
 * are left out; one in Sent Items is marked `sent`. If Graph refuses the
 * conversation's filter, the run gets the message alone: its body quotes
 * what came before.
 */
async function readThread(
  send: AppSend,
  raw: RawMessage,
  conversation: string | undefined,
  budget: MailTurnBudget,
): Promise<MailRead> {
  const page =
    conversation !== undefined && CONVERSATION_ID.test(conversation)
      ? await conversationPage(send, conversation, budget)
      : undefined;
  const folders = await threadFolders(send);
  const message = (m: RawMessage): MailMessage => {
    const read = outlookMessage(m, budget.mailChars, 'uniqueBody', 'turn');
    const sent = folders.sentitems !== undefined && m.parentFolderId === folders.sentitems;
    return sent ? { ...read, sent: true } : read;
  };
  const mail = message(raw);
  if (page === undefined || conversation === undefined) {
    return { kind: 'ok', mail, thread: [mail], notRead: 0 };
  }
  const leftOut = new Set([folders.deleteditems, folders.junkemail]);
  leftOut.delete(undefined);
  const inThread = (m: RawMessage): boolean =>
    m.id === raw.id || (m.isDraft !== true && !leftOut.has(m.parentFolderId ?? undefined));
  const newest = page.items.filter((m) => m.id !== raw.id && inThread(m));
  if (!page.more) {
    const { picked, notRead } = pickThread(
      inOrder([...newest.map(message), mail]),
      mail.id,
      budget.threadMails,
    );
    return { kind: 'ok', mail, thread: picked, notRead };
  }
  // Longer than a page: its first and its newest, and how many it holds.
  const all = (await conversationIds(send, conversation)).filter(inThread);
  const taken = newest.slice(0, budget.threadMails - 1);
  const firstId = all[0]?.id;
  const first =
    firstId === undefined || firstId === raw.id || taken.some((m) => m.id === firstId)
      ? undefined
      : (newest.find((m) => m.id === firstId) ?? (await messageOf(send, firstId)));
  const thread = inOrder([
    ...(first === undefined ? [] : [message(first)]),
    ...taken.map(message),
    mail,
  ]);
  const held = all.length + (all.some((m) => m.id === raw.id) ? 0 : 1);
  return { kind: 'ok', mail, thread, notRead: Math.max(0, held - thread.length) };
}

/** Messages oldest first by when each came; two of the same time keep their order. */
function inOrder(messages: readonly MailMessage[]): MailMessage[] {
  return messages
    .map((m, i) => ({ m, i, at: Date.parse(m.receivedAt) }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map(({ m }) => m);
}

/**
 * The conversation's newest messages across folders, newest first, a
 * page of the budget and room for those left out, and whether it holds
 * more. Undefined when Graph refuses the filter.
 */
async function conversationPage(
  send: AppSend,
  conversation: string,
  budget: MailTurnBudget,
): Promise<{ readonly items: RawMessage[]; readonly more: boolean } | undefined> {
  const url = `${GRAPH}/me/messages?${query({
    // Graph orders by a property only when the filter starts with it.
    $filter: `receivedDateTime ge ${ANY_TIME} and conversationId eq '${conversation}'`,
    $orderby: 'receivedDateTime desc',
    $top: String(Math.min(budget.threadMails + LEFT_OUT_ROOM, 1000)),
    $select: THREAD_FIELDS,
    $expand: ATTACHMENTS,
  })}`;
  let answer: { readonly value?: unknown; readonly '@odata.nextLink'?: unknown } | null;
  try {
    answer = (await graphJson(
      send,
      'outlook.messages.list',
      url,
      `${AS_TEXT}, ${IMMUTABLE_IDS}`,
    )) as typeof answer;
  } catch (err) {
    if (err instanceof AppRefused && err.status === 400) return undefined;
    throw err;
  }
  return {
    items: rawMessages(answer?.value),
    more: typeof answer?.['@odata.nextLink'] === 'string',
  };
}

/**
 * Every message of the conversation, oldest first, by id and where it
 * is, never its content: one page of 1,000, so a longer one counts the
 * oldest 1,000.
 */
async function conversationIds(send: AppSend, conversation: string): Promise<RawMessage[]> {
  const answer = (await graphJson(
    send,
    'outlook.messages.list',
    `${GRAPH}/me/messages?${query({
      $filter: `receivedDateTime ge ${ANY_TIME} and conversationId eq '${conversation}'`,
      $orderby: 'receivedDateTime asc',
      $top: '1000',
      $select: 'id,isDraft,parentFolderId',
    })}`,
    IMMUTABLE_IDS,
  )) as { readonly value?: unknown } | null;
  return rawMessages(answer?.value);
}

function rawMessages(value: unknown): RawMessage[] {
  return (Array.isArray(value) ? (value as (RawMessage | null)[]) : []).filter(
    (m): m is RawMessage => m !== null && typeof m?.id === 'string',
  );
}

/**
 * The ids of the folders a thread's read looks up, read with the same id
 * format as the messages. A mailbox without one has nothing in it.
 */
async function threadFolders(send: AppSend): Promise<Partial<Record<ThreadFolder, string>>> {
  const ids = await Promise.all(
    THREAD_FOLDERS.map(async (name) => {
      try {
        const folder = (await graphJson(
          send,
          'outlook.folders.get',
          `${GRAPH}/me/mailFolders/${name}?${query({ $select: 'id' })}`,
          IMMUTABLE_IDS,
        )) as { readonly id?: unknown } | null;
        return typeof folder?.id === 'string' ? folder.id : undefined;
      } catch (err) {
        if (err instanceof GraphNotFound) return undefined;
        throw err;
      }
    }),
  );
  return Object.fromEntries(
    THREAD_FOLDERS.flatMap((name, i) => (ids[i] === undefined ? [] : [[name, ids[i]]])),
  );
}

/** The folder: a well-known name (`inbox`, the default) or a folder's id. */
function folderOf(input: MailFolder): string {
  const folder = input.folder ?? 'inbox';
  if (!GRAPH_ID.test(folder)) throw new Error(`"${folder}" isn't an Outlook folder.`);
  return folder;
}

/** `from` less the clock margin, to the second, as Graph takes a time in a `$filter`. */
function graphTime(from: Date): string {
  const ms = from.getTime() - MAIL_CLOCK_MARGIN_MS;
  if (!Number.isFinite(ms)) throw new Error('`from` is not a time.');
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * A link to read with the connection's token: only ever Microsoft Graph's
 * own, so a cursor that was changed where it's kept can't send the token
 * anywhere else.
 */
function graphLink(link: string, what: string): string {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error(`${what} isn't a link.`);
  }
  if (
    url.origin !== 'https://graph.microsoft.com' ||
    !url.pathname.startsWith('/v1.0/') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error(`${what} isn't Microsoft Graph's: the token goes only to graph.microsoft.com.`);
  }
  return link;
}
