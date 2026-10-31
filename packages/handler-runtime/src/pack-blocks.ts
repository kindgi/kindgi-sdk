// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pack's data blocks: its prompts and settings, one JSON file each,
 * found by the blocks discovery pattern (`blocks/**\/*.json` by default).
 * A file holds the block as `kindgi blocks publish @<file>` takes it
 * (`id`, `version`, `kind`, `description`, `content`); a prompt may keep
 * its template in a file of its own (`content.templateFile`, relative to
 * the block's file and inside the blocks folder), read in here so the
 * index holds the whole block.
 *
 * Every indexer (this one, Python's, kindgi-pack's) checks the same:
 * the block's shape (`pack-index.schema.json` `$defs/block`), its
 * template file, and each id once. What needs the block engine (the
 * template parses as Liquid, the values satisfy their schema) is
 * `validateBlock`'s, which the CLI runs on the index and a deploy runs
 * again.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { globStaticPrefix, globToRegex } from './discovery.js';

/**
 * The capability a runtime's `/v1/openapi.json` lists in
 * `info["x-kindgi-capabilities"]` when its deploy publishes the data
 * blocks a pack brings (the index's `blocks`). A runtime without it reads
 * no `blocks`: it would pin an agent's blocks to what it already holds,
 * so the CLI refuses to deploy a pack with blocks to it.
 */
export const DEPLOY_PUBLISHES_PACK_BLOCKS = 'deploy-publishes-pack-blocks';

/** A data block as the index carries it (`pack-index.schema.json` `$defs/block`). */
export interface IndexedBlock {
  readonly id: string;
  readonly version: string;
  readonly kind: 'prompt' | 'settings';
  readonly description?: string;
  readonly content: Readonly<Record<string, unknown>>;
  /** The block's file, relative to the pack root. */
  readonly modulePath: string;
}

/** One block file the indexer refused, and why. */
export interface PackBlockError {
  readonly message: string;
  readonly filePath: string;
}

export interface PackBlocks {
  /** The blocks, sorted by id. */
  readonly blocks: readonly IndexedBlock[];
  /** Every file read, relative to the pack root: block files and template files, sorted. */
  readonly files: readonly string[];
  /** The files refused, in discovery order. */
  readonly errors: readonly PackBlockError[];
}

const ID = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const BLOCK_FIELDS = ['id', 'version', 'kind', 'description', 'content'];
const CONTENT_FIELDS = {
  prompt: ['template', 'templateFile', 'parameters'],
  settings: ['values', 'schema'],
} as const;

/** The folder a blocks pattern starts at, `''` for the pack root: template files stay inside it. */
export function blocksFolder(pattern: string): string {
  return globStaticPrefix(pattern);
}

/** Read the pack's blocks: each file the pattern matches, checked, its template file read in. */
export async function readPackBlocks(packDir: string, pattern: string): Promise<PackBlocks> {
  const root = path.resolve(packDir);
  const folder = blocksFolder(pattern);
  const found: string[] = [];
  await walk(root, folder, found, globToRegex(pattern));
  found.sort();

  const blocks: IndexedBlock[] = [];
  const files: string[] = [];
  const errors: PackBlockError[] = [];
  const owners = new Map<string, string>();
  for (const relPath of found) {
    const read = await readBlock(root, folder, relPath);
    if (read.kind === 'err') {
      errors.push({ message: `${relPath}: ${read.message}`, filePath: relPath });
      continue;
    }
    const owner = owners.get(read.block.id);
    if (owner !== undefined) {
      errors.push({
        message: `${relPath}: duplicate block '${read.block.id}' (also defined in ${owner}); a pack holds one version of each block`,
        filePath: relPath,
      });
      continue;
    }
    owners.set(read.block.id, relPath);
    blocks.push(read.block);
    files.push(relPath, ...read.templates);
  }
  blocks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { blocks, files: [...new Set(files)].sort(), errors };
}

type ReadBlock =
  | { readonly kind: 'ok'; readonly block: IndexedBlock; readonly templates: readonly string[] }
  | { readonly kind: 'err'; readonly message: string };

async function readBlock(root: string, folder: string, relPath: string): Promise<ReadBlock> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8(await fs.readFile(path.join(root, relPath))));
  } catch (cause) {
    return err(`not a JSON file (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  if (!isObject(parsed)) return err('a block file holds one JSON object: the block');
  const unknown = Object.keys(parsed).filter((k) => !BLOCK_FIELDS.includes(k));
  if (unknown.length > 0) {
    return err(
      `unknown field "${unknown[0]}" (a block has id, version, kind, description and content)`,
    );
  }
  const { id, version, kind, description, content } = parsed;
  if (typeof id !== 'string' || !ID.test(id)) {
    return err('`id` must be a dotted lowercase id, e.g. "acme.reply-prompt"');
  }
  if (typeof version !== 'string' || !VERSION.test(version)) {
    return err('`version` must be major.minor.patch, e.g. "1.0.0"');
  }
  if (kind !== 'prompt' && kind !== 'settings') {
    return err('`kind` must be "prompt" or "settings"');
  }
  if (description !== undefined && typeof description !== 'string') {
    return err('`description` must be a string');
  }
  if (!isObject(content)) return err('`content` must be an object');
  const unknownContent = Object.keys(content).filter(
    (k) => !(CONTENT_FIELDS[kind] as readonly string[]).includes(k),
  );
  if (unknownContent.length > 0) {
    return err(
      `unknown field "content.${unknownContent[0]}" (a ${kind} block's content has ${CONTENT_FIELDS[kind].join(', ')})`,
    );
  }

  const templates: string[] = [];
  let shown: Readonly<Record<string, unknown>> = content;
  if (kind === 'prompt') {
    const { templateFile, ...rest } = content;
    if (templateFile !== undefined) {
      if (rest.template !== undefined) {
        return err('give `content.template` or `content.templateFile`, not both');
      }
      const template = await readTemplate(root, folder, relPath, templateFile);
      if (template.kind === 'err') return template;
      templates.push(template.relPath);
      shown = { ...rest, template: template.text };
    }
    if (typeof shown.template !== 'string') {
      return err('a prompt needs `content.template` (a Liquid template) or `content.templateFile`');
    }
    if (shown.parameters !== undefined && !Array.isArray(shown.parameters)) {
      return err('`content.parameters` must be an array');
    }
  } else {
    if (!isObject(content.values)) return err('settings need `content.values`, an object');
    if (content.schema !== undefined && !isObject(content.schema)) {
      return err('`content.schema` must be a JSON Schema object');
    }
  }

  return {
    kind: 'ok',
    block: {
      id,
      version,
      kind,
      ...(description !== undefined && { description }),
      content: shown,
      modulePath: relPath,
    },
    templates,
  };
}

