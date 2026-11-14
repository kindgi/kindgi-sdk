// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { defineApp } from './define.js';

/**
 * Texts, for the company: a phone number at a texting provider, connected
 * with the provider account's API key, which the registration keeps by
 * reference. No person signs in.
 *
 * - **Sign-in:** the registration's API key. A connect names the number,
 *   and the server looks it up at the provider with that key.
 * - **Whose account:** the number. The provider's id for it is the
 *   account id, and the number in E.164 is its label.
 * - **Inbound:** connecting moves the number onto Kindgi's messaging
 *   profile, so its texts come to the server. A connect whose number's
 *   texts go somewhere else today is refused until it says to replace
 *   that.
 * - **Withdrawing:** a disconnect puts the number's inbound back where it
 *   was before the connect, or clears what Kindgi set.
 * - **Permissions:** the key reaches the whole provider account, so the
 *   server checks each permission itself; `grants` is the permission's
 *   own key.
 */
export const texts = defineApp({
  id: 'texts',
  name: 'Texts',
  signIn: { kind: 'token', providers: ['telnyx'] },
  owners: ['company'],
  permissions: {
    'texts.reply': {
      grants: 'texts.reply',
      says: 'Answer the people who text this number',
      changes: true,
    },
    'texts.send': {
      grants: 'texts.send',
      says: 'Text people from this number',
      changes: true,
    },
  },
  account: { kind: 'number' },
  removal: { revoke: 'restore-inbound' },
  setupGuide: '/guides/connections/texts/',
});
