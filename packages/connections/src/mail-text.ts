// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Mail as text, for every mail app: addresses out of a header, RFC 2047
 * encoded words, a body's bytes in its charset, HTML as plain text, and
 * whether a machine sent the message (RFC 3834's `Auto-Submitted`).
 */

import { TextDecoder } from 'node:util';

/** A mail address and the name shown with it. */
export interface MailAddress {
  readonly address: string;
  readonly name?: string;
}

/**
 * The addresses in a header's value (`From`, `To`, `Cc`, `Reply-To`):
 * `Bo <bo@acme.example>`, `"Doe, Jo" <jo@acme.example>`, `bo@acme.example`,
 * a group (`Team: a@acme.example, b@acme.example;`), or comments
 * (`bo@acme.example (Bo)`). Names are decoded from RFC 2047 encoded words.
 * Anything that isn't an address is left out.
 */
export function parseAddressList(value: string): MailAddress[] {
  const out: MailAddress[] = [];
  for (const item of splitAddresses(value)) {
    const parsed = parseAddress(item);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

/** The header's items, split at the commas and semicolons outside quotes, angle brackets and comments; a group's name is dropped. */
function splitAddresses(value: string): string[] {
  const items: string[] = [];
  let item = '';
  let angled = false;
  for (let i = 0; i < value.length; ) {
    const ch = value.charAt(i);
    const next = endOfToken(value, i);
    if (angled || next > i + 1 || !SEPARATORS.has(ch)) {
      item += value.slice(i, next);
      if (ch === '<') angled = true;
      else if (ch === '>') angled = false;
    } else {
      // A comma or semicolon ends an item; a colon ends a group's name
      // (`Team: a@acme.example, b@acme.example;`), which is dropped.
      if (ch !== ':') items.push(item);
      item = '';
    }
    i = next;
  }
  items.push(item);
  return items;
}

/** Just past the token at `i`: a quoted string, a comment, or one character. */
function endOfToken(value: string, i: number): number {
  const ch = value.charAt(i);
  if (ch === '"') return endOfQuoted(value, i);
  if (ch === '(') return endOfComment(value, i);
  return i + 1;
}

const SEPARATORS: ReadonlySet<string> = new Set([',', ';', ':']);

/** Just past the end of the quoted string starting at `start`, or the text's end. */
function endOfQuoted(value: string, start: number): number {
  for (let i = start + 1; i < value.length; i++) {
    const ch = value.charAt(i);
    if (ch === '\\') i++;
    else if (ch === '"') return i + 1;
  }
  return value.length;
}

/** Just past the end of the comment starting at `start` (comments nest), or the text's end. */
function endOfComment(value: string, start: number): number {
  let depth = 0;
  for (let i = start; i < value.length; i++) {
    const ch = value.charAt(i);
    if (ch === '\\') i++;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i + 1;
  }
  return value.length;
}

function parseAddress(item: string): MailAddress | undefined {
  const open = item.lastIndexOf('<');
  const close = item.lastIndexOf('>');
  if (open !== -1 && close > open) {
    const address = item.slice(open + 1, close).trim();
    if (!isAddress(address)) return undefined;
    const name = displayName(item.slice(0, open));
    return { address, ...(name !== '' && { name }) };
  }
  // A bare address, with any comment as its name (`bo@acme.example (Bo)`).
  const comment = /\(([^()]*)\)/.exec(item)?.[1];
  const address = item.replace(/\([^()]*\)/g, '').trim();
  if (!isAddress(address)) return undefined;
  const name = comment !== undefined ? decodeEncodedWords(comment.trim()) : '';
  return { address, ...(name !== '' && { name }) };
}

function isAddress(value: string): boolean {
  const at = value.lastIndexOf('@');
  return at > 0 && at < value.length - 1 && !/[\s<>()",;]/.test(value);
}

/** A display name: unquoted, unescaped, its encoded words decoded, spaces collapsed. */
function displayName(raw: string): string {
  let name = raw.trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return decodeEncodedWords(name).replace(/\s+/g, ' ').trim();
}

/**
 * Text with its RFC 2047 encoded words decoded (`=?UTF-8?B?…?=`,
 * `=?ISO-8859-1?Q?…?=`); the space between two adjacent words is dropped,
 * as the RFC says. Text without them, a header an app has decoded already
 * included, comes back as it is.
 */
export function decodeEncodedWords(text: string): string {
  if (!text.includes('=?')) return text;
  return (
    text
      .replace(/(\?=)\s+(?==\?)/g, '$1')
      // Bounded, so text full of `=?` without an end stays linear.
      .replace(
        /=\?([^?\s]{1,64})\?([BbQq])\?([^?\s]{0,1024})\?=/g,
        (_word, charset: string, how, data) => {
          const bytes =
            how === 'B' || how === 'b'
              ? Buffer.from(data, 'base64')
              : Buffer.from(
                  data
                    .replace(/_/g, ' ')
                    .replace(/=([0-9A-Fa-f]{2})/g, (_: string, hex: string) =>
                      String.fromCharCode(Number.parseInt(hex, 16)),
                    ),
                  'latin1',
                );
          // RFC 2231 may add a language: `UTF-8*en`.
          return decodeBytes(bytes, charset.split('*')[0]);
        },
      )
  );
}

/**
 * Bytes as text in their charset (any label `TextDecoder` knows), else in
 * UTF-8. Bytes that aren't valid in it become U+FFFD; nothing throws.
 */
export function decodeBytes(bytes: Uint8Array, charset?: string): string {
  const decoder = decoderFor(charset);
  const text = decoder.decode(bytes);
  // Labels such as `iso-8859-1` and `us-ascii` name Windows-1252 too.
  return decoder.encoding === 'windows-1252'
    ? text.replace(/[\u0080-\u009f]/g, (c: string) => CP1252_C1.charAt(c.charCodeAt(0) - 0x80))
    : text;
}

function decoderFor(charset: string | undefined): TextDecoder {
  try {
    return new TextDecoder(charset?.trim() || 'utf-8');
  } catch {
    // A charset no decoder knows: UTF-8 is the likeliest.
    return new TextDecoder('utf-8');
  }
}

/**
 * Windows-1252's characters at 0x80-0x9F (its five unused bytes as they
 * are). Some `TextDecoder`s give these bytes as Latin-1's controls
 * instead, so curly quotes from Outlook would read as controls.
 */
const CP1252_C1 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';

/** Whether a message's `Auto-Submitted` header (RFC 3834) says a machine sent it: present, and anything but `no`. */
export function isAutoSubmitted(value: string | undefined): boolean {
  if (value === undefined) return false;
  return (value.split(';')[0] ?? '').trim().toLowerCase() !== 'no';
}

/** At most `max` characters of `text`, never splitting a character in two, and whether it was cut. */
export function cutText(
  text: string,
  max: number,
): { readonly text: string; readonly cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return { text: text.slice(0, end), cut: true };
}

/** Elements whose content is never text to read. */
const DROPPED = ['head', 'script', 'style', 'title', 'template', 'noscript'] as const;
/** Elements that start or end a line. */
const BLOCKS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tr',
  'ul',
]);
/** The named character references mail commonly uses; any other stays as written. */
const ENTITIES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ndash: '–',
    mdash: '—',
    hellip: '…',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    laquo: '«',
    raquo: '»',
    bull: '•',
    middot: '·',
    copy: '©',
    reg: '®',
    trade: '™',
    euro: '€',
    pound: '£',
    yen: '¥',
    cent: '¢',
    sect: '§',
    deg: '°',
    times: '×',
    divide: '÷',
    zwnj: '',
    zwj: '',
    shy: '',
  }),
);

