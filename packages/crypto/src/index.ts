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

export {
  EXPORT_SIGNING_ALGORITHMS,
  createEcdsaP256ExportSigner,
  createEd25519ExportSigner,
  createExportSignerFromPem,
  ecdsaDerToP1363,
  exportSignerFromSigningKeyBinding,
  exportSigningKey,
} from './export-signing.js';
export { parseRetiredExportKeys, withRetiredExportKeys } from './retired-export-keys.js';
export type {
  ExportSignature,
  ExportSigningAlgorithm,
  ExportSigningBinding,
  ExportSigningError,
  ExportSigningKey,
} from './export-signing.js';
export type { SigningAlgorithm, SigningKeyBinding, SigningKeyDescriptor } from './binding.js';

export type {
  CryptoError,
  MalformedKeyError,
  MalformedSignatureError,
  UnsupportedFormatError,
} from './errors.js';

export { ED25519_RAW_KEY_BYTES } from './encoding.js';
