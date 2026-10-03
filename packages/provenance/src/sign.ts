// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';

import type { Result, Timestamp } from '@kindgi/types';

import { signingBytes } from './canonical.js';
import type {
  MissingSignatureError,
  ProvenanceError,
  SignatureVerificationError,
  SigningNotSupportedError,
  UnknownKeyError,
} from './errors.js';
import type { KeyProvider, Provenance, Signature } from './types.js';

/**
 * Sign a provenance record. Resolves the signing key via the provider's
 * hybrid lookup (per-tenant → deployment), computes canonical signing
 * bytes, produces the Ed25519 signature, and returns the record with the
 * signature attached.
 *
 * If the record already has a signature, it is replaced — callers signing
 * a re-emitted DAG get a fresh signature covering the new content.
 */
export function signProvenance(
  provenance: Provenance,
  keyProvider: KeyProvider,
): Result<Provenance, ProvenanceError> {
  const key = keyProvider.signingKey(provenance.tenantId);
  if (key.privateKey === undefined) {
    const err: SigningNotSupportedError = {
      code: 'signing-not-supported',
      message: `No private key for keyId "${key.keyId}" (tenant "${provenance.tenantId}")`,
      keyId: key.keyId,
      tenantId: provenance.tenantId,
    };
    return { kind: 'err', error: err };
  }
  const privateKey = createPrivateKey({
    key: Buffer.from(key.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const bytes = signingBytes(provenance);
  const signatureBytes = cryptoSign(null, bytes, privateKey);
  const signature: Signature = {
    algorithm: 'ed25519',
    keyId: key.keyId,
    value: signatureBytes.toString('base64'),
    signedAt: new Date().toISOString() as Timestamp,
  };
  return { kind: 'ok', value: { ...provenance, signature } };
}

/**
 * Verify a signed provenance record. Resolves the key by the signature's
 * `keyId` (not by tenant — a rotated key still has to verify old signatures)
 * and checks the Ed25519 signature against canonical bytes.
 */
export function verifyProvenance(
  provenance: Provenance,
  keyProvider: KeyProvider,
): Result<void, ProvenanceError> {
  const sig = provenance.signature;
  if (sig === undefined) {
    const err: MissingSignatureError = {
      code: 'missing-signature',
      message: `Provenance "${provenance.id}" has no signature to verify`,
      provenanceId: provenance.id,
    };
    return { kind: 'err', error: err };
  }
  const key = keyProvider.verificationKey(sig.keyId);
  if (key === undefined) {
    const err: UnknownKeyError = {
      code: 'unknown-key',
      message: `No key registered for keyId "${sig.keyId}"`,
      keyId: sig.keyId,
    };
    return { kind: 'err', error: err };
  }
  return verifyWithPublicKey(provenance, sig, key.publicKey);
}

/**
 * Standalone verifier: check a signed provenance JSON against a caller-supplied
 * Ed25519 public key (base64-encoded DER, SPKI). No dependency on a
 * KeyProvider or the runtime — this is the primitive an external auditor
 * uses to verify an exported DAG.
 */
export function verifyExported(
  provenance: Provenance,
  base64PublicKey: string,
): Result<void, ProvenanceError> {
  const sig = provenance.signature;
  if (sig === undefined) {
    return {
      kind: 'err',
      error: {
        code: 'missing-signature',
        message: `Provenance "${provenance.id}" has no signature to verify`,
        provenanceId: provenance.id,
      },
    };
  }
  return verifyWithPublicKey(provenance, sig, base64PublicKey);
}

function verifyWithPublicKey(
  provenance: Provenance,
  sig: Signature,
  base64PublicKey: string,
): Result<void, ProvenanceError> {
  const publicKey = createPublicKey({
    key: Buffer.from(base64PublicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const bytes = signingBytes(provenance);
  const ok = cryptoVerify(null, bytes, publicKey, Buffer.from(sig.value, 'base64'));
  if (!ok) {
    const err: SignatureVerificationError = {
      code: 'signature-verification-failed',
      message: `Signature "${sig.keyId}" does not verify against canonical bytes`,
      keyId: sig.keyId,
    };
    return { kind: 'err', error: err };
  }
  return { kind: 'ok', value: undefined };
}
