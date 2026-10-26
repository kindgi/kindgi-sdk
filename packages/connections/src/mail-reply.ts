// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where a reply goes, for both reply tools: the one address the mail it
 * answers names, its `Reply-To` if that names an address, else its `From`,
 * as a mail client works it out. The call's `to` must name that address,
 * so the model can't steer a reply elsewhere, and a person who approves a
 * reply sees where it goes.
 */

import type { MailPerson } from './mail.js';

/** The mail tools' `format: 'email'`, as their input schemas check it (ajv-formats' full form). */
const EMAIL =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/** Whether `value` is an address the mail tools' `ADDRESS` takes: no line break or list separator, 254 characters at most. */
export function isMailAddress(value: string): boolean {
  return value.length <= 254 && /^[^\r\n,;<>"]+$/.test(value) && EMAIL.test(value);
}

/** The people a mail's `Reply-To` and `From` name (`undefined` for an entry that isn't an address). */
export interface ReplyHeaders {
  readonly replyTo: readonly (MailPerson | undefined)[];
  readonly from: readonly (MailPerson | undefined)[];
}

/**
 * The address a reply goes to: the one the `Reply-To` names, else the one
 * the `From` names. A `Reply-To` that names no address (none there, blank,
 * an empty group, or nothing the read can parse) is none, as the read
 * shows it. Refused, before anything is sent, when the header it goes by
 * names more than one, or the `From` none, when that one isn't an address
 * a mail tool takes, when it's the mailbox's own (`own`, the connection's
 * account), or when `to` isn't it (in any letter case). The refusal names
 * the address the mail asks for.
 */
export function replyAddress(headers: ReplyHeaders, to: string, own: string | undefined): string {
  const byReplyTo = headers.replyTo.some((person) => person !== undefined);
  const name = byReplyTo ? 'Reply-To' : 'From';
  const people = byReplyTo ? headers.replyTo : headers.from;
  if (people.length !== 1) {
    const names = people.length === 0 ? 'no address' : `${people.length} addresses`;
    throw new Error(
      `The mail's ${name} names ${names}, and a reply goes to one: this tool sent nothing.`,
    );
  }
  const address = people[0]?.address;
  if (address === undefined || !isMailAddress(address)) {
    throw new Error(
      `The mail's ${name} isn't an address a reply can go to: this tool sent nothing.`,
    );
  }
  if (own !== undefined && address.toLowerCase() === own.toLowerCase()) {
    throw new Error(
      `The mail's ${name} is this mailbox's own address, so a reply would come back to it: this tool sent nothing.`,
    );
  }
  if (to.toLowerCase() !== address.toLowerCase()) {
    throw new Error(
      `The mail asks for replies to ${address} (its ${name}), and \`to\` names another address: this tool sent nothing. A reply goes only where the mail asks.`,
    );
  }
  return address;
}

/** A header's value unfolded (RFC 5322 §2.2.3): each line break followed by a space or tab removed. */
export function unfold(value: string): string {
  return value.replace(/\r?\n(?=[ \t])/g, '');
}