type ReadTemplate =
  | { readonly kind: 'ok'; readonly text: string; readonly relPath: string }
  | { readonly kind: 'err'; readonly message: string };

/**
 * A prompt's template file: relative to its block's file, inside the
 * blocks folder (what a pack image's indexer stage is given), and read
 * as UTF-8.
 */
async function readTemplate(
  root: string,
  folder: string,
  blockPath: string,
  templateFile: unknown,
): Promise<ReadTemplate> {
  if (typeof templateFile !== 'string' || templateFile.length === 0) {
    return err('`content.templateFile` must be a path relative to the block file');
  }
  if (path.posix.isAbsolute(templateFile) || templateFile.includes('\\')) {
    return err(
      `\`content.templateFile\` "${templateFile}" must be a path relative to the block file, with forward slashes`,
    );
  }
  const relPath = path.posix.normalize(
    path.posix.join(path.posix.dirname(blockPath), templateFile),
  );
  const inside =
    folder === ''
      ? relPath !== '..' && !relPath.startsWith('../')
      : relPath.startsWith(`${folder}/`);
  if (!inside) {
    return err(
      `\`content.templateFile\` "${templateFile}" is outside ${folder === '' ? 'the pack' : `the blocks folder (${folder}/)`}; keep a block's template next to it`,
    );
  }
  const abs = path.join(root, relPath);
  try {
    // Lexically inside isn't inside through a link: a link could put any
    // file of the machine's into the index, and so into a deploy.
    if ((await fs.lstat(abs)).isSymbolicLink()) {
      return err(
        `\`content.templateFile\` "${templateFile}" is a symbolic link; keep the template itself in the blocks folder`,
      );
    }
    return { kind: 'ok', text: utf8(await fs.readFile(abs)), relPath };
  } catch {
    return err(
      `\`content.templateFile\` "${templateFile}" isn't a readable UTF-8 file (looked for ${relPath})`,
    );
  }
}

