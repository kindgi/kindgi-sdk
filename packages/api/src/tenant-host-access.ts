// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * How far tenant configuration may reach into the server's own host and
 * network: `KINDGI_TENANT_HOST_ACCESS`. A token holder registers things
 * (MCP endpoints, providers, webhooks) the server then acts on; some of
 * them can act on the host itself, which only a single-user machine
 * should allow.
 *
 *   - `local` (the default under `KINDGI_DEV`): a developer's machine.
 *     Tenant configuration may run commands on the host.
 *   - `deployed` (the default otherwise): a stdio MCP endpoint, which
 *     runs its command in the server's container as the server's user,
 *     is refused at registration and at connect; and the server's
 *     outbound calls to hosts a tenant chose (an MCP endpoint, a model
 *     provider's base URL, an HTTP tool, an image registry) refuse the
 *     cloud metadata endpoints and the server's own host.
 *   - `isolated`: a server whose tenants don't trust one another. All
 *     that `deployed` refuses, plus the private networks the server sits
 *     on, and the server's own cloud credentials: a model provider can't
 *     sign in as the server.
 *
 * Checks ask `deniesHostReach(level, reach)`, never compare levels, so a
 * stricter level (or a new kind of reach) is one more row or entry here.
 */

/** The levels, least strict first. */
export const TENANT_HOST_ACCESS_LEVELS = ['local', 'deployed', 'isolated'] as const;

export type TenantHostAccess = (typeof TENANT_HOST_ACCESS_LEVELS)[number];

/** What tenant configuration can make the server do on its own host. */
export type HostReach =
  /** Run a command: a `stdio` MCP endpoint. */
  | 'exec'
  /**
   * Connect to a cloud metadata endpoint, which hands out the server's own
   * credentials or its host's configuration: link-local (169.254.0.0/16,
   * fe80::/10) and those that clouds serve outside it (168.63.129.16,
   * 100.100.100.200, fd00:ec2::254, fd00:ec2::23, fd20:ce::254,
   * fd00:a9fe:a9fe::1, fd00:42::42), or to an address no tenant has a
   * reason to reach: multicast, reserved, documentation and the like.
   */
  | 'metadata-network'
  /** Connect to the server's own host: 127.0.0.0/8, ::1, 0.0.0.0/8, `::`. */
  | 'loopback'
  /**
   * Connect to a private network address: 10.0.0.0/8, 172.16.0.0/12,
   * 192.168.0.0/16, CGNAT 100.64.0.0/10, IPv6 unique-local fc00::/7 and
   * the deprecated site-local fec0::/10.
   */
  | 'private-network'
  /**
   * Sign in as the server: with credentials its environment holds
   * (Google's Application Default Credentials, for a Gemini provider on
   * Vertex AI with no key) or as its own cloud identities (Azure OpenAI's
   * `entra`, Bedrock's `aws-identity`).
   */
  | 'server-credentials';

const DENIED: Readonly<Record<TenantHostAccess, ReadonlySet<HostReach>>> = {
  local: new Set(),
  deployed: new Set(['exec', 'metadata-network', 'loopback']),
  isolated: new Set([
    'exec',
    'metadata-network',
    'loopback',
    'private-network',
    'server-credentials',
  ]),
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

/** Why a stdio MCP endpoint is refused at `level`, the same at registration and at connect. */
export function stdioRefusal(endpointId: string, level: TenantHostAccess): string {
  return `MCP endpoint "${endpointId}" uses the stdio transport, which runs a command on the server's host; KINDGI_TENANT_HOST_ACCESS=${level} refuses that. Run the MCP server over HTTP (streamable-http) instead.`;
}
