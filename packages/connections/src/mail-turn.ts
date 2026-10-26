// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A mail-started turn, from a mail read: what it carries within the
 * budget, the agent's message, and the ids it covered. Pure: it makes no
 * call and reads no clock. Not a package subpath: `mail.ts` gives it.
 */

import { createHash } from 'node:crypto';

import { LIST_MAX, NAME_MAX, clipText, cutText } from './mail-text.js';
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
 * Its text stays within `turnChars`, every line counted. It takes the
 * new mail, then the first mail it carries (its text cut to what's left
 * when it doesn't fit), then the rest newest first, and leaves out what
 * doesn't fit. On a new conversation, the mails the read didn't take
 * count as left out too. A mail's lines besides its text are bounded:
 * the first 20 people of each of To, Cc and Reply-To and the first 20
 * attachments, then how many more, and each name or subject cut at 200
 * characters. The new mail always goes in, so only a `turnChars` under
 * its lines (at most about 37,000 characters besides its id) is passed,
 * by them alone.
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
  const subject = threadSubject(read.thread[0] ?? read.mail);
  const newLines = (m: MailMessage): string[] => newMailLines(m, input.mailbox, subject);
  const lines = (m: MailMessage): string[] => mailLines(m, input.mailbox, subject);

  // No count the text gives is above `most`: its count lines at their
  // longest. Room for the left-out line only when something is left out.
  const most = read.thread.length + read.notRead;
  const head = size([threadLine(input, subject, most, most)]);
  const take = (reserved: number) => {
    // The last line has no line break.
    let left = budget.turnChars + 1 - reserved;
    const mail = fit(read.mail, left, newLines) ?? {
      ...read.mail,
      body: '',
      bodyCut: read.mail.bodyCut || read.mail.body !== '',
    };
    left -= size(newLines(mail));
    const [firstMail, ...rest] = carried;
    const first = firstMail === undefined ? undefined : fit(firstMail, left, lines);
    left -= first === undefined ? 0 : size(lines(first));
    const newest: MailMessage[] = [];
    for (const m of rest.reverse()) {
      const chars = size(lines(m));
      if (chars > left) break;
      newest.push(m);
      left -= chars;
    }
    const thread = [...(first === undefined ? [] : [first]), ...newest.reverse()];
    const leftOut =
      carried.length - thread.length + (input.conversation === 'new' ? read.notRead : 0);
    return { mail, first, thread, leftOut };
  };
  const all = take(head);
  const { mail, first, thread, leftOut } =
    all.leftOut === 0 ? all : take(head + size([leftOutLine(most)]));

  const blocks = thread.map(lines);
  // Between the first mail and the rest: what's left out is in between.
  if (leftOut > 0) blocks.splice(first === undefined ? 0 : 1, 0, [leftOutLine(leftOut)]);
  const shown = thread.length + 1;
  return {
    text: [
      threadLine(input, subject, shown + leftOut, shown),
      ...blocks.flat(),
      ...newLines(mail),
    ].join('\n'),
    input: { mail, thread, leftOut },
    covered: read.thread
      .slice(0, at + 1)
      .filter((m) => !given.has(m.id))
      .map((m) => m.id),
  };
}

/**
 * The mail, its text cut so that its lines fit in `room` characters.
 * Undefined when not even one character of its text would.
 */
function fit(
  m: MailMessage,
  room: number,
  lines: (m: MailMessage) => string[],
): MailMessage | undefined {
  let over = size(lines(m)) - room;
  if (over <= 0) return m;
  let chars = m.body.length - over;
  while (chars > 0) {
    const cut: MailMessage = { ...m, body: cutText(m.body, chars).text, bodyCut: true };
    over = size(lines(cut)) - room;
    if (over <= 0) return cut;
    chars -= over;
  }
  return undefined;
}

/** What lines take of the text: each with its line break. */
function size(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0);
}

