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
 *
 * A path the pack names in another case than the disk has reads on a
 * disk that ignores case (macOS, Windows), and a build on Linux won't
 * find it: `misCasedPaths` finds those.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';

import { validateBlock } from '@kindgi/agents';
import {
  type IndexedBlock,
  type PackBlocks,
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

/** A folder's entry names, as `fs.readdir` gives them; tests pass their own. */
export type ReadFolder = (dir: string) => Promise<readonly string[]>;

/** A pack-relative path as the pack names it, and as the disk spells it. */
export interface MisCasedPath {
  readonly named: string;
  readonly onDisk: string;
}

/**
 * The paths among `relPaths` (pack-relative, `/`-separated) that name a
 * file in another case than the disk has. Each segment below `packDir` is
 * held to its folder's entries, each folder listed once: an exact name
 * passes (in NFC, so a name the disk keeps decomposed isn't a mismatch),
 * and one entry equal to it but for case is a mismatch. A segment with
 * neither isn't this check's: the reader refused a missing file already.
 */
export async function misCasedPaths(
  packDir: string,
  relPaths: readonly string[],
  readFolder: ReadFolder = (dir) => readdir(dir),
): Promise<MisCasedPath[]> {
  const root = resolve(packDir);
  const listed = new Map<string, Promise<readonly string[]>>();
  const list = (rel: string): Promise<readonly string[]> => {
    let names = listed.get(rel);
    if (names === undefined) {
      names = readFolder(rel === '' ? root : join(root, rel)).catch(() => []);
      listed.set(rel, names);
    }
    return names;
  };
  const spell = async (named: string): Promise<MisCasedPath | undefined> => {
    const onDisk: string[] = [];
    let misCased = false;
    for (const segment of named.split('/')) {
      // Listed by the disk's spelling so far: the folder as it is.
      const names = await list(onDisk.join('/'));
      const wanted = segment.normalize('NFC');
      const exact = names.find((name) => name.normalize('NFC') === wanted);
      if (exact !== undefined) {
        onDisk.push(exact);
        continue;
      }
      const folded = names.filter(
        (name) => name.normalize('NFC').toLowerCase() === wanted.toLowerCase(),
      );
      if (folded.length !== 1) return undefined;
      onDisk.push(folded[0] as string);
      misCased = true;
    }
    return misCased ? { named, onDisk: onDisk.join('/') } : undefined;
  };
  const found: MisCasedPath[] = [];
  for (const named of relPaths) {
    const spelled = await spell(named);
    if (spelled !== undefined) found.push(spelled);
  }
  return found;
}

/**
 * A line for each block file and template the pack names in another case
 * than the disk has (`misCasedPaths` on what the reader read). A block
 * file's path is the pattern's folder and the disk's names below it, so
 * its case is the pattern's: one line for the pattern. A template's is
 * its block's `content.templateFile`: a line for each block naming it.
 */
export async function misCasedBlockLines(
  packDir: string,
  pattern: string,
  read: PackBlocks,
  readFolder?: ReadFolder,
): Promise<string[]> {
  const misCased = await misCasedPaths(packDir, read.files, readFolder);
  if (misCased.length === 0) return [];
  const folder = blocksFolder(pattern);
  const depth = folder === '' ? 0 : folder.split('/').length;
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.every((s, i) => s.normalize('NFC') === b[i]?.normalize('NFC'));
  const blockFiles = new Set(read.blocks.map((b) => b.modulePath));
  const lines: string[] = [];
  let folderSaid = false;
  let namers: Promise<readonly TemplateNamer[]> | undefined;
  for (const { named, onDisk } of misCased) {
    const n = named.split('/');
    const d = onDisk.split('/');
    if (!folderSaid && !same(n.slice(0, depth), d.slice(0, depth))) {
      folderSaid = true;
      lines.push(
        `The blocks pattern "${pattern}" names ${n.slice(0, depth).join('/')}/, but the folder is ${d.slice(0, depth).join('/')}/.`,
      );
    }
    if (blockFiles.has(named) || same(n.slice(depth), d.slice(depth))) continue;
    namers ??= templateNamers(packDir, read.blocks);
    const by = (await namers).filter((t) => t.relPath === named);
    if (by.length === 0) {
      lines.push(`A block's \`content.templateFile\` names ${named}, but the file is ${onDisk}.`);
    }
    for (const t of by) {
      lines.push(
        `${t.blockFile}: \`content.templateFile\` "${t.templateFile}" names ${named}, but the file is ${onDisk}.`,
      );
    }
  }
  return lines;
}

/** A prompt block's template file: its block's file, the name it gives, and the path it names. */
interface TemplateNamer {
  readonly blockFile: string;
  readonly templateFile: string;
  readonly relPath: string;
}

/**
 * Each prompt block's `content.templateFile`, read again from its file
 * (the index holds the template's text, not its name), and the path it
 * names, resolved as the reader does: from the block's file.
 */
async function templateNamers(
  packDir: string,
  blocks: readonly IndexedBlock[],
): Promise<readonly TemplateNamer[]> {
  const namers: TemplateNamer[] = [];
  for (const block of blocks) {
    if (block.kind !== 'prompt') continue;
    let templateFile: unknown;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(packDir, block.modulePath), 'utf8'));
      templateFile = (parsed as { readonly content?: { readonly templateFile?: unknown } })
        .content?.templateFile;
    } catch {
      continue;
    }
    if (typeof templateFile !== 'string') continue;
    namers.push({
      blockFile: block.modulePath,
      templateFile,
      relPath: posix.normalize(posix.join(posix.dirname(block.modulePath), templateFile)),
    });
  }
  return namers;
}

/**
 * The pack's blocks after its local index (`kindgi build`): the indexer
 * read them, none is a secret-shaped file, each is named in the disk's
 * case, and each holds up.
 */
export async function checkPackBlocks(opts: {
  readonly packDir: string;
  readonly pattern: string;
  readonly indexPath: string;
  readonly blocksCounted: boolean;
  readonly indexer: string;
  readonly release: string;
  /** The folders' entry names, for the case check (default: the disk's). */
  readonly readFolder?: ReadFolder;
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
  const misCased = await misCasedBlockLines(opts.packDir, opts.pattern, read, opts.readFolder);
  if (misCased.length > 0) {
    return {
      kind: 'err',
      message: `The pack's blocks name files in another case than the disk has. Linux tells them apart, so a build on Linux won't find them. Name them as the disk does:\n${misCased.map((line) => `  ${line}`).join('\n')}`,
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
