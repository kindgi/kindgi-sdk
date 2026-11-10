// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi prepare` — Kindgi Cloud's own build step: `kindgi build`'s pack
 * steps (index, bundle, Containerfile, tar) as one call, over a tree whose
 * dependencies are already installed. It writes `pack.tgz` and
 * `expected-index.json` under `--out`, and stdout is one JSON line naming
 * them. It never sends the pack anywhere, never checks an image and never
 * signs: Kindgi Cloud does those.
 *
 * Hidden (`LeafCommand.hidden`): `--help`, the reference and their
 * suggestions leave it out. A self-hosted runtime builds with
 * `kindgi build`.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { type ProgressLines, progressLines } from '../progress-lines.js';
import {
  DEFAULT_OUT_DIR,
  PATH_OPTION,
  VERSION_OPTIONS,
  prepareTarball,
  resolvePackArgs,
  withBanner,
} from './build.js';
import type { CommandResult, LeafCommand } from './types.js';

export const prepareCommand: LeafCommand = {
  kind: 'leaf',
  name: 'prepare',
  description:
    "Kindgi Cloud's own build step: indexes the pack and writes `pack.tgz` and `expected-index.json` under `--out`. " +
    'Not for self-hosted runtimes yet: build with `kindgi build`.',
  hidden: true,
  usage:
    'kindgi prepare --target <t> [--out <dir>] [--artifact-version <v>] [--published-at <iso>] [--path <dir>]',
  optionSpec: {
    target: {
      type: 'string',
      description: 'The build target, set in the image build. Required.',
    },
    out: {
      type: 'string',
      description: `Where \`pack.tgz\` and \`expected-index.json\` go (default: \`${DEFAULT_OUT_DIR}\`). It cannot be the pack root or a directory containing it; for a TypeScript pack it must stay under the pack root.`,
    },
    ...VERSION_OPTIONS,
    ...PATH_OPTION,
  },
  run: async (ctx): Promise<CommandResult> =>
    runPrepare(ctx, progressLines(ctx.progress, ctx.globals.format === 'quiet')),
};

/**
 * The pack steps, then one JSON line on stdout:
 * `{ packTgz, sha256, size, expectedIndex, counts }`. Progress goes to
 * stderr. A pack whose install needs build secrets (a private registry) is
 * refused before anything is written under `--out`: Kindgi Cloud's build
 * gets none.
 */
export async function runPrepare(ctx: CommandContext, out: ProgressLines): Promise<CommandResult> {
  const targetFlag = ctx.options.target;
  if (typeof targetFlag !== 'string' || targetFlag === '') {
    throw new UsageError(
      'kindgi prepare needs --target <t>: the build target set in the image build.',
    );
  }
  const runners = ctx.buildRunners;
  if (runners === undefined) {
    return {
      kind: 'error',
      stderr:
        'Internal error: kindgi prepare requires build runners to be wired. ' +
        'Rebuild the CLI (`pnpm --filter @kindgi/cli build`).\n',
      exitCode: 1,
    };
  }
  const parsed = await resolvePackArgs(ctx, targetFlag);
  if (parsed.kind === 'error') return parsed;
  const args = parsed.args;

  out.line('');
  out.line(`  Target:      ${args.buildTarget}`);
  out.line(`  Output:      ${args.outDir}`);
  out.line('');

  const expectedIndex = join(args.outDir, 'expected-index.json');
  await mkdir(args.outDir, { recursive: true });
  const prepared = await prepareTarball(ctx, runners, args, expectedIndex, out, 'refuse');
  if (prepared.kind === 'error') return withBanner(prepared, out);
  const result = {
    packTgz: prepared.tarball.path,
    sha256: prepared.tarballHash,
    size: prepared.tarball.size,
    expectedIndex,
    counts: prepared.counts,
  };
  return {
    kind: 'ok',
    rendered: { stdout: `${JSON.stringify(result)}\n`, stderr: out.kept() },
  };
}
