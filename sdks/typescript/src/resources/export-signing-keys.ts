// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  ExportSigningKeyList,
  ExportSigningKey as ExportSigningKeyWire,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type ExportSigningKey = ExportSigningKeyWire;

export interface ExportSigningKeysClient {
  /**
   * The public keys this deployment signs its exports with, active
   * first: what `verifySignedExport`'s `trustedKeys` pins (their
   * `publicKeyPem`). Empty when the deployment doesn't sign exports.
   *
   * @wire `GET /v1/export-signing-keys`
   */
  list(): Promise<readonly ExportSigningKey[]>;
}

export function makeExportSigningKeysClient(transport: Transport): ExportSigningKeysClient {
  return {
    async list() {
      const page = await transport.request<ExportSigningKeyList>({
        method: 'GET',
        path: '/v1/export-signing-keys',
      });
      return page.data;
    },
  };
}
