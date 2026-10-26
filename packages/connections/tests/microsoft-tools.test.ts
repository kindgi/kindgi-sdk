// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import {
  type ToolConnection,
  type ToolContext,
  invokeToolForTest,
  toManifest,
  toolContextForTest,
} from '@kindgi/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type OutlookSendInput,
  outlookMessageGet,
  outlookMessagesList,
  outlookSend,
} from '../src/microsoft-tools.js';

const TOKEN = 'eyJ0eXAi.not-a-real-token';
const GRAPH = 'https://graph.microsoft.com/v1.0';

const send = outlookSend({ id: 'acme.outlook.send' });
const list = outlookMessagesList({ id: 'acme.outlook.messages.list' });
const get = outlookMessageGet({ id: 'acme.outlook.messages.get' });

function mail(): ToolConnection {
  return {
    connectionId: randomUUID(),
    app: 'microsoft',
    appName: 'Microsoft',
    accessToken: TOKEN,
    account: { id: 'm-1', label: 'ana@acme.test' },
  };
}

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** Microsoft Graph, stubbed: what each call sent. */
function graphAnswering(
  answer: (url: string) => Response = () => new Response(null, { status: 202 }),
) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({
        url,
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string>,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return answer(url);
    }),
  );
  return sent;
}

/** A URL's query, decoded, by name. */
function queryOf(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams);
}

const SEND: OutlookSendInput = {
  to: ['bo@acme.test'],
  subject: 'Following up',
  body: 'Hi Bo,\n\nAs promised, the notes.\n\nAna',
};

const RAW_MESSAGE = {
  id: 'AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A',
  subject: 'The revised quote',
  from: { emailAddress: { address: 'bo@acme.test', name: 'Bo' } },
  toRecipients: [{ emailAddress: { address: 'ana@acme.test', name: 'Ana' } }],
  ccRecipients: [{ emailAddress: { address: 'cy@acme.test' } }],
  receivedDateTime: '2026-10-22T14:03:00Z',
  bodyPreview: 'Here it is',
  isRead: false,
  body: { contentType: 'text', content: 'Here it is.\nBo' },
  conversationId: 'AAQkAGI2-conv',
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('outlook.send', () => {
  it("sends as the person, asks before an unattended send, and needs only that person's mail.send", () => {
    expect(send).toMatchObject({
      id: 'acme.outlook.send',
      version: '1.0.0',
      mutating: true,
      needsApprovalWhenUnattended: true,
      needsSpec: {
        connections: { mail: { app: 'microsoft', permissions: ['mail.send'], as: 'person' } },
      },
      network: { kind: 'allowlist', hosts: ['graph.microsoft.com'] },
    });
    expect(send.effects?.map((e) => e.kind)).toEqual([
      'external-side-effect',
      'sensitive-data-egress',
    ]);
  });

  it('is the tool under the id its pack names: two ids, two tools alike but for the id', () => {
    for (const [tool, make] of [
      [send, outlookSend],
      [list, outlookMessagesList],
      [get, outlookMessageGet],
    ] as const) {
      const other = make({ id: 'beta.mail.tool' });
      expect(other.id).toBe('beta.mail.tool');
      expect({ ...toManifest(other), id: tool.id }).toEqual(toManifest(tool));
    }
    expect(() => outlookSend({ id: '' })).toThrow('The tool "" failed to compile');
  });

  it("posts the message to Graph's sendMail with the person's token, and says Microsoft took it", async () => {
    const sent = graphAnswering();
    const r = await invokeToolForTest(
      send,
      { ...SEND, cc: ['cy@acme.test', 'di@acme.test'] },
      { connections: { mail: mail() } },
    );
    expect(r).toEqual({ kind: 'ok', value: { accepted: true } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: `${GRAPH}/me/sendMail`, method: 'POST' });
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // Microsoft adds the From line: the sender is always the connected account.
    expect(sent[0]?.body).toEqual({
      message: {
        subject: 'Following up',
        body: { contentType: 'Text', content: SEND.body },
        toRecipients: [{ emailAddress: { address: 'bo@acme.test' } }],
        ccRecipients: [
          { emailAddress: { address: 'cy@acme.test' } },
          { emailAddress: { address: 'di@acme.test' } },
        ],
      },
      saveToSentItems: true,
    });
  });

  it("under any id, a send is charged as Outlook's: 30 a minute on a connection, then each waits its turn; reads aren't counted", async () => {
    vi.useFakeTimers();
    const sent = graphAnswering((url) =>
      url.includes('/sendMail')
        ? new Response(null, { status: 202 })
        : Response.json({ value: [] }),
    );
    const ctx = { connections: { mail: mail() } };
    for (let i = 0; i < 30; i++) expect((await invokeToolForTest(send, SEND, ctx)).kind).toBe('ok');
    // The sends' limit is spent; a read goes at once all the same.
    expect((await invokeToolForTest(list, {}, ctx)).kind).toBe('ok');
    expect(sent).toHaveLength(31);
    const next = invokeToolForTest(send, SEND, ctx);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sent).toHaveLength(31);
    await vi.advanceTimersByTimeAsync(1);
    expect((await next).kind).toBe('ok');
    expect(sent).toHaveLength(32);
  });

  it('a line break in an address or the subject is refused before anything is sent', async () => {
    const sent = graphAnswering();
    for (const input of [
      { ...SEND, subject: 'Hi\r\nBcc: eve@evil.test' },
      { ...SEND, to: ['bo@acme.test\r\nBcc: eve@evil.test'] },
      { ...SEND, to: ['bo@acme.test, eve@evil.test'] },
      { ...SEND, cc: ['"Eve" <eve@evil.test>'] },
      { ...SEND, to: [] },
    ]) {
      const r = await invokeToolForTest(send, input, { connections: { mail: mail() } });
      expect(r.kind === 'err' && r.error.code).toBe('input-validation-failed');
    }
    // The handler refuses them too when called without the schema in front of it.
    await expect(
      send.handler(
        { ...SEND, subject: 'Hi\nBcc: eve@evil.test' },
        toolContextForTest({ connections: { mail: mail() } }),
      ),
    ).rejects.toThrow('line break');
    expect(sent).toHaveLength(0);
  });

  it("Microsoft's refusal comes back in its words, never with the token; only a 202 is taken as sent", async () => {
    graphAnswering(() =>
      Response.json(
        {
          error: {
            code: 'ErrorInvalidRecipients',
            message: 'At least one recipient is not valid.',
          },
        },
        { status: 400 },
      ),
    );
    const r = await invokeToolForTest(send, SEND, { connections: { mail: mail() } });
    expect(r.kind === 'err' && r.error.code).toBe('handler-error');
    const message = r.kind === 'err' ? r.error.message : '';
    expect(message).toContain(
      "Outlook didn't send the message: ErrorInvalidRecipients: At least one recipient is not valid.",
    );
    expect(message).not.toContain(TOKEN);

    graphAnswering(() => Response.json({}, { status: 200 }));
    const odd = await invokeToolForTest(send, SEND, { connections: { mail: mail() } });
    expect(odd.kind).toBe('err');
  });

  it("sends once per call: a step run again gets the first send's answer from its record", async () => {
    const sent = graphAnswering();
    const journal = new Map<string, unknown>();
    const record: ToolContext['record'] = async (key, decide) => {
      if (!journal.has(key)) journal.set(key, await decide());
      return journal.get(key) as never;
    };
    const ctx = { connections: { mail: mail() }, record };
    for (let i = 0; i < 2; i++) {
      expect(await invokeToolForTest(send, SEND, ctx)).toEqual({
        kind: 'ok',
        value: { accepted: true },
      });
    }
    expect(sent).toHaveLength(1);
  });
});

