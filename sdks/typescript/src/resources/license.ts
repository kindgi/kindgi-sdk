// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  LicenseStatus as LicenseStatusWire,
  LicenseUsage as LicenseUsageWire,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type LicenseStatus = LicenseStatusWire;
export type LicenseUsage = LicenseUsageWire;

export interface LicenseClient {
  /**
   * Where the deployment's license key stands: whose, which use, until
   * when and how many days are left, and from 30 days before it expires
   * how to get the next one. Never the key itself. The deployment's own
   * token reads all of it; where the deployment serves one tenant, that
   * tenant's admins read the countdown only; anyone else gets 403
   * `license-operator-only`, as `identity.permissions()` says before asking
   * (`licenseOperatorOnly`). A deployment that doesn't report it answers
   * 404.
   *
   * @wire `GET /v1/license`
   */
  get(): Promise<LicenseStatus>;
  /**
   * How much the deployment was used since `since`: what a free key's
   * renewal carries (`kindgi license renew --runtime`). The runs started
   * (not dry runs, replays, test runs or child runs), the distinct people who
   * started runs or decided approvals (counted in each tenant and summed),
   * the projects in production when the runtime can put projects in
   * production, and its version. Counts only. A `since` up to five minutes
   * ahead of the runtime's clock is taken as now. Only the deployment's own
   * token reads it;
   * anyone else gets 403 `license-operator-only`. A deployment that
   * doesn't report it answers 404.
   *
   * @wire `GET /v1/license/usage`
   */
  usage(input: { readonly since: Date | string }): Promise<LicenseUsage>;
  /**
   * Hands the running server a renewed license key, so it runs it without
   * a restart (`kindgi license renew --runtime`). The server checks it
   * offline: a trusted signature, the same licensee and use as the key it
   * runs, and newer. The same key again is taken as it is. Answers the
   * status with the new key. A key it refuses throws 409
   * `license-key-refused`, with `details.reason`. Only the deployment's own
   * token, or a system key holding `system:license`; anyone else gets 403
   * `license-operator-only`. A deployment that doesn't take a key this way
   * answers 404.
   *
   * @wire `PUT /v1/license`
   */
  replace(input: { readonly key: string }): Promise<LicenseStatus>;
}

export function makeLicenseClient(transport: Transport): LicenseClient {
  return {
    async get() {
      return transport.request<LicenseStatus>({ method: 'GET', path: '/v1/license' });
    },
    async usage({ since }) {
      return transport.request<LicenseUsage>({
        method: 'GET',
        path: '/v1/license/usage',
        query: { since: since instanceof Date ? since.toISOString() : since },
      });
    },
    async replace({ key }) {
      return transport.request<LicenseStatus>({
        method: 'PUT',
        path: '/v1/license',
        body: { key },
      });
    },
  };
}
