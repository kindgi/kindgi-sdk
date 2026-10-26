// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Outlook's mail calls against answers in the shapes Microsoft's pages give:
 * - a folder's messages delta:
 *   learn.microsoft.com/en-us/graph/delta-query-messages (pages with
 *   `@odata.nextLink`, the last with `@odata.deltaLink`; "Microsoft Graph
 *   automatically encodes any OData and custom query options into the
 *   @odata.nextLink or @odata.deltaLink"; a removal as `@removed`);
 * - an expired delta link: learn.microsoft.com/en-us/graph/delta-query-overview
 *   ("a 40X-series error with error codes such as syncStateNotFound", or a 410);
 * - a message: learn.microsoft.com/en-us/graph/api/resources/message
 *   (`conversationId`, `uniqueBody`, `internetMessageHeaders`, `replyTo`);
 * - an error: `{error: {code, message}}`.
 */

import { randomUUID } from 'node:crypto';

import { ConnectionRejectedError } from '@kindgi/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAIL_CLOCK_MARGIN_MS,
  MAIL_TURN_BUDGET,
  type MailCall,
  isMailCallError,
  isMailScopeMissing,
} from '../src/mail.js';
import { microsoftMail } from '../src/microsoft-mail.js';

const TOKEN = 'eyJ0eXAi.not-a-real-token';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const INBOX_DELTA = `${GRAPH}/me/mailFolders/inbox/messages/delta`;

/**
 * Graph, as the `fetch` a mail call is given: each GET, and the answer
 * `answer` gives it. A stopped signal rejects with its reason, as `fetch` does.
 */
function graph(answer: (url: URL) => Response) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return answer(new URL(String(url)));
  });
  const call: MailCall = { token: TOKEN, connectionId: randomUUID(), fetch };
  return { call, calls };
}

function graphError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function item(id: string, receivedDateTime: string, conversationId = `conv-${id}`) {
  return {
    '@odata.type': '#microsoft.graph.message',
    '@odata.etag': 'W/"CQAAABYAAAA"',
    id,
    receivedDateTime,
    conversationId,
  };
}

/** A message as `GET /me/messages/{id}` gives it, with `$select` and the `Prefer` for text. */
function message(id: string, at: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    conversationId: 'AAQkADAwATM0MDAAMS1hMzE2LTZhZTQtMDACLTAwCgAQAMN8DmETPLdPpPsc2YSiwmQ=',
    subject: 'Order 1042',
    from: { emailAddress: { address: 'bo@acme.example', name: 'Bo Lund' } },
    toRecipients: [{ emailAddress: { address: 'support@acme.example', name: 'Acme Support' } }],
    ccRecipients: [],
    replyTo: [],
    receivedDateTime: at,
    internetMessageHeaders: [{ name: 'Received', value: 'from mail.acme.example' }],
    body: { contentType: 'text', content: 'Where is order 1042?' },
    uniqueBody: { contentType: 'text', content: 'Where is order 1042?' },
    attachments: [],
    ...extra,
  };
}

function queryOf(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams);
}

