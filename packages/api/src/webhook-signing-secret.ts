// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomBytes, randomInt } from 'node:crypto';

import type { WebhookSignatureScheme } from '@kindgi/types';

/**
 * A new signing secret for a webhook trigger. `standard-webhooks`: `whsec_`
 * and 32 random bytes in base64. Otherwise 40 letters and digits:
 * WooCommerce HTML-decodes its secret before signing, so anything else
 * could sign differently.
 */
export function generateSigningSecret(signature: WebhookSignatureScheme | undefined): string {
  if (signature?.kind === 'standard-webhooks') {
    return `whsec_${randomBytes(32).toString('base64')}`;
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 40; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}
