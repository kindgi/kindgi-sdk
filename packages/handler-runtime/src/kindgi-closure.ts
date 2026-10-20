// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi-closure`, the two steps of a pack image that carries only what
 * the pack loads (`image.dependencies: 'loaded'`):
 *
 *   trim   the closure stage: write the trimmed tree (`pack-closure.ts`)
 *          and print what it kept and dropped
 *   check  the indexer stage, on the trimmed tree: import every package
 *          the bundles import by name, as they import it, so one loaded
 *          only lazily (`await import('sharp')` in a handler) and missing
 *          from the closure fails the build, never a run
 *
 * Its lines start with `kindgi-closure: `; `kindgi build` shows them.
 */

import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import {
  closureReport,
  computeClosure,
  formatClosureReport,
  writeClosure,
} from './pack-closure.js';

const run = promisify(execFile);

/** `dist/externals.json`, which `kindgi build` writes beside the bundles. */
export interface ExternalsFile {
  /** The packages the bundles import by name. */
  readonly packages: readonly string[];
  /** What the bundles import, as they import it (`@prisma/client/runtime/library`). */
  readonly specifiers: readonly string[];
}

interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const PREFIX = 'kindgi-closure: ';

const defaultIo: Io = {
  out: (line) => process.stdout.write(`${PREFIX}${line}\n`),
  err: (line) => process.stderr.write(`${PREFIX}${line}\n`),
};

export async function main(argv: readonly string[], io: Io = defaultIo): Promise<number> {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  if (options === undefined) {
    io.err(
      'usage: kindgi-closure trim --root <dir> --bundle-dir <dir> --externals <file> [--keep <name>]… [--keep-if-installed <name>]… --out <dir>',
    );
    io.err('       kindgi-closure check --bundle-dir <dir> --externals <file>');
    return 2;
  }
  if (command === 'trim') return trim(options, io);
  if (command === 'check') return check(options, io);
  io.err(`unknown command ${JSON.stringify(command)}: trim or check`);
  return 2;
}

interface Options {
  readonly root?: string;
  readonly bundleDir?: string;
  readonly externals?: string;
  readonly out?: string;
  readonly keep: readonly string[];
  readonly keepIfInstalled: readonly string[];
}

function parseOptions(args: readonly string[]): Options | undefined {
  const keep: string[] = [];
  const keepIfInstalled: string[] = [];
  const named: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === undefined || value === undefined || !flag.startsWith('--')) return undefined;
    if (flag === '--keep') keep.push(value);
    else if (flag === '--keep-if-installed') keepIfInstalled.push(value);
    else named[flag.slice(2)] = value;
  }
  return {
    ...(named.root !== undefined && { root: named.root }),
    ...(named['bundle-dir'] !== undefined && { bundleDir: named['bundle-dir'] }),
    ...(named.externals !== undefined && { externals: named.externals }),
    ...(named.out !== undefined && { out: named.out }),
    keep,
    keepIfInstalled,
  };
}

async function trim(options: Options, io: Io): Promise<number> {
  const { root, bundleDir, externals, out } = options;
  if (
    root === undefined ||
    bundleDir === undefined ||
    externals === undefined ||
    out === undefined
  ) {
    io.err('trim needs --root, --bundle-dir, --externals and --out');
    return 2;
  }
  const imported = await readExternals(externals);
  const closure = await computeClosure({
    root,
    bundleDir,
    externals: imported.packages,
    keep: options.keep,
    keepIfInstalled: options.keepIfInstalled,
  });
  if (closure.missing.length > 0) {
    for (const miss of closure.missing) {
      io.err(
        miss.reason === 'external'
          ? `${miss.name}: the pack's code imports it, and it isn't installed where Node looks from ${bundleDir}. Add it to the pack's package.json dependencies.`
          : `${miss.name} (image.keep): it isn't installed, from the bundles' folder or beside a package the image keeps. Check the name, or remove it from image.keep.`,
      );
    }
    return 1;
  }
  await writeClosure(closure, root, out);
  for (const name of closure.skipped)
    io.out(`${name} (an extension's keep) isn't installed, so it isn't kept`);
  for (const line of formatClosureReport(await closureReport(closure, root, dirname(bundleDir))))
    io.out(line);
  return 0;
}

