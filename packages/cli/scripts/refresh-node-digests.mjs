#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Print `NODE_BASE_IMAGES` (src/build/node-image.ts) with today's
 * digests: for each supported major, `node:<major>-bookworm-slim`'s
 * image index digest (every platform) and the Node version it runs.
 * Needs Docker. Paste the output over the table, and check the diff.
 *
 *   node scripts/refresh-node-digests.mjs
 */

import { execFileSync } from 'node:child_process';

const MAJORS = [22, 24];

const rows = MAJORS.map((major) => {
  const tag = `node:${major}-bookworm-slim`;
  const manifest = JSON.parse(
    execFileSync(
      'docker',
      ['buildx', 'imagetools', 'inspect', tag, '--format', '{{json .Manifest}}'],
      {
        encoding: 'utf8',
      },
    ),
  );
  const ref = `${tag}@${manifest.digest}`;
  const version = execFileSync('docker', ['run', '--rm', ref, 'node', '--version'], {
    encoding: 'utf8',
  })
    .trim()
    .replace(/^v/, '');
  return { major, version, ref };
});

const today = new Date().toISOString().slice(0, 10);
const entries = rows
  .map(
    (r) =>
      `  {\n    major: ${r.major},\n    version: '${r.version}',\n    ref: '${r.ref}',\n  },\n`,
  )
  .join('');
process.stdout.write(
  `/** \`node:<major>-bookworm-slim\`, pinned (image index digests, verified ${today}), oldest first. */
export const NODE_BASE_IMAGES: readonly NodeBaseImage[] = [
${entries}];
`,
);
