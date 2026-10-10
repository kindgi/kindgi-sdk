// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Retired export keys: public keys a deployment no longer signs with,
 * listed after its own. A verifier that pins `GET /v1/export-signing-keys`
 * (`kindgi exports verify --from-runtime`) then still trusts an export
 * signed before a key rotation. A retired key never signs: only public
 * keys go in, and `sign` stays the binding's own.
 */

import { type KeyObject, createPublicKey } from 'node:crypto';

import type { Result } from '@kindgi/types';

import { unwrapPublicKeySpki } from './encoding.js';
import type { CryptoError } from './errors.js';
import { malformedKey } from './errors.js';
import {
  type ExportSigningBinding,
  type ExportSigningKey,
  exportSigningKey,
} from './export-signing.js';

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g;

/**
 * The export keys in a PEM bundle: one or more `PUBLIC KEY` blocks (SPKI),
 * Ed25519 or EC P-256, in order, under the ids `exportSigningKey` derives.
 * `err` names the block (by its position) that's a private key, another
 * kind of block, unreadable, or a key of another kind; and a bundle with
 * no block at all.
 */
export function parseRetiredExportKeys(
  pemBundle: string,
): Result<readonly ExportSigningKey[], CryptoError> {
  const blocks = [...pemBundle.matchAll(PEM_BLOCK)];
  if (blocks.length === 0)
    return malformedKey('it holds no PEM block (-----BEGIN PUBLIC KEY-----)');
  const keys: ExportSigningKey[] = [];
  for (const [i, block] of blocks.entries()) {
    const where = `block ${i + 1} of ${blocks.length}`;
    const label = block[1] ?? '';
    if (label.includes('PRIVATE')) {
      return malformedKey(
        `${where} is a private key (${label}): retired keys are public keys only`,
      );
    }
    if (label !== 'PUBLIC KEY') {
      return malformedKey(`${where} is a ${label}, not a PUBLIC KEY`);
    }
    let key: KeyObject;
    try {
      key = createPublicKey({ key: block[0], format: 'pem' });
    } catch (cause) {
      return malformedKey(`${where} is not a readable PEM public key`, cause);
    }
    const described = describePublicKey(key);
    if (described.kind === 'err') {
      return malformedKey(
        `${where} is ${described.error}: exports are signed with Ed25519 or EC P-256 keys`,
      );
    }
    keys.push(described.value);
  }
  return { kind: 'ok', value: keys };
}

/**
 * `binding` with `retired` listed after its own keys (a key it already
 * lists, or one given twice, once). The active key and `sign` stay
 * `binding`'s, so signing with a retired key's id is
 * `signing-key-not-found`.
 */
export function withRetiredExportKeys(
  binding: ExportSigningBinding,
  retired: readonly ExportSigningKey[],
): ExportSigningBinding {
  const listKeys = (): readonly ExportSigningKey[] => {
    const own = binding.listKeys();
    const seen = new Set(own.map((k) => k.keyId));
    const extra: ExportSigningKey[] = [];
    for (const key of retired) {
      if (seen.has(key.keyId)) continue;
      seen.add(key.keyId);
      extra.push(key);
    }
    return [...own, ...extra];
  };
  return {
    activeKey: () => binding.activeKey(),
    listKeys,
    sign: (bytes, options) => binding.sign(bytes, options),
  };
}

function describePublicKey(
  key: KeyObject,
):
  | { readonly kind: 'ok'; readonly value: ExportSigningKey }
  | { readonly kind: 'err'; readonly error: string } {
  if (key.asymmetricKeyType === 'ed25519') {
    const raw = unwrapPublicKeySpki(new Uint8Array(key.export({ format: 'der', type: 'spki' })));
    if (raw.kind === 'err') return { kind: 'err', error: 'an Ed25519 key that could not be read' };
    return { kind: 'ok', value: exportSigningKey(raw.value, 'ed25519') };
  }
  if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') {
    const jwk = key.export({ format: 'jwk' });
    const point = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(String(jwk.x), 'base64url'),
      Buffer.from(String(jwk.y), 'base64url'),
    ]);
    return { kind: 'ok', value: exportSigningKey(new Uint8Array(point), 'ecdsa-p256-sha256') };
  }
  const type = key.asymmetricKeyType ?? 'an unknown kind of key';
  const curve = key.asymmetricKeyDetails?.namedCurve;
  return {
    kind: 'err',
    error: curve !== undefined ? `an ${type} key on ${curve}` : `an ${type} key`,
  };
}
