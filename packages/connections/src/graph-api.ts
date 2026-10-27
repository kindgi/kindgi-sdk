// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Microsoft Graph's mail API as the Outlook tools and mail functions call
 * it: its address, a GET's answer, Microsoft's errors in its own words,
 * and a message as a `MailMessage`. Not a package subpath.
 */

import { AppRefused, type AppSend } from './app-request.js';
import {
  type MailTextUse,
  clippedPerson,
  cutText,
  htmlToText,
  isAutoSubmitted,
  listedAttachments,
  listedRecipients,
  trimLinks,
} from './mail-text.js';
import type { MailAttachment, MailMessage, MailPerson } from './mail.js';
import { microsoft } from './microsoft.js';

export const GRAPH = 'https://graph.microsoft.com/v1.0';
/** Ids that stay the same when a message moves to another folder, as a sent one does. */
export const IMMUTABLE_IDS = 'IdType="ImmutableId"';
/** A message's `body` and `uniqueBody` as text, not HTML. */
export const AS_TEXT = 'outlook.body-content-type="text"';
/** Ids of messages, folders and conversations, and the well-known folder names (`inbox`). */
export const GRAPH_ID = /^[A-Za-z0-9=_-]{1,512}$/;

/** What a message is read with: all a `MailMessage` needs but its body. */
export const MESSAGE_FIELDS =
  'id,conversationId,subject,from,toRecipients,ccRecipients,replyTo,receivedDateTime,internetMessageHeaders';
/** Its attachments' names, types and sizes, never their content. */
export const ATTACHMENTS = 'attachments($select=name,contentType,size,isInline)';

/** Graph found nothing at the path: a message deleted, or a folder that isn't there. */
export class GraphNotFound extends AppRefused {}

/**
 * A GET in the mailbox, its JSON answer, or an error in Microsoft's words.
 * `toolId` is the operation's own name (`outlook.messages.list`), whatever
 * id the pack gave the tool: the entry's rate limits charge by it.
 */
export async function graphJson(
  send: AppSend,
  toolId: string,
  url: string,
  prefer: string,
): Promise<unknown> {
  const res = await send({
    entry: microsoft,
    connection: 'mail',
    toolId,
    url,
    headers: { prefer },
  });
  if (res.ok) return res.json();
  throw graphRefusal(res.status, graphErrorOf(await res.text(), res.status), url);
}

/** Graph's refusal of a call to `url`: a 404 as `GraphNotFound`. */
export function graphRefusal(
  status: number,
  error: { readonly code?: string; readonly says: string },
  url: string,
): AppRefused {
  if (status === 404) {
    const path = new URL(url).pathname.replace(/^\/v1\.0/, '');
    return new GraphNotFound(
      404,
      error.code,
      `Outlook found nothing at ${path} in the mailbox. (${error.says})`,
    );
  }
  return new AppRefused(
    status,
    error.code,
    `Outlook refused the call (HTTP ${status}): ${error.says}`,
  );
}

/** What Microsoft's error says (its code and message), else the HTTP status. */
export async function graphSays(res: Response): Promise<string> {
  return graphErrorOf(await res.text(), res.status).says;
}

/** An error answer's code, and what it says (its code and message, else the HTTP status). */
export function graphErrorOf(
  text: string,
  status: number,
): { readonly code?: string; readonly says: string } {
  try {
    const e = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown } }).error;
    const code = typeof e?.code === 'string' ? e.code : undefined;
    if (typeof e?.message === 'string') {
      return {
        ...(code !== undefined && { code }),
        says: code !== undefined ? `${code}: ${e.message}` : e.message,
      };
    }
    if (code !== undefined) return { code, says: code };
  } catch {
    // Not JSON: the status says enough.
  }
  return { says: `HTTP ${status}` };
}

/** OData's query options, their `$` names as they are and their values encoded. */
export function query(options: Readonly<Record<string, string>>): string {
  return Object.entries(options)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('&');
}

export interface RawAddress {
  readonly emailAddress?: { readonly address?: unknown; readonly name?: unknown } | null;
}

