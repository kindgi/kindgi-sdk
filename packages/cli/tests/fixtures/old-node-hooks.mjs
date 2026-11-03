// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Load hooks for `old-node.mjs`: the built CLI may load its entry and the
// modules the entry's Node check needs, and Node's built-ins; anything else
// fails, because on an older Node it would load before the check's line.

const DIST = new URL('../../dist/', import.meta.url);
const BEFORE_THE_CHECK = new Set(
  ['cli.js', 'node-version.js', 'stop-signal.js', 'write-fully.js'].map(
    (file) => new URL(file, DIST).href,
  ),
);

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (!resolved.url.startsWith('node:') && !BEFORE_THE_CHECK.has(resolved.url)) {
    throw new Error(`${resolved.url} loads before the CLI's Node check`);
  }
  return resolved;
}
