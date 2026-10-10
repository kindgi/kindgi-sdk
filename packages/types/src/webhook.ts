// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * How a sender signs the requests a webhook trigger receives.
 *
 * - `hmac-sha256`: HMAC-SHA256 of the raw request body under the shared
 *   secret's UTF-8 bytes, in one header, `hex` or `base64`, after an
 *   optional `prefix` (GitHub and Drupal's Webhooks module send
 *   `X-Hub-Signature-256: sha256=<hex>`; WooCommerce sends
 *   `X-WC-Webhook-Signature: <base64>`; Shopify `X-Shopify-Hmac-Sha256:
 *   <base64>`). No timestamp is signed, so a replay is caught only by the
 *   trigger's delivery-id dedupe.
 * - `standard-webhooks`: the Standard Webhooks format
 *   (https://www.standardwebhooks.com): `webhook-id`, `webhook-timestamp`
 *   and `webhook-signature: v1,<base64>` over `{id}.{timestamp}.{body}`,
 *   with a `whsec_` secret. A timestamp further than `toleranceSeconds`
 *   from the receiver's clock is refused (default 300).
 */
export type WebhookSignatureScheme =
  | {
      readonly kind: 'hmac-sha256';
      readonly encoding: 'hex' | 'base64';
      /** The header that carries the signature; matched case-insensitively. */
      readonly header: string;
      /** Stripped from the header's value before decoding (e.g. `sha256=`). */
      readonly prefix?: string;
    }
  | {
      readonly kind: 'standard-webhooks';
      readonly toleranceSeconds?: number;
    };