async function check(options: Options, io: Io): Promise<number> {
  const { bundleDir, externals } = options;
  if (bundleDir === undefined || externals === undefined) {
    io.err('check needs --bundle-dir and --externals');
    return 2;
  }
  const outcome = await checkLoads((await readExternals(externals)).specifiers, bundleDir);
  for (const warning of outcome.warnings) io.out(warning);
  for (const miss of outcome.missing) {
    io.err(
      `${miss.specifier}: ${miss.message}. The image keeps only the packages the pack loads: add the one it needs to image.keep, or set image.dependencies: 'all'.`,
    );
  }
  return outcome.missing.length > 0 ? 1 : 0;
}

export interface LoadCheck {
  readonly missing: readonly { readonly specifier: string; readonly message: string }[];
  /** Loaded, but threw for another reason (not a missing package): said, and not a failure. */
  readonly warnings: readonly string[];
}

/**
 * Import each specifier as a module in `bundleDir` imports it: a plain
 * Node process runs a module written there for the check (removed after),
 * so the packages' own load-time code stays out of this process. A
 * missing module is a miss; any other error a module throws as it loads
 * is reported but passes: it isn't the closure's to fix.
 */
export async function checkLoads(
  specifiers: readonly string[],
  bundleDir: string,
): Promise<LoadCheck> {
  const loader = join(bundleDir, '.kindgi-load-check.mjs');
  const results = join(bundleDir, '.kindgi-load-check.json');
  await writeFile(loader, LOADER, 'utf8');
  try {
    await run(
      process.execPath,
      [loader, JSON.stringify([...new Set(specifiers)].sort()), results],
      {
        cwd: bundleDir,
        timeout: LOAD_CHECK_TIMEOUT_MS,
      },
    );
    const loaded = JSON.parse(await readFile(results, 'utf8')) as readonly LoadResult[];
    const missing: { specifier: string; message: string }[] = [];
    const warnings: string[] = [];
    for (const r of loaded) {
      if (r.ok) continue;
      if (r.code === 'ERR_MODULE_NOT_FOUND' || r.code === 'MODULE_NOT_FOUND') {
        missing.push({ specifier: r.specifier, message: r.message });
      } else {
        warnings.push(
          `${r.specifier} loaded with an error that isn't a missing package (${r.message}); not a closure miss`,
        );
      }
    }
    return { missing, warnings };
  } finally {
    await rm(loader, { force: true });
    await rm(results, { force: true });
  }
}

interface LoadResult {
  readonly specifier: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly message: string;
}

/** Long enough for a large native package to load on a slow builder. */
const LOAD_CHECK_TIMEOUT_MS = 120_000;

/** The check's own module: imports each specifier, writes the outcomes to a file (a package may print). */
const LOADER = `import { writeFileSync } from 'node:fs';
const [specifiers, out] = [JSON.parse(process.argv[2]), process.argv[3]];
const results = [];
for (const specifier of specifiers) {
  try {
    await import(specifier);
    results.push({ specifier, ok: true, message: '' });
  } catch (error) {
    const message = String(error?.message ?? error).split('\\n')[0];
    results.push({ specifier, ok: false, ...(typeof error?.code === 'string' && { code: error.code }), message });
  }
}
writeFileSync(out, JSON.stringify(results));
process.exit(0);
`;

async function readExternals(path: string): Promise<ExternalsFile> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ExternalsFile>;
  return {
    packages: Array.isArray(parsed.packages) ? parsed.packages : [],
    specifiers: Array.isArray(parsed.specifiers) ? parsed.specifiers : [],
  };
}
