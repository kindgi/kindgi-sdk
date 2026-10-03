// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * How `kindgi dev` builds, indexes and runs a pack's code — by its
 * language (`packLanguage` of the pack's config).
 *
 *   - node:   esbuild bundles, the TypeScript indexer in a Node child, the
 *             Node pack service (`@kindgi/handler-runtime`).
 *   - python: no bundling, `python -m kindgi.pack index` and
 *             `python -m kindgi.pack serve` with the pack's own interpreter.
 *
 * Both run under the pack's environment (`devPackEnv`) and behind the same
 * supervisor and front, so the api-server never knows which it is.
 */

import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { PackLanguage } from '@kindgi/handler-runtime';

/** The pack's code: its language, and for Python the interpreter (an argv prefix). */
export type PackCode =
  | { readonly language: 'node' }
  | { readonly language: 'python'; readonly python: readonly [string, ...string[]] };

export const NODE_PACK_CODE: PackCode = { language: 'node' };

type Outcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'err'; readonly message: string };

/**
 * The interpreter that runs a Python pack:
 *
 *   1. `dev.python` in the config — a path, or an argv such as
 *      `["uv", "run", "python"]`;
 *   2. the pack's own virtualenv, `.venv/bin/python`;
 *   3. `python3` on `PATH`.
 */
export async function resolvePackPython(
  packDir: string,
  config: Readonly<Record<string, unknown>> | undefined,
): Promise<Outcome<readonly [string, ...string[]]>> {
  const dev = config?.dev;
  const configured =
    dev !== null && typeof dev === 'object' ? (dev as Record<string, unknown>).python : undefined;
  if (configured !== undefined) {
    const argv = typeof configured === 'string' ? [configured] : configured;
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((part): part is string => typeof part === 'string' && part !== '')
    ) {
      return {
        kind: 'err',
        message:
          '`dev.python` must be an interpreter path or a non-empty command list (e.g. ["uv", "run", "python"]).',
      };
    }
    return { kind: 'ok', value: argv as unknown as readonly [string, ...string[]] };
  }
  for (const candidate of [
    join(packDir, '.venv', 'bin', 'python'),
    join(packDir, '.venv', 'Scripts', 'python.exe'),
  ]) {
    try {
      await access(candidate);
      return { kind: 'ok', value: [candidate] };
    } catch {
      // next
    }
  }
  return { kind: 'ok', value: ['python3'] };
}

/** The pack code for a language, with the interpreter resolved for Python. */
export async function resolvePackCode(
  language: PackLanguage,
  packDir: string,
  config: Readonly<Record<string, unknown>> | undefined,
): Promise<Outcome<PackCode>> {
  if (language === 'node') return { kind: 'ok', value: NODE_PACK_CODE };
  const python = await resolvePackPython(packDir, config);
  if (python.kind === 'err') return python;
  return { kind: 'ok', value: { language: 'python', python: python.value } };
}

/**
 * Check the pack's Python can run pack code (`import kindgi.pack`), with the
 * pack's environment and from the pack's directory — so a missing
 * virtualenv or package is one clear line at boot instead of an indexer
 * failure.
 */
export async function checkPackPython(
  python: readonly [string, ...string[]],
  env: Readonly<Record<string, string>>,
  packDir?: string,
): Promise<Outcome<string>> {
  const [program, ...prefix] = python;
  const script =
    'import sys, kindgi.pack, kindgi; print(sys.version.split()[0], kindgi.__version__)';
  const { code, stdout, stderr, spawnError } = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    spawnError?: string;
  }>((resolve) => {
    const child = spawn(program, [...prefix, '-c', script], {
      env,
      ...(packDir !== undefined && { cwd: packDir }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.once('error', (cause) =>
      resolve({ code: null, stdout: out, stderr: err, spawnError: cause.message }),
    );
    child.once('close', (exit) => resolve({ code: exit, stdout: out, stderr: err }));
  });
  const shown = python.join(' ');
  if (spawnError !== undefined) {
    return { kind: 'err', message: `the pack's Python (${shown}) did not start: ${spawnError}` };
  }
  if (code !== 0) {
    const last = stderr.trim().split('\n').pop() ?? '';
    const shadow = packDir === undefined ? undefined : join(packDir, 'kindgi', '__init__.py');
    if (shadow !== undefined && (await isFile(shadow))) {
      return {
        kind: 'err',
        message: [
          `the pack's Python (${shown}) cannot import kindgi: ${last}`,
          `    ${shadow} makes the pack's kindgi/ folder a Python package named kindgi, which hides the kindgi SDK.`,
          "    Delete that __init__.py — kindgi/ only holds the pack's files; Kindgi imports them itself.",
        ].join('\n'),
      };
    }
    const lines = [
      `the pack's Python (${shown}) cannot import kindgi: ${last}`,
      "    Install the Kindgi Python SDK into the pack's environment (e.g. `uv add kindgi`, or `pip install kindgi`),",
      '    or point `dev.python` in [tool.kindgi] at an interpreter that has it.',
    ];
    return { kind: 'err', message: lines.join('\n') };
  }
  const [pythonVersion, kindgiVersion] = stdout.trim().split(/\s+/);
  return {
    kind: 'ok',
    value: `Python ${pythonVersion ?? '?'} · kindgi ${kindgiVersion ?? '?'} (${shown})`,
  };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
