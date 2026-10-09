// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import type { ExportSigningBinding } from '@kindgi/crypto';

import type { AppEnv } from '../types.js';

/**
 * `GET /v1/export-signing-keys`: the public keys this deployment signs
 * its exports with, active first. A verifier pins them: an export's own
 * embedded `publicKey` only proves it wasn't changed, these say who
 * signed it. Empty when the deployment doesn't sign exports. Any
 * authenticated caller may read them; they're public keys.
 */
export function exportSigningKeysRouter(signer: ExportSigningBinding | undefined): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get('/', (c) =>
    c.json({
      data: (signer?.listKeys() ?? []).map((key, index) => ({
        keyId: key.keyId,
        algorithm: key.algorithm,
        publicKeyPem: key.publicKeyPem,
        fingerprint: key.fingerprint,
        active: index === 0,
      })),
    }),
  );
  return r;
}
