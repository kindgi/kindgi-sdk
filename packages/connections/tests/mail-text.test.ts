// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import {
  cutText,
  decodeBytes,
  decodeEncodedWords,
  htmlToText,
  isAutoSubmitted,
  parseAddressList,
} from '../src/mail-text.js';

describe('parseAddressList', () => {
  it.each([
    ['a bare address', 'bo@acme.example', [{ address: 'bo@acme.example' }]],
    [
      'a name and an address',
      'Bo Lund <bo@acme.example>',
      [{ address: 'bo@acme.example', name: 'Bo Lund' }],
    ],
    [
      'a quoted name with a comma and an escaped quote',
      '"Lund, Bo \\"B\\"" <bo@acme.example>, jo@acme.example',
      [{ address: 'bo@acme.example', name: 'Lund, Bo "B"' }, { address: 'jo@acme.example' }],
    ],
    [
      'an encoded name',
      '=?UTF-8?B?QmrDtnJu?= <bjorn@acme.example>',
      [{ address: 'bjorn@acme.example', name: 'Björn' }],
    ],
    [
      'a group, its name dropped',
      'Support team: a@acme.example, B <b@acme.example>;, c@acme.example',
      [
        { address: 'a@acme.example' },
        { address: 'b@acme.example', name: 'B' },
        { address: 'c@acme.example' },
      ],
    ],
    ['an empty group', 'undisclosed-recipients:;', []],
    [
      'a comment as the name, with a comma in it',
      'bo@acme.example (Bo, at acme)',
      [{ address: 'bo@acme.example', name: 'Bo, at acme' }],
    ],
    ['an angle address without a name', '<bo@acme.example>', [{ address: 'bo@acme.example' }]],
    ['no address at all', 'Bo Lund, , <not an address>', []],
    ['empty', '', []],
  ])('%s', (_name, header, want) => {
    expect(parseAddressList(header)).toEqual(want);
  });
});

describe('decodeEncodedWords', () => {
  it.each([
    ['base64, UTF-8', '=?UTF-8?B?w4RyZW5kZSDinJM=?=', 'Ärende ✓'],
    ['Q, Latin-1, underscores as spaces', '=?ISO-8859-1?Q?R=E9ponse_rapide?=', 'Réponse rapide'],
    ['adjacent words joined', '=?UTF-8?Q?a?= =?UTF-8?Q?b?=', 'ab'],
    ['words among plain text', 'Re: =?UTF-8?Q?caf=C3=A9?= order', 'Re: café order'],
    ['a language after the charset', '=?UTF-8*en?Q?hi?=', 'hi'],
    ['an unknown charset, read as UTF-8', '=?x-acme?Q?caf=C3=A9?=', 'café'],
    ['text an app has decoded already', 'Réponse =? rapide', 'Réponse =? rapide'],
  ])('%s', (_name, text, want) => {
    expect(decodeEncodedWords(text)).toBe(want);
  });

  it('stays linear on text full of unfinished words', () => {
    const text = '=?a'.repeat(100_000);
    expect(decodeEncodedWords(text)).toBe(text);
  });
});

describe('decodeBytes', () => {
  it.each([
    ['UTF-8 when none is named', undefined, [0xc3, 0xa9], 'é'],
    ['Windows-1252', 'windows-1252', [0x93, 0x68, 0x69, 0x94], '“hi”'],
    ['Windows-1252, its first, last and an unused byte', 'cp1252', [0x80, 0x9f, 0x81], '€Ÿ\u0081'],
    ['Latin-1, which names Windows-1252', 'iso-8859-1', [0xe9, 0x92], 'é’'],
    ['Shift JIS', 'Shift_JIS', [0x82, 0xa0], 'あ'],
    ['an unknown charset, as UTF-8', 'x-acme', [0xc3, 0xa9], 'é'],
    ['bytes invalid in it, as U+FFFD', 'utf-8', [0xff], '�'],
  ])('%s', (_name, charset, bytes, want) => {
    expect(decodeBytes(Uint8Array.from(bytes), charset)).toBe(want);
  });
});

describe('isAutoSubmitted', () => {
  it.each([
    [undefined, false],
    ['no', false],
    [' No ; comment', false],
    ['auto-replied', true],
    ['auto-generated', true],
    ['auto-notified; owner-email="a@acme.example"', true],
  ])('%s → %s', (value, want) => {
    expect(isAutoSubmitted(value)).toBe(want);
  });
});