/**
 * HTML as plain text: what a reader sees, one line per paragraph, list
 * item or table row, with `head`, `script` and `style` content, comments
 * and tags left out, and character references decoded. Links keep their
 * text only. Linear in the input's length.
 */
export function htmlToText(html: string): string {
  let text = withoutComments(html);
  for (const name of DROPPED) text = withoutElement(text, name);
  // Whitespace in HTML is one space, wherever it is.
  text = tagsAsText(text.replace(/[ \t\r\n\f]+/g, ' '));
  return decodeHtmlEntities(text)
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Each tag as the line break or space it makes, else nothing; a `<` that starts no tag stays. */
function tagsAsText(html: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const open = html.indexOf('<', from);
    if (open === -1) return out + html.slice(from);
    out += html.slice(from, open);
    if (!/[A-Za-z/!?]/.test(html.charAt(open + 1))) {
      out += '<';
      from = open + 1;
      continue;
    }
    const close = html.indexOf('>', open + 1);
    // A tag left open runs to the end.
    if (close === -1) return out;
    out += tagAsText(html.slice(open + 1, close));
    from = close + 1;
  }
}

function tagAsText(inner: string): string {
  const m = /^(\/?)\s*([A-Za-z][A-Za-z0-9]*)/.exec(inner);
  if (m === null) return '';
  const tag = (m[2] as string).toLowerCase();
  const end = m[1] === '/';
  if (tag === 'li') return end ? '' : '\n- ';
  if (tag === 'td' || tag === 'th') return end ? '' : ' ';
  return BLOCKS.has(tag) ? '\n' : '';
}

function withoutComments(html: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const start = html.indexOf('<!--', from);
    if (start === -1) return out + html.slice(from);
    out += html.slice(from, start);
    const end = html.indexOf('-->', start + 4);
    if (end === -1) return out;
    from = end + 3;
  }
}

/** `html` without each `<name …>…</name>`, in any case; an element left open runs to the end. */
function withoutElement(html: string, name: string): string {
  const lower = html.toLowerCase();
  let out = '';
  let from = 0;
  for (;;) {
    const start = openingTag(lower, name, from);
    if (start === -1) return out + html.slice(from);
    out += html.slice(from, start);
    const close = lower.indexOf(`</${name}`, start);
    if (close === -1) return out;
    const end = lower.indexOf('>', close);
    if (end === -1) return out;
    from = end + 1;
  }
}

/** Where the next `<name` that is a whole tag name starts, or -1. */
function openingTag(lower: string, name: string, from: number): number {
  for (let i = lower.indexOf(`<${name}`, from); i !== -1; i = lower.indexOf(`<${name}`, i + 1)) {
    const after = lower.charAt(i + name.length + 1);
    if (after === '' || after === '>' || after === '/' || /\s/.test(after)) return i;
  }
  return -1;
}

/** Text with its HTML character references decoded (`&amp;`, `&#39;`, `&#x2713;`); one it doesn't know stays as written. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z]{2,8});/g,
    (ref, body: string) => {
      if (body.startsWith('#')) {
        const code =
          body[1] === 'x' || body[1] === 'X'
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
          ? String.fromCodePoint(code)
          : '�';
      }
      return ENTITIES.get(body) ?? ref;
    },
  );
}
