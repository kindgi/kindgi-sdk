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
