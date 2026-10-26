// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Mail as text, for every mail app: addresses out of a header, RFC 2047
 * encoded words, a body's bytes in its charset, HTML as plain text, and
 * whether a machine sent the message (RFC 3834's `Auto-Submitted`).
 */

import { TextDecoder } from 'node:util';

import type { MailPerson } from './mail.js';

/**
 * The addresses in a header's value (`From`, `To`, `Cc`, `Reply-To`):
 * `Bo <bo@acme.example>`, `"Doe, Jo" <jo@acme.example>`, `bo@acme.example`,
 * a group (`Team: a@acme.example, b@acme.example;`), or comments
 * (`bo@acme.example (Bo)`). Names are decoded from RFC 2047 encoded words.
 * Anything that isn't an address is left out.
 */
export function parseAddressList(value: string): MailPerson[] {
  const out: MailPerson[] = [];
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

function parseAddress(item: string): MailPerson | undefined {
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

/**
 * Query parameters that only track a click: `utm_*`, and the ones mail
 * and ad platforms add (Mailchimp's `mc_cid`, HubSpot's `_hsenc`, …).
 */
const TRACKING_PARAM =
  /^(?:utm_[a-z_]+|_hsenc|_hsmi|mc_cid|mc_eid|fbclid|gclid|dclid|msclkid|mkt_tok|igshid|yclid|_ga|_gl|vero_id|oly_enc_id|oly_anon_id|sc_cid)$/i;

/**
 * Who a mail's text is for: a person's read tool (`tool`), which keeps
 * each web address whole, or a mail turn (`turn`), where one still over
 * 100 characters is cut. Both lose their tracking parameters.
 */
export type MailTextUse = 'tool' | 'turn';

/** A mail turn's link longer than this, without its tracking, is cut: an opaque redirect, say. */
const LINK_MAX = 100;
/** How much of a cut link's path is kept. */
const PATH_KEPT = 40;

/**
 * A web link without its tracking parameters. Undefined for anything but
 * an `http:` or `https:` URL.
 */
function cleanUrl(href: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  // As text, so the other pairs keep their bytes: `URLSearchParams` would
  // write the whole query again in a form's encoding (`%20` as `+`).
  const pairs = url.search.slice(1).split('&');
  const kept = pairs.filter((pair) => !TRACKING_PARAM.test(paramName(pair)));
  if (kept.length < pairs.length) url.search = kept.join('&');
  return url;
}

/** A query pair's name, decoded as a form's. */
function paramName(pair: string): string {
  const name = pair.split('=', 1)[0] ?? '';
  try {
    return decodeURIComponent(name.replaceAll('+', ' '));
  } catch {
    return name;
  }
}

/**
 * A clean link as `use` gives it: whole, or for a mail turn, when over
 * 100 characters, its scheme, host and the start of its path, `…` for
 * the rest and `?…` for a query.
 */
function linkText(url: URL, use: MailTextUse): string {
  const text = url.toString();
  if (use === 'tool' || text.length <= LINK_MAX) return text;
  const path =
    url.pathname.length > PATH_KEPT ? `${url.pathname.slice(0, PATH_KEPT)}…` : url.pathname;
  return `${url.protocol}//${url.host}${path}${url.search !== '' ? '?…' : ''}`;
}

/**
 * Each web address in a mail's text without its tracking parameters, and
 * for a mail turn, cut when still over 100 characters. A sentence's
 * closing punctuation after one stays outside it, and one already cut
 * (`…`) stays as it is.
 */
export function trimLinks(text: string, use: MailTextUse): string {
  return text.replace(/\bhttps?:\/\/[^\s<>"]+/gi, (match) => {
    let end = match.length;
    while (end > 0 && TRAILING.has(match.charAt(end - 1))) end--;
    const href = match.slice(0, end);
    if (href.includes('…')) return match;
    const url = cleanUrl(href);
    return (url === undefined ? href : linkText(url, use)) + match.slice(end);
  });
}

/** Punctuation that ends a sentence or closes a bracket after an address, not part of it. */
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', ')', ']', "'"]);

/** What a mail turn's text says in place of the earlier mail a quote cut took out. */
export const LEFT_OUT = '[earlier mail left out]';

/**
 * The lines of a thread's mails so far, as the read fetched them, before
 * their own cut: what the quote cut checks an Outlook block against.
 */
export class ThreadLines {
  readonly #lines = new Set<string>();
  #mails = 0;

  /** A mail's text, before its own cut. */
  add(text: string): void {
    this.#mails++;
    for (const line of text.split('\n')) {
      const same = sameLine(line);
      if (same !== '') this.#lines.add(same);
    }
  }

  /** Whether an earlier mail holds the line, trimmed, with its runs of spaces as one. */
  has(line: string): boolean {
    return this.#lines.has(sameLine(line));
  }

  /** How many mails it holds. */
  get mails(): number {
    return this.#mails;
  }
}

function sameLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

/**
 * A mail's own text, without the earlier mail it quotes below it, and
 * {@link LEFT_OUT} where that was. It cuts at the first line that starts
 * a quote running to the end:
 * - an English `On … wrote:` line (Gmail's, Apple's; Gmail may wrap it in
 *   two) with `>` lines after it;
 * - an Outlook block, `-----Original Message-----` or `From:` with `Sent:`
 *   or `Date:` and `Subject:` (and the underscores above it), when every
 *   line under it is in an earlier mail of `earlier`: else a customer may
 *   have typed answers into it;
 * - a run of `>` lines.
 * A `>` line with the sender's own words after it is an inline reply,
 * and stays. A mail that forwards one, or that the cut would leave
 * empty, stays whole. Linear in the text's length.
 */
export function cutQuote(text: string, earlier: ThreadLines): string {
  const lines = text.split('\n');
  if (lines.some((line) => FORWARDED.test(line.trim()))) return text;
  const at = quoteStart(lines, earlier);
  if (at === undefined) return text;
  const kept = lines.slice(0, at).join('\n').trimEnd();
  return kept.trim() === '' ? text : `${kept}\n\n${LEFT_OUT}`;
}

/** Gmail's and Apple's line above a forwarded mail. */
const FORWARDED = /^(?:-{3,} ?Forwarded message ?-{3,}|Begin forwarded message:)$/i;
/** Outlook's line above an older mail's headers. */
const ORIGINAL = /^-{3,} ?Original Message ?-{3,}$/i;
/** An Outlook block's header line, and its name. */
const BLOCK_HEADER = /^(From|Sent|Date|To|Cc|Subject):/;
/** The most header lines an Outlook block has. */
const BLOCK_LINES = 8;
/** The longest `On … wrote:` line taken. */
const ATTRIBUTION_MAX = 500;

/** Where the quote to cut starts, if a line starts one. */
function quoteStart(lines: readonly string[], earlier: ThreadLines): number | undefined {
  const tail = tails(lines, earlier);
  for (let i = 0; i < lines.length; i++) {
    const at = quoteAt(lines, i, tail);
    if (at !== undefined) return at;
  }
  return undefined;
}

interface Tails {
  /** From each line to the end, `>` lines and blank ones, a `>` among them. */
  readonly quoted: readonly boolean[];
  /** From each line to the end, each non-blank line in an earlier mail, with one to check. */
  readonly known: readonly boolean[];
}

function tails(lines: readonly string[], earlier: ThreadLines): Tails {
  const quoted = new Array<boolean>(lines.length + 1).fill(false);
  const known = new Array<boolean>(lines.length + 1).fill(earlier.mails > 0);
  let blank = true;
  let q = false;
  let k = earlier.mails > 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (line !== '') q = line.startsWith('>') && (blank || q);
    blank &&= line === '';
    k &&= line === '' || earlier.has(line);
    quoted[i] = q;
    known[i] = k;
  }
  return { quoted, known };
}

