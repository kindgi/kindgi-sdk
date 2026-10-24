// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pack that brings data blocks (`blocks/`) deploys only to a runtime
 * whose deploy publishes them: one whose `/v1/openapi.json` lists
 * `deploy-publishes-pack-blocks` in `info["x-kindgi-capabilities"]`. An
 * earlier runtime reads no `blocks` from the image's index, and pins the
 * agents' blocks to the versions it already holds, so `kindgi deploy`
 * refuses before anything is built or sent. The list is open: a name
 * this CLI doesn't know is ignored.
 */

import { DEPLOY_PUBLISHES_PACK_BLOCKS } from '@kindgi/handler-runtime';

import type { CommandContext } from '../context.js';

/** Why the runtime at `endpoint` can't take the pack's blocks, or `undefined` when it can. */
export async function packBlocksRefusal(opts: {
  readonly endpoint: string;
  readonly fetchImpl: CommandContext['fetch'];
  readonly signal?: AbortSignal;
  /** What the pack brings, e.g. `blocks/: 2 files`. */
  readonly brought: string;
  /** The release whose runtime publishes them: this CLI's. */
  readonly release: string;
}): Promise<string | undefined> {
  const unread = (why: string) =>
    `Couldn't read what the runtime at ${opts.endpoint} does (GET /v1/openapi.json: ${why}), which a pack with blocks (${opts.brought}) needs before it deploys. Check the address, then deploy again.\n`;
  let listed: unknown;
  try {
    const res = await opts.fetchImpl(`${opts.endpoint.replace(/\/+$/, '')}/v1/openapi.json`, {
      method: 'GET',
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
    if (!res.ok) return unread(`HTTP ${res.status}`);
    const doc = (await res.json()) as { readonly info?: Readonly<Record<string, unknown>> } | null;
    listed = doc?.info?.['x-kindgi-capabilities'];
  } catch (err) {
    return unread((err as Error).message);
  }
  if (Array.isArray(listed) && listed.includes(DEPLOY_PUBLISHES_PACK_BLOCKS)) return undefined;
  return `The runtime at ${opts.endpoint} doesn't publish a pack's blocks (${opts.brought}); deploy to a runtime with Kindgi ${opts.release} or later, or remove them.\n`;
}
