// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { renderJson, renderTable } from '../output.js';
import { runSdkRendered } from './helpers.js';
import type { LeafCommand } from './types.js';

/** Both lists, empty when the deployment publishes none of that kind. */
interface Egress {
  readonly server: readonly string[];
  readonly deployments: readonly string[];
}

interface EgressRow {
  readonly calls: 'server' | 'deployments';
  readonly address: string;
}

/**
 * `kindgi egress`: the addresses this deployment's calls to other sites
 * come from, from `GET /v1/tenant`'s `egress`. They're the deployment's,
 * so any key answers the same. A runtime that publishes none, or one
 * from before `egress`, has no field: both lists are then empty.
 */
export const egressCommand: LeafCommand = {
  kind: 'leaf',
  name: 'egress',
  description:
    "Print the IP addresses this deployment's calls to other sites come from, for a site that admits only known addresses: the server's own calls (such as to MCP servers and model providers, and webhook deliveries) and calls made by your deployed code. Every tenant on the deployment calls from the same addresses, so keep your site's own credentials too. --json prints both lists.",
  usage: 'kindgi egress [--json]',
  run: (ctx) =>
    runSdkRendered(ctx, 'kindgi egress', async () => {
      const { egress } = await ctx.client().tenant.get();
      const lists: Egress = {
        server: egress?.server ?? [],
        deployments: egress?.deployments ?? [],
      };
      return ctx.globals.formatRequested && ctx.globals.format !== 'table'
        ? renderJson(lists, ctx.globals.format)
        : { stdout: egressText(lists), stderr: '' };
    }),
};

function egressText(lists: Egress): string {
  const rows: EgressRow[] = [
    ...lists.server.map((address) => ({ calls: 'server' as const, address })),
    ...lists.deployments.map((address) => ({ calls: 'deployments' as const, address })),
  ];
  if (rows.length === 0) return 'This deployment publishes no egress addresses.\n';
  const table = renderTable(rows, [
    { header: 'CALLS', get: (row) => row.calls },
    { header: 'ADDRESS', get: (row) => row.address },
  ]).stdout;
  return `${table}\nEvery tenant on this deployment calls from these addresses: admitting them admits all of their calls, so keep your site's own credentials too.\n`;
}
