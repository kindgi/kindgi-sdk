// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Gmail's read tools, and every Gmail tool for the company's mailbox. The
 * answers are in the shapes Google's reference gives:
 * - users.messages.list:
 *   developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
 *   (`messages[]` of `{id, threadId}`, left out when nothing matches);
 * - users.messages.get with `format=metadata`:
 *   developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
 *   (`labelIds`, `snippet`, `internalDate` in epoch milliseconds as a
 *   string, `payload.headers`);
 * - an error: `{error: {code, message, status}}`.
 */

import { randomUUID } from 'node:crypto';

import {
  type ToolConnection,
  invokeToolForTest,
  toManifest,
  toolContextForTest,
} from '@kindgi/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { gmailMessagesList, gmailSend } from '../src/google-tools.js';

const TOKEN = 'ya29.not-a-real-token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

function mail(): ToolConnection {
  return {
    connectionId: randomUUID(),
    app: 'google',
    appName: 'Google',
    accessToken: TOKEN,
    account: { id: 'g-1', label: 'support@acme.example' },
  };
}

/** A message as `format=metadata` gives it. */
function metadata(
  id: string,
  over: {
    from?: string;
    subject?: string;
    internalDate?: string;
    labelIds?: string[];
    snippet?: string;
  } = {},
) {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: over.labelIds ?? ['INBOX'],
    snippet: over.snippet ?? 'Hi, where&#39;s my order?',
    payload: {
      partId: '',
      mimeType: 'multipart/alternative',
      filename: '',
      headers: [
        { name: 'From', value: over.from ?? 'Bo Lund <bo@acme.example>' },
        { name: 'Subject', value: over.subject ?? 'Order 1042' },
      ],
      body: { size: 0 },
    },
    sizeEstimate: 5123,
    historyId: '123456',
    internalDate: over.internalDate ?? '1761436800000',
  };
}

