// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Debian packages in a pack image — the one place that renders the
 * `apt-get` step, so every pack image installs them the same way.
 *
 * A pack declares them when its code needs programs or libraries outside
 * its language's packages (OCR, PDF tools, `libmagic`, …):
 *   - a Python pack: `[tool.kindgi.image] system-packages = [...]` in
 *     `pyproject.toml` — the Python spelling of the `aptGet` image
 *     extension (plan decision K8) a TypeScript pack configures under
 *     `image:` in `kindgi.config`;
 *   - the Node pack image renders the same step for `aptGet` (R3).
 *
 * Names are checked against Debian's package-name rules, with an optional
 * `=version` pin, so nothing else can reach the `RUN` line.
 */

/** `name` or `name=version`, as Debian policy allows them. */
const APT_PACKAGE = /^[a-z0-9][a-z0-9+.-]+(=[A-Za-z0-9.+~:-]+)?$/;

export type AptPackages =
  | { readonly kind: 'ok'; readonly packages: readonly string[] }
  | { readonly kind: 'err'; readonly message: string };

/** The declared packages, checked — `where` names the setting in messages. */
export function checkAptPackages(value: unknown, where: string): AptPackages {
  if (value === undefined) return { kind: 'ok', packages: [] };
  if (!Array.isArray(value) || !value.every((p): p is string => typeof p === 'string')) {
    return { kind: 'err', message: `${where} must be a list of Debian package names` };
  }
  const bad = value.filter((p) => !APT_PACKAGE.test(p));
  if (bad.length > 0) {
    return {
      kind: 'err',
      message: `${where}: not a Debian package name: ${bad.map((p) => JSON.stringify(p)).join(', ')}`,
    };
  }
  return { kind: 'ok', packages: [...new Set(value)].sort() };
}

/**
 * The Containerfile `RUN` step installing `packages` (checked by
 * `checkAptPackages`): one layer, no recommended extras, the package
 * lists removed after. Empty → no step.
 */
export function renderAptGetStep(packages: readonly string[]): string {
  if (packages.length === 0) return '';
  return [
    'RUN apt-get update \\',
    ` && apt-get install -y --no-install-recommends ${packages.join(' ')} \\`,
    ' && rm -rf /var/lib/apt/lists/*',
  ].join('\n');
}