describe('cutText', () => {
  it('keeps text within the limit as it is', () => {
    expect(cutText('hello', 5)).toEqual({ text: 'hello', cut: false });
  });

  it('cuts longer text, never splitting a character', () => {
    expect(cutText('abcdef', 4)).toEqual({ text: 'abcd', cut: true });
    expect(cutText('abc😀def', 4)).toEqual({ text: 'abc', cut: true });
  });
});

describe('htmlToText', () => {
  it('gives a line per paragraph, break, list item and row, and a space per cell', () => {
    const html = `<html><head><title>x</title><style>p { color: red }</style></head>
      <body><p>Hello   Bo,</p><p>Your order<br>is late.</p>
      <ul><li>one</li><li>two</li></ul>
      <table><tr><td>Total</td><td>12&nbsp;EUR</td></tr></table>
      <script>alert(1)</script><!-- a comment <p>hidden</p> --></body></html>`;
    expect(htmlToText(html)).toBe(
      'Hello Bo,\n\nYour order\nis late.\n\n- one\n- two\n\nTotal 12 EUR',
    );
  });

  it('decodes character references, and keeps one it doesn’t know', () => {
    expect(htmlToText('5 &lt; 6 &amp;&amp; &#8364;1 &#x2713; &rsquo; &valueOf; &bogus;')).toBe(
      '5 < 6 && €1 ✓ ’ &valueOf; &bogus;',
    );
  });

  it('keeps a < that starts no tag, and drops a tag left open', () => {
    expect(htmlToText('a < b and c > d')).toBe('a < b and c > d');
    expect(htmlToText('kept <a href="x')).toBe('kept');
  });

  it("keeps a web link's address after its text, without its tracking parameters", () => {
    expect(
      htmlToText(
        '<p>See <a class="btn" href="https://acme.example/orders/1042?utm_source=mail&amp;utm_medium=email&amp;id=7&amp;mc_cid=ab12">your order</a>.</p>',
      ),
    ).toBe('See your order <https://acme.example/orders/1042?id=7>.');
    expect(htmlToText("<a href='https://photos.acme.example/album/ZpQ3'>our photos</a>")).toBe(
      'our photos <https://photos.acme.example/album/ZpQ3>',
    );
    expect(htmlToText('<a href=https://acme.example/faq>FAQ</a>')).toBe(
      'FAQ <https://acme.example/faq>',
    );
  });

  it("keeps a link's text only when it shows the address, has none, or isn't a web link", () => {
    expect(
      htmlToText('<a href="https://acme.example/faq/?utm_campaign=fall">acme.example/faq</a>'),
    ).toBe('acme.example/faq');
    expect(htmlToText('<a href="https://acme.example/">https://acme.example</a>')).toBe(
      'https://acme.example',
    );
    expect(htmlToText('<a href="https://acme.example/p"><img src="cid:logo"></a>')).toBe('');
    expect(htmlToText('<a href="mailto:support@acme.example">write to us</a>')).toBe('write to us');
    expect(htmlToText('<a href="tel:+4640123456">call us</a>')).toBe('call us');
    expect(htmlToText('<a href="javascript:void(0)">open</a>')).toBe('open');
    expect(htmlToText('<a name="top">Top</a>')).toBe('Top');
  });

  it('shortens a link still over 100 characters to its host and the start of its path', () => {
    const redirect = `https://click.mail.acme.example/ls/click?upn=${'u001.Xk9'.repeat(20)}`;
    expect(htmlToText(`<a href="${redirect}">Track the parcel</a>`)).toBe(
      'Track the parcel <https://click.mail.acme.example/ls/click?…>',
    );
    const deep = `https://acme.example/${'account/'.repeat(10)}orders`;
    expect(htmlToText(`<a href="${deep}?ref=7">Your account</a>`)).toBe(
      `Your account <https://acme.example/${'account/'.repeat(5).slice(0, 39)}…?…>`,
    );
  });

  it("keeps a link's text and no address when the link is left open", () => {
    expect(htmlToText('<a href="https://acme.example/x">the order')).toBe('the order');
  });

  it('drops a script with no end tag to the end', () => {
    expect(htmlToText('<p>kept</p><SCRIPT type="x">gone')).toBe('kept');
  });

  it('stays linear on text full of unfinished tags', () => {
    const html = '<a'.repeat(100_000);
    expect(htmlToText(html)).toBe('');
    expect(htmlToText(`${'<!--'.repeat(50_000)}x`)).toBe('');
  });
});
