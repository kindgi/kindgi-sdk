// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi dev`'s warning for what `kindgi build` refuses: a package the
 * pack's code imports that its `package.json` lists only in
 * `devDependencies`. It loads here, from the app's `node_modules`, but a
 * deployed pack installs production dependencies only, so it's missing
 * there.
 *
 * Every build a refresh loads is checked, by the build's own rule
 * (`devOnlyImports`), against the pack's dependencies, read again each
 * time as the build reads them (`readPackDependencies`). A package is
 * warned about when it becomes a dev-only import, not again on every
 * save; one that stops being one (moved to `dependencies`, or no longer
 * imported) is reported once. A Python pack has no `node_modules` and
 * isn't checked.
 */

import { devOnlyImports, readPackDependencies } from '../build/host-install.js';
import type { ExternalPackage } from './runners.js';

/** At most this many importing files are named per package. */
const NAMED_IMPORTERS = 3;

export interface DevOnlyImportsCheck {
  /**
   * Check a build's externals: the lines to print, a warning for the
   * packages that just became dev-only imports and a note for those that
   * stopped being ones. Nothing when the set is unchanged.
   */
  check(externals: readonly ExternalPackage[]): Promise<readonly string[]>;
  /** The dev-only imports as of the last check, with the files importing each. */
  current(): readonly ExternalPackage[];
}

export function createDevOnlyImportsCheck(packDir: string): DevOnlyImportsCheck {
  let current: readonly ExternalPackage[] = [];
  return {
    async check(externals) {
      const deps = await readPackDependencies(packDir);
      const names = externals.map((e) => e.name);
      const devOnly = devOnlyImports(names, deps);
      const next = externals.filter((e) => devOnly.includes(e.name));
      const known = new Set(current.map((e) => e.name));
      const added = next.filter((e) => !known.has(e.name));
      const gone = current.filter((e) => !devOnly.includes(e.name)).map((e) => e.name);
      current = next;
      return [
        ...(added.length > 0 ? [describeDevOnlyImports(added)] : []),
        ...(gone.length > 0
          ? [`✓ The pack no longer imports ${gone.join(', ')} from devDependencies only.`]
          : []),
      ];
    },
    current: () => current,
  };
}

/** The warning for packages the pack imports that `package.json` lists only in devDependencies. */
export function describeDevOnlyImports(found: readonly ExternalPackage[]): string {
  const one = found.length === 1;
  const named = found.map((f) => `${f.name}${importedIn(f.importers)}`).join(', ');
  return `⚠ The pack imports ${named}, which package.json lists only in devDependencies: a deployed pack installs production dependencies only, so ${one ? 'it' : 'they'} won't load there. Move ${one ? 'it' : 'them'} to dependencies (kindgi build refuses until then).`;
}

/** ` (in tools/a.ts, lib/db.ts)`; at most `NAMED_IMPORTERS`, then how many more. */
function importedIn(importers: readonly string[]): string {
  if (importers.length === 0) return '';
  const named = importers.slice(0, NAMED_IMPORTERS).join(', ');
  const more = importers.length - NAMED_IMPORTERS;
  return ` (in ${named}${more > 0 ? ` and ${more} more` : ''})`;
}
