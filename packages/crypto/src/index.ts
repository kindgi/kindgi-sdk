// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export {
  ED25519_SIGNATURE_BYTES,
  generateEd25519KeyPair,
  parsePrivateKeyBase64,
  parsePrivateKeyPem,
  parsePublicKeyBase64,
  parsePublicKeyPem,
  serializePrivateKeyBase64,
  serializePrivateKeyPem,
  serializePublicKeyBase64,
  serializePublicKeyPem,
  signEd25519,
  verifyEd25519,
} from './ed25519.js';
export type { Ed25519KeyPair } from './ed25519.js';

export { hmacSha256Sign, hmacSha256Verify } from './hmac.js';

export {
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  generateWebhookSecret,
  isStrongWebhookSecret,
  signWebhook,
  verifyWebhook,
  WEBHOOK_HEADERS,
  WEBHOOK_SECRET_MIN_BYTES,
  WEBHOOK_SECRET_PREFIX,
  webhookHeaders,
} from './webhook.js';
export type {
  SignWebhookInput,
  VerifyWebhookFailure,
  VerifyWebhookInput,
  VerifyWebhookResult,
  WebhookRequestHeaders,
} from './webhook.js';

export { createInMemorySigningKeyBinding } from './binding.js';
export type { SigningAlgorithm, SigningKeyBinding, SigningKeyDescriptor } from './binding.js';

export type {
  CryptoError,
  MalformedKeyError,
  MalformedSignatureError,
  UnsupportedFormatError,
} from './errors.js';

export { ED25519_RAW_KEY_BYTES } from './encoding.js';