/** The text's first line: the thread's subject, and how many mails it has and shows. */
function threadLine(input: MailTurnInput, subject: string, mails: number, shown: number): string {
  const what = input.conversation === 'linked' ? 'new mail' : 'mail';
  return `Mail thread "${headerText(subject, NAME_MAX)}": ${count(mails, what)}, ${shown} shown, oldest first`;
}

function leftOutLine(n: number): string {
  return `--- ${count(n, 'mail')} left out ---`;
}

/** An earlier mail's lines: who it's from and when, then its text. */
function mailLines(m: MailMessage, mailbox: string, subject: string): string[] {
  return [`--- ${about(m, mailbox, subject)}`, ...mailText(m)];
}

/** The new mail's lines: its id too, and its To, Cc and Reply-To. */
function newMailLines(m: MailMessage, mailbox: string, subject: string): string[] {
  const to = recipients(m);
  return [
    `--- NEW, id ${m.id}: ${about(m, mailbox, subject)}`,
    ...(to === '' ? [] : [to]),
    ...mailText(m),
  ];
}

/**
 * Who a mail is from and when it came, and its subject when it isn't the
 * thread's. Only the mailbox's sent mail is its own: anyone can send mail
 * from its address.
 */
function about(m: MailMessage, mailbox: string, subject: string): string {
  const from =
    m.from === undefined
      ? '(no sender)'
      : m.sent === true
        ? `${headerText(m.from.address, ADDRESS_MAX)} (this mailbox)`
        : m.from.address.toLowerCase() === mailbox.toLowerCase()
          ? `${personText(m.from)} (this mailbox's address, not its sent mail)`
          : personText(m.from);
  const when = timeOf(m.receivedAt);
  const own = threadSubject(m);
  const other = sameSubject(own, subject) ? '' : `, subject "${headerText(own, NAME_MAX)}"`;
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
    .map(
      ([name, people]) =>
        `${name}: ${listText(people.slice(0, LIST_MAX).map(personText), people.length - LIST_MAX)}`,
    )
    .join(' · ');
}

/**
 * A mail's own text, its lines that would read as this message's own
 * `---` lines set in by a space, then its attachments.
 */
function mailText(m: MailMessage): string[] {
  const empty = m.body.trim() === '';
  const body = empty ? (m.bodyCut ? [] : ['(no text)']) : m.body.split(LINE_BREAK);
  const lines = body.map((line) => (line.startsWith('---') ? ` ${line}` : line));
  if (m.bodyCut) lines.push('[the rest of this mail is cut]');
  const more = Math.max(m.attachments.length - LIST_MAX, 0) + (m.attachmentsLeftOut ?? 0);
  if (m.attachments.length > 0 || more > 0) {
    const listed = m.attachments.slice(0, LIST_MAX).map(attachmentText);
    lines.push(`Attachments: ${listText(listed, more)}`);
  }
  return lines;
}

/** Items, then how many more there are, when there are more. */
function listText(items: readonly string[], more: number): string {
  return [...items, ...(more > 0 ? [`and ${more} more`] : [])].join(', ');
}

function attachmentText(a: MailAttachment): string {
  return `${headerText(a.name, NAME_MAX)} (${a.inline === true ? 'inline, ' : ''}${headerText(a.contentType, NAME_MAX)}, ${sizeText(a.size)})`;
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The longest address shown: no valid one is longer (RFC 5321). */
const ADDRESS_MAX = 254;

function personText(p: MailPerson): string {
  const address = headerText(p.address, ADDRESS_MAX);
  return p.name === undefined ? address : `${headerText(p.name, NAME_MAX)} <${address}>`;
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

/**
 * Every break a reader takes as a new line: CRLF, LF, CR, a vertical tab,
 * a form feed, NEL, and Unicode's line and paragraph separators.
 */
const LINE_BREAK = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/;

/** A header's value on one line, cut at `max` characters: a value can hold line breaks. */
function headerText(text: string, max: number): string {
  return clipText(text.replace(new RegExp(`(?:${LINE_BREAK.source})+`, 'g'), ' '), max);
}

function count(n: number, what: string): string {
  return `${n} ${what}${n === 1 ? '' : 's'}`;
}
