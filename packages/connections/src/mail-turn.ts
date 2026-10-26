// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A mail-started turn, from a mail read: what it carries within the
 * budget, the agent's message, and the ids it covered. Pure: it makes no
 * call and reads no clock. Not a package subpath: `mail.ts` gives it.
 */

import { createHash } from 'node:crypto';

import { cutText } from './mail-text.js';
import type { MailAttachment, MailMessage, MailPerson, MailTurn, MailTurnInput } from './mail.js';

/**
 * A run's reply mark, which each reply the run sends carries in
 * `X-Reply-Ref`: lowercase hex, the first 32 characters of SHA-256 over
 * `reply-ref:v1:` and the run id. A hash, so the header never shows the
 * run's id.
 */
export function replyRefOf(runId: string): string {
  return createHash('sha256').update(`reply-ref:v1:${runId}`).digest('hex').slice(0, 32);
}

/**
 * The turn a read makes. It carries the thread's mail up to and including
 * the new mail: on a new conversation all of it, on a linked one what
 * the conversation wasn't given. Mail newer than the new mail waits for
 * its own fire. The mailbox's sent mail with the mark of one of
 * `runIds` is the agent's own reply, already in the conversation: it's
 * dropped, and covered.
 *
 * Within `turnChars` of mail text, it takes the new mail, then the first
 * mail it carries (cut to what's left when it doesn't fit), then the
 * rest newest first, and leaves out what doesn't fit. On a new
 * conversation, the mails the read didn't take count as left out too.
 */
export function mailTurn(input: MailTurnInput): MailTurn {
  const { read, given, budget } = input;
  const at = read.thread.findIndex((m) => m.id === read.mail.id);
  if (at === -1) throw new Error("The read's thread doesn't hold its mail.");
  const before = read.thread.slice(0, at);
  const marks = new Set(input.runIds.map(replyRefOf));
  const own = (m: MailMessage): boolean =>
    m.sent === true && m.replyRef !== undefined && marks.has(m.replyRef);
  const carried = before.filter((m) => !given.has(m.id) && !own(m));

  let left = budget.turnChars;
  const mail = fit(read.mail, left);
  left -= mail.body.length;
  const [firstMail, ...rest] = carried;
  const first = firstMail !== undefined && left > 0 ? fit(firstMail, left) : undefined;
  left -= first?.body.length ?? 0;
  const newest: MailMessage[] = [];
  for (const m of rest.reverse()) {
    if (m.body.length > left) break;
    newest.push(m);
    left -= m.body.length;
  }
  const thread = [...(first === undefined ? [] : [first]), ...newest.reverse()];
  const leftOut =
    carried.length - thread.length + (input.conversation === 'new' ? read.notRead : 0);

  return {
    text: turnText(input, mail, thread, leftOut, first !== undefined),
    input: { mail, thread, leftOut },
    covered: read.thread
      .slice(0, at + 1)
      .filter((m) => !given.has(m.id))
      .map((m) => m.id),
  };
}

/** The mail, its body cut to `chars` when it's longer. */
function fit(m: MailMessage, chars: number): MailMessage {
  if (m.body.length <= chars) return m;
  return { ...m, body: cutText(m.body, Math.max(chars, 0)).text, bodyCut: true };
}

/** The agent's message: a line on the thread, then each mail, the new one last. */
function turnText(
  input: MailTurnInput,
  mail: MailMessage,
  thread: readonly MailMessage[],
  leftOut: number,
  firstShown: boolean,
): string {
  const subject = threadSubject(input.read.thread[0] ?? mail);
  const shown = thread.length + 1;
  const mails = count(shown + leftOut, input.conversation === 'linked' ? 'new mail' : 'mail');
  const blocks = thread.map((m) => [`--- ${about(m, input.mailbox, subject)}`, ...mailText(m)]);
  // Between the first mail and the rest: what's left out is in between.
  if (leftOut > 0)
    blocks.splice(firstShown ? 1 : 0, 0, [`--- ${count(leftOut, 'mail')} left out ---`]);
  const to = recipients(mail);
  return [
    `Mail thread "${oneLine(subject)}": ${mails}, ${shown} shown, oldest first`,
    ...blocks.flat(),
    `--- NEW, id ${mail.id}: ${about(mail, input.mailbox, subject)}`,
    ...(to === '' ? [] : [to]),
    ...mailText(mail),
  ].join('\n');
}

/** Who a mail is from and when it came, and its subject when it isn't the thread's. */
function about(m: MailMessage, mailbox: string, subject: string): string {
  const mine =
    m.sent === true ||
    (m.from !== undefined && m.from.address.toLowerCase() === mailbox.toLowerCase());
  const from =
    m.from === undefined
      ? '(no sender)'
      : mine
        ? `${oneLine(m.from.address)} (this mailbox)`
        : personText(m.from);
  const when = timeOf(m.receivedAt);
  const own = threadSubject(m);
  const other = sameSubject(own, subject) ? '' : `, subject "${oneLine(own)}"`;
  return `${from}${when === undefined ? '' : `, ${when}`}${other}`;
}

/** The new mail's To, Cc and Reply-To, those it has. */
function recipients(mail: MailMessage): string {
  const parts: [string, readonly MailPerson[]][] = [
    ['To', mail.to],
    ['Cc', mail.cc],
    ['Reply-To', mail.replyTo],
  ];
  return parts
    .filter(([, people]) => people.length > 0)
    .map(([name, people]) => `${name}: ${people.map(personText).join(', ')}`)
    .join(' · ');
}

/**
 * A mail's own text, its lines that would read as this message's own
 * `---` lines set in by a space, then its attachments.
 */
function mailText(m: MailMessage): string[] {
  const body = m.body.trim() === '' ? ['(no text)'] : m.body.split('\n');
  const lines = body.map((line) => (line.startsWith('---') ? ` ${line}` : line));
  if (m.bodyCut) lines.push('[the rest of this mail is cut]');
  if (m.attachments.length > 0) {
    lines.push(`Attachments: ${m.attachments.map(attachmentText).join(', ')}`);
  }
  return lines;
}

function attachmentText(a: MailAttachment): string {
  return `${oneLine(a.name)} (${a.inline === true ? 'inline, ' : ''}${oneLine(a.contentType)}, ${sizeText(a.size)})`;
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function personText(p: MailPerson): string {
  return p.name === undefined ? oneLine(p.address) : `${oneLine(p.name)} <${oneLine(p.address)}>`;
}

/** `2026-10-20 14:03 UTC`, else undefined for a time that isn't one. */
function timeOf(receivedAt: string): string | undefined {
  const ms = Date.parse(receivedAt);
  if (Number.isNaN(ms)) return undefined;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** A mail's subject without the `Re:` and `Fwd:` a reply or forward adds, else `(no subject)`. */
function threadSubject(m: MailMessage): string {
  const subject = m.subject.replace(/^\s*(?:(?:re|fwd?)\s*:\s*)+/i, '').trim();
  return subject === '' ? '(no subject)' : subject;
}

function sameSubject(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').toLowerCase() === b.replace(/\s+/g, ' ').toLowerCase();
}

/** A header's text on one line: a value can hold line breaks. */
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

function count(n: number, what: string): string {
  return `${n} ${what}${n === 1 ? '' : 's'}`;
}
