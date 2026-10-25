// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/connections/google/tools` — tools that act with a person's Google
 * connection. A pack includes one by exporting it as a tool under an id the
 * pack names: a tool folder whose `index.ts` is
 * `export default gmailSend({ id: 'acme.gmail.send' })`. The id is the
 * pack's because a tool id is the tenant's, filed under the first project
 * that publishes it.
 */

import type { Tool } from '@kindgi/tools';

import { appFetch } from './app-fetch.js';
import { type AppToolOptions, appTool } from './app-tool.js';
import { google } from './google.js';

export type { AppToolOptions } from './app-tool.js';

const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/** A mail address. Line breaks and list separators are refused: they could add a header or a recipient. */
const ADDRESS = {
  type: 'string',
  format: 'email',
  maxLength: 254,
  pattern: '^[^\\r\\n,;<>"]+$',
} as const;

export interface GmailSendInput {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  /** Plain text. */
  readonly body: string;
}

export interface GmailSendOutput {
  /** Gmail's id for the sent message. */
  readonly messageId: string;
}

const GMAIL_SEND: Omit<Tool<GmailSendInput, GmailSendOutput>, 'id'> = {
  description:
    "Send a plain-text email from the person's own Gmail account (the one they connected) to the addresses in `to` and `cc`. Gmail adds the From line: the sender is always that person. Returns the sent message's id. In a run no person started, each send waits for that person's yes.",
  version: '1.0.0',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['to', 'subject', 'body'],
    properties: {
      to: { type: 'array', minItems: 1, maxItems: 100, items: ADDRESS },
      cc: { type: 'array', maxItems: 100, items: ADDRESS },
      subject: { type: 'string', minLength: 1, maxLength: 900, pattern: '^[^\\r\\n]*$' },
      body: { type: 'string', minLength: 1, maxLength: 500_000 },
    },
  },
  output: {
    type: 'object',
    additionalProperties: false,
    required: ['messageId'],
    properties: { messageId: { type: 'string' } },
  },
  effects: [
    {
      kind: 'external-side-effect',
      resource: 'external:gmail',
      notes: 'Sends mail as the person.',
    },
    { kind: 'sensitive-data-egress', resource: 'external:gmail' },
  ],
  mutating: true,
  // A send as a person never goes out unasked in a run a schedule, a webhook
  // or a service account's key started: the person says yes to each one.
  needsApprovalWhenUnattended: true,
  network: { kind: 'allowlist', hosts: ['gmail.googleapis.com'] },
  needsSpec: {
    connections: { mail: { app: 'google', permissions: ['gmail.send'], as: 'person' } },
  },
  handler: async (input, ctx) => {
    // The input schema refuses these too; a handler called directly still mustn't send them.
    for (const value of [...input.to, ...(input.cc ?? []), input.subject]) {
      if (/[\r\n]/.test(value)) throw new Error('An address or the subject has a line break.');
    }
    const raw = Buffer.from(mimeMessage(input), 'utf8').toString('base64url');
    const send = async (): Promise<GmailSendOutput> => {
      const res = await appFetch(ctx, {
        entry: google,
        connection: 'mail',
        // Gmail's own name for the call, whatever the pack's id: the entry's costs use it.
        toolId: 'gmail.send',
        url: SEND_URL,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw }),
      });
      if (!res.ok) throw new Error(`Gmail didn't send the message: ${await googleSays(res)}`);
      const sent = (await res.json()) as { readonly id?: unknown };
      if (typeof sent.id !== 'string') throw new Error('Gmail sent the message but gave no id.');
      return { messageId: sent.id };
    };
    // Sent once per call: a step run again (resumed or retried) gets the first send's answer.
    return ctx.record !== undefined ? ctx.record('sent', send) : send();
  },
};

/** A tool, under the id the pack names, that sends a plain-text email as the person whose Google connection the call has. */
export function gmailSend(options: AppToolOptions): Tool<GmailSendInput, GmailSendOutput> {
  return appTool(GMAIL_SEND, options);
}

/** The message as RFC 5322 text: headers folded short, the body base64 in UTF-8. */
export function mimeMessage(m: GmailSendInput): string {
  const cc = m.cc ?? [];
  return [
    `To: ${m.to.join(',\r\n ')}`,
    ...(cc.length > 0 ? [`Cc: ${cc.join(',\r\n ')}`] : []),
    `Subject: ${encodedSubject(m.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    lines(Buffer.from(m.body, 'utf8').toString('base64'), 76),
  ].join('\r\n');
}

/**
 * Printable ASCII as it is; anything else as RFC 2047 encoded words, each
 * under 76 characters and never splitting a character, folded onto lines
 * of their own.
 */
function encodedSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  const words: string[] = [];
  let chunk = '';
  for (const ch of subject) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk !== '') words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function lines(text: string, width: number): string {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width));
  return out.join('\r\n');
}

/** What Google's error says (its status and message), else the HTTP status. */
async function googleSays(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const e = (JSON.parse(text) as { error?: { status?: unknown; message?: unknown } }).error;
    if (typeof e?.message === 'string') {
      return typeof e.status === 'string' ? `${e.status}: ${e.message}` : e.message;
    }
  } catch {
    // Not JSON: the status says enough.
  }
  return `HTTP ${res.status}`;
}
