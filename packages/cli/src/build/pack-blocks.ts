// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pack's data blocks (`blocks/`) at `kindgi build` and in `kindgi dev`.
 *
 * The indexer reads them (`readPackBlocks`, in every language's indexer)
 * and refuses a file it can't read as a block. What needs the block
 * engine is checked here, on the index: each prompt's template parses as
 * Liquid, each settings block's values satisfy its schema
 * (`validateBlock`), as `kindgi blocks publish` and a deploy check them
 * on the server.
 *
 * A Python or JVM pack's indexer is the pack's own `kindgi` package; one
 * from before blocks reads none, so a pack that has some is refused
 * rather than built without them.
 */

import { readFile } from 'node:fs/promises';

import { validateBlock } from '@kindgi/agents';
import {
  type IndexedBlock,
  type PackLanguage,
  blocksFolder,
  readPackBlocks,
} from '@kindgi/handler-runtime';

import { forbiddenReason } from './context-files.js';

/** One thing `validateBlock` refuses in a block, and the block's file. */
export interface BlockProblem {
  readonly filePath: string;
  readonly message: string;
}

/** Each issue `validateBlock` finds in the index's blocks, by file (the index orders blocks by id). */
export function blockProblems(blocks: readonly IndexedBlock[]): BlockProblem[] {
  const problems: BlockProblem[] = [];
  for (const { modulePath, ...definition } of blocks) {
    const checked = validateBlock(definition);
    if (checked.kind === 'ok') continue;
    for (const issue of checked.error.issues) {
      problems.push({
        filePath: modulePath,
        message: `${issue.message}${issue.path === '' ? '' : ` (at ${issue.path})`}`,
      });
    }
  }
  return problems.sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));
}

/** The blocks an index holds (none when it has no `blocks`). */
export function blocksOf(index: unknown): readonly IndexedBlock[] {
  const blocks = (index as { readonly blocks?: unknown } | null)?.blocks;
  return Array.isArray(blocks) ? (blocks as IndexedBlock[]) : [];
}

/**
 * Why the pack's indexer leaves its blocks out, or `undefined`: the pack
 * has block files, but the indexer's report counts no blocks, so it's
 * from before blocks in a pack.
 */
export async function indexerPredatesBlocks(opts: {
  readonly packDir: string;
  /** The blocks discovery pattern, defaults filled in. */
  readonly pattern: string;
  /** Whether the indexer's report has a `blocks` count. */
  readonly blocksCounted: boolean;
  /** The pack's indexer, e.g. "the pack's `kindgi` Python package". */
  readonly indexer: string;
  /** The release that reads blocks: this CLI's. */
  readonly release: string;
}): Promise<string | undefined> {
  if (opts.blocksCounted) return undefined;
  const read = await readPackBlocks(opts.packDir, opts.pattern);
  const found = new Set([...read.files, ...read.errors.map((e) => e.filePath)]).size;
  if (found === 0) return undefined;
  return `The pack has blocks (${describeFiles(opts.pattern, found)}), but ${opts.indexer} reads none: it's from before blocks in a pack. Upgrade it to Kindgi ${opts.release} or later.`;
}

/** The indexer a pack of this language runs, for `indexerPredatesBlocks`. */
export function packIndexerName(language: PackLanguage): string {
  if (language === 'python') return "the pack's `kindgi` Python package";
  if (language === 'java' || language === 'scala') return "the pack's com.kindgi:kindgi-pack";
  return "this CLI's indexer";
}

export type PackBlocksCheck =
  | {
      readonly kind: 'ok';
      /** The block files and their templates, pack-relative: what an image's indexer reads. */
      readonly files: readonly string[];
    }
  | { readonly kind: 'err'; readonly message: string };

/**
 * The pack's blocks after its local index (`kindgi build`): the indexer
 * read them, none is a secret-shaped file, and each holds up.
 */
export async function checkPackBlocks(opts: {
  readonly packDir: string;
  readonly pattern: string;
  readonly indexPath: string;
  readonly blocksCounted: boolean;
  readonly indexer: string;
  readonly release: string;
}): Promise<PackBlocksCheck> {
  const predates = await indexerPredatesBlocks(opts);
  if (predates !== undefined) return { kind: 'err', message: predates };
  const read = await readPackBlocks(opts.packDir, opts.pattern);
  if (read.files.length === 0) return { kind: 'ok', files: [] };
  const refused = read.files
    .map((rel) => ({ rel, reason: forbiddenReason(rel) }))
    .filter((f) => f.reason !== undefined);
  if (refused.length > 0) {
    return {
      kind: 'err',
      message: `Refusing to put these block files in the image: ${refused.map((f) => `${f.rel} (${f.reason})`).join(', ')}. Rename them.`,
    };
  }
  const problems = blockProblems(blocksOf(JSON.parse(await readFile(opts.indexPath, 'utf8'))));
  if (problems.length > 0) {
    return {
      kind: 'err',
      message: `The pack's blocks don't hold up — fix them before building:\n${problems.map((p) => `  ${p.filePath}: ${p.message}`).join('\n')}`,
    };
  }
  return { kind: 'ok', files: read.files };
}

/** `blocks/: 2 files`: the pattern's folder (the pattern, at the pack root) and a count. */
export function describeFiles(pattern: string, count: number): string {
  const folder = blocksFolder(pattern);
  return `${folder === '' ? pattern : `${folder}/`}: ${count} ${count === 1 ? 'file' : 'files'}`;
}
