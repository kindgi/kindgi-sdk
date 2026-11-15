// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import type { AppEnv } from '../types.js';

/**
 * Whether the runtime serves connections to other apps: the
 * `/v1/connection-*` routes, and the tools that need a connection. When
 * they're off, a runtime in development mode says why in `reason`, in its
 * own words; one in production never does.
 */
export type RuntimeConnections =
  | { readonly on: true }
  | { readonly on: false; readonly reason?: string };

/**
 * Which runtime answers: its release, how many tenants it serves, whether
 * it runs in development mode, and whether it serves connections. What a
 * client says about the runtime it's connected to.
 */
export interface RuntimeInfo {
  /** Its release, such as `0.3.0`, or what its build gave otherwise (`dev` when it gave none). */
  readonly version: string;
  /** `single` when the runtime serves one tenant, `multi` when it serves many. */
  readonly tenancy: 'single' | 'multi';
  /** It runs in development mode, which allows development-only settings. */
  readonly development: boolean;
  /** Whether it serves connections to other apps. Absent when the runtime doesn't say. */
  readonly connections?: RuntimeConnections;
}

/**
 * What the host says about itself (`CreateAppInput.runtime`). Its tenancy
 * isn't asked: it's `CreateAppInput.tenancy`, so the two can't disagree.
 */
export type RuntimeInfoInput = Omit<RuntimeInfo, 'tenancy'>;

/** `GET /v1/runtime`: any caller of a tenant reads it; no right is asked. */
export function runtimeRouter(
  input: RuntimeInfoInput,
  tenancy: 'single' | 'multi' | undefined,
): Hono<AppEnv> {
  // The fields named here only: nothing else the host's object carries reaches the wire.
  const connections = connectionsOf(input.connections, input.development);
  const body: RuntimeInfo = {
    version: input.version,
    tenancy: tenancy ?? 'single',
    development: input.development,
    ...(connections !== undefined && { connections }),
  };
  const r = new Hono<AppEnv>();
  r.get('/', (c) => c.json(body));
  return r;
}

/**
 * Field by field, as for the body. The reason names the settings the runtime
 * lacks, so only a runtime in development mode gives it: any caller of a
 * tenant reads this route.
 */
function connectionsOf(
  connections: RuntimeConnections | undefined,
  development: boolean,
): RuntimeConnections | undefined {
  if (connections === undefined) return undefined;
  if (connections.on === true) return { on: true };
  return development && connections.reason !== undefined
    ? { on: false, reason: connections.reason }
    : { on: false };
}