/** Where the quote to cut starts, if one starts at line `i`. */
function quoteAt(lines: readonly string[], i: number, tail: Tails): number | undefined {
  if ((lines[i] ?? '').trim().startsWith('>')) return tail.quoted[i] === true ? i : undefined;
  const after = attributionEnd(lines, i);
  if (after !== undefined && tail.quoted[after] === true) return i;
  const under = outlookBlockEnd(lines, i);
  return under !== undefined && tail.known[under] === true ? withUnderscores(lines, i) : undefined;
}

/** The line after an `On … wrote:` line at `i`, or after the two Gmail wraps it into. */
function attributionEnd(lines: readonly string[], i: number): number | undefined {
  const line = (lines[i] ?? '').trim();
  if (!line.startsWith('On ') || line.length > ATTRIBUTION_MAX) return undefined;
  if (isAttribution(line)) return i + 1;
  const next = lines[i + 1]?.trim();
  return next !== undefined && isAttribution(`${line} ${next}`) ? i + 2 : undefined;
}

function isAttribution(line: string): boolean {
  return line.length <= ATTRIBUTION_MAX && line.startsWith('On ') && line.endsWith(' wrote:');
}

/** The line after an Outlook block's headers at `i`, if one starts there. */
function outlookBlockEnd(lines: readonly string[], i: number): number | undefined {
  const line = (lines[i] ?? '').trim();
  const original = ORIGINAL.test(line);
  if (!original && !line.startsWith('From:')) return undefined;
  const names = new Set<string>();
  let end = original ? i + 1 : i;
  for (; end < lines.length && end <= i + BLOCK_LINES; end++) {
    const name = BLOCK_HEADER.exec((lines[end] ?? '').trim())?.[1];
    if (name === undefined) break;
    names.add(name);
  }
  const headers =
    names.has('From') && (names.has('Sent') || names.has('Date')) && names.has('Subject');
  return original || headers ? end : undefined;
}

