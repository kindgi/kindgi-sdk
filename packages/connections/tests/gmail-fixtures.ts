// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Gmail's answers, in the shapes its reference gives:
 * - a message with `format=full`:
 *   developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages#Message
 *   (`id`, `threadId`, `labelIds`, `snippet`, `historyId`, `internalDate`
 *   in epoch milliseconds as a string, `payload` as MIME parts with
 *   `body.data` in base64url, `sizeEstimate`);
 * - an error: `{error: {code, message, errors: [{message, domain, reason}],
 *   status, details}}`: `errors` as Gmail's error guide shows it
 *   (developers.google.com/workspace/gmail/api/guides/handle-errors),
 *   `details` and its ErrorInfo as google.aip.dev/193 gives them. A
 *   missing scope's ErrorInfo reason, `ACCESS_TOKEN_SCOPE_INSUFFICIENT` in
 *   the `googleapis.com` domain, is in Google's list of reasons
 *   (github.com/googleapis/googleapis/blob/master/google/api/error_reason.proto).
 *   No Gmail page names the `errors[].reason` that goes with it,
 *   `insufficientPermissions`.
 */

/** A text part, its content in UTF-8, base64url. */
function textPart(mimeType: string, content: string) {
  const bytes = Buffer.from(content, 'utf8');
  return {
    partId: '',
    mimeType,
    filename: '',
    headers: [{ name: 'Content-Type', value: `${mimeType}; charset="UTF-8"` }],
    body: { size: bytes.length, data: bytes.toString('base64url') },
  };
}

export interface FullMessage {
  readonly from?: string;
  readonly to?: string;
  readonly cc?: string;
  readonly replyTo?: string;
  readonly subject?: string;
  readonly at?: string;
  readonly text?: string;
  /** An HTML-only message when `text` isn't given. */
  readonly html?: string;
  readonly labelIds?: readonly string[];
  readonly autoSubmitted?: string;
  /** Its `X-Reply-Ref` header, or one header for each value. */
  readonly replyRef?: string | readonly string[];
  readonly attachment?: { readonly name: string; readonly type: string; readonly size: number };
}

/** A message as `users.messages.get` and `users.threads.get` give it with `format=full`. */
export function fullMessage(id: string, threadId: string, m: FullMessage = {}) {
  const headers = [
    { name: 'Received', value: 'from mail.acme.example by mx.google.com' },
    { name: 'From', value: m.from ?? 'Bo Lund <bo@acme.example>' },
    { name: 'To', value: m.to ?? 'support@acme.example' },
    ...(m.cc !== undefined ? [{ name: 'Cc', value: m.cc }] : []),
    ...(m.replyTo !== undefined ? [{ name: 'Reply-To', value: m.replyTo }] : []),
    { name: 'Subject', value: m.subject ?? 'Order 1042' },
    ...(m.autoSubmitted !== undefined ? [{ name: 'Auto-Submitted', value: m.autoSubmitted }] : []),
    ...[m.replyRef ?? []].flat().map((value) => ({ name: 'X-Reply-Ref', value })),
    { name: 'MIME-Version', value: '1.0' },
  ];
  const text = m.text ?? 'Where is order 1042?';
  const content =
    m.html === undefined || m.text !== undefined
      ? {
          partId: '',
          mimeType: 'multipart/alternative',
          filename: '',
          headers: [{ name: 'Content-Type', value: 'multipart/alternative; boundary="b1"' }],
          body: { size: 0 },
          parts: [textPart('text/plain', text), textPart('text/html', `<div>${text}</div>`)],
        }
      : textPart('text/html', m.html);
  const payload =
    m.attachment === undefined
      ? { ...content, headers: [...headers, ...content.headers] }
      : {
          partId: '',
          mimeType: 'multipart/mixed',
          filename: '',
          headers: [...headers, { name: 'Content-Type', value: 'multipart/mixed; boundary="b0"' }],
          body: { size: 0 },
          parts: [
            content,
            {
              partId: '1',
              mimeType: m.attachment.type,
              filename: m.attachment.name,
              headers: [
                {
                  name: 'Content-Disposition',
                  value: `attachment; filename="${m.attachment.name}"`,
                },
              ],
              body: { attachmentId: 'ANGjdJ9fkTs', size: m.attachment.size },
            },
          ],
        };
  return {
    id,
    threadId,
    labelIds: m.labelIds ?? ['INBOX', 'UNREAD'],
    snippet: text.slice(0, 100),
    historyId: '9876543210',
    internalDate: String(Date.parse(m.at ?? '2026-10-26T01:00:00Z')),
    payload,
    sizeEstimate: 4096,
  };
}

/** Google's error answer: `reason` in `errors`, and `info` as its ErrorInfo's, when given. */
export function googleError(
  code: number,
  status: string,
  message: string,
  reason?: string,
  info?: string,
  headers?: Record<string, string>,
): Response {
  return Response.json(
    {
      error: {
        code,
        message,
        ...(reason !== undefined && { errors: [{ message, domain: 'global', reason }] }),
        status,
        ...(info !== undefined && {
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: info,
              domain: 'googleapis.com',
              metadata: { service: 'gmail.googleapis.com' },
            },
          ],
        }),
      },
    },
    { status: code, ...(headers !== undefined && { headers }) },
  );
}
