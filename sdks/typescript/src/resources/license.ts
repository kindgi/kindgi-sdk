// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { LicenseStatus as LicenseStatusWire } from '../generated/api.js';
import type { Transport } from '../transport.js';

export type LicenseStatus = LicenseStatusWire;

export interface LicenseClient {
  /**
   * Where the deployment's license key stands: whose, which use, until
   * when and how many days are left, and from 30 days before it expires
   * how to get the next one. Never the key itself. A deployment that
   * doesn't report it answers 404.
   *
   * @wire `GET /v1/license`
   */
  get(): Promise<LicenseStatus>;
}

export function makeLicenseClient(transport: Transport): LicenseClient {
  return {
    async get() {
      return transport.request<LicenseStatus>({ method: 'GET', path: '/v1/license' });
    },
  };
}
