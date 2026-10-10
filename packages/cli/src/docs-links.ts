// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { CLI_VERSION } from './version-info.js';

const DOCS = 'https://docs.kindgi.com';

/**
 * A docs page on this CLI's release line: `docs.kindgi.com/v<major>.<minor>/<path>`,
 * the line's latest release. The site's root moves on to the next line's
 * docs (and, on a release candidate, is still the last release's), so a
 * link the CLI prints names its own line, as the skills it installs do
 * (`check:refs` holds both to it). A version that isn't one (a broken
 * install's `'unknown'`) links the root.
 *
 * Every docs link the CLI prints is built here.
 */
export function docsUrl(path: string, version: string = CLI_VERSION): string {
  const page = path.replace(/^\/+/, '');
  const line = /^(\d+)\.(\d+)\./.exec(version);
  return line === null ? `${DOCS}/${page}` : `${DOCS}/v${line[1]}.${line[2]}/${page}`;
}