/** A message as Graph gives it: only the fields read here. */
export interface RawMessage {
  readonly id: string;
  readonly subject?: string | null;
  readonly from?: RawAddress | null;
  readonly toRecipients?: readonly RawAddress[] | null;
  readonly ccRecipients?: readonly RawAddress[] | null;
  readonly replyTo?: readonly RawAddress[] | null;
  readonly receivedDateTime?: string | null;
  readonly bodyPreview?: string | null;
  readonly isRead?: boolean | null;
  readonly isDraft?: boolean | null;
  readonly parentFolderId?: string | null;
  readonly body?: RawBody | null;
  readonly uniqueBody?: RawBody | null;
  readonly conversationId?: string | null;
  readonly internetMessageHeaders?:
    | readonly ({ readonly name?: unknown; readonly value?: unknown } | null)[]
    | null;
  readonly attachments?: readonly (RawAttachment | null)[] | null;
}

interface RawBody {
  /** `text` when Graph took the `Prefer`, else `html`. */
  readonly contentType?: string | null;
  readonly content?: string | null;
}

interface RawAttachment {
  readonly '@odata.type'?: unknown;
  readonly name?: unknown;
  readonly contentType?: unknown;
  readonly size?: unknown;
  readonly isInline?: unknown;
}

export function person(raw: RawAddress | null | undefined): MailPerson | undefined {
  const address = raw?.emailAddress?.address;
  if (typeof address !== 'string' || address === '') return undefined;
  const name = raw?.emailAddress?.name;
  return { address, ...(typeof name === 'string' && name !== '' && { name }) };
}

export function people(raw: readonly RawAddress[] | null | undefined): MailPerson[] {
  return (raw ?? []).map(person).filter((p): p is MailPerson => p !== undefined);
}

/**
 * A message as a `MailMessage`, its body cut at `chars`: its `body`, or
 * its `uniqueBody` (what it added to its thread), its links as `use`
 * gives them. A body Graph gives as HTML, not taking the `Prefer`, is
 * turned into text.
 */
export function outlookMessage(
  raw: RawMessage,
  chars: number,
  which: 'body' | 'uniqueBody',
  use: MailTextUse,
): MailMessage {
  const from = person(raw.from);
  const content = raw[which];
  const text =
    content?.contentType?.toLowerCase() === 'html'
      ? htmlToText(content.content ?? '')
      : (content?.content ?? '');
  const body = cutText(trimLinks(text, use), chars);
  const listed = listedAttachments(attachmentsOf(raw));
  return {
    id: raw.id,
    ...(typeof raw.conversationId === 'string' &&
      raw.conversationId !== '' && { threadId: raw.conversationId }),
    ...(from !== undefined && { from: clippedPerson(from) }),
    ...listedRecipients(people(raw.toRecipients), people(raw.ccRecipients), people(raw.replyTo)),
    subject: raw.subject ?? '',
    receivedAt: raw.receivedDateTime ?? '',
    body: body.text,
    bodyCut: body.cut,
    attachments: listed.attachments,
    ...(listed.leftOut > 0 && { attachmentsLeftOut: listed.leftOut }),
    autoSubmitted: isAutoSubmitted(headerOf(raw, 'auto-submitted')),
  };
}

/**
 * The message's attachments, one shown in the body (an image in the HTML)
 * marked `inline`. An attached message (`itemAttachment`) has no type of
 * its own.
 */
function attachmentsOf(raw: RawMessage): MailAttachment[] {
  return (raw.attachments ?? [])
    .filter((a): a is RawAttachment => a !== null)
    .map((a) => {
      const item = a['@odata.type'] === '#microsoft.graph.itemAttachment';
      return {
        name: typeof a.name === 'string' && a.name !== '' ? a.name : 'attachment',
        contentType:
          typeof a.contentType === 'string' && a.contentType !== ''
            ? a.contentType
            : item
              ? 'message/rfc822'
              : 'application/octet-stream',
        size: typeof a.size === 'number' && a.size >= 0 ? a.size : 0,
        ...(a.isInline === true && { inline: true }),
      };
    });
}

/**
 * A header's value by its lower-case name, from `internetMessageHeaders`.
 * Graph gives them for mail that came from outside the organization;
 * mail sent within it may have none.
 */
function headerOf(raw: RawMessage, name: string): string | undefined {
  const value = raw.internetMessageHeaders?.find(
    (h) => typeof h?.name === 'string' && h.name.toLowerCase() === name,
  )?.value;
  return typeof value === 'string' ? value : undefined;
}