describe('outlook.messages.list', () => {
  it("reads only, with that person's mail.read", () => {
    expect(list).toMatchObject({
      id: 'acme.outlook.messages.list',
      version: '1.1.0',
      mutating: false,
      resultIsOutsideData: true,
      needsSpec: {
        connections: { mail: { app: 'microsoft', permissions: ['mail.read'], as: 'person' } },
      },
      network: { kind: 'allowlist', hosts: ['graph.microsoft.com'] },
    });
    expect(list.effects?.map((e) => e.kind)).toEqual(['reads', 'network']);
    expect(list.needsApprovalWhenUnattended).toBeUndefined();
  });

  it('lists the newest first, with ids that survive a move', async () => {
    const sent = graphAnswering(() =>
      Response.json({ value: [RAW_MESSAGE, { id: 'draft-1', subject: null, isRead: true }] }),
    );
    const r = await invokeToolForTest(list, {}, { connections: { mail: mail() } });
    expect(r).toEqual({
      kind: 'ok',
      value: {
        messages: [
          {
            id: RAW_MESSAGE.id,
            subject: 'The revised quote',
            from: { address: 'bo@acme.test', name: 'Bo' },
            receivedAt: '2026-10-22T14:03:00Z',
            preview: 'Here it is',
            isRead: false,
          },
          { id: 'draft-1', subject: '', receivedAt: '', preview: '', isRead: true },
        ],
      },
    });
    const url = sent[0]?.url ?? '';
    expect(url.startsWith(`${GRAPH}/me/messages?$top=25&`)).toBe(true);
    expect(queryOf(url)).toEqual({
      $top: '25',
      $select: 'id,subject,from,receivedDateTime,bodyPreview,isRead',
      $orderby: 'receivedDateTime desc',
    });
    expect(sent[0]?.headers.prefer).toBe('IdType="ImmutableId"');
  });

  it("searches in Outlook's syntax, in one folder, without an order Outlook would refuse", async () => {
    const sent = graphAnswering(() => Response.json({ value: [] }));
    const r = await invokeToolForTest(
      list,
      { search: 'from:bo@acme.test quote', folder: 'inbox', top: 5 },
      { connections: { mail: mail() } },
    );
    expect(r.kind).toBe('ok');
    const url = sent[0]?.url ?? '';
    expect(url.startsWith(`${GRAPH}/me/mailFolders/inbox/messages?`)).toBe(true);
    expect(queryOf(url)).toEqual({
      $top: '5',
      $select: 'id,subject,from,receivedDateTime,bodyPreview,isRead',
      $search: '"from:bo@acme.test quote"',
    });
  });

  it("a quote, a backslash or a line break can't end the search string", async () => {
    const sent = graphAnswering(() => Response.json({ value: [] }));
    for (const search of ['quote" OR "x', 'a\\b', 'a\nb', '']) {
      const r = await invokeToolForTest(list, { search }, { connections: { mail: mail() } });
      expect(r.kind === 'err' && r.error.code).toBe('input-validation-failed');
    }
    await expect(
      list.handler(
        { search: 'quote" OR "x' },
        toolContextForTest({ connections: { mail: mail() } }),
      ),
    ).rejects.toThrow('quote');
    expect(sent).toHaveLength(0);
  });

  it('a folder Outlook has no such thing at comes back saying so', async () => {
    graphAnswering(() =>
      Response.json(
        { error: { code: 'ErrorItemNotFound', message: 'Not found.' } },
        { status: 404 },
      ),
    );
    const r = await invokeToolForTest(
      list,
      { folder: 'archive' },
      { connections: { mail: mail() } },
    );
    expect(r.kind === 'err' && r.error.message).toContain(
      "Outlook found nothing at /me/mailFolders/archive/messages in the person's mailbox. (ErrorItemNotFound: Not found.)",
    );
  });
});

