// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * How far tenant configuration may reach into the server's own host:
 * `KINDGI_TENANT_HOST_ACCESS`. A token holder registers things (MCP
 * endpoints, providers, webhooks) the server then acts on; some of them
 * can act on the host itself, which only a single-user machine should
 * allow.
 *
 *   - `local` (the default under `KINDGI_DEV`): a developer's machine.
 *     Tenant configuration may run commands on the host.
 *   - `deployed` (the default otherwise): a stdio MCP endpoint, which
 *     runs its command in the server's container as the server's user,
 *     is refused at registration and at connect; and the server's
 *     outbound calls to hosts a tenant chose (an MCP endpoint, a model
 *     provider's base URL, an HTTP tool, an image registry) refuse the
 *     cloud metadata endpoints and the server's own host.
 *
 * Checks ask `deniesHostReach(level, reach)`, never compare levels, so a
 * stricter level (or a new kind of reach) is one more row or entry here.
 */

/** The levels, least strict first. */
export const TENANT_HOST_ACCESS_LEVELS = ['local', 'deployed'] as const;

export type TenantHostAccess = (typeof TENANT_HOST_ACCESS_LEVELS)[number];

/** What tenant configuration can make the server do on its own host. */
export type HostReach =
  /** Run a command: a `stdio` MCP endpoint. */
  | 'exec'
  /**
   * Connect to a link-local address (169.254.0.0/16, fe80::/10,
   * fd00:ec2::254), where the cloud metadata endpoints hand out the
   * server's own credentials.
   */
  | 'metadata-network'
  /** Connect to the server's own host: 127.0.0.0/8, ::1, 0.0.0.0/8, `::`. */
  | 'loopback';

const DENIED: Readonly<Record<TenantHostAccess, ReadonlySet<HostReach>>> = {
  local: new Set(),
  deployed: new Set(['exec', 'metadata-network', 'loopback']),
};

/** Whether `level` refuses tenant configuration that needs `reach`. */
export function deniesHostReach(level: TenantHostAccess, reach: HostReach): boolean {
  return DENIED[level].has(reach);
}

/** `value` as a level, or `undefined` when it isn't one. */
export function parseTenantHostAccess(value: string): TenantHostAccess | undefined {
  return (TENANT_HOST_ACCESS_LEVELS as readonly string[]).includes(value)
    ? (value as TenantHostAccess)
    : undefined;
}

/** Why a stdio MCP endpoint is refused, the same at registration and at connect. */
export function stdioRefusal(endpointId: string): string {
  return `MCP endpoint "${endpointId}" uses the stdio transport, which runs a command on the server's host; KINDGI_TENANT_HOST_ACCESS=deployed refuses that. Run the MCP server over HTTP (streamable-http) instead.`;
}
