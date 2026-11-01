// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { RuntimeInfo as RuntimeInfoWire } from '../generated/api.js';
import type { Transport } from '../transport.js';

export type RuntimeInfo = RuntimeInfoWire;

export interface RuntimeClient {
  /**
   * Which runtime answers: its version (its release, such as `0.3.0`, or
   * what its build gave otherwise: `dev` when it gave none), its tenancy
   * (`single` when it serves one tenant, `multi` when it serves many) and
   * whether it runs in development mode.
   * Any caller of a workspace reads it. A runtime that doesn't report it
   * answers 404.
   *
   * @wire `GET /v1/runtime`
   */
  get(): Promise<RuntimeInfo>;
}

export function makeRuntimeClient(transport: Transport): RuntimeClient {
  return {
    async get() {
      return transport.request<RuntimeInfo>({ method: 'GET', path: '/v1/runtime' });
    },
  };
}
