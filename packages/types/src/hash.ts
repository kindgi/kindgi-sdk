// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Brand } from './ids.js';

/**
 * A content-addressed hash of a payload, formatted as `<algo>:<hex>`.
 *
 * Current supported algorithms:
 *   - `sha256:<64 hex chars>`
 *
 * Meant for content addressing: tamper-evident provenance node content,
 * blob dedup at ingest, memory LogEntry / Fact content hashes.
 *
 * The prefix is significant: consumers must reject hashes without a recognized
 * algorithm prefix, so future migration to sha3 or blake3 is non-breaking.
 */
export type ContentHash = Brand<string, 'ContentHash'>;

/**
 * An Ed25519 signature over some canonical serialization, base64-encoded.
 *
 * Format is padded base64 (RFC 4648 §4). No URL-safe variants — canonical form
 * for interoperability with signing tools.
 */
export type SignatureValue = Brand<string, 'SignatureValue'>;

/**
 * Identifier for a signing key in provider-qualified form. Opaque to Kindgi;
 * interpreted by whichever key provider resolves it. (Keys held in a
 * `SigningKeyBinding` from `@kindgi/crypto` are addressed by `SigningKeyId`.)
 *
 * Convention: `<provider>:<key-name>` (e.g. `ed25519-local:tenant-abc-v1`,
 * `hsm:pkcs11:slot-3:key-42`, `kms:aws:arn:aws:kms:...`). Consumers should
 * treat this string as opaque and let the provider resolve it.
 */
export type KeyId = Brand<string, 'KeyId'>;
