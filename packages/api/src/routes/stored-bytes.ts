// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Headers for stored bytes served from the API's own origin, where a
 * browser may also hold a session. Whatever an uploader stored, a browser
 * that opens it never runs it as a page of this origin:
 *
 * - `X-Content-Type-Options: nosniff`: the browser takes the type served
 *   and never guesses another from the bytes.
 * - An attachment (`Content-Disposition`) is saved, not opened.
 * - `Content-Security-Policy: default-src 'none'; sandbox`: a page opened
 *   anyway runs no script, loads nothing, and has an origin of its own.
 *
 * A stored type is served as itself when it's a well-formed media type of
 * at most `TYPE_MAX` characters, else as `application/octet-stream`: an
 * upload may name any type.
 */

const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
/** A type or a subtype name, up to RFC 6838's 127 characters (§4.2). */
const NAME = "[!#$%&'*+.^_`|~0-9A-Za-z-]{1,127}";
const QUOTED = '"(?:[\\t \\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\\t\\x20-\\x7e])*"';
/**
 * `type/subtype`, then `;`-separated parameters (RFC 9110 §8.3.1). Each
 * whitespace run has one place to go: before a `;`, before the parameter
 * after it, or at the end.
 */
const MEDIA_TYPE = new RegExp(
  `^${NAME}/${NAME}(?:[\\t ]*;(?:[\\t ]*${TOKEN}=(?:${TOKEN}|${QUOTED}))?)*[\\t ]*$`,
);
/** The longest stored type served as itself, checked before `MEDIA_TYPE`. */
const TYPE_MAX = 255;

const SANDBOX = "default-src 'none'; sandbox";

/**
 * Types a browser shows without running anything of the page's own. An S3
 * read of one stays inline, so a presigned link to a picture or a PDF opens
 * as one. Not SVG, which is a document that runs script.
 */
const SHOWN_INLINE: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'text/plain',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/mp4',
  'video/mp4',
  'video/webm',
  'video/ogg',
]);

/** The type served for a stored `contentType`. */
function servedType(contentType: string): string {
  const type = contentType.trim();
  return type.length <= TYPE_MAX && MEDIA_TYPE.test(type) ? type : 'application/octet-stream';
}

/**
 * `attachment`, with the name as a quoted ASCII `filename` for any client
 * and in full as a UTF-8 `filename*` for the ones that read it (RFC 6266).
 */
function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["%/\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** A download: the stored bytes, always saved as a file. */
export function savedFileHeaders(meta: {
  readonly contentType: string;
  readonly name: string;
}): Record<string, string> {
  return {
    'Content-Type': servedType(meta.contentType),
    'Content-Disposition': attachment(meta.name),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': SANDBOX,
  };
}

/**
 * An S3 object read: one of a type a browser shows without running it
 * stays inline; any other is a download, as `savedFileHeaders` answers it.
 * Decided on the type served, the one this returns.
 */
export function objectReadHeaders(meta: {
  readonly contentType: string;
  readonly name: string;
}): Record<string, string> {
  const type = servedType(meta.contentType);
  const essence = (type.split(';')[0] as string).trim().toLowerCase();
  if (!SHOWN_INLINE.has(essence)) return savedFileHeaders({ ...meta, contentType: type });
  return { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' };
}
