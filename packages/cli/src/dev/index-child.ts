// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The indexer, as a child process of `kindgi dev`:
 *
 *   node index-child.js --pack <dir> --out <index.json> --bundle-map <map.json>
 *
 * It runs with the pack's environment (not the CLI's), so modules that
 * read env when imported behave as they will in the pack service, and
 * each run is a fresh process — no module cache carried between
 * generations. Each primitive's source file is imported as its bundle
 * (the map: source path → bundle path, relative to the pack root), while
 * the index records the source path.
 *
 * Prints one JSON line: the indexer's outcome. Self-contained (no
 * relative imports) so it also runs from source under Node's type
 * stripping.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runIndexer } from '@kindgi/handler-runtime';

function arg(name: string): string {
  const at = process.argv.indexOf(name);
  const value = at >= 0 ? process.argv[at + 1] : undefined;
  if (value === undefined) throw new Error(`index-child: ${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const packDir = resolve(arg('--pack'));
  const outputPath = resolve(arg('--out'));
  const bundleMap = JSON.parse(await readFile(arg('--bundle-map'), 'utf8')) as Record<
    string,
    string
  >;

  const outcome = await runIndexer({
    packDir,
    outputPath,
    importModule: (fileUrl: string) => {
      const source = relative(packDir, fileURLToPath(fileUrl)).split(sep).join('/');
      const bundle = bundleMap[source];
      if (bundle === undefined) return import(fileUrl);
      const abs = isAbsolute(bundle) ? bundle : resolve(packDir, bundle);
      return import(pathToFileURL(abs).href);
    },
  });
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
  process.stdout.write(
    `${JSON.stringify({ kind: 'err', error: { code: 'index-child-failed', message } })}\n`,
  );
  process.exitCode = 1;
});