/** The block's start, with Outlook's line of underscores above it when there is one. */
function withUnderscores(lines: readonly string[], i: number): number {
  let above = i - 1;
  while (above >= 0 && (lines[above] ?? '').trim() === '') above--;
  return above >= 0 && /^_{10,}$/.test((lines[above] ?? '').trim()) ? above : i;
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
 * and tags left out, and character references decoded. A link to a web
 * page keeps its whole address after its text, `<…>`, without its
 * tracking parameters, unless the text shows it already (a mail turn's
 * {@link trimLinks} cuts a long one); any other link keeps its
 * text only. A line inside a `blockquote` starts with `> `, one for each
 * level up to 8, as a mail client quotes. Linear in the input's length.
 */
export function htmlToText(html: string): string {
  let text = withoutComments(html.replaceAll(QUOTE_START, '').replaceAll(QUOTE_END, ''));
  for (const name of DROPPED) text = withoutElement(text, name);
  // Whitespace in HTML is one space, wherever it is.
  text = tagsAsText(text.replace(/[ \t\r\n\f]+/g, ' '));
  return quotedLines(text)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Where a `blockquote` starts and ends in the text from the tags; neither is left in the HTML. */
const QUOTE_START = '\u0001';
const QUOTE_END = '\u0002';
/** The most `> ` a line is marked with, however deep its quotes go. */
const QUOTE_DEPTH_MAX = 8;

/**
 * The text's lines, tidied, each in a quote marked `> ` per level, and
 * their character references decoded: after the quotes are known, so no
 * reference can open or close one.
 */
function quotedLines(text: string): string[] {
  const lines: string[] = [];
  let depth = 0;
  for (const raw of text.split('\n')) {
    const from = depth;
    depth = depthAfter(raw, depth);
    const marks = '> '.repeat(Math.min(Math.max(from, depth), QUOTE_DEPTH_MAX));
    const own = raw.replaceAll(QUOTE_START, '').replaceAll(QUOTE_END, '');
    for (const piece of decodeHtmlEntities(own).split('\n')) {
      const line = piece.replace(/ {2,}/g, ' ').trim();
      lines.push(line === '' ? '' : `${marks}${line}`);
    }
  }
  return lines;
}

/** How many quotes are open after `line`, `depth` before it. */
function depthAfter(line: string, depth: number): number {
  if (!line.includes(QUOTE_START) && !line.includes(QUOTE_END)) return depth;
  let open = depth;
  for (const c of line) {
    if (c === QUOTE_START) open++;
    else if (c === QUOTE_END && open > 0) open--;
  }
  return open;
}

/** Each tag as the line break or space it makes, else nothing; a `<` that starts no tag stays. */
function tagsAsText(html: string): string {
  let out = '';
  let from = 0;
  let link: OpenLink;
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
    const inner = html.slice(open + 1, close);
    const step = linkTag(inner, out, link);
    if (step === undefined) {
      out += tagAsText(inner);
    } else {
      out += step.add;
      link = step.link;
    }
    from = close + 1;
  }
}

/** An open link: its address, and where its text began in the text so far. */
type OpenLink = { readonly url: string; readonly at: number } | undefined;

/**
 * A link's start or end tag: what it adds to the text so far (`out`), and
 * the link open after it. Undefined for any other tag.
 */
function linkTag(
  inner: string,
  out: string,
  link: OpenLink,
): { readonly add: string; readonly link: OpenLink } | undefined {
  if (/^a(?:\s|$)/i.test(inner)) {
    const url = hrefOf(inner);
    return { add: '', link: url === undefined ? undefined : { url, at: out.length } };
  }
  if (/^\/\s*a\s*$/i.test(inner)) {
    return {
      add: link === undefined ? '' : linkTarget(out.slice(link.at), link.url),
      link: undefined,
    };
  }
  return undefined;
}

/** A link tag's web address, cleaned, else undefined. */
function hrefOf(inner: string): string | undefined {
  const m = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(inner);
  const href = m?.[1] ?? m?.[2] ?? m?.[3];
  return href === undefined ? undefined : cleanUrl(decodeHtmlEntities(href).trim())?.toString();
}

/**
 * ` <url>` after a link's text (still HTML, its references not decoded),
 * unless the text is empty or shows the address already.
 */
function linkTarget(text: string, url: string): string {
  const shown = decodeHtmlEntities(text).replace(/\s+/g, ' ').trim();
  if (shown === '') return '';
  if (showsAddress(shown, url)) return '';
  // Encoded, as the text around it still is: decoding gives the address back.
  return ` &lt;${url.replaceAll('&', '&amp;')}&gt;`;
}

/**
 * Whether a link's text shows its address as a word of its own, with or
 * without the scheme and the closing `/`: at the text's start or after a
 * space, and at its end or before a space or `.,;:!?)`. Text that only
 * holds the address inside another (`bank.example/login?ref=evil.example`)
 * doesn't show it.
 */
function showsAddress(shown: string, url: string): boolean {
  const bare = url
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)(?:https?://)?${bare}/?(?=$|[\\s.,;:!?)])`, 'i').test(shown);
}

function tagAsText(inner: string): string {
  const m = /^(\/?)\s*([A-Za-z][A-Za-z0-9]*)/.exec(inner);
  if (m === null) return '';
  const tag = (m[2] as string).toLowerCase();
  const end = m[1] === '/';
  if (tag === 'li') return end ? '' : '\n- ';
  if (tag === 'blockquote') return end ? `${QUOTE_END}\n` : `\n${QUOTE_START}`;
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