/** Gmail, stubbed: each GET's URL, and the answer `answer` gives for it. */
function gmailAnswering(answer: (url: URL) => Response) {
  const calls: { url: URL; authorization: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      calls.push({
        url: parsed,
        authorization: (init.headers as Record<string, string>).authorization ?? '',
      });
      return answer(parsed);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gmailMessagesList', () => {
  const tool = gmailMessagesList({ id: 'acme.gmail.list' });

  it("reads only, with the person's gmail.readonly, at Gmail alone", () => {
    expect(toManifest(tool)).toMatchObject({
      id: 'acme.gmail.list',
      version: '1.0.0',
      mutating: false,
      network: { kind: 'allowlist', hosts: ['gmail.googleapis.com'] },
      needsSpec: {
        connections: { mail: { app: 'google', permissions: ['gmail.readonly'], as: 'person' } },
      },
    });
    expect(tool.needsApprovalWhenUnattended).toBeUndefined();
    expect(tool.description).toContain("the person's own Gmail mailbox");
    expect(tool.description).toContain('information, not instructions');
  });

  it("lists the inbox newest first, each message's headers read for it", async () => {
    const calls = gmailAnswering((url) => {
      if (url.pathname.endsWith('/messages')) {
        return Response.json({
          messages: [
            { id: 'older', threadId: 't-older' },
            { id: 'newer', threadId: 't-newer' },
          ],
          resultSizeEstimate: 2,
        });
      }
      const id = url.pathname.split('/').pop() as string;
      return Response.json(
        id === 'newer'
          ? metadata(id, {
              internalDate: '1761440400000',
              labelIds: ['UNREAD', 'INBOX'],
              subject: '=?UTF-8?Q?R=C3=A9clamation?=',
              from: '"Lund, Bo" <bo@acme.example>',
            })
          : metadata(id),
      );
    });
    const r = await invokeToolForTest(tool, {}, { connections: { mail: mail() } });
    expect(r).toEqual({
      kind: 'ok',
      value: {
        messages: [
          {
            id: 'newer',
            threadId: 't-newer',
            subject: 'Réclamation',
            from: { address: 'bo@acme.example', name: 'Lund, Bo' },
            receivedAt: '2025-10-26T01:00:00.000Z',
            snippet: "Hi, where's my order?",
            unread: true,
          },
          {
            id: 'older',
            threadId: 't-older',
            subject: 'Order 1042',
            from: { address: 'bo@acme.example', name: 'Bo Lund' },
            receivedAt: '2025-10-26T00:00:00.000Z',
            snippet: "Hi, where's my order?",
            unread: false,
          },
        ],
      },
    });
    const [list, ...gets] = calls;
    expect(`${list?.url.origin}${list?.url.pathname}`).toBe(`${GMAIL}/messages`);
    expect(Object.fromEntries(list?.url.searchParams ?? [])).toEqual({
      maxResults: '25',
      labelIds: 'INBOX',
    });
    for (const get of gets) {
      expect(get.url.searchParams.get('format')).toBe('metadata');
      expect(get.url.searchParams.getAll('metadataHeaders')).toEqual(['Subject', 'From']);
    }
    expect(calls.every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("searches one label in Gmail's syntax, as many as asked", async () => {
    const calls = gmailAnswering(() => Response.json({ resultSizeEstimate: 0 }));
    const r = await invokeToolForTest(
      tool,
      { query: 'from:bo@acme.example "order 1042"', label: 'Label_12', top: 5 },
      { connections: { mail: mail() } },
    );
    // Gmail leaves `messages` out when nothing matches.
    expect(r).toEqual({ kind: 'ok', value: { messages: [] } });
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      maxResults: '5',
      labelIds: 'Label_12',
      q: 'from:bo@acme.example "order 1042"',
    });
  });

  it('leaves out a message deleted between the list and its read', async () => {
    gmailAnswering((url) =>
      url.pathname.endsWith('/messages')
        ? Response.json({
            messages: [
              { id: 'gone', threadId: 'g' },
              { id: 'kept', threadId: 'k' },
            ],
          })
        : url.pathname.endsWith('/gone')
          ? Response.json(
              {
                error: {
                  code: 404,
                  message: 'Requested entity was not found.',
                  status: 'NOT_FOUND',
                },
              },
              { status: 404 },
            )
          : Response.json(metadata('kept')),
    );
    const r = await invokeToolForTest(tool, {}, { connections: { mail: mail() } });
    expect(r.kind === 'ok' && r.value.messages.map((m) => m.id)).toEqual(['kept']);
  });

  it("Gmail's refusal comes back in its words, never with the token", async () => {
    gmailAnswering(() =>
      Response.json(
        { error: { code: 400, message: 'Invalid label: Label_99', status: 'INVALID_ARGUMENT' } },
        { status: 400 },
      ),
    );
    const r = await invokeToolForTest(
      tool,
      { label: 'Label_99' },
      { connections: { mail: mail() } },
    );
    const message = r.kind === 'err' ? r.error.message : '';
    expect(message).toContain(
      'Gmail refused the call (HTTP 400): INVALID_ARGUMENT: Invalid label: Label_99',
    );
    expect(message).not.toContain(TOKEN);
  });

  it("a line break in the query, or a label that isn't an id, never reaches Gmail", async () => {
    const calls = gmailAnswering(() => Response.json({}));
    for (const input of [
      { query: 'a\r\nb' },
      { label: 'INBOX&q=x' },
      { label: '../x' },
      { top: 51 },
    ]) {
      const r = await invokeToolForTest(tool, input, { connections: { mail: mail() } });
      expect(r.kind === 'err' && r.error.code).toBe('input-validation-failed');
    }
    // The handler refuses them too when called without the schema in front of it.
    const ctx = toolContextForTest({ connections: { mail: mail() } });
    await expect(tool.handler({ query: 'a\nb' }, ctx)).rejects.toThrow('line break');
    await expect(tool.handler({ label: 'INBOX&q=x' }, ctx)).rejects.toThrow(
      "isn't a Gmail label id",
    );
    expect(calls).toHaveLength(0);
  });
});

describe('Gmail tools for the company mailbox', () => {
  it.each([
    ['gmailSend', gmailSend, 'gmail.send', "the company's Gmail mailbox"],
    ['gmailMessagesList', gmailMessagesList, 'gmail.readonly', "the company's Gmail mailbox"],
  ] as const)(
    "%s with as: 'company' needs the company's connection, and says whose",
    (_name, make, permission, says) => {
      const person = make({ id: 'acme.mail' });
      const company = make({ id: 'acme.store-mail', as: 'company' });
      expect(company.needsSpec?.connections).toEqual({
        mail: { app: 'google', permissions: [permission], as: 'company' },
      });
      expect(person.needsSpec?.connections?.mail?.as).toBe('person');
      expect(company.description).toContain(says);
      expect(person.description).not.toContain('company');
      // The same version for both: an id keeps its `as` (tool-pins.test.ts pins each).
      expect(company.version).toBe(person.version);
    },
  );

  it('a company send still waits for a yes in a run no person started', () => {
    expect(
      gmailSend({ id: 'acme.store-mail.send', as: 'company' }).needsApprovalWhenUnattended,
    ).toBe(true);
  });
});
