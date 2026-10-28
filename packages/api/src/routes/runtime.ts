// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import type { AppEnv } from '../types.js';

/**
 * Which runtime answers: its release, how it's hosted, and whether it runs
 * in development mode. What a client says about the runtime it's connected
 * to.
 */
export interface RuntimeInfo {
  /** Its release, such as `0.3.0`, or what its build gave otherwise (`dev` when it gave none). */
  readonly version: string;
  /** `hosted`: the runtime serves many tenants; `self-hosted`: it serves one. */
  readonly hosting: 'hosted' | 'self-hosted';
  /** It runs in development mode, which allows development-only settings. */
  readonly development: boolean;
}

/**
 * What the host says about itself (`CreateAppInput.runtime`). How it's hosted
 * isn't asked: it follows from `CreateAppInput.tenancy`, so the two can't disagree.
 */
export type RuntimeInfoInput = Omit<RuntimeInfo, 'hosting'>;

/** `GET /v1/runtime`: any caller of a tenant reads it; no right is asked. */
export function runtimeRouter(
  input: RuntimeInfoInput,
  tenancy: 'single' | 'multi' | undefined,
): Hono<AppEnv> {
  // The three fields only: nothing else the host's object carries reaches the wire.
  const body: RuntimeInfo = {
    version: input.version,
    hosting: tenancy === 'multi' ? 'hosted' : 'self-hosted',
    development: input.development,
  };
  const r = new Hono<AppEnv>();
  r.get('/', (c) => c.json(body));
  return r;
}
