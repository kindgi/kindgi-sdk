// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A Gmail message's text and attachments, from the MIME parts
 * `users.messages.get` gives with `format=full`
 * (developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages#MessagePart):
 * each part has its `mimeType`, `filename`, `headers`, a `body` whose
 * `data` is the part's content in base64url (or an `attachmentId` when
 * Gmail keeps it apart), and `parts` when it's a `multipart/*` container.
 */

import { receivedAt } from './google-api.js';
import {
  cutText,
  decodeBytes,
  decodeEncodedWords,
  htmlToText,
  isAutoSubmitted,
  parseAddressList,
  trimLinks,
} from './mail-text.js';
import { type MailAttachment, type MailMessage, REPLY_REF_HEADER, isReplyRef } from './mail.js';

/** One MIME part of a Gmail message, as the API gives it. */
export interface GmailPart {
  readonly partId?: string | null;
  readonly mimeType?: string | null;
  readonly filename?: string | null;
  readonly headers?: readonly GmailHeader[] | null;
  readonly body?: {
    readonly attachmentId?: string | null;
    readonly size?: number | null;
    readonly data?: string | null;
  } | null;
  readonly parts?: readonly GmailPart[] | null;
}

export interface GmailHeader {
  readonly name?: string | null;
  readonly value?: string | null;
}

/** A message as `users.messages.get` and `users.threads.get` give it: only the fields read here. */
export interface GmailMessage {
  readonly id?: unknown;
  readonly threadId?: unknown;
  readonly labelIds?: readonly unknown[] | null;
  readonly snippet?: unknown;
  /** When Gmail received it, in milliseconds since the epoch, as a string. */
  readonly internalDate?: unknown;
  readonly payload?: GmailPart | null;
}

/**
 * A message read with `format=full`, its body cut at `chars`. Header
 * values are decoded from RFC 2047 encoded words, which leaves one Gmail
 * has decoded already as it is.
 */
export function gmailMessage(raw: GmailMessage, chars: number): MailMessage {
  const payload = raw.payload ?? {};
  const header = (name: string): string => gmailHeader(payload, name) ?? '';
  const from = parseAddressList(header('From'))[0];
  const { text, attachments } = gmailBody(payload);
  const body = cutText(trimLinks(text), chars);
  const replyRef = replyRefOf(payload);
  const sent = (Array.isArray(raw.labelIds) ? raw.labelIds : []).includes('SENT');
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    ...(typeof raw.threadId === 'string' && raw.threadId !== '' && { threadId: raw.threadId }),
    ...(from !== undefined && { from }),
    to: parseAddressList(header('To')),
    cc: parseAddressList(header('Cc')),
    replyTo: parseAddressList(header('Reply-To')),
    subject: decodeEncodedWords(header('Subject')),
    receivedAt: receivedAt(raw.internalDate),
    body: body.text,
    bodyCut: body.cut,
    attachments,
    autoSubmitted: isAutoSubmitted(gmailHeader(payload, 'Auto-Submitted')),
    ...(replyRef !== undefined && { replyRef }),
    ...(sent && { sent: true }),
  };
}

/** The message's reply mark: its one `X-Reply-Ref` header, in a mark's form. */
function replyRefOf(payload: GmailPart): string | undefined {
  const wanted = REPLY_REF_HEADER.toLowerCase();
  const values = (payload.headers ?? []).filter((h) => h.name?.toLowerCase() === wanted);
  const value = values.length === 1 ? values[0]?.value?.trim() : undefined;
  return value !== undefined && isReplyRef(value) ? value : undefined;
}

/** What a text part Gmail keeps apart (with an `attachmentId`, no `data`) reads as. */
export const PART_NOT_READ = '[Part of this message’s text is too long to read here.]';

/**
 * The message's text and its attachments.
 *
 * - **Text:** in a `multipart/alternative`, the `text/plain` choice, else
 *   the first other one (`text/html` as plain text); in a
 *   `multipart/related`, its first part; in any other `multipart/*`, each
 *   part's text in order, a blank line between. A blank plain choice
 *   gives way to one with text. A part with a file name, or
 *   `Content-Disposition: attachment`, is an attachment, never text.
 * - **Charset:** each part's `Content-Type` charset, else UTF-8.
 * - **Attachments:** every attachment part, at any depth, and every other
 *   part that isn't text: an image pasted into the mail, say, with no
 *   name. One shown in the body is marked `inline`. An attached message
 *   (`message/rfc822`) is one attachment; what's inside isn't read.
 * - **A `multipart/alternative`'s other choices:** one that's the body in
 *   another form (`text/x-amp-html`, `text/watch-html`) is neither text
 *   nor an attachment. An invite's `text/calendar` choice without a name
 *   is listed, unless the mail attaches a calendar file too: an invite is
 *   listed once.
 */
