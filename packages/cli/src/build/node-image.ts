// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The base image of a TypeScript pack image: `node:<major>-bookworm-slim`,
 * pinned by its image index digest (every platform: amd64 for Cloud
 * Run, arm64 for a laptop), for each Node major the CLI supports.
 *
 * The image is the oldest pinned one whose Node satisfies the host's
 * `engines.node`, so the image runs a Node the app declares (and an
 * `engine-strict` install accepts). No `engines.node`: the oldest.
 *
 * Refresh the table with `node scripts/refresh-node-digests.mjs`.
 */

import semver from 'semver';

export interface NodeBaseImage {
  readonly major: number;
  /** The Node version the pinned image runs. */
  readonly version: string;
  readonly ref: string;
}

/** `node:<major>-bookworm-slim`, pinned (image index digests, verified 2026-10-02), oldest first. */
export const NODE_BASE_IMAGES: readonly NodeBaseImage[] = [
  {
    major: 22,
    version: '22.23.3',
    ref: 'node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c',
  },
  {
    major: 24,
    version: '24.21.0',
    ref: 'node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6',
  },
];

export type NodeBaseImageOutcome =
  | { readonly kind: 'ok'; readonly image: NodeBaseImage }
  | { readonly kind: 'err'; readonly message: string };

/** The base image for a host whose `engines.node` is `range` (absent: none declared). */
export function nodeBaseImageFor(range: string | undefined): NodeBaseImageOutcome {
  const [oldest] = NODE_BASE_IMAGES;
  if (oldest === undefined) throw new Error('NODE_BASE_IMAGES is empty');
  if (range === undefined || range.trim() === '') return { kind: 'ok', image: oldest };
  if (semver.validRange(range) === null) {
    return { kind: 'err', message: `engines.node is "${range}", which isn't a semver range.` };
  }
  const image = NODE_BASE_IMAGES.find((i) => semver.satisfies(i.version, range));
  if (image !== undefined) return { kind: 'ok', image };
  return {
    kind: 'err',
    message: `engines.node is "${range}": a pack image runs Node ${NODE_BASE_IMAGES.map((i) => i.version).join(' or ')}, and the range admits neither.`,
  };
}