/** A block's new version, as making an Improve candidate live under `kindgi dev` writes it. */
export interface PackBlockWrite {
  readonly id: string;
  readonly version: string;
  /** The whole content, a prompt's template text included. */
  readonly content: Readonly<Record<string, unknown>>;
}

export type PackBlockWriteOutcome =
  | {
      readonly kind: 'ok';
      /** The block's file, relative to the pack root. */
      readonly file: string;
      /** The template file written too, when the prompt keeps one. */
      readonly templateFile?: string;
      /** The version the file held before. */
      readonly replaced: string;
    }
  | {
      readonly kind: 'err';
      /** `not-in-pack`: no such block; `invalid`: the write doesn't fit it; `not-newer`: its version isn't past the file's. */
      readonly reason: 'not-in-pack' | 'invalid' | 'not-newer';
      readonly message: string;
    };

/**
 * Write a block's new version into the pack: its own file (found by id
 * among the pack's blocks, so only an existing file inside the blocks
 * folder, never a path a caller names), and a prompt's template into its
 * template file when it keeps one. The file keeps its other fields, its
 * order and its indentation. Each file is written whole and then renamed
 * into place, so a reader sees the old file or the new one.
 *
 * Refused: a block the pack doesn't have, content that doesn't fit the
 * block's kind, and a version that isn't past the file's (a write never
 * takes a block back, nor over a newer edit).
 */
export async function writePackBlock(
  packDir: string,
  pattern: string,
  write: PackBlockWrite,
): Promise<PackBlockWriteOutcome> {
  const refused = (reason: 'not-in-pack' | 'invalid' | 'not-newer', message: string) =>
    ({ kind: 'err', reason, message }) as const;
  if (!VERSION.test(write.version)) {
    return refused('invalid', '`version` must be major.minor.patch, e.g. "1.0.1"');
  }
  if (!isObject(write.content)) return refused('invalid', '`content` must be an object');
  const root = path.resolve(packDir);
  const folder = blocksFolder(pattern);
  const current = (await readPackBlocks(packDir, pattern)).blocks.find((b) => b.id === write.id);
  if (current === undefined) {
    return refused(
      'not-in-pack',
      `block "${write.id}" isn't in the pack's blocks folder: only a block the pack has is written`,
    );
  }
  if (compareVersions(write.version, current.version) <= 0) {
    return refused(
      'not-newer',
      `${current.modulePath} holds ${write.id} ${current.version} now, not older than ${write.version}: evaluate the change again from the pack's version`,
    );
  }
  const problem = contentProblem(current.kind, write.content);
  if (problem !== undefined) return refused('invalid', problem);

  const filePath = path.join(root, current.modulePath);
  const next = blockFileText(utf8(await fs.readFile(filePath)), current.kind, write);
  if (next.kind === 'err') return next;
  let templateFile: string | undefined;
  if (next.template !== undefined) {
    // The template stays in its own file, where the block's file points.
    const template = await readTemplate(root, folder, current.modulePath, next.template.file);
    if (template.kind === 'err') return refused('invalid', template.message);
    templateFile = template.relPath;
    await replaceFile(path.join(root, templateFile), next.template.text);
  }
  await replaceFile(filePath, next.text);
  return {
    kind: 'ok',
    file: current.modulePath,
    ...(templateFile !== undefined && { templateFile }),
    replaced: current.version,
  };
}

/** What a block's new version makes of its file's text (`blockFileText`). */
export type BlockFileText =
  | {
      readonly kind: 'ok';
      /** The block's file, with the new version and content. */
      readonly text: string;
      /**
       * For a prompt whose file keeps its template apart: the file's
       * `content.templateFile` as it names it (relative to the block's
       * file), and the new template text for that file.
       */
      readonly template?: { readonly file: string; readonly text: string };
      /** The version the file held. */
      readonly replaced: string;
    }
  | {
      readonly kind: 'err';
      /** `invalid`: the write doesn't fit the block, or the text isn't its file; `not-newer`: its version isn't past the file's. */
      readonly reason: 'invalid' | 'not-newer';
      readonly message: string;
    };

/**
 * A block's new version written into its file's `text`, without the
 * disk: `writePackBlock` writes the result into the pack, and the runtime
 * commits it to the pack's repository. The file keeps its other fields,
 * their order and its indentation. A prompt whose file names
 * `content.templateFile` keeps that field, and its template comes back
 * apart, for the caller to write into that file.
 *
 * Refused: content that doesn't fit `kind`, text that isn't this block's
 * file (another id or kind, or no `major.minor.patch` version), and a
 * version that isn't past the file's.
 */