export function gmailBody(payload: GmailPart): {
  readonly text: string;
  readonly attachments: readonly MailAttachment[];
} {
  const attachments: MailAttachment[] = [];
  const invites = new Set<MailAttachment>();
  collectAttachments(payload, attachments, invites);
  const fileToo = attachments.some((a) => !invites.has(a) && CALENDAR_FILES.has(a.contentType));
  return {
    text: textOf(payload)?.text ?? '',
    attachments: fileToo ? attachments.filter((a) => !invites.has(a)) : attachments,
  };
}

/** The body in another form, beside the plain and HTML choices. */
const BODY_FORMS = new Set(['text/x-amp-html', 'text/watch-html']);
/** An invite as a file. */
const CALENDAR_FILES = new Set(['text/calendar', 'application/ics']);

/** A header's value, by name in any case: the first one. */
export function gmailHeader(part: GmailPart, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const value = part.headers?.find((h) => h.name?.toLowerCase() === wanted)?.value;
  return typeof value === 'string' ? value : undefined;
}

interface PartText {
  readonly text: string;
  readonly html: boolean;
}

function textOf(part: GmailPart): PartText | undefined {
  if (isAttachment(part)) return undefined;
  const type = mimeTypeOf(part);
  if (type === 'text/plain' || type === 'text/html') {
    const content = contentOf(part);
    return {
      text: type === 'text/html' ? htmlToText(content) : content,
      html: type === 'text/html',
    };
  }
  if (!type.startsWith('multipart/')) return undefined;
  const texts = (part.parts ?? []).map(textOf).filter((t): t is PartText => t !== undefined);
  if (type === 'multipart/alternative') {
    // Some mailers send a blank plain choice beside the HTML that has the text.
    return (
      texts.find((t) => !t.html && t.text.trim() !== '') ??
      texts.find((t) => t.text.trim() !== '') ??
      texts[0]
    );
  }
  if (type === 'multipart/related') return texts[0];
  if (texts.length === 0) return undefined;
  return {
    text: texts
      .map((t) => t.text.trim())
      .filter((t) => t !== '')
      .join('\n\n'),
    html: texts.every((t) => t.html),
  };
}

/**
 * The attachments under `part`, `parent` its container's type. Each
 * nameless `text/calendar` choice of an alternative goes in `invites` too.
 */
function collectAttachments(
  part: GmailPart,
  into: MailAttachment[],
  invites: Set<MailAttachment>,
  parent = '',
): void {
  const type = mimeTypeOf(part);
  const choice = parent === 'multipart/alternative';
  if (choice && BODY_FORMS.has(type)) return;
  if (isAttachment(part)) {
    const name = decodeEncodedWords(part.filename ?? '').trim();
    const attachment = attachmentOf(part, name, parent === 'multipart/related');
    into.push(attachment);
    if (choice && type === 'text/calendar' && name === '') invites.add(attachment);
    return;
  }
  for (const child of part.parts ?? []) collectAttachments(child, into, invites, type);
}

function attachmentOf(part: GmailPart, name: string, inRelated: boolean): MailAttachment {
  const type = mimeTypeOf(part);
  return {
    name: name !== '' ? name : type === 'message/rfc822' ? 'message.eml' : 'attachment',
    contentType: type !== '' ? type : 'application/octet-stream',
    size: typeof part.body?.size === 'number' ? part.body.size : 0,
    ...(isInline(part, inRelated) && { inline: true }),
  };
}

function isAttachment(part: GmailPart): boolean {
  if ((part.filename ?? '') !== '') return true;
  const type = mimeTypeOf(part);
  // Not text, and not a container: an image, a calendar invite, an attached message.
  if (type !== 'text/plain' && type !== 'text/html' && !type.startsWith('multipart/')) return true;
  const disposition = gmailHeader(part, 'Content-Disposition');
  return disposition !== undefined && /^\s*attachment\b/i.test(disposition);
}

/**
 * Shown in the body, not attached: as its `Content-Disposition` says, else
 * a part of a `multipart/related` that its HTML refers to by `Content-ID`.
 */
function isInline(part: GmailPart, inRelated: boolean): boolean {
  const disposition = gmailHeader(part, 'Content-Disposition');
  if (disposition !== undefined) return /^\s*inline\b/i.test(disposition);
  return inRelated && gmailHeader(part, 'Content-ID') !== undefined;
}

function mimeTypeOf(part: GmailPart): string {
  return (part.mimeType ?? '').trim().toLowerCase();
}

/** A text part's content, decoded from base64url in its charset. */
function contentOf(part: GmailPart): string {
  const data = part.body?.data;
  if (typeof data !== 'string') {
    return typeof part.body?.attachmentId === 'string' ? PART_NOT_READ : '';
  }
  // Gmail sends base64url; the decoder takes standard base64 too.
  return decodeBytes(Buffer.from(data, 'base64url'), charsetOf(part));
}

/** The `charset` parameter of a part's `Content-Type`, quoted or not. */
function charsetOf(part: GmailPart): string | undefined {
  const type = gmailHeader(part, 'Content-Type');
  return type === undefined ? undefined : /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(type)?.[1];
}
