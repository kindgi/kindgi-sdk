// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { join } from 'node:path';

/**
 * Where `kindgi dev` writes the pack index and the dev api-server reads
 * it — inside Kindgi's own `.kindgi/` (gitignored), never the pack root,
 * which may be an existing application's root.
 */
export function devIndexPath(packDir: string): string {
  return join(packDir, '.kindgi', 'dev', 'index.json');
}

/**
 * Where a re-index writes before the pack service has loaded it. It
 * becomes `devIndexPath` only once a pack service is serving that code,
 * so the api-server never lists tools whose code isn't running.
 */
export function devStagedIndexPath(packDir: string): string {
  return join(packDir, '.kindgi', 'dev', 'index.next.json');
}

/** Where `kindgi dev` bundles the pack's code. */
export function devDistDir(packDir: string): string {
  return join(packDir, '.kindgi', 'dev', 'dist');
}

/**
 * The staged index as the pack service reads it: the same index, with
 * each module path pointing at its bundle.
 */
export function devStagedPackIndexPath(packDir: string): string {
  return join(packDir, '.kindgi', 'dev', 'index.next.pack.json');
}

/** The source → bundle map the indexer child reads. */
export function devBundleMapPath(packDir: string): string {
  return join(packDir, '.kindgi', 'dev', 'bundle-map.json');
}

/**
 * Where `kindgi dev` keeps a Java pack's build files: the classpath Maven
 * resolved, the `@argfile` that passes it to \`java`, and the launcher
 * (`kindgi-pack-java`) extracted from the pack's own kindgi-pack jar.
 */
export function devJavaDir(packDir: string): string {
  return join(packDir, '.kindgi', 'dev', 'java');
}
