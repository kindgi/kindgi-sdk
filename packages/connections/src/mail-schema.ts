// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** The read tools' output schemas for mail, as `./mail.ts` types it. Not a package subpath. */

/** A `MailPerson`. */
export const MAIL_PERSON = {
  type: 'object',
  additionalProperties: false,
  required: ['address'],
  properties: { address: { type: 'string' }, name: { type: 'string' } },
} as const;

/** A `MailMessage`. */
export const MAIL_MESSAGE = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'to',
    'cc',
    'replyTo',
    'subject',
    'receivedAt',
    'body',
    'bodyCut',
    'attachments',
    'autoSubmitted',
  ],
  properties: {
    id: { type: 'string' },
    threadId: { type: 'string' },
    from: MAIL_PERSON,
    to: { type: 'array', items: MAIL_PERSON },
    cc: { type: 'array', items: MAIL_PERSON },
    replyTo: { type: 'array', items: MAIL_PERSON },
    subject: { type: 'string' },
    receivedAt: { type: 'string' },
    body: { type: 'string' },
    bodyCut: { type: 'boolean' },
    attachments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'contentType', 'size'],
        properties: {
          name: { type: 'string' },
          contentType: { type: 'string' },
          size: { type: 'integer', minimum: 0 },
          inline: { type: 'boolean' },
        },
      },
    },
    attachmentsLeftOut: { type: 'integer', minimum: 1 },
    autoSubmitted: { type: 'boolean' },
    replyRef: { type: 'string', pattern: '^[0-9a-f]{32}$' },
    sent: { type: 'boolean' },
  },
} as const;
