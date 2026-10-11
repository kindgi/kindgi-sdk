// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Verify a signed export (an approval's audit bundle, a run's
 * provenance, compliance evidence) where it's read: Web Crypto's
 * Ed25519, so it runs in Node and in a browser alike, with nothing to
 * install.
 *
 * It checks the signature over the exact bytes shipped (`bundle`):
 * nothing is re-serialized. Two algorithms: `ed25519`, and
 * `ecdsa-p256-sha256` (its signature IEEE P1363 `r‖s`). Any other is
 * refused, naming it, so a newer one fails loudly here, never silently. A signature that checks out against the
 * export's own `publicKey` proves the bytes weren't changed; pass
 * `trustedKeys` (from `exportSigningKeys.list()`, or a key you pinned)
 * to know who signed them.
 */

/** The algorithms this verifier checks, and Web Crypto's names for each. */
const ALGORITHMS = {
  ed25519: { key: { name: 'Ed25519' }, verify: { name: 'Ed25519' } },
  'ecdsa-p256-sha256': {
    key: { name: 'ECDSA', namedCurve: 'P-256' },
    verify: { name: 'ECDSA', hash: 'SHA-256' },
  },
} as const;

/** The algorithms `verifySignedExport` checks. */
export const SIGNED_EXPORT_ALGORITHMS = Object.keys(
  ALGORITHMS,
) as readonly (keyof typeof ALGORITHMS)[];

/** The envelope every signed export answers. */
export interface SignedExportEnvelope {
  readonly kind?: 'audit-bundle' | 'provenance' | 'compliance';
  readonly bundle: string;
  readonly bundleSchemaVersion: string | number;
  readonly algorithm: string;
  readonly signingKeyId: string;
  readonly signature: string;
  readonly publicKey: string;
  readonly canonicalization: string;
  readonly exportedAt: string;
}

export interface VerifySignedExportOptions {
  /** The public keys (PEM) you trust. Absent: the export is checked against its own key only. */
  readonly trustedKeys?: readonly string[];
}

export interface SignedExportVerification {
  /** The signature checks out (and, with `trustedKeys`, the key is one of them). */
  readonly valid: boolean;
  /** What failed, in words. Present when `valid` is `false`. */
  readonly issues?: readonly string[];
  /** Whether the signing key was checked against `trustedKeys`, or only against itself. */
  readonly checkedAgainst: 'trusted-keys' | 'its-own-key';
  /** The signed body, parsed: present when the signature checks out. */
  readonly body?: Readonly<Record<string, unknown>>;
  readonly signingKeyId: string;
  /**
   * What a valid export's reader should know, in words: for an audit
   * bundle made by Kindgi 0.1.4 whose envelope `exportedAt` isn't the
   * signed one, the signed time. Absent when there's nothing to say.
   */
  readonly notes?: readonly string[];
}

/** Verify a signed export's signature, and its key when `trustedKeys` is given. */
export async function verifySignedExport(
  envelope: SignedExportEnvelope,
  options: VerifySignedExportOptions = {},
): Promise<SignedExportVerification> {
  const issues: string[] = [];
  const checkedAgainst = options.trustedKeys !== undefined ? 'trusted-keys' : 'its-own-key';
  const fail = (): SignedExportVerification => ({
    valid: false,
    issues,
    checkedAgainst,
    signingKeyId: envelope.signingKeyId,
  });

  const algorithm = Object.hasOwn(ALGORITHMS, envelope.algorithm)
    ? ALGORITHMS[envelope.algorithm as keyof typeof ALGORITHMS]
    : undefined;
  if (algorithm === undefined) {
    issues.push(
      `algorithm "${envelope.algorithm}" isn't one this verifier knows (${SIGNED_EXPORT_ALGORITHMS.join(', ')}): a newer verifier may check it`,
    );
  }
  if (envelope.canonicalization !== 'sorted-key-json') {
    issues.push(`canonicalization "${envelope.canonicalization}" isn't sorted-key-json`);
  }
  if (
    options.trustedKeys !== undefined &&
    !options.trustedKeys.some((pem) => samePem(pem, envelope.publicKey))
  ) {
    issues.push(`it was signed with key "${envelope.signingKeyId}", which isn't one you trust`);
  }
  if (issues.length > 0 || algorithm === undefined) return fail();

  let bytes: Uint8Array;
  let signed: boolean;
  try {
    bytes = fromBase64(envelope.bundle);
    const key = await crypto.subtle.importKey(
      'spki',
      toArrayBuffer(fromPem(envelope.publicKey)),
      algorithm.key,
      false,
      ['verify'],
    );
    signed = await crypto.subtle.verify(
      algorithm.verify,
      key,
      toArrayBuffer(fromBase64(envelope.signature)),
      toArrayBuffer(bytes),
    );
  } catch (cause) {
    issues.push(`it can't be checked: ${cause instanceof Error ? cause.message : String(cause)}`);
    return fail();
  }
  if (!signed) {
    issues.push(
      "the signature doesn't match the bundle: it was changed, or signed with another key",
    );
    return fail();
  }

  const body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  const notes: string[] = [];
  // The envelope's own exportedAt isn't signed; the body's is.
  if (body.exportedAt !== undefined && body.exportedAt !== envelope.exportedAt) {
    if (!madeByKindgi014(envelope, body)) {
      issues.push(
        `the envelope's exportedAt (${envelope.exportedAt}) isn't the signed one (${String(body.exportedAt)})`,
      );
      return fail();
    }
    notes.push(
      `made by Kindgi 0.1.4, which stamped the envelope's exportedAt separately: the signed export time is ${String(body.exportedAt)} (the envelope says ${envelope.exportedAt})`,
    );
  }
  return {
    valid: true,
    checkedAgainst,
    body,
    signingKeyId: envelope.signingKeyId,
    ...(notes.length > 0 && { notes }),
  };
}

/**
 * An audit bundle in Kindgi 0.1.4's format: the envelope's
 * `bundleSchemaVersion` is the integer `1`, over a signed body with
 * `bundleVersion: 1` (and no `bundleSchemaVersion`). 0.1.4 stamped the
 * envelope's `exportedAt` separately from the signed one, so the two can
 * be a millisecond apart; only this format is let off comparing them, and
 * the signed time is the one reported. The body is signed, so an envelope
 * can't claim the format for a later bundle.
 */
function madeByKindgi014(
  envelope: SignedExportEnvelope,
  body: Readonly<Record<string, unknown>>,
): boolean {
  return (
    envelope.bundleSchemaVersion === 1 &&
    body.bundleVersion === 1 &&
    body.bundleSchemaVersion === undefined
  );
}

function samePem(a: string, b: string): boolean {
  return a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
}

function fromPem(pem: string): Uint8Array {
  return fromBase64(pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, ''));
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
