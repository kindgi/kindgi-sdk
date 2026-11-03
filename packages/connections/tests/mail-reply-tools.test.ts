// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import {
  type ToolConnection,
  type ToolContext,
  invokeToolForTest,
  toolContextForTest,
} from '@kindgi/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type GmailReplyInput, gmailReply } from '../src/google-tools.js';
import { isMailAddress } from '../src/mail-reply.js';
import { replyRefOf } from '../src/mail.js';
import { type OutlookReplyInput, outlookReply } from '../src/microsoft-tools.js';

const TOKEN = 'not-a-real-token';
const GRAPH = 'https://graph.microsoft.com/v1.0';
/** The mailbox's own address: its connection's account. */
const OWN = 'ana@acme.test';

function connection(app: 'google' | 'microsoft'): ToolConnection {
  return {
    connectionId: randomUUID(),
    app,
    appName: app === 'google' ? 'Google' : 'Microsoft',
    accessToken: TOKEN,
    account: { id: `${app}-1`, label: OWN },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A run's journal: a step run again gets each key's first answer. */
function journal(): NonNullable<ToolContext['record']> {
  const kept = new Map<string, unknown>();
  return async (key, decide) => {
    if (!kept.has(key)) kept.set(key, await decide());
    return kept.get(key) as never;
  };
}

describe('gmailReply', () => {
  const tool = gmailReply({ id: 'acme.gmail.reply' });

  /** A message as `format=metadata` gives it, with these headers. */
  function answered(headers: Readonly<Record<string, string>>, threadId: unknown = 'thread-1') {
    return {
      id: 'msg-1',
      threadId,
      payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
    };
  }

  /** Gmail, stubbed: the message read gives `message`; a send's raw message is kept, decoded. */
  function gmailAnswering(
    message: unknown,
    sendAnswer: () => Response = () => Response.json({ id: 'reply-1', threadId: 'thread-1' }),
  ) {
    const reads: string[] = [];
    const sent: { url: string; threadId: unknown; message: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (init.method !== 'POST') {
          reads.push(url);
          return typeof message === 'function'
            ? (message as () => Response)()
            : Response.json(message);
        }
        const { raw, threadId } = JSON.parse(String(init.body)) as {
          raw: string;
          threadId: unknown;
        };
        sent.push({ url, threadId, message: Buffer.from(raw, 'base64url').toString('utf8') });
        return sendAnswer();
      }),
    );
    return { reads, sent };
  }

  /** A header's value, unfolded. */
  function header(message: string, name: string): string | undefined {
    const head = message.split('\r\n\r\n')[0] ?? '';
    const m = new RegExp(`^${name}: (.*(?:\\r\\n .*)*)`, 'm').exec(head);
    return m?.[1]?.replace(/\r\n /g, ' ');
  }

  function bodyOf(message: string): string {
    const base64 = message.split('\r\n\r\n')[1]?.replace(/\r\n/g, '') ?? '';
    return Buffer.from(base64, 'base64').toString('utf8');
  }

  const HEADERS = {
    From: 'Bo <bo@acme.test>',
    'Reply-To': 'Orders <orders@acme.test>',
    Subject: 'Order 1042',
    'Message-ID': '<m2@acme.test>',
    References: '<m0@acme.test> <m1@acme.test>',
  };
  const REPLY: GmailReplyInput = {
    inReplyTo: 'msg-1',
    to: 'orders@acme.test',
    body: 'Hi,\n\nYour order ships today.\n\nAna',
  };
  const ctx = (more: Partial<ToolContext> = {}) => ({
    connections: { mail: connection('google') },
    runId: 'run-1',
    ...more,
  });

  it('changes things as the person, asks before an unattended reply, and needs their gmail.send and gmail.readonly', () => {
    expect(tool).toMatchObject({
      id: 'acme.gmail.reply',
      version: '1.0.0',
      mutating: true,
      needsApprovalWhenUnattended: true,
      needsSpec: {
        connections: {
          mail: { app: 'google', permissions: ['gmail.send', 'gmail.readonly'], as: 'person' },
        },
      },
      network: { kind: 'allowlist', hosts: ['gmail.googleapis.com'] },
    });
    expect(gmailReply({ id: 'acme.gmail.reply', as: 'company' }).needsSpec).toMatchObject({
      connections: { mail: { app: 'google', as: 'company' } },
    });
  });

  it("replies in the message's thread, to its Reply-To, with In-Reply-To, References, the Re: subject and the run's mark", async () => {
    const { reads, sent } = gmailAnswering(answered(HEADERS));
    const r = await invokeToolForTest(tool, { ...REPLY, to: 'Orders@ACME.test' }, ctx());
    expect(r).toEqual({ kind: 'ok', value: { messageId: 'reply-1', threadId: 'thread-1' } });
    expect(reads).toHaveLength(1);
    const read = new URL(reads[0] ?? '');
    expect(read.pathname).toBe('/gmail/v1/users/me/messages/msg-1');
    expect(read.searchParams.get('format')).toBe('metadata');
    expect(read.searchParams.getAll('metadataHeaders')).toEqual([
      'Message-ID',
      'References',
      'Subject',
      'Reply-To',
      'From',
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(sent[0]?.threadId).toBe('thread-1');
    const m = sent[0]?.message ?? '';
    // `to` as the call named it: the address the person approving saw.
    expect(header(m, 'To')).toBe('Orders@ACME.test');
    expect(header(m, 'Subject')).toBe('Re: Order 1042');
    expect(header(m, 'In-Reply-To')).toBe('<m2@acme.test>');
    expect(header(m, 'References')).toBe('<m0@acme.test> <m1@acme.test> <m2@acme.test>');
    expect(header(m, 'X-Reply-Ref')).toBe(replyRefOf('run-1'));
    expect(header(m, 'From')).toBeUndefined();
    expect(bodyOf(m)).toBe(REPLY.body);
  });

  it('with no Reply-To, replies to its From; a subject that starts with Re: keeps it', async () => {
    const { From: _, 'Reply-To': __, ...rest } = HEADERS;
    const { sent } = gmailAnswering(
      answered({ ...rest, From: 'bo@acme.test (Bo)', Subject: 'RE: Order 1042' }),
    );
    const r = await invokeToolForTest(tool, { ...REPLY, to: 'bo@acme.test' }, ctx());
    expect(r.kind).toBe('ok');
    expect(header(sent[0]?.message ?? '', 'To')).toBe('bo@acme.test');
    expect(header(sent[0]?.message ?? '', 'Subject')).toBe('RE: Order 1042');
  });

  it('a Reply-To that names no address is none: the reply goes to its From', async () => {
    for (const replyTo of ['', 'undisclosed-recipients:;', 'Orders']) {
      const { sent } = gmailAnswering(answered({ ...HEADERS, 'Reply-To': replyTo }));
      const r = await invokeToolForTest(tool, { ...REPLY, to: 'bo@acme.test' }, ctx());
      expect(r.kind, replyTo).toBe('ok');
      expect(header(sent[0]?.message ?? '', 'To')).toBe('bo@acme.test');
    }
  });

  it('each of these is one address, parsed as the read parses it', async () => {
    for (const [headers, to] of [
      [{ 'Reply-To': '"Doe, Jane" <jane@example.com>' }, 'jane@example.com'],
      [{ 'Reply-To': '=?UTF-8?B?w4lsaXNl?= <elise@example.com>' }, 'elise@example.com'],
      [{ 'Reply-To': undefined, From: 'bo@acme.example (Bo)' }, 'bo@acme.example'],
    ] as const) {
      const { sent } = gmailAnswering(
        answered({ ...HEADERS, ...headers } as Record<string, string>),
      );
      const r = await invokeToolForTest(tool, { ...REPLY, to }, ctx());
      expect(r.kind, JSON.stringify(headers)).toBe('ok');
      expect(header(sent[0]?.message ?? '', 'To')).toBe(to);
    }
  });

  it("refuses, and sends nothing, when the mail names two addresses, none, one that isn't an address, its own, or another than `to`; the refusal names the one it asks for", async () => {
    const own = { 'Reply-To': undefined, From: `Ana <${OWN.toUpperCase()}>` };
    for (const [headers, to, says] of [
      [{ 'Reply-To': 'a@acme.test, b@acme.test' }, 'a@acme.test', 'Reply-To names 2 addresses'],
      [
        { 'Reply-To': undefined, From: 'undisclosed-recipients:;' },
        'bo@acme.test',
        'From names no address',
      ],
      [
        { 'Reply-To': 'Bo <bo@localhost>' },
        'bo@acme.test',
        "Reply-To isn't an address a reply can go to",
      ],
      [own, OWN, "From is this mailbox's own address"],
      [{}, 'eve@evil.test', 'The mail asks for replies to orders@acme.test (its Reply-To)'],
      // Reply-To wins over From: a `to` naming the From is refused.
      [{}, 'bo@acme.test', 'The mail asks for replies to orders@acme.test (its Reply-To)'],
    ] as const) {
      const { sent } = gmailAnswering(
        answered({ ...HEADERS, ...headers } as Record<string, string>),
      );
      const r = await invokeToolForTest(tool, { ...REPLY, to }, ctx());
      expect(r.kind === 'err' && r.error.code, says).toBe('handler-error');
      expect(r.kind === 'err' ? r.error.message : '').toContain(says);
      expect(r.kind === 'err' ? r.error.message : '').toContain('this tool sent nothing');
      expect(sent, says).toHaveLength(0);
    }
  });

  it("refuses a value of the mail's that would carry a line break into the reply's headers, once unfolded and decoded, and an id that isn't <…> or runs past 900", async () => {
    for (const [headers, says] of [
      [{ Subject: '=?UTF-8?Q?Hi=0D=0ABcc:_eve@evil.test?=' }, 'Subject has a line break'],
      [{ References: '<m0@acme.test> =?UTF-8?Q?=0D=0A?=' }, "References isn't message ids"],
      [{ References: '<m0@acme.test> m1@acme.test' }, "References isn't message ids"],
      [{ References: '<m0@acme.test> <m<1@acme.test>' }, "References isn't message ids"],
      [{ References: '<m0@acme.test> <m1>@acme.test>' }, "References isn't message ids"],
      [{ References: '<m0@acme.test> <>' }, "References isn't message ids"],
      [{ References: `<${'r'.repeat(890)}@acme.test>` }, 'References has an id over 900'],
      [{ 'Message-ID': '<m2@acme.test>\r\nBcc: eve@evil.test' }, 'Message-ID has a line break'],
      [{ 'Message-ID': 'm2@acme.test' }, "Message-ID isn't message ids"],
      [{ 'Message-ID': '<m<2@acme.test>' }, "Message-ID isn't message ids"],
      [{ 'Message-ID': '<m>2@acme.test>' }, "Message-ID isn't message ids"],
      [{ 'Message-ID': '<m2 @acme.test>' }, "Message-ID isn't message ids"],
      [{ 'Message-ID': `<${'m'.repeat(890)}@acme.test>` }, 'Message-ID has an id over 900'],
    ] as const) {
      const { sent } = gmailAnswering(answered({ ...HEADERS, ...headers }));
      const r = await invokeToolForTest(tool, REPLY, ctx());
      expect(r.kind === 'err' ? r.error.message : '', says).toContain(says);
      expect(sent, says).toHaveLength(0);
    }
  });

  it('a folded References is unfolded and kept, and ids that touch are each kept', async () => {
    for (const references of [
      '<m0@acme.test>\r\n <m1@acme.test>\r\n\t<m1b@acme.test>',
      '<m0@acme.test><m1@acme.test>\r\n\t<m1b@acme.test>',
    ]) {
      const { sent } = gmailAnswering(answered({ ...HEADERS, References: references }));
      expect((await invokeToolForTest(tool, REPLY, ctx())).kind, references).toBe('ok');
      expect(header(sent[0]?.message ?? '', 'References'), references).toBe(
        '<m0@acme.test> <m1@acme.test> <m1b@acme.test> <m2@acme.test>',
      );
    }
  });

  it('a mail with no Message-ID, or a blank one, gets no In-Reply-To, and its own References, or none', async () => {
    const { 'Message-ID': _, ...noId } = HEADERS;
    for (const headers of [noId, { ...noId, 'Message-ID': ' ' }]) {
      let { sent } = gmailAnswering(answered(headers));
      expect((await invokeToolForTest(tool, REPLY, ctx())).kind).toBe('ok');
      expect(header(sent[0]?.message ?? '', 'In-Reply-To')).toBeUndefined();
      expect(header(sent[0]?.message ?? '', 'References')).toBe('<m0@acme.test> <m1@acme.test>');
      const { References: __, ...none } = headers;
      ({ sent } = gmailAnswering(answered(none)));
      expect((await invokeToolForTest(tool, REPLY, ctx())).kind).toBe('ok');
      expect(sent[0]?.message).toMatch(/^To: orders@acme\.test\r\n/);
      expect(sent[0]?.message).not.toMatch(/^(?:In-Reply-To|References):/m);
    }
  });

  it('a References of 500 ids gives 20, the first and the newest; a 900-character subject stays 900 with Re:', async () => {
    const references = Array.from({ length: 500 }, (_, i) => `<id${i}@acme.test>`);
    const { sent } = gmailAnswering(
      answered({ ...HEADERS, References: references.join(' '), Subject: 's'.repeat(900) }),
    );
    expect((await invokeToolForTest(tool, REPLY, ctx())).kind).toBe('ok');
    const m = sent[0]?.message ?? '';
    const ids = header(m, 'References')?.split(' ') ?? [];
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe('<id0@acme.test>');
    expect(ids.slice(1, -1)).toEqual(references.slice(-18));
    expect(ids.at(-1)).toBe('<m2@acme.test>');
    expect(header(m, 'Subject')).toBe(`Re: ${'s'.repeat(896)}`);
  });

  it('References go one id to a line, so ids near 900 characters keep each line under 998', async () => {
    const references = Array.from(
      { length: 25 },
      (_, i) => `<${String(i).padStart(2, '0')}${'r'.repeat(836)}@acme.test>`,
    );
    const { sent } = gmailAnswering(answered({ ...HEADERS, References: references.join(' ') }));
    expect((await invokeToolForTest(tool, REPLY, ctx())).kind).toBe('ok');
    const m = sent[0]?.message ?? '';
    expect(header(m, 'References')?.split(' ')).toEqual([
      references[0],
      ...references.slice(-18),
      '<m2@acme.test>',
    ]);
    for (const line of m.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
  });

  it('a call outside a run sends no mark', async () => {
    const { sent } = gmailAnswering(answered(HEADERS));
    // A test context has a run id: the call outside a run is one without it.
    const { runId: _, ...outside } = toolContextForTest(ctx());
    expect(await tool.handler(REPLY, outside)).toEqual({
      messageId: 'reply-1',
      threadId: 'thread-1',
    });
    expect(header(sent[0]?.message ?? '', 'X-Reply-Ref')).toBeUndefined();
  });

  it('refuses a message Gmail gives no thread, and one gone since it was listed', async () => {
    let { sent } = gmailAnswering(answered(HEADERS, null));
    let r = await invokeToolForTest(tool, REPLY, ctx());
    expect(r.kind === 'err' ? r.error.message : '').toContain('Gmail gave the message no thread');
    expect(sent).toHaveLength(0);
    ({ sent } = gmailAnswering(() =>
      Response.json(
        { error: { code: 404, status: 'NOT_FOUND', message: 'Not Found' } },
        { status: 404 },
      ),
    ));
    r = await invokeToolForTest(tool, REPLY, ctx());
    expect(r.kind === 'err' ? r.error.message : '').toContain(
      'Gmail found nothing at /messages/msg-1',
    );
    expect(sent).toHaveLength(0);
  });

  it('`to` is a bare address, and the message id one Gmail gives: the schema refuses others, and so does the handler called directly', async () => {
    const { reads } = gmailAnswering(answered(HEADERS));
    for (const input of [
      { ...REPLY, to: 'Orders <orders@acme.test>' },
      { ...REPLY, to: 'orders@acme.test\r\nBcc: eve@evil.test' },
      { ...REPLY, inReplyTo: '../profile' },
    ]) {
      const r = await invokeToolForTest(tool, input, ctx());
      expect(r.kind === 'err' && r.error.code).toBe('input-validation-failed');
    }
    await expect(
      tool.handler(
        { ...REPLY, to: 'orders@acme.test\nBcc: eve@evil.test' },
        toolContextForTest(ctx()),
      ),
    ).rejects.toThrow("`to` isn't an address a reply can go to.");
    await expect(
      tool.handler({ ...REPLY, inReplyTo: '../profile' }, toolContextForTest(ctx())),
    ).rejects.toThrow("That isn't a message id gmailMessagesList gives.");
    expect(reads).toHaveLength(0);
  });

  it("Gmail's refusal comes back in its words, never with the token", async () => {
    gmailAnswering(answered(HEADERS), () =>
      Response.json(
        { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid To header' } },
        { status: 400 },
      ),
    );
    const r = await invokeToolForTest(tool, REPLY, ctx());
    const message = r.kind === 'err' ? r.error.message : '';
    expect(message).toContain("Gmail didn't send the reply: INVALID_ARGUMENT: Invalid To header");
    expect(message).not.toContain(TOKEN);
  });

  it("reads and sends once per call: a step run again gets the first reply's answer", async () => {
    const { reads, sent } = gmailAnswering(answered(HEADERS));
    const run = ctx({ record: journal() });
    const first = await invokeToolForTest(tool, REPLY, run);
    expect(await invokeToolForTest(tool, REPLY, run)).toEqual(first);
    expect(reads).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
});

describe('outlookReply', () => {
  const tool = outlookReply({ id: 'acme.outlook.reply' });

  interface Sent {
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
  }

  /** Graph, stubbed: the message read gives `message`; the reply's answer is `replyAnswer`. */
  function graphAnswering(
    message: unknown,
    replyAnswer: () => Response = () => new Response(null, { status: 202 }),
  ) {
    const calls: Sent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const method = init.method ?? 'GET';
        calls.push({
          url,
          method,
          headers: init.headers as Record<string, string>,
          body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
        });
        return method === 'POST' ? replyAnswer() : Response.json(message);
      }),
    );
    return calls;
  }

  const address = (a: string, name?: string) => ({
    emailAddress: { address: a, ...(name !== undefined && { name }) },
  });
  const MESSAGE = {
    id: 'AAMkAD1',
    from: address('bo@acme.test', 'Bo'),
    replyTo: [address('orders@acme.test', 'Orders')],
  };
  const REPLY: OutlookReplyInput = {
    inReplyTo: 'AAMkAD1',
    to: 'orders@acme.test',
    body: 'Hi,\n\nYour order ships today.\n\nAna',
  };
  const ctx = (more: Partial<ToolContext> = {}) => ({
    connections: { mail: connection('microsoft') },
    runId: 'run-1',
    ...more,
  });
  const posts = (calls: readonly Sent[]) => calls.filter((c) => c.method === 'POST');

  it('changes things as the person, asks before an unattended reply, and needs their mail.send and mail.read', () => {
    expect(tool).toMatchObject({
      id: 'acme.outlook.reply',
      version: '1.0.0',
      mutating: true,
      needsApprovalWhenUnattended: true,
      needsSpec: {
        connections: {
          mail: { app: 'microsoft', permissions: ['mail.send', 'mail.read'], as: 'person' },
        },
      },
      network: { kind: 'allowlist', hosts: ['graph.microsoft.com'] },
    });
    expect(outlookReply({ id: 'acme.outlook.reply', as: 'company' }).needsSpec).toMatchObject({
      connections: { mail: { app: 'microsoft', as: 'company' } },
    });
  });

  it('reads who the message asks replies to go to, then posts the body, as text, to its /reply, to that one address', async () => {
    const calls = graphAnswering(MESSAGE);
    const r = await invokeToolForTest(tool, { ...REPLY, to: 'ORDERS@acme.test' }, ctx());
    expect(r).toEqual({ kind: 'ok', value: { accepted: true } });
    expect(calls).toHaveLength(2);
    const read = new URL(calls[0]?.url ?? '');
    expect(`${read.origin}${read.pathname}`).toBe(`${GRAPH}/me/messages/AAMkAD1`);
    expect(read.searchParams.get('$select')).toBe('from,replyTo');
    expect(calls[0]?.headers.prefer).toBe('IdType="ImmutableId"');
    expect(calls[1]).toMatchObject({
      url: `${GRAPH}/me/messages/AAMkAD1/reply`,
      method: 'POST',
      headers: { prefer: 'IdType="ImmutableId"' },
    });
    // The whole request: one recipient, the body as text, and no `comment`.
    expect(calls[1]?.body).toEqual({
      message: {
        toRecipients: [{ emailAddress: { address: 'ORDERS@acme.test' } }],
        body: { contentType: 'text', content: REPLY.body },
      },
    });
  });

  it('with no Reply-To, or one that names no address, replies to its From', async () => {
    for (const replyTo of [[], undefined, [address('')]]) {
      const calls = graphAnswering({ ...MESSAGE, replyTo });
      const r = await invokeToolForTest(tool, { ...REPLY, to: 'bo@acme.test' }, ctx());
      expect(r.kind, JSON.stringify(replyTo)).toBe('ok');
      expect(posts(calls)[0]?.body).toMatchObject({
        message: { toRecipients: [{ emailAddress: { address: 'bo@acme.test' } }] },
      });
    }
  });

  it("refuses, and sends nothing, when the mail names two addresses, none, one that isn't an address, its own, or another than `to`; the refusal names the one it asks for", async () => {
    for (const [message, to, says] of [
      [
        { replyTo: [address('a@acme.test'), address('b@acme.test')] },
        'a@acme.test',
        'Reply-To names 2 addresses',
      ],
      // An entry with no address still counts, beside one that has one.
      [
        { replyTo: [address('orders@acme.test'), address('')] },
        'orders@acme.test',
        'Reply-To names 2 addresses',
      ],
      [
        { replyTo: [address('bo@localhost')] },
        'bo@acme.test',
        "Reply-To isn't an address a reply can go to",
      ],
      [{ replyTo: [], from: undefined }, 'bo@acme.test', 'From names no address'],
      [
        { replyTo: [], from: address('') },
        'bo@acme.test',
        "From isn't an address a reply can go to",
      ],
      [{ replyTo: [], from: address('Ana@Acme.test') }, OWN, "From is this mailbox's own address"],
      [{}, 'eve@evil.test', 'The mail asks for replies to orders@acme.test (its Reply-To)'],
      [{}, 'bo@acme.test', 'The mail asks for replies to orders@acme.test (its Reply-To)'],
    ] as const) {
      const calls = graphAnswering({ ...MESSAGE, ...message });
      const r = await invokeToolForTest(tool, { ...REPLY, to }, ctx());
      expect(r.kind === 'err' && r.error.code, says).toBe('handler-error');
      expect(r.kind === 'err' ? r.error.message : '').toContain(says);
      expect(posts(calls), says).toHaveLength(0);
    }
  });

  it('`to` is a bare address, and the message id one Graph gives: the schema refuses others, and so does the handler called directly', async () => {
    const calls = graphAnswering(MESSAGE);
    const r = await invokeToolForTest(tool, { ...REPLY, to: 'Orders <orders@acme.test>' }, ctx());
    expect(r.kind === 'err' && r.error.code).toBe('input-validation-failed');
    await expect(
      tool.handler({ ...REPLY, to: 'orders@acme.test, eve@evil.test' }, toolContextForTest(ctx())),
    ).rejects.toThrow("`to` isn't an address a reply can go to.");
    await expect(
      tool.handler({ ...REPLY, inReplyTo: '../me' }, toolContextForTest(ctx())),
    ).rejects.toThrow("That isn't a message id outlookMessagesList gives.");
    expect(calls).toHaveLength(0);
  });

  it("Outlook's refusal comes back in its words, never with the token", async () => {
    graphAnswering(MESSAGE, () =>
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
    const r = await invokeToolForTest(tool, REPLY, ctx());
    const message = r.kind === 'err' ? r.error.message : '';
    expect(message).toContain("Outlook didn't send the reply: ErrorInvalidRecipients");
    expect(message).not.toContain(TOKEN);
  });

  it("reads and sends once per call: a step run again gets the first reply's answer", async () => {
    const calls = graphAnswering(MESSAGE);
    const run = ctx({ record: journal() });
    expect(await invokeToolForTest(tool, REPLY, run)).toEqual({
      kind: 'ok',
      value: { accepted: true },
    });
    expect(await invokeToolForTest(tool, REPLY, run)).toEqual({
      kind: 'ok',
      value: { accepted: true },
    });
    expect(calls).toHaveLength(2);
  });
});

describe('isMailAddress', () => {
  it("takes the addresses the reply tools' `to` schema takes, and no others", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const atAcme = (length: number) => `${'a'.repeat(length - '@acme.test'.length)}@acme.test`;
    const gmail = gmailReply({ id: 'acme.gmail.reply' });
    const outlook = outlookReply({ id: 'acme.outlook.reply' });
    const calls = {
      gmailReply: (to: string) =>
        invokeToolForTest(
          gmail,
          { inReplyTo: 'msg-1', to, body: 'Hi' },
          { connections: { mail: connection('google') }, runId: 'run-1' },
        ),
      outlookReply: (to: string) =>
        invokeToolForTest(
          outlook,
          { inReplyTo: 'AAMkAD1', to, body: 'Hi' },
          { connections: { mail: connection('microsoft') }, runId: 'run-1' },
        ),
    };
    for (const to of [
      'orders@acme.test',
      'o.b+x@sub.acme.test',
      atAcme(254),
      atAcme(255),
      'bo@localhost',
      '"bo smith"@acme.test',
      'bo..x@acme.test',
      '.bo@acme.test',
      'bo@acme.test.',
      'bo@-acme.test',
      'bø@acme.test',
      'bo@acme.test, eve@evil.test',
      'Bo <bo@acme.test>',
    ]) {
      for (const [name, call] of Object.entries(calls)) {
        const r = await call(to);
        const schemaTakes = !(r.kind === 'err' && r.error.code === 'input-validation-failed');
        expect(isMailAddress(to), `${name} ${to}`).toBe(schemaTakes);
      }
    }
  });
});
