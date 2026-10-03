// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi test` — run the pack's tests via vitest.
 *
 * Shells out to the pack's OWN installed vitest binary
 * (either `pnpm exec vitest` or `npx --no-install vitest`, picked at
 * production wire time). The CLI does NOT bundle a vitest version —
 * that would force upgrades on downstream packs whenever the CLI
 * upgrades.
 *
 * Ergonomic defaults:
 *   - Refuses to spawn without a `vitest.config.*` at the pack root
 *     (bare vitest would sweep the whole repo on dev machines).
 *   - `--watch` threads through as `--watch`. Everything else (except
 *     the CLI's own `--reporter` short-cut + `--path`) is verbatim
 *     pass-through after `--`.
 *   - Ctrl+C forwards to the child process (via `ctx.stopSignal`),
 *     matching `kindgi dev`.
 *
 * Every child-process side-effect flows through `TestRunners` so tests
 * substitute stubs; production wiring lives at
 * `packages/cli/src/test/defaults.ts`.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { KINDGI_CONFIG_FILENAMES } from '@kindgi/handler-runtime';

import type { CommandContext } from '../context.js';
import { renderJson } from '../output.js';
import type { CommandResult, LeafCommand } from './types.js';

export const testCommand: LeafCommand = {
  kind: 'leaf',
  name: 'test',
  description: "Run the pack's tests via vitest. Ergonomic wrapper over `vitest run`.",
  usage: 'kindgi test [--watch] [--reporter <name>] [--path <dir>] [-- <vitest-args>...]',
  optionSpec: {
    watch: {
      type: 'boolean',
      description: 'Run vitest in watch mode. By default the tests run once (`vitest run`).',
    },
    reporter: {
      type: 'string',
      description: "The vitest reporter to use (vitest's `--reporter`), e.g. `verbose` or `json`.",
    },
    path: {
      type: 'string',
      description:
        'The pack root, with a `kindgi.config.ts` and a `vitest.config.*`. Default: the current directory.',
    },
  },
  run: async (ctx): Promise<CommandResult> => runTestCommand(ctx),
};

export async function runTestCommand(ctx: CommandContext): Promise<CommandResult> {
  const runners = ctx.testRunners;
  if (runners === undefined) {
    return {
      kind: 'error',
      stderr:
        'Internal error: kindgi test requires test runners to be wired. ' +
        'Rebuild the CLI (`pnpm --filter @kindgi/cli build`).\n',
      exitCode: 1,
    };
  }

  const args = resolveArgs(ctx);

  // Confirm kindgi.config.ts sits at the pack root — same shape
  // kindgi dev / build use. Failing loud beats a cryptic vitest
  // error later.
  const configOk = await ensurePackConfig(args.packDir);
  if (!configOk) {
    return {
      kind: 'error',
      stderr: `kindgi test could not find a kindgi.config.ts at ${args.packDir}.\nRun \`kindgi init <pack-name>\` to scaffold a pack, or pass --path=<dir>.\n`,
      exitCode: 1,
    };
  }

  const hasConfig = await runners.hasVitestConfig({ packDir: args.packDir });
  if (!hasConfig) {
    return {
      kind: 'error',
      stderr: `kindgi test could not find a vitest config at ${args.packDir}.\nCreate one (e.g. \`vitest.config.ts\`) or \`cd\` into your pack root.\nThe two templates shipped with \`kindgi init\` ship one out of the box.\n`,
      exitCode: 1,
    };
  }

  const forwarded = buildForwardedArgs(args);

  const banner: string[] = [
    '',
    `  Running pack tests: ${args.packDir}`,
    `    Runner:    vitest (via pack's local install)`,
    `    Mode:      ${args.watch ? 'watch' : 'one-shot'}`,
    ...(args.reporter !== undefined ? [`    Reporter:  ${args.reporter}`] : []),
    ...(args.passthroughArgs.length > 0
      ? [`    Pass-through args: ${args.passthroughArgs.join(' ')}`]
      : []),
    '',
  ];

  const result = await runners.runTests({
    packDir: args.packDir,
    runner: 'vitest',
    args: forwarded,
    env: ctx.env,
    ...(ctx.stopSignal !== undefined && { signal: ctx.stopSignal }),
    onLog: (chunk: string) => {
      // Forward child output to stderr so JSON stdout stays clean.
      process.stderr.write(chunk);
    },
  });

  if (!result.spawned) {
    if (result.reason === 'runner-binary-not-found') {
      return {
        kind: 'error',
        stderr:
          'kindgi test could not find the vitest binary. ' +
          'Install it in your pack: `pnpm add -D vitest` (or `npm i -D vitest`).\n' +
          `The CLI does NOT bundle vitest — it uses the pack's own install.\n`,
        exitCode: 1,
      };
    }
    return {
      kind: 'error',
      stderr: `kindgi test failed to spawn the vitest runner (${result.resolvedBinary ?? 'unknown'}). Check your pack's install (\`pnpm install\`) and re-run.\n`,
      exitCode: 1,
    };
  }

  const summary = {
    packDir: args.packDir,
    runner: 'vitest' as const,
    resolvedBinary: result.resolvedBinary,
    watch: args.watch,
    ...(args.reporter !== undefined && { reporter: args.reporter }),
    passthroughArgs: args.passthroughArgs,
    exitCode: result.exitCode,
  };
  const rendered = renderJson(summary, ctx.globals.format);
  const stderr = `${banner.join('\n')}\n`;
  if (result.exitCode === 0) {
    return { kind: 'ok', rendered: { stdout: rendered.stdout, stderr } };
  }
  return {
    kind: 'ok',
    exitCode: result.exitCode,
    rendered: { stdout: rendered.stdout, stderr },
  };
}

// ---------------------------------------------------------------------
// Argument resolution
// ---------------------------------------------------------------------

interface ResolvedTestArgs {
  readonly packDir: string;
  readonly watch: boolean;
  readonly reporter: string | undefined;
  readonly passthroughArgs: readonly string[];
}

function resolveArgs(ctx: CommandContext): ResolvedTestArgs {
  const pathFlag = ctx.options.path;
  const rawPath = typeof pathFlag === 'string' && pathFlag !== '' ? pathFlag : ctx.cwd;
  const packDir = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);

  const watch = ctx.options.watch === true;
  const reporterFlag = ctx.options.reporter;
  const reporter =
    typeof reporterFlag === 'string' && reporterFlag !== '' ? reporterFlag : undefined;

  // node:util.parseArgs surfaces tokens after `--` as regular
  // positionals when `allowPositionals: true`. `kindgi test` treats
  // every positional as a pass-through vitest arg — the command has
  // no positional inputs of its own.
  const passthroughArgs = ctx.positionals;

  return { packDir, watch, reporter, passthroughArgs };
}

function buildForwardedArgs(args: ResolvedTestArgs): readonly string[] {
  const out: string[] = [];
  // vitest defaults to watch=true when invoked without subcommand; the
  // CLI's contract is one-shot unless `--watch` is set.
  if (args.watch) {
    out.push('--watch');
  } else {
    out.push('run');
  }
  if (args.reporter !== undefined) {
    out.push('--reporter', args.reporter);
  }
  out.push(...args.passthroughArgs);
  return out;
}

async function ensurePackConfig(packDir: string): Promise<boolean> {
  for (const c of KINDGI_CONFIG_FILENAMES) {
    try {
      await readFile(join(packDir, c), 'utf8');
      return true;
    } catch {
      // try next
    }
  }
  return false;
}