export function blockFileText(
  text: string,
  kind: IndexedBlock['kind'],
  write: PackBlockWrite,
): BlockFileText {
  const refused = (reason: 'invalid' | 'not-newer', message: string) =>
    ({ kind: 'err', reason, message }) as const;
  if (!VERSION.test(write.version)) {
    return refused('invalid', '`version` must be major.minor.patch, e.g. "1.0.1"');
  }
  const problem = contentProblem(kind, write.content);
  if (problem !== undefined) return refused('invalid', problem);
  const raw = blockFileOf(text, kind, write.id);
  if (raw === undefined) {
    return refused(
      'invalid',
      `the text isn't the file of ${kind} block "${write.id}" with a major.minor.patch version`,
    );
  }
  if (compareVersions(write.version, raw.version) <= 0) {
    return refused(
      'not-newer',
      `the file holds ${write.id} ${raw.version}, not older than ${write.version}`,
    );
  }
  const rawContent = isObject(raw.content) ? raw.content : {};
  let content: Record<string, unknown> = { ...write.content };
  let template: { readonly file: string; readonly text: string } | undefined;
  if (kind === 'prompt' && typeof rawContent.templateFile === 'string') {
    const { template: templateText, ...rest } = write.content;
    content = { ...rest, templateFile: rawContent.templateFile };
    template = { file: rawContent.templateFile, text: String(templateText) };
  }
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    next[key] = key === 'version' ? write.version : key === 'content' ? content : value;
  }
  return {
    kind: 'ok',
    text: `${JSON.stringify(next, null, indentOf(text))}${text.endsWith('\n') ? '\n' : ''}`,
    ...(template !== undefined && { template }),
    replaced: raw.version,
  };
}

/** `text` as the file of block `id` of `kind`, with a `major.minor.patch` version; `undefined` when it isn't. */
function blockFileOf(
  text: string,
  kind: IndexedBlock['kind'],
  id: string,
): (Record<string, unknown> & { readonly version: string }) | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isObject(raw) &&
    raw.id === id &&
    raw.kind === kind &&
    typeof raw.version === 'string' &&
    VERSION.test(raw.version)
    ? (raw as Record<string, unknown> & { readonly version: string })
    : undefined;
}

/** Why `content` doesn't fit a block of `kind`; `undefined` when it does. */
function contentProblem(
  kind: IndexedBlock['kind'],
  content: Readonly<Record<string, unknown>>,
): string | undefined {
  if (!isObject(content)) return '`content` must be an object';
  const allowed = CONTENT_FIELDS[kind] as readonly string[];
  const extra = Object.keys(content).find((k) => k === 'templateFile' || !allowed.includes(k));
  if (extra !== undefined) return `"content.${extra}" doesn't fit a ${kind} block`;
  if (kind === 'prompt' && typeof content.template !== 'string') {
    return 'a prompt needs `content.template`';
  }
  if (kind === 'settings' && !isObject(content.values)) {
    return 'settings need `content.values`, an object';
  }
  return undefined;
}

/** `a` before, equal to, or after `b`: major.minor.patch, compared as numbers. */
function compareVersions(a: string, b: string): number {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The indentation a JSON file uses: its second line's leading spaces or tab, else two spaces. */
function indentOf(text: string): string | number {
  const second = text.split('\n')[1] ?? '';
  const lead = /^[ \t]+/.exec(second)?.[0];
  return lead === undefined ? 2 : lead;
}

/** Write a file whole beside it, under a dot name discovery skips, then rename it into place. */
async function replaceFile(target: string, text: string): Promise<void> {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.kindgi-write`);
  await fs.writeFile(temp, text, 'utf8');
  await fs.rename(temp, target);
}

/** Bytes as UTF-8, refusing anything else (as Python's and Java's indexers do). */
function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function err(message: string): { readonly kind: 'err'; readonly message: string } {
  return { kind: 'err', message };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The files under `rel` the pattern matches, skipping `node_modules` and dot folders as discovery does. */
async function walk(root: string, rel: string, out: string[], regex: RegExp): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(rel === '' ? root : path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    // A link is never followed (`Dirent` describes the link itself).
    if (entry.isDirectory()) await walk(root, child, out, regex);
    else if (entry.isFile() && regex.test(child)) out.push(child);
  }
}