describe('outlook.messages.get', () => {
  it("reads only, with that person's mail.read", () => {
    expect(get).toMatchObject({
      mutating: false,
      resultIsOutsideData: true,
      needsSpec: {
        connections: { mail: { app: 'microsoft', permissions: ['mail.read'], as: 'person' } },
      },
    });
    expect(get.effects?.map((e) => e.kind)).toEqual(['reads', 'network']);
  });

  it('reads one message, its body as plain text', async () => {
    const sent = graphAnswering(() => Response.json(RAW_MESSAGE));
    const r = await invokeToolForTest(
      get,
      { messageId: RAW_MESSAGE.id },
      { connections: { mail: mail() } },
    );
    expect(r).toEqual({
      kind: 'ok',
      value: {
        id: RAW_MESSAGE.id,
        subject: 'The revised quote',
        from: { address: 'bo@acme.test', name: 'Bo' },
        to: [{ address: 'ana@acme.test', name: 'Ana' }],
        cc: [{ address: 'cy@acme.test' }],
        receivedAt: '2026-10-22T14:03:00Z',
        body: 'Here it is.\nBo',
        bodyCut: false,
        conversationId: 'AAQkAGI2-conv',
      },
    });
    const url = sent[0]?.url ?? '';
    expect(url.split('?')[0]).toBe(`${GRAPH}/me/messages/${RAW_MESSAGE.id}`);
    expect(queryOf(url)).toEqual({
      $select: 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,conversationId',
    });
    expect(sent[0]?.headers.prefer).toBe('outlook.body-content-type="text", IdType="ImmutableId"');
  });

  it('gives the first 50,000 characters of a longer body, and says it was cut', async () => {
    graphAnswering(() => Response.json({ ...RAW_MESSAGE, body: { content: 'x'.repeat(50_001) } }));
    const r = await invokeToolForTest(
      get,
      { messageId: RAW_MESSAGE.id },
      { connections: { mail: mail() } },
    );
    expect(r.kind === 'ok' && r.value.body.length).toBe(50_000);
    expect(r.kind === 'ok' && r.value.bodyCut).toBe(true);
  });

  it("an id that isn't one never reaches the path", async () => {
    const sent = graphAnswering(() => Response.json(RAW_MESSAGE));
    for (const messageId of ['../mailFolders', 'a/b', 'a?b', '']) {
      const r = await invokeToolForTest(get, { messageId }, { connections: { mail: mail() } });
      expect(r.kind === 'err' && r.error.code).toBe('input-validation-failed');
    }
    await expect(
      get.handler({ messageId: '../me' }, toolContextForTest({ connections: { mail: mail() } })),
    ).rejects.toThrow("isn't a message id");
    expect(sent).toHaveLength(0);
  });
});
