// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

const DOCS = 'https://docs.kindgi.com';

/**
 * A docs page on `version`'s release line: `docs.kindgi.com/v<major>.<minor>/<path>`,
 * the line's latest release. The site's root moves on to the next line's
 * docs (and, during a release candidate, is still the last release's), so
 * a link a program shows names its own line: the CLI passes its version,
 * a console the runtime's. Without a version that is one (none, or a broken
 * install's `unknown`), the root.
 *
 * No dependencies: `@kindgi/client/sso-handoff` builds its guide links here.
 */
export function docsUrl(path: string, version?: string): string {
  const page = path.replace(/^\/+/, '');
  const line = version === undefined ? null : /^(\d+)\.(\d+)\./.exec(version);
  return line === null ? `${DOCS}/${page}` : `${DOCS}/v${line[1]}.${line[2]}/${page}`;
}
