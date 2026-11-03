// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Gmail's MIME parts as `users.messages.get` with `format=full` gives them
 * (developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages#MessagePart):
 * `mimeType`, `filename`, `headers`, `body.data` in base64url or
 * `body.attachmentId`, and `parts` for a container.
 */

import { describe, expect, it } from 'vitest';

import { type GmailPart, PART_NOT_READ, gmailBody, gmailHeader } from '../src/gmail-mime.js';

/** A text part: its content in `charset` (UTF-8 by default), base64url. */
function text(mimeType: string, content: string | Buffer, charset = 'UTF-8'): GmailPart {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return {
    mimeType,
    filename: '',
    headers: [{ name: 'Content-Type', value: `${mimeType}; charset="${charset}"` }],
    body: { size: bytes.length, data: bytes.toString('base64url') },
  };
}

function multipart(subtype: string, ...parts: GmailPart[]): GmailPart {
  return {
    mimeType: `multipart/${subtype}`,
    filename: '',
    headers: [{ name: 'Content-Type', value: `multipart/${subtype}; boundary="b"` }],
    body: { size: 0 },
    parts,
  };
}

function file(mimeType: string, filename: string, size: number): GmailPart {
  return {
    mimeType,
    filename,
    headers: [{ name: 'Content-Disposition', value: `attachment; filename="${filename}"` }],
    body: { attachmentId: 'ANGjdJ8', size },
  };
}

describe('gmailBody', () => {
  it('reads a message that is one text part', () => {
    expect(gmailBody(text('text/plain', 'Where is order 1042?'))).toEqual({
      text: 'Where is order 1042?',
      attachments: [],
    });
  });

  it('takes the plain text of a plain and HTML alternative', () => {
    const payload = multipart(
      'alternative',
      text('text/plain', 'Plain words'),
      text('text/html', '<p>HTML words</p>'),
    );
    expect(gmailBody(payload).text).toBe('Plain words');
  });

  it('turns HTML into text when there is no plain part', () => {
    expect(gmailBody(text('text/html', '<p>Hi,</p><p>the <b>mug</b> broke.</p>')).text).toBe(
      'Hi,\n\nthe mug broke.',
    );
    expect(
      gmailBody(multipart('alternative', text('text/html', '<div>only HTML</div>'))).text,
    ).toBe('only HTML');
  });

  it('finds the text in nested parts, and lists the attachments, an inline image without a name marked', () => {
    const inlineImage: GmailPart = {
      mimeType: 'image/png',
      filename: '',
      headers: [{ name: 'Content-ID', value: '<logo>' }],
      body: { attachmentId: 'img', size: 900 },
    };
    const payload = multipart(
      'mixed',
      multipart(
        'alternative',
        text('text/plain', 'See the receipt.'),
        multipart('related', text('text/html', '<p>See the receipt.</p>'), inlineImage),
      ),
      file('application/pdf', 'receipt.pdf', 52_113),
    );
    expect(gmailBody(payload)).toEqual({
      text: 'See the receipt.',
      attachments: [
        { name: 'attachment', contentType: 'image/png', size: 900, inline: true },
        { name: 'receipt.pdf', contentType: 'application/pdf', size: 52_113 },
      ],
    });
  });

  it('marks a part inline as its Content-Disposition says, and lists one that is not text', () => {
    const photo: GmailPart = {
      mimeType: 'image/jpeg',
      filename: 'IMG_0412.jpeg',
      headers: [{ name: 'Content-Disposition', value: 'inline; filename="IMG_0412.jpeg"' }],
      body: { attachmentId: 'photo', size: 81_920 },
    };
    const invite: GmailPart = {
      mimeType: 'text/calendar',
      filename: '',
      headers: [{ name: 'Content-Type', value: 'text/calendar; method=REQUEST' }],
      body: { attachmentId: 'ics', size: 1_200 },
    };
    const payload = multipart(
      'mixed',
      multipart('alternative', text('text/plain', 'The mug, broken.'), invite),
      photo,
    );
    expect(gmailBody(payload)).toEqual({
      text: 'The mug, broken.',
      attachments: [
        { name: 'attachment', contentType: 'text/calendar', size: 1_200 },
        { name: 'IMG_0412.jpeg', contentType: 'image/jpeg', size: 81_920, inline: true },
      ],
    });
  });

  it('lists no attachment for the choices that are the body in another form', () => {
    const payload = multipart(
      'alternative',
      text('text/plain', 'Your order shipped.'),
      text('text/x-amp-html', '<!doctype html><html amp4email><body>Track it</body></html>'),
      text('text/watch-html', '<b>Shipped</b>'),
      text('text/html', '<p>Your order shipped.</p>'),
    );
    expect(gmailBody(payload)).toEqual({ text: 'Your order shipped.', attachments: [] });
  });

  /** An invite as a mailer sends it: a `text/calendar` choice beside the text, without a name. */
  const inviteChoice: GmailPart = {
    mimeType: 'text/calendar',
    filename: '',
    headers: [{ name: 'Content-Type', value: 'text/calendar; charset="UTF-8"; method=REQUEST' }],
    body: { size: 1_400, data: Buffer.from('BEGIN:VCALENDAR').toString('base64url') },
  };

  it('lists an invite once when the mail attaches it as a file too', () => {
    const payload = multipart(
      'mixed',
      multipart(
        'alternative',
        text('text/plain', 'Tasting at the roastery, Thursday.'),
        text('text/html', '<p>Tasting at the roastery, Thursday.</p>'),
        inviteChoice,
      ),
      file('application/ics', 'invite.ics', 1_400),
    );
    expect(gmailBody(payload)).toEqual({
      text: 'Tasting at the roastery, Thursday.',
      attachments: [{ name: 'invite.ics', contentType: 'application/ics', size: 1_400 }],
    });
  });

  it('lists a body form that comes as a named part outside an alternative', () => {
    const payload = multipart(
      'mixed',
      text('text/plain', 'Your order shipped.'),
      file('text/watch-html', 'watch.html', 30),
      file('text/x-amp-html', 'order.amp.html', 40),
    );
    expect(gmailBody(payload).attachments).toEqual([
      { name: 'watch.html', contentType: 'text/watch-html', size: 30 },
      { name: 'order.amp.html', contentType: 'text/x-amp-html', size: 40 },
    ]);
  });

  it('lists a named calendar choice beside an attached calendar file: only a nameless choice is the invite', () => {
    const payload = multipart(
      'mixed',
      multipart('alternative', text('text/plain', 'Tasting at the roastery, Thursday.'), {
        ...inviteChoice,
        filename: 'tasting.ics',
      }),
      file('application/ics', 'invite.ics', 1_400),
    );
    expect(gmailBody(payload).attachments).toEqual([
      { name: 'tasting.ics', contentType: 'text/calendar', size: 1_400 },
      { name: 'invite.ics', contentType: 'application/ics', size: 1_400 },
    ]);
  });

  it('lists an invite that is only a choice', () => {
    const payload = multipart(
      'alternative',
      text('text/plain', 'Tasting at the roastery, Thursday.'),
      text('text/html', '<p>Tasting at the roastery, Thursday.</p>'),
      inviteChoice,
    );
    expect(gmailBody(payload).attachments).toEqual([
      { name: 'attachment', contentType: 'text/calendar', size: 1_400 },
    ]);
  });

  it('takes the HTML choice when the plain one is blank', () => {
    const payload = multipart(
      'alternative',
      text('text/plain', ' \r\n'),
      text('text/html', '<p>Order 1042 came <b>broken</b>.</p>'),
    );
    expect(gmailBody(payload).text).toBe('Order 1042 came broken.');
  });

  it('reads an HTML-only message whose related part holds the HTML', () => {
    const payload = multipart(
      'mixed',
      multipart(
        'related',
        text('text/html', '<p>Order <i>1042</i></p>'),
        file('image/png', 'a.png', 5),
      ),
    );
    expect(gmailBody(payload)).toEqual({
      text: 'Order 1042',
      attachments: [{ name: 'a.png', contentType: 'image/png', size: 5 }],
    });
  });

  it('joins the text parts of a mixed message, a blank line between', () => {
    const payload = multipart(
      'mixed',
      text('text/plain', 'First.\n'),
      text('text/plain', 'Second.'),
    );
    expect(gmailBody(payload).text).toBe('First.\n\nSecond.');
  });

  it.each([
    ['ISO-8859-1', Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'café'],
    ['windows-1252', Buffer.from([0x93, 0x6f, 0x6b, 0x94]), '“ok”'],
    ['Shift_JIS', Buffer.from([0x82, 0xa0]), 'あ'],
    ['x-unknown', Buffer.from('café', 'utf8'), 'café'],
  ])('reads a part in %s', (charset, bytes, want) => {
    expect(gmailBody(text('text/plain', bytes, charset)).text).toBe(want);
  });

  it('reads a part without a charset as UTF-8, and takes standard base64 too', () => {
    const part: GmailPart = {
      mimeType: 'text/plain',
      headers: [{ name: 'Content-Type', value: 'text/plain' }],
      body: { data: Buffer.from('ok ✓ ~~~???', 'utf8').toString('base64') },
    };
    expect(gmailBody(part).text).toBe('ok ✓ ~~~???');
  });

  it('says so for a text part Gmail keeps apart', () => {
    const payload = multipart('alternative', {
      mimeType: 'text/plain',
      filename: '',
      body: { attachmentId: 'big', size: 9_000_000 },
    });
    expect(gmailBody(payload).text).toBe(PART_NOT_READ);
  });

  it('lists an attached message as one attachment and reads none of it', () => {
    const attached: GmailPart = {
      mimeType: 'message/rfc822',
      filename: '',
      body: { size: 2_000 },
      parts: [text('text/plain', 'inner text')],
    };
    expect(gmailBody(multipart('mixed', text('text/plain', 'Forwarding this.'), attached))).toEqual(
      {
        text: 'Forwarding this.',
        attachments: [{ name: 'message.eml', contentType: 'message/rfc822', size: 2_000 }],
      },
    );
  });

  it('takes a text part marked attachment without a name as an attachment, not the body, and decodes an encoded name', () => {
    const unnamed: GmailPart = {
      mimeType: 'text/plain',
      filename: '',
      headers: [{ name: 'content-disposition', value: 'Attachment' }],
      body: { data: Buffer.from('a,b').toString('base64url'), size: 3 },
    };
    const payload = multipart(
      'mixed',
      text('text/plain', 'Two files.'),
      unnamed,
      file('application/pdf', '=?UTF-8?Q?kvitto_f=C3=B6r_1042.pdf?=', 7),
    );
    expect(gmailBody(payload)).toEqual({
      text: 'Two files.',
      attachments: [
        { name: 'attachment', contentType: 'text/plain', size: 3 },
        { name: 'kvitto för 1042.pdf', contentType: 'application/pdf', size: 7 },
      ],
    });
  });

  it('gives empty text for a message with no text part', () => {
    expect(gmailBody(multipart('mixed', file('image/jpeg', 'x.jpg', 1)))).toEqual({
      text: '',
      attachments: [{ name: 'x.jpg', contentType: 'image/jpeg', size: 1 }],
    });
  });
});

describe('gmailHeader', () => {
  it('finds the first header of a name, in any case', () => {
    const part: GmailPart = {
      headers: [
        { name: 'Received', value: 'one' },
        { name: 'received', value: 'two' },
        { name: 'Auto-Submitted', value: 'auto-replied' },
      ],
    };
    expect(gmailHeader(part, 'RECEIVED')).toBe('one');
    expect(gmailHeader(part, 'auto-submitted')).toBe('auto-replied');
    expect(gmailHeader(part, 'Subject')).toBeUndefined();
  });
});
