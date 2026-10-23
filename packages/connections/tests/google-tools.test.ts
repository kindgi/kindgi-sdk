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

import { type GmailSendInput, gmailSend, mimeMessage } from '../src/google-tools.js';

const TOKEN = 'ya29.not-a-real-token';

function mail(): ToolConnection {
  return {
    connectionId: randomUUID(),
    app: 'google',
    appName: 'Google',
    accessToken: TOKEN,
    account: { id: 'g-1', label: 'ana@acme.test' },
  };
}

/** Gmail's send endpoint, stubbed: what each call sent, decoded. */
function gmailAnswering(answer: () => Response = () => Response.json({ id: 'msg-1' })) {
  const sent: { url: string; authorization: string; message: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const { raw } = JSON.parse(String(init.body)) as { raw: string };
      sent.push({
        url,
        authorization: (init.headers as Record<string, string>).authorization ?? '',
        message: Buffer.from(raw, 'base64url').toString('utf8'),
      });
      return answer();
    }),
  );
  return sent;
}

/** A header's value, unfolded. */
function header(message: string, name: string): string | undefined {
  const head = message.split('\r\n\r\n')[0] ?? '';
  const m = new RegExp(`^${name}: (.*(?:\\r\\n .*)*)`, 'm').exec(head);
  return m?.[1]?.replace(/\r\n /g, ' ');
}

function bodyOf(message: string): string {
  return Buffer.from(message.split('\r\n\r\n')[1]?.replace(/\r\n/g, '') ?? '', 'base64').toString(
    'utf8',
  );
}

const SEND: GmailSendInput = {
  to: ['bo@acme.test'],
  subject: 'Following up',
  body: 'Hi Bo,\n\nAs promised, the notes.\n\nAna',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gmail.send', () => {
  it("sends as the person, asks before an unattended send, and needs only that person's gmail.send", () => {
    expect(gmailSend).toMatchObject({
      id: 'gmail.send',
      version: '1.0.0',
      mutating: true,
      needsApprovalWhenUnattended: true,
      needsSpec: {
        connections: { mail: { app: 'google', permissions: ['gmail.send'], as: 'person' } },
      },
      network: { kind: 'allowlist', hosts: ['gmail.googleapis.com'] },
    });
    expect(gmailSend.effects?.map((e) => e.kind)).toEqual([
      'external-side-effect',
      'sensitive-data-egress',
    ]);
  });

  it("posts the message to Gmail with the person's token and answers with its id", async () => {
    const sent = gmailAnswering();
    const r = await invokeToolForTest(
      gmailSend,
      { ...SEND, cc: ['cy@acme.test', 'di@acme.test'] },
      { connections: { mail: mail() } },
    );
    expect(r).toEqual({ kind: 'ok', value: { messageId: 'msg-1' } });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(sent[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    const m = sent[0]?.message ?? '';
    expect(header(m, 'To')).toBe('bo@acme.test');
    expect(header(m, 'Cc')).toBe('cy@acme.test, di@acme.test');
    expect(header(m, 'Subject')).toBe('Following up');
    expect(header(m, 'Content-Type')).toBe('text/plain; charset="UTF-8"');
    // Gmail adds the From line: the sender is always the connected account.
    expect(header(m, 'From')).toBeUndefined();
    expect(bodyOf(m)).toBe(SEND.body);
  });

  it('a subject outside ASCII goes as RFC 2047 words of at most 75 characters, never splitting a character', () => {
    const subject = `Über die Notizen 📎 ${'ü'.repeat(60)}`;
    const m = mimeMessage({ ...SEND, subject });
    const words = header(m, 'Subject')?.split(' ') ?? [];
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) {
      expect(w.length).toBeLessThanOrEqual(75);
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    }
    const decoded = words
      .map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe(subject);
    // Each line of the message stays short.
    for (const line of m.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
  });

  it('a long recipient list is folded, one address to a line', () => {
    const to = Array.from({ length: 40 }, (_, i) => `person-${i}@acme.test`);
    const m = mimeMessage({ ...SEND, to });
    expect(header(m, 'To')).toBe(to.join(', '));
    for (const line of m.split('\r\n')) expect(line.length).toBeLessThan(78);
  });

  it('a line break in an address or the subject is refused before anything is sent: no added header, no added recipient', async () => {
    const sent = gmailAnswering();
    for (const input of [
      { ...SEND, subject: 'Hi\r\nBcc: eve@evil.test' },
      { ...SEND, to: ['bo@acme.test\r\nBcc: eve@evil.test'] },
      { ...SEND, to: ['bo@acme.test, eve@evil.test'] },
      { ...SEND, cc: ['"Eve" <eve@evil.test>'] },
      { ...SEND, to: [] },
    ]) {
      const r = await invokeToolForTest(gmailSend, input, { connections: { mail: mail() } });
      expect(r.kind === 'err' && r.error.code).toBe('input-validation-failed');
    }
    // The handler refuses them too when called without the schema in front of it.
    await expect(
      gmailSend.handler(
        { ...SEND, subject: 'Hi\nBcc: eve@evil.test' },
        toolContextForTest({ connections: { mail: mail() } }),
      ),
    ).rejects.toThrow('line break');
    expect(sent).toHaveLength(0);
  });

  it("Gmail's refusal comes back in its words, never with the token", async () => {
    gmailAnswering(() =>
      Response.json(
        { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid To header' } },
        { status: 400 },
      ),
    );
    const r = await invokeToolForTest(gmailSend, SEND, { connections: { mail: mail() } });
    expect(r.kind === 'err' && r.error.code).toBe('handler-error');
    const message = r.kind === 'err' ? r.error.message : '';
    expect(message).toContain("Gmail didn't send the message: INVALID_ARGUMENT: Invalid To header");
    expect(message).not.toContain(TOKEN);
  });

  it("sends once per call: a step run again gets the first send's answer from its record", async () => {
    const sent = gmailAnswering();
    const journal = new Map<string, unknown>();
    const record: ToolContext['record'] = async (key, decide) => {
      if (!journal.has(key)) journal.set(key, await decide());
      return journal.get(key) as never;
    };
    const ctx = { connections: { mail: mail() }, record };
    expect(await invokeToolForTest(gmailSend, SEND, ctx)).toEqual({
      kind: 'ok',
      value: { messageId: 'msg-1' },
    });
    expect(await invokeToolForTest(gmailSend, SEND, ctx)).toEqual({
      kind: 'ok',
      value: { messageId: 'msg-1' },
    });
    expect(sent).toHaveLength(1);
  });
});
