// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import {
  LEFT_OUT,
  ThreadLines,
  cutQuote,
  cutText,
  decodeBytes,
  decodeEncodedWords,
  htmlToText,
  isAutoSubmitted,
  parseAddressList,
  trimLinks,
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

describe('trimLinks', () => {
  it("cleans each web address in plain text, a sentence's punctuation left after it", () => {
    for (const use of ['tool', 'turn'] as const) {
      expect(
        trimLinks(
          'Track it at https://acme.example/t/1042?utm_source=mail&id=9. Or see (https://acme.example/faq?fbclid=Zx1)!',
          use,
        ),
      ).toBe('Track it at https://acme.example/t/1042?id=9. Or see (https://acme.example/faq)!');
    }
  });

  it("keeps a site's own parameters as written, and a name no tracker owns alone", () => {
    for (const use of ['tool', 'turn'] as const) {
      expect(trimLinks('https://carrier.example/track?trk=1Z999AA10123456784&lang=en', use)).toBe(
        'https://carrier.example/track?trk=1Z999AA10123456784&lang=en',
      );
      expect(trimLinks('https://acme.example/s?q=a%20b&utm_source=n&p=x/y:z~1', use)).toBe(
        'https://acme.example/s?q=a%20b&p=x/y:z~1',
      );
      expect(trimLinks('https://acme.example/?utm%5Fsource=n&a=1', use)).toBe(
        'https://acme.example/?a=1',
      );
    }
  });

  it("cuts a mail turn's address over 100 characters to its host and the start of its path", () => {
    const redirect = `https://click.mail.acme.example/ls/click?upn=${'u001.Xk9'.repeat(20)}`;
    expect(trimLinks(`Unsubscribe: ${redirect}`, 'turn')).toBe(
      'Unsubscribe: https://click.mail.acme.example/ls/click?…',
    );
    const hundred = `https://acme.example/r/${'a'.repeat(77)}`;
    expect(hundred).toHaveLength(100);
    expect(trimLinks(`${hundred}?utm_source=mail`, 'turn')).toBe(hundred);
    expect(trimLinks(`${hundred}b`, 'turn')).toBe(`https://acme.example/r/${'a'.repeat(37)}…`);
  });

  it("keeps a read tool's long address whole, without its tracking", () => {
    const long = `https://share.acme.example/s/${'k'.repeat(60)}/invoice.pdf?rlkey=${'z'.repeat(30)}`;
    expect(long.length).toBeGreaterThan(100);
    expect(trimLinks(`The invoice: ${long}&utm_source=mail.`, 'tool')).toBe(
      `The invoice: ${long}.`,
    );
  });

  it('leaves other text, and an address already cut, as they are', () => {
    for (const use of ['tool', 'turn'] as const) {
      expect(trimLinks('http is a protocol; mailto:support@acme.example', use)).toBe(
        'http is a protocol; mailto:support@acme.example',
      );
      expect(trimLinks('See <https://click.mail.acme.example/ls/click?…>', use)).toBe(
        'See <https://click.mail.acme.example/ls/click?…>',
      );
    }
  });

  it('stays linear on an address that is mostly punctuation', () => {
    expect(trimLinks(`https://acme.example/${'.'.repeat(200_000)}x`, 'turn')).toBe(
      `https://acme.example/${'.'.repeat(39)}…`,
    );
    expect(trimLinks(`https://acme.example/x${'.'.repeat(200_000)}`, 'turn')).toBe(
      `https://acme.example/x${'.'.repeat(200_000)}`,
    );
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

  it("quotes a blockquote's last line too when the quote ends on it", () => {
    expect(htmlToText('<p>Yes.</p><blockquote>Can you come?<br>On Thursday?</blockquote>')).toBe(
      'Yes.\n\n> Can you come?\n> On Thursday?',
    );
  });

  it("shows a link's target when its text holds the address only inside other words", () => {
    expect(
      htmlToText('<a href="https://evil.example/">bank.example/login?ref=evil.example</a>'),
    ).toBe('bank.example/login?ref=evil.example <https://evil.example/>');
    expect(htmlToText('<a href="https://acme.example/faq">see evilacme.example/faq</a>')).toBe(
      'see evilacme.example/faq <https://acme.example/faq>',
    );
    expect(htmlToText('<p>Visit <a href="https://acme.example/">acme.example</a>.</p>')).toBe(
      'Visit acme.example.',
    );
    expect(htmlToText('<a href="https://acme.example/">Visit acme.example, today</a>')).toBe(
      'Visit acme.example, today',
    );
  });

  it("shows a link's target when its text runs on past the address into a host of its own", () => {
    for (const shown of [
      'evil.example.bank.example',
      'evil.example.bank.example/login',
      'https://evil.example.bank.example',
      'evil.example:8443',
    ]) {
      expect(htmlToText(`<a href="https://evil.example/">${shown}</a>`)).toBe(
        `${shown} <https://evil.example/>`,
      );
    }
    expect(htmlToText('<a href="https://evil.example/">Visit evil.example.</a>')).toBe(
      'Visit evil.example.',
    );
    expect(htmlToText('<a href="https://evil.example/">evil.example?! Yes.</a>')).toBe(
      'evil.example?! Yes.',
    );
  });

  it("compares a link's text with its address in any case, and each dot only as a dot", () => {
    // The address lowercases the host; the text keeps the case it was written in.
    expect(htmlToText('<a href="https://evil.example/">EVIL.Example</a>')).toBe('EVIL.Example');
    // A dot in the address matches only a dot, not any character.
    expect(htmlToText('<a href="https://p.ypal.example/">paypal.example</a>')).toBe(
      'paypal.example <https://p.ypal.example/>',
    );
  });

  it("drops what shows as nothing from a link's text before it looks for the address", () => {
    for (const [html, shown] of [
      ['evil.example&#xFEFF;.bank.example', 'evil.example\ufeff.bank.example'],
      ['evil.example\ufeff.bank.example', 'evil.example\ufeff.bank.example'],
      ['evil.example.\ufeffbank.example', 'evil.example.\ufeffbank.example'],
      ['evil.example\u200b.bank.example', 'evil.example\u200b.bank.example'],
    ]) {
      expect(htmlToText(`<a href="https://evil.example/">${html}</a>`)).toBe(
        `${shown} <https://evil.example/>`,
      );
    }
    // A space that shows as one still parts the address from the next word.
    for (const space of ['\u00a0', '\u200a']) {
      expect(htmlToText(`<a href="https://evil.example/">Visit${space}evil.example</a>`)).toBe(
        `Visit${space}evil.example`,
      );
    }
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

  it("keeps a long link's address whole, for a mail turn's trimLinks to cut", () => {
    const redirect = `https://click.mail.acme.example/ls/click?upn=${'u001.Xk9'.repeat(20)}`;
    const text = htmlToText(`<a href="${redirect}&amp;utm_source=mail">Track the parcel</a>`);
    expect(text).toBe(`Track the parcel <${redirect}>`);
    expect(trimLinks(text, 'turn')).toBe(
      'Track the parcel <https://click.mail.acme.example/ls/click?…>',
    );
    const deep = `https://acme.example/${'account/'.repeat(10)}orders`;
    expect(trimLinks(htmlToText(`<a href="${deep}?ref=7">Your account</a>`), 'turn')).toBe(
      `Your account <https://acme.example/${'account/'.repeat(5).slice(0, 39)}…?…>`,
    );
  });

  it("keeps a link's text and no address when the link is left open", () => {
    expect(htmlToText('<a href="https://acme.example/x">the order')).toBe('the order');
  });

  it('marks each quoted line with "> ", one per level, and leaves a blank quoted line blank', () => {
    const html = `<div dir="ltr"><p>Yes, Thursday works.</p></div>
      <div class="gmail_quote"><div>On Mon, 20 Oct 2026 at 14:03, Acme Support &lt;support@acme.example&gt; wrote:</div>
      <blockquote class="gmail_quote" style="margin:0 0 0 .8ex"><p>Can you come on Thursday?</p><p>&nbsp;</p>
      <blockquote type="cite"><p>The order is late.</p></blockquote><p>Best, Acme</p></blockquote></div>`;
    expect(htmlToText(html)).toBe(
      [
        'Yes, Thursday works.',
        '',
        'On Mon, 20 Oct 2026 at 14:03, Acme Support <support@acme.example> wrote:',
        '',
        '> Can you come on Thursday?',
        '',
        '> > The order is late.',
        '',
        '> Best, Acme',
      ].join('\n'),
    );
  });

  it('marks quotes by the tags alone: never by a character reference, never past 8 levels', () => {
    expect(htmlToText('a&#1;b<br>&#2;c<br>\u0001d')).toBe('a\u0001b\n\u0002c\nd');
    const deep = htmlToText(`${'<blockquote>x'.repeat(50_000)}`);
    expect(deep.split('\n').at(-1)).toBe(`${'> '.repeat(8)}x`);
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

describe('cutQuote', () => {
  const asked = 'Can you come on Thursday?\n\nAcme Support';
  const block = [
    'From: Acme Support <support@acme.example>',
    'Sent: Monday, October 20, 2026 2:03 PM',
    'To: Ann Lee <ann@example.com>',
    'Subject: Your visit',
  ].join('\n');

  function earlierMails(...mails: string[]): ThreadLines {
    const lines = new ThreadLines();
    for (const mail of mails) lines.add(mail);
    return lines;
  }

  it.each([
    [
      "Gmail's",
      'Yes, Thursday works.\n\nOn Mon, 20 Oct 2026 at 14:03, Acme Support <support@acme.example> wrote:\n\n> Can you come on Thursday?\n>\n> Acme Support\n',
      'Yes, Thursday works.',
    ],
    [
      "Gmail's, wrapped in two lines",
      'Yes, Thursday works.\n\nOn Mon, 20 Oct 2026 at 14:03, Acme Support <\nsupport@acme.example> wrote:\n> Can you come on Thursday?',
      'Yes, Thursday works.',
    ],
    [
      "Apple's",
      'Sounds good.\n\nSent from my phone\n\nOn Oct 20, 2026, at 14:03, Acme Support <support@acme.example> wrote:\n\n> Can you come on Thursday?',
      'Sounds good.\n\nSent from my phone',
    ],
    ['a run of `>` lines', 'See below.\n> Can you come on Thursday?\n> Acme Support', 'See below.'],
  ])('cuts %s quote, and says so', (_, text, own) => {
    expect(cutQuote(text, new ThreadLines())).toBe(`${own}\n\n${LEFT_OUT}`);
  });

  it("cuts Outlook's blocks when each line under one is in an earlier mail", () => {
    const earlier = earlierMails(asked);
    expect(
      cutQuote(
        `Yes.\n\n________________________________\n${block}\n\nCan you come  on Thursday?\n\n  Acme Support`,
        earlier,
      ),
    ).toBe(`Yes.\n\n${LEFT_OUT}`);
    expect(cutQuote(`Yes.\n\n-----Original Message-----\n${block}\n\n${asked}`, earlier)).toBe(
      `Yes.\n\n${LEFT_OUT}`,
    );
    expect(cutQuote(`Yes.\n\n${block.replace('Sent:', 'Date:')}\n\n${asked}`, earlier)).toBe(
      `Yes.\n\n${LEFT_OUT}`,
    );
    expect(cutQuote(`Yes.\n\n-----Original Message-----\n${asked}`, earlier)).toBe(
      `Yes.\n\n${LEFT_OUT}`,
    );
  });

  it('keeps From: and Date: lines with no Subject: line: a notice the sender pasted, not a block', () => {
    const notice = 'Your parcel is on its way.\nTracking: 1Z999AA10123456784';
    const text = `This is what the shop sent me:\n\nFrom: Acme Shipping <ship@acme.example>\nDate: Monday, October 20, 2026 2:03 PM\n\n${notice}`;
    expect(cutQuote(text, earlierMails(notice))).toBe(text);
  });

  it('keeps an Outlook block with answers typed into it, or with no earlier mail to check', () => {
    const typed = `See my answers.\n\n${block}\n\nCan you come on Thursday? YES, after 10\n\nAcme Support`;
    expect(cutQuote(typed, earlierMails(asked))).toBe(typed);
    for (const quoted of [
      `Yes.\n\n${block}\n\n${asked}`,
      `Yes.\n\n${block}`,
      `Yes.\n\n${block}\n\n`,
    ]) {
      expect(cutQuote(quoted, new ThreadLines())).toBe(quoted);
    }
    const headless = `Yes.\n\nFrom: Acme Support <support@acme.example>\nTo: Ann Lee <ann@example.com>\n\n${asked}`;
    expect(cutQuote(headless, earlierMails(asked))).toBe(headless);
  });

  it('keeps an inline reply, and cuts only the quote after its last answer', () => {
    const inline =
      'On Mon, 20 Oct 2026 at 14:03, Acme Support <support@acme.example> wrote:\n> Can you come on Thursday?\nYes.\n> Which size?\nLarge.';
    expect(cutQuote(inline, new ThreadLines())).toBe(inline);
    expect(cutQuote(`${inline}\n>\n> Acme Support`, new ThreadLines())).toBe(
      `${inline}\n\n${LEFT_OUT}`,
    );
  });

  it("keeps a forwarded mail, a quote it doesn't know, and a mail the cut would leave empty", () => {
    for (const text of [
      'FYI\n\n---------- Forwarded message ---------\nFrom: Ann Lee <ann@example.com>\nDate: Mon, 20 Oct 2026\nSubject: Order 1042\nTo: support@acme.example\n\nWhere is it?\n> Shipped on Friday.',
      'FYI\n\nBegin forwarded message:\n\n> Shipped on Friday.',
      'Ja.\n\nAm 20.10.2026 um 14:03 schrieb Acme Support:\nKönnen Sie am Donnerstag kommen?',
      'On Mon, 20 Oct 2026 at 14:03, Acme Support <support@acme.example> wrote:\n> Can you come on Thursday?',
      '\n> Can you come on Thursday?\n',
    ]) {
      expect(cutQuote(text, earlierMails(asked))).toBe(text);
    }
  });

  it("cuts an HTML-only mail's quote once it is text, and keeps Gmail's inline answers", () => {
    const attr =
      '<div class="gmail_attr">On Mon, 20 Oct 2026 at 14:03, Acme Support &lt;support@acme.example&gt; wrote:<br></div>';
    const reply = `<div dir="ltr">Yes, Thursday works.</div><br><div class="gmail_quote">${attr}<blockquote class="gmail_quote"><p>Can you come on Thursday?</p><p>Acme Support</p></blockquote></div>`;
    expect(cutQuote(htmlToText(reply), new ThreadLines())).toBe(
      `Yes, Thursday works.\n\n${LEFT_OUT}`,
    );
    const inline = `<div dir="ltr">Answers below.</div><div class="gmail_quote">${attr}<blockquote class="gmail_quote"><p>Can you come on Thursday?</p></blockquote><div>Yes, after 10.</div><blockquote class="gmail_quote"><p>Which size?</p></blockquote><div>Large.</div></div>`;
    const text = htmlToText(inline);
    expect(text).toContain('> Which size?\n\nLarge.');
    expect(cutQuote(text, new ThreadLines())).toBe(text);
  });

  it('stays linear on many lines that each start a quote', () => {
    for (const text of [
      `${'On a wrote:\n'.repeat(100_000)}end`,
      `${'From: a\nSent: b\nTo: c\n'.repeat(100_000)}end`,
      `x${'\n'.repeat(200_000)}${'> a\n'.repeat(100_000)}`,
    ]) {
      expect(cutQuote(text, earlierMails(asked)).length).toBeGreaterThan(0);
    }
  });
});
