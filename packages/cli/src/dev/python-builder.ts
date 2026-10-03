// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The `PackBuilder` of a Python pack. Python runs its sources, so a build
 * produces no bundles (an empty bundle map); what it does is the job the
 * bundler's parse does for a Node pack: compile every `.py` file under the
 * pack root with the pack's own interpreter and report syntax errors
 * located `file:line:col`. A build with errors leaves the previous pack
 * service and index in place, as a bundle error does.
 *
 * The watch covers any `.py` file under the pack root — shared modules
 * outside the discovery folders included — and `pyproject.toml`.
 */

import { spawn } from 'node:child_process';
import { type FSWatcher, watch } from 'node:fs';

import type { PackBuild, PackBuilder } from './runners.js';

const SKIPPED_DIRS = ['__pycache__', 'node_modules', 'venv', 'site-packages'];
const DEFAULT_DEBOUNCE_MS = 150;

/**
 * Compiles every source under the pack root (argv[1]); prints a JSON list of
 * `{file, line, col, message}` for the ones that don't. Self-contained:
 * nothing of the pack is imported.
 */
const COMPILE_SCRIPT = `
import json, os, sys
root = sys.argv[1]
skip = set(${JSON.stringify(SKIPPED_DIRS)})
errors = []
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d not in skip)
    for name in sorted(filenames):
        if not name.endswith(".py") or name.startswith("."):
            continue
        path = os.path.join(dirpath, name)
        rel = os.path.relpath(path, root).replace(os.sep, "/")
        try:
            with open(path, "rb") as f:
                compile(f.read(), rel, "exec", dont_inherit=True)
        except SyntaxError as e:
            errors.append({"file": rel, "line": e.lineno or 0, "col": e.offset or 0, "message": f"{type(e).__name__}: {e.msg}"})
        except (ValueError, OSError) as e:
            errors.append({"file": rel, "line": 0, "col": 0, "message": f"{type(e).__name__}: {e}"})
print(json.dumps(errors))
`;

export interface PythonPackBuilderOptions {
  readonly packDir: string;
  /** The pack's interpreter (an argv prefix). */
  readonly python: readonly [string, ...string[]];
  /** The pack's environment. */
  readonly env: () => Promise<Readonly<Record<string, string>>>;
  readonly debounceMs?: number;
  /** Test seam: `node:fs.watch`. */
  readonly watchFs?: typeof watch;
}

/** Whether a change to `relPath` (relative to the pack root) is a change to the pack's code. */
export function isPythonSourceChange(relPath: string): boolean {
  const segments = relPath.split(/[\\/]/);
  const dirs = segments.slice(0, -1);
  if (dirs.some((s) => s.startsWith('.') || SKIPPED_DIRS.includes(s))) return false;
  const name = segments[segments.length - 1] ?? '';
  return relPath === 'pyproject.toml' || (name.endsWith('.py') && !name.startsWith('.'));
}

export function createPythonPackBuilder(options: PythonPackBuilderOptions): PackBuilder {
  const watchFs = options.watchFs ?? watch;
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function build(): Promise<PackBuild> {
    const [program, ...prefix] = options.python;
    const env = await options.env();
    const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(program, [...prefix, '-c', COMPILE_SCRIPT, options.packDir], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.once('error', (cause) => resolve({ code: null, stdout, stderr: cause.message }));
        child.once('close', (code) => resolve({ code, stdout, stderr }));
      },
    );
    let errors: { file: string; line: number; col: number; message: string }[];
    try {
      errors = JSON.parse(run.stdout.trim().split('\n').pop() ?? '') as typeof errors;
    } catch {
      return {
        kind: 'err',
        errors: [
          `the pack's Python could not check the sources (${run.code}): ${run.stderr.trim()}`,
        ],
      };
    }
    if (errors.length > 0) {
      return {
        kind: 'err',
        errors: errors.map((e) => `${e.file}:${e.line}:${e.col}: ${e.message}`),
      };
    }
    return { kind: 'ok', bundleMap: {} };
  }

  return {
    build,
    async watch(onBuild) {
      if (watcher !== undefined) return;
      watcher = watchFs(options.packDir, { recursive: true }, (_event, filename) => {
        if (filename === null || !isPythonSourceChange(filename.toString())) return;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          void build().then(onBuild);
        }, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
      });
    },
    // New or removed files need no entry list: the next build sees what is there.
    syncEntries: () => Promise.resolve(false),
    async dispose() {
      if (timer !== undefined) clearTimeout(timer);
      watcher?.close();
      watcher = undefined;
    },
  };
}