beforeEach(() => {
  // The calls use the `fetch` they're given, never the global one.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('the global fetch was called');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('microsoftMail.start', () => {
  it("reads the folder's new mail from the clock margin before `from`, page by page, and keeps the delta link", async () => {
    const deltaLink = `${INBOX_DELTA}?$deltatoken=LztZwWjo5IivWBhyxw5rACKxf7mPm0oW6JZZm`;
    const nextLink = `${GRAPH}/me/mailfolders('AQMkADNkNAAAgEMAAAA')/messages/delta?$skiptoken=GwcBoTmPuoTQWfcsAbkYM`;
    const { call, calls } = graph((url) =>
      url.searchParams.has('$skiptoken')
        ? Response.json({
            value: [
              item('m2', '2026-10-26T01:59:00Z'),
              { id: 'gone', '@removed': { reason: 'deleted' } },
            ],
            '@odata.deltaLink': deltaLink,
          })
        : Response.json({
            value: [item('m1', '2026-10-26T01:55:00Z')],
            '@odata.nextLink': nextLink,
          }),
    );
    const start = await microsoftMail.start(call, { from: new Date('2026-10-26T02:00:00.750Z') });
    expect(start).toEqual({
      cursor: deltaLink,
      messages: [
        {
          messageId: 'm1',
          threadId: 'conv-m1',
          found: 'delta',
          receivedAt: '2026-10-26T01:55:00Z',
        },
        {
          messageId: 'm2',
          threadId: 'conv-m2',
          found: 'delta',
          receivedAt: '2026-10-26T01:59:00Z',
        },
      ],
    });
    expect(calls[0]?.url.split('?')[0]).toBe(INBOX_DELTA);
    expect(queryOf(calls[0]?.url ?? '')).toEqual({
      changeType: 'created',
      $select: 'id,receivedDateTime,conversationId',
      // 02:00:00.750 less 10 minutes, to the second.
      $filter: 'receivedDateTime ge 2026-10-26T01:50:00Z',
    });
    expect(calls[1]?.url).toBe(nextLink);
    for (const c of calls) {
      expect(c.headers.prefer).toBe('IdType="ImmutableId", odata.maxpagesize=100');
      expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`);
    }
    expect(MAIL_CLOCK_MARGIN_MS).toBe(600_000);
  });

  it("still brings mail received after the start when Microsoft's clock is behind the caller's", async () => {
    // A Graph that keeps the start's filter in its delta link, as the page says, and
    // gives each round the mail that came since the last one and passes the filter.
    const mailbox = [item('before-margin', '2026-10-26T01:49:00Z')];
    let delivered = 0;
    const { call } = graph((url) => {
      const filter = url.searchParams.get('$filter') ?? '';
      const since = filter.replace('receivedDateTime ge ', '');
      const round = mailbox.slice(delivered).filter((m) => m.receivedDateTime >= since);
      delivered = mailbox.length;
      return Response.json({
        value: round,
        '@odata.deltaLink': `${INBOX_DELTA}?$deltatoken=t${delivered}&$filter=${encodeURIComponent(filter)}`,
      });
    });
    const start = await microsoftMail.start(call, { from: new Date('2026-10-26T02:00:00Z') });
    expect(start.messages).toEqual([]);
    // Just after the start, by Microsoft's clock, 2 minutes behind the caller's: 01:58.
    mailbox.push(item('after-start', '2026-10-26T01:58:00Z'));
    const changes = await microsoftMail.changes(call, { cursor: start.cursor });
    expect(changes.kind === 'ok' && changes.messages.map((m) => m.messageId)).toEqual([
      'after-start',
    ]);
  });

  it("refuses a folder that isn't a well-known name or an id", async () => {
    const { call, calls } = graph(() => Response.json({}));
    await expect(
      microsoftMail.start(call, { from: new Date(), folder: 'inbox/../../users' }),
    ).rejects.toThrow("isn't an Outlook folder");
    expect(calls).toHaveLength(0);
  });
  it('tries a busy answer again, as the tools do', async () => {
    let tries = 0;
    const { call, calls } = graph(() =>
      ++tries === 1
        ? Response.json(
            {
              error: {
                code: 'ApplicationThrottled',
                message: 'Application is over its MailboxConcurrency limit.',
              },
            },
            { status: 429, headers: { 'retry-after': '0' } },
          )
        : Response.json({ value: [], '@odata.deltaLink': `${INBOX_DELTA}?$deltatoken=t1` }),
    );
    const start = await microsoftMail.start(call, { from: new Date('2026-10-26T02:00:00Z') });
    expect(start.cursor).toBe(`${INBOX_DELTA}?$deltatoken=t1`);
    expect(calls).toHaveLength(2);
  });
});

describe('microsoftMail.changes', () => {
  const cursor = `${INBOX_DELTA}?$deltatoken=LztZwWjo5IivWBhyxw5rACKxf7mPm0oW6JZZm`;

  it('reads the delta link as it was kept, and gives the next one', async () => {
    const next = `${INBOX_DELTA}?$deltatoken=Nn5gS1Vb9A`;
    const { call, calls } = graph(() =>
      Response.json({ value: [item('m9', '2026-10-26T02:01:00Z')], '@odata.deltaLink': next }),
    );
    expect(await microsoftMail.changes(call, { cursor })).toEqual({
      kind: 'ok',
      messages: [
        {
          messageId: 'm9',
          threadId: 'conv-m9',
          found: 'delta',
          receivedAt: '2026-10-26T02:01:00Z',
        },
      ],
      cursor: next,
    });
    expect(calls.map((c) => c.url)).toEqual([cursor]);
  });

  it.each([
    ['a 410', () => new Response(null, { status: 410, headers: { location: `${INBOX_DELTA}` } })],
    [
      'syncStateNotFound',
      () => graphError(400, 'SyncStateNotFound', 'The sync state was not found.'),
    ],
    ['syncStateInvalid', () => graphError(400, 'syncStateInvalid', 'Invalid sync state.')],
  ])('says the cursor expired on %s', async (_name, answer) => {
    const { call } = graph(answer);
    expect(await microsoftMail.changes(call, { cursor })).toEqual({ kind: 'cursor-expired' });
  });

  it('throws a refused token as ConnectionRejectedError, so the caller renews it', async () => {
    const { call } = graph(() => new Response('', { status: 401 }));
    await expect(microsoftMail.changes(call, { cursor })).rejects.toBeInstanceOf(
      ConnectionRejectedError,
    );
  });

  it("throws a missing scope's 403 as a MailCallError with Graph's code, without the token or Microsoft's words", async () => {
    const { call } = graph(() =>
      graphError(403, 'ErrorAccessDenied', 'Access is denied. Check credentials and try again.'),
    );
    const err = await microsoftMail.changes(call, { cursor }).catch((e: unknown) => e);
    expect(isMailCallError(err)).toBe(true);
    expect(err).toMatchObject({ status: 403, reason: 'ErrorAccessDenied' });
    expect(isMailScopeMissing(err)).toBe(true);
    expect(String(err)).not.toContain(TOKEN);
    expect(String(err)).not.toContain('Check credentials');
  });

  it.each([
    ['words', 'Access is denied for bo@acme.example', undefined],
    ['over 100 characters', 'E'.repeat(101), undefined],
    ['100 characters', 'E'.repeat(100), 'E'.repeat(100)],
  ])("takes Graph's code as the reason only in a code's form: %s", async (_, code, reason) => {
    const { call } = graph(() => graphError(403, code, 'Access is denied.'));
    const err = await microsoftMail.changes(call, { cursor }).catch((e: unknown) => e);
    expect(isMailCallError(err)).toBe(true);
    expect(err).toMatchObject({ status: 403, reason });
    if (reason === undefined)
      expect(String(err)).toBe('MailCallError: the mail call failed with 403');
  });

  it('throws a 503 the tries did not get past as a MailCallError, after 3 tries', async () => {
    const { call, calls } = graph(() =>
      Response.json(
        {
          error: {
            code: 'ServiceNotAvailable',
            message: 'The service is temporarily unavailable.',
          },
        },
        { status: 503, headers: { 'retry-after': '0' } },
      ),
    );
    const err = await microsoftMail.changes(call, { cursor }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 503, reason: 'ServiceNotAvailable' });
    expect(calls).toHaveLength(3);
  });

  it("throws a folder that isn't there as a MailCallError 404, not a read's not-found", async () => {
    const { call } = graph(() =>
      graphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.'),
    );
    const err = await microsoftMail.start(call, { from: new Date() }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 404, reason: 'ErrorItemNotFound' });
  });

  it("rejects with the signal's reason when the call is cut off, not as a MailCallError", async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    const { call } = graph(() => Response.json({ value: [] }));
    const cut = { ...call, abortSignal: AbortSignal.abort(timeout) };
    await expect(microsoftMail.changes(cut, { cursor })).rejects.toBe(timeout);
  });

  it.each([
    'https://graph.microsoft.com.evil.example/v1.0/me/messages/delta',
    'http://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta',
    'https://graph.microsoft.com:8443/v1.0/me/mailFolders/inbox/messages/delta',
    'https://user:pass@graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta',
    'https://graph.microsoft.com/beta/me/mailFolders/inbox/messages/delta',
    'not a link',
  ])('never sends the token to a cursor that is not Graph v1.0: %s', async (bad) => {
    const { call, calls } = graph(() => Response.json({}));
    await expect(microsoftMail.changes(call, { cursor: bad })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("follows no next page that isn't Graph's", async () => {
    const { call, calls } = graph(() =>
      Response.json({ value: [], '@odata.nextLink': 'https://evil.example/v1.0/x' }),
    );
    await expect(microsoftMail.changes(call, { cursor })).rejects.toThrow(
      "isn't Microsoft Graph's",
    );
    expect(calls).toHaveLength(1);
  });

  it('stops after twenty pages, its cursor the next page, so the next call goes on from there', async () => {
    let page = 0;
    const { call, calls } = graph(() => {
      page += 1;
      return Response.json({
        value: [item(`m${page}`, '2026-10-26T02:00:00Z')],
        '@odata.nextLink': `${INBOX_DELTA}?$skiptoken=p${page + 1}`,
      });
    });
    const changes = await microsoftMail.changes(call, { cursor });
    expect(calls).toHaveLength(20);
    expect(changes.kind === 'ok' && changes.cursor).toBe(`${INBOX_DELTA}?$skiptoken=p21`);
    expect(changes.kind === 'ok' && changes.messages).toHaveLength(20);
  });
});

describe('microsoftMail.since', () => {
  it('lists the folder from the clock margin before `from`, newest first, and says when there were more', async () => {
    const { call, calls } = graph(() =>
      Response.json({
        value: [
          item('m3', '2026-10-26T01:59:00Z'),
          item('m2', '2026-10-26T01:58:00Z'),
          item('m1', '2026-10-26T01:57:00Z'),
        ],
      }),
    );
    expect(
      await microsoftMail.since(call, {
        from: new Date('2026-10-26T02:00:00Z'),
        max: 2,
        folder: 'archive',
      }),
    ).toEqual({
      messages: [
        {
          messageId: 'm3',
          threadId: 'conv-m3',
          found: 'catch-up',
          receivedAt: '2026-10-26T01:59:00Z',
        },
        {
          messageId: 'm2',
          threadId: 'conv-m2',
          found: 'catch-up',
          receivedAt: '2026-10-26T01:58:00Z',
        },
      ],
      more: true,
    });
    expect(calls[0]?.url.split('?')[0]).toBe(`${GRAPH}/me/mailFolders/archive/messages`);
    expect(queryOf(calls[0]?.url ?? '')).toEqual({
      $filter: 'receivedDateTime ge 2026-10-26T01:50:00Z',
      $orderby: 'receivedDateTime desc',
      $top: '3',
      $select: 'id,receivedDateTime,conversationId',
    });
  });

  it('refuses a max outside one page', async () => {
    const { call, calls } = graph(() => Response.json({ value: [] }));
    await expect(microsoftMail.since(call, { from: new Date(), max: 1000 })).rejects.toThrow(
      '`max`',
    );
    expect(calls).toHaveLength(0);
  });
});

describe('microsoftMail.read', () => {
  const conversation = 'AAQkADAwATM0MDAAMS1hMzE2LTZhZTQtMDACLTAwCgAQAMN8DmETPLdPpPsc2YSiwmQ=';

  const FIELDS =
    'id,conversationId,subject,from,toRecipients,ccRecipients,replyTo,receivedDateTime,internetMessageHeaders,uniqueBody,isDraft,parentFolderId';

  it('reads the message, then its conversation, oldest first, each what it added', async () => {
    const { call, calls } = graph((url) =>
      url.pathname.endsWith('/me/messages')
        ? Response.json({
            value: [
              message('m3', '2026-10-26T01:00:00Z'),
              message('m2', '2026-10-25T11:00:00Z', {
                from: { emailAddress: { address: 'support@acme.example' } },
                uniqueBody: { contentType: 'text', content: 'It ships today.' },
              }),
              message('d1', '2026-10-25T10:30:00Z', { isDraft: true }),
              message('m1', '2026-10-25T10:00:00Z', {
                uniqueBody: { contentType: 'text', content: 'Order 1042 is late.' },
              }),
            ],
          })
        : Response.json(
            message('m3', '2026-10-26T01:00:00Z', {
              internetMessageHeaders: [{ name: 'auto-submitted', value: 'no' }],
              body: { contentType: 'text', content: 'Where is order 1042?\n\nFrom: Acme Support' },
            }),
          ),
    );
    const read = await microsoftMail.read(call, { messageId: 'm3', budget: MAIL_TURN_BUDGET });
    const mail = {
      id: 'm3',
      threadId: conversation,
      from: { address: 'bo@acme.example', name: 'Bo Lund' },
      to: [{ address: 'support@acme.example', name: 'Acme Support' }],
      cc: [],
      replyTo: [],
      subject: 'Order 1042',
      receivedAt: '2026-10-26T01:00:00Z',
      body: 'Where is order 1042?',
      bodyCut: false,
      attachments: [],
      autoSubmitted: false,
    };
    expect(read).toEqual({
      kind: 'ok',
      mail,
      thread: [
        expect.objectContaining({ id: 'm1', body: 'Order 1042 is late.' }),
        expect.objectContaining({ id: 'm2', body: 'It ships today.' }),
        mail,
      ],
      notRead: 0,
    });
    expect(calls[0]?.url.split('?')[0]).toBe(`${GRAPH}/me/messages/m3`);
    expect(queryOf(calls[0]?.url ?? '')).toEqual({
      $select: FIELDS,
      $expand: 'attachments($select=name,contentType,size,isInline)',
    });
    expect(calls[0]?.headers.prefer).toBe('outlook.body-content-type="text", IdType="ImmutableId"');
    expect(queryOf(calls[1]?.url ?? '')).toEqual({
      $filter: `receivedDateTime ge 1900-01-01T00:00:00Z and conversationId eq '${conversation}'`,
      $orderby: 'receivedDateTime desc',
      $top: '110',
      $select: FIELDS,
      $expand: 'attachments($select=name,contentType,size,isInline)',
    });
  });

  /** A conversation as Graph lists it across folders: a draft, one deleted, one in junk and one sent among the rest. */
  function folders(missing?: 'junkemail') {
    const ids: Record<string, string> = {
      deleteditems: 'AAMkAGDeletedItems=',
      junkemail: 'AAMkAGJunkEmail=',
      sentitems: 'AAMkAGSentItems=',
    };
    return graph((url) => {
      const folder = /\/me\/mailFolders\/([a-z]+)$/.exec(url.pathname)?.[1];
      if (folder !== undefined) {
        return folder === missing
          ? graphError(404, 'ErrorFolderNotFound', 'The specified folder could not be found.')
          : Response.json({ id: ids[folder] });
      }
      if (url.pathname.endsWith('/me/messages')) {
        return Response.json({
          value: [
            message('d1', '2026-10-25T12:00:00Z', {
              isDraft: true,
              parentFolderId: 'AAMkAGDrafts=',
              uniqueBody: { contentType: 'text', content: "I'll refund the full 500." },
            }),
            message('t1', '2026-10-25T11:30:00Z', { parentFolderId: 'AAMkAGDeletedItems=' }),
            message('m2', '2026-10-25T11:00:00Z', {
              parentFolderId: 'AAMkAGSentItems=',
              internetMessageHeaders: [
                { name: 'X-Reply-Ref', value: '2118217d737b7ef413cde9791b633d32' },
              ],
            }),
            message('j1', '2026-10-25T10:30:00Z', { parentFolderId: 'AAMkAGJunkEmail=' }),
            message('m1', '2026-10-25T10:00:00Z', { parentFolderId: 'AAMkAGInbox=' }),
            message('m0', '2026-10-25T09:00:00Z', { parentFolderId: 'AAMkAGInbox=' }),
          ],
        });
      }
      return Response.json(message('m3', '2026-10-26T01:00:00Z'));
    });
  }

  it('leaves out a draft, and messages in Deleted Items or Junk Email', async () => {
    const { call, calls } = folders();
    const read = await microsoftMail.read(call, { messageId: 'm3', budget: MAIL_TURN_BUDGET });
    expect(read.kind === 'ok' && read.thread.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(
      calls
        .slice(2)
        .map((c) => `${c.url} ${c.headers.prefer}`)
        .sort(),
    ).toEqual([
      `${GRAPH}/me/mailFolders/deleteditems?$select=id IdType="ImmutableId"`,
      `${GRAPH}/me/mailFolders/junkemail?$select=id IdType="ImmutableId"`,
      `${GRAPH}/me/mailFolders/sentitems?$select=id IdType="ImmutableId"`,
    ]);
  });

  it('takes the first and the newest when the conversation holds more than the budget, and counts the rest', async () => {
    const { call, calls } = folders();
    const read = await microsoftMail.read(call, {
      messageId: 'm3',
      budget: { ...MAIL_TURN_BUDGET, threadMails: 3 },
    });
    expect(read.kind === 'ok' && [read.thread.map((m) => m.id), read.notRead]).toEqual([
      ['m0', 'm2', 'm3'],
      1,
    ]);
    expect(queryOf(calls[1]?.url ?? '').$top).toBe('13');
  });

  it('still leaves out what it can when the mailbox has no Junk Email', async () => {
    const { call } = folders('junkemail');
    const read = await microsoftMail.read(call, { messageId: 'm3', budget: MAIL_TURN_BUDGET });
    expect(read.kind === 'ok' && read.thread.map((m) => m.id)).toEqual([
      'm0',
      'm1',
      'j1',
      'm2',
      'm3',
    ]);
  });

  it('marks a message in Sent Items sent, and gives no reply mark: Outlook replies carry none', async () => {
    const { call } = folders();
    const read = await microsoftMail.read(call, { messageId: 'm3', budget: MAIL_TURN_BUDGET });
    expect(read.kind === 'ok' && read.thread.map((m) => [m.id, m.sent, m.replyRef])).toEqual([
      ['m0', undefined, undefined],
      ['m1', undefined, undefined],
      ['m2', true, undefined],
      ['m3', undefined, undefined],
    ]);
  });

  /** A conversation of 20 messages, c00 the first and c19 the newest, c01 a draft, over a page of `$top`. */
  function longConversation() {
    const ids = Array.from({ length: 20 }, (_, i) => `c${String(i).padStart(2, '0')}`);
    const at = (id: string) =>
      `2026-10-${String(Number(id.slice(1)) + 1).padStart(2, '0')}T09:00:00Z`;
    const raw = (id: string) => message(id, at(id), id === 'c01' ? { isDraft: true } : {});
    return graph((url) => {
      if (url.pathname.includes('/mailFolders/')) return Response.json({ id: 'AAMkAGFolder=' });
      if (!url.pathname.endsWith('/me/messages')) {
        return Response.json(raw(decodeURIComponent(url.pathname.split('/').pop() ?? '')));
      }
      const query = queryOf(url.href);
      if (query.$select === 'id,isDraft,parentFolderId') {
        return Response.json({
          value: ids.map((id) => ({ id, ...(id === 'c01' && { isDraft: true }) })),
        });
      }
      const top = Number(query.$top);
      return Response.json({
        value: [...ids].reverse().slice(0, top).map(raw),
        '@odata.nextLink': `${GRAPH}/me/messages?$skip=${top}`,
      });
    }).call;
  }

  it('takes the first and the newest of a conversation longer than a page, and counts the rest', async () => {
    const read = await microsoftMail.read(longConversation(), {
      messageId: 'c19',
      budget: { ...MAIL_TURN_BUDGET, threadMails: 2 },
    });
    expect(read.kind === 'ok' && [read.thread.map((m) => m.id), read.notRead]).toEqual([
      ['c00', 'c18', 'c19'],
      16,
    ]);
    const old = await microsoftMail.read(longConversation(), {
      messageId: 'c00',
      budget: { ...MAIL_TURN_BUDGET, threadMails: 2 },
    });
    expect(old.kind === 'ok' && [old.thread.map((m) => m.id), old.notRead]).toEqual([
      ['c00', 'c19'],
      17,
    ]);
  });

  it("gives a mail's web addresses without their tracking, one over 100 characters cut", async () => {
    const invoice = `The invoice: https://share.acme.example/s/${'k'.repeat(80)}?rlkey=z9`;
    const { call } = graph((url) =>
      url.pathname.endsWith('/me/messages')
        ? Response.json({
            value: [
              message('m2', '2026-10-25T11:00:00Z', {
                uniqueBody: { contentType: 'text', content: invoice },
              }),
            ],
          })
        : Response.json(
            message('m3', '2026-10-26T01:00:00Z', {
              uniqueBody: {
                contentType: 'text',
                content: `Your parcel: https://acme.example/track/1042?utm_source=mail&carrier=dhl\n${invoice}`,
              },
            }),
          ),
    );
    const read = await microsoftMail.read(call, { messageId: 'm3', budget: MAIL_TURN_BUDGET });
    const cut = `The invoice: https://share.acme.example/s/${'k'.repeat(37)}…?…`;
    expect(read.kind === 'ok' && read.thread.map((m) => m.body)).toEqual([
      cut,
      `Your parcel: https://acme.example/track/1042?carrier=dhl\n${cut}`,
    ]);
  });

  it("gives the message alone when Graph refuses the conversation's filter", async () => {
    const { call } = graph((url) =>
      url.pathname.endsWith('/me/messages')
        ? graphError(
            400,
            'InefficientFilter',
            'The restriction or sort order is too complex for this operation.',
          )
        : Response.json(message('m3', '2026-10-26T01:00:00Z')),
    );
    const read = await microsoftMail.read(call, { messageId: 'm3', budget: MAIL_TURN_BUDGET });
    expect(read).toEqual({
      kind: 'ok',
      mail: expect.objectContaining({ id: 'm3' }),
      thread: [expect.objectContaining({ id: 'm3' })],
      notRead: 0,
    });
  });

  it('gives the message alone, and lists no conversation, when it has none', async () => {
    const { call, calls } = graph(() =>
      Response.json({ ...message('m3', '2026-10-26T01:00:00Z'), conversationId: null }),
    );
    const read = await microsoftMail.read(call, { messageId: 'm3', budget: MAIL_TURN_BUDGET });
    expect(read.kind === 'ok' && [read.thread.map((m) => m.id), read.notRead]).toEqual([['m3'], 0]);
    expect(calls.filter((c) => c.url.split('?')[0]?.endsWith('/me/messages'))).toHaveLength(0);
  });

  it('says not-found for a message deleted before it was read', async () => {
    const { call } = graph(() =>
      graphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.'),
    );
    expect(await microsoftMail.read(call, { messageId: 'gone', budget: MAIL_TURN_BUDGET })).toEqual(
      {
        kind: 'not-found',
      },
    );
  });

  it('refuses ids it would put in a path or a filter, before any call', async () => {
    const { call, calls } = graph(() => Response.json({}));
    await expect(
      microsoftMail.read(call, { messageId: '../mailFolders', budget: MAIL_TURN_BUDGET }),
    ).rejects.toThrow("isn't an Outlook message id");
    await expect(
      microsoftMail.read(call, {
        messageId: 'm1',
        threadId: "x' or 1 eq 1",
        budget: MAIL_TURN_BUDGET,
      }),
    ).rejects.toThrow("isn't an Outlook conversation id");
    expect(calls).toHaveLength(0);
  });
});
