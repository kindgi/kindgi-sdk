// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pack's data blocks (`pack-blocks.ts`): one JSON file each, read into
 * the index with a prompt's template file inlined, and refused per file.
 * The Python (`sdks/python/tests/test_pack_blocks.py`) and Java
 * (`PackBlocksTest`) indexers are held to the same cases and messages.
 */

import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as addFormatsModule from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runIndexer } from '../src/kindgi-index.js';
import { readPackBlocks } from '../src/pack-blocks.js';

const addFormats = ((addFormatsModule as { default?: unknown }).default ??
  addFormatsModule) as unknown as (ajv: Ajv2020) => void;
const specAjv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
addFormats(specAjv);
const validateIndexSpec = specAjv.compile(
  JSON.parse(
    await fs.readFile(
      createRequire(import.meta.url).resolve('@kindgi/specs/pack-index.schema.json'),
      'utf8',
    ),
  ) as object,
);

const BLOCKS = 'blocks/**/*.json';

let packDir: string;

beforeEach(async () => {
  packDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindgi-pack-blocks-'));
});

afterEach(async () => {
  await fs.rm(packDir, { recursive: true, force: true });
});

async function write(files: Readonly<Record<string, string | Uint8Array>>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(packDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const prompt = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'acme.reply-prompt',
  version: '1.2.0',
  kind: 'prompt',
  description: 'How the support agent replies',
  content: { template: 'Reply to {{ customer_name }}.', parameters: [] },
  ...overrides,
});

const settings = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'acme.reply-style',
  version: '1.0.0',
  kind: 'settings',
  content: {
    values: { tone: 'warm' },
    schema: { type: 'object', properties: { tone: { type: 'string' } } },
  },
  ...overrides,
});

describe('readPackBlocks', () => {
  test('reads each block file, sorted by id, naming its file', async () => {
    await write({
      'blocks/style.json': json(settings()),
      'blocks/support/reply.json': json(prompt()),
    });
    const read = await readPackBlocks(packDir, BLOCKS);
    expect(read.errors).toEqual([]);
    expect(read.blocks).toEqual([
      { ...prompt(), modulePath: 'blocks/support/reply.json' },
      { ...settings(), modulePath: 'blocks/style.json' },
    ]);
    expect(read.files).toEqual(['blocks/style.json', 'blocks/support/reply.json']);
  });

  test("a prompt's templateFile is read in, relative to its block file", async () => {
    await write({
      'blocks/support/reply.json': json(
        prompt({ content: { templateFile: 'reply.liquid', parameters: [] } }),
      ),
      'blocks/support/reply.liquid': 'Reply to {{ customer_name }}.\nKeep it short.\n',
    });
    const read = await readPackBlocks(packDir, BLOCKS);
    expect(read.errors).toEqual([]);
    expect(read.blocks[0]?.content).toEqual({
      template: 'Reply to {{ customer_name }}.\nKeep it short.\n',
      parameters: [],
    });
    expect(read.files).toEqual(['blocks/support/reply.json', 'blocks/support/reply.liquid']);
  });

  test('a template file may sit elsewhere in the blocks folder, and its byte order mark is dropped', async () => {
    await write({
      'blocks/support/reply.json': json(
        prompt({ content: { templateFile: '../templates/reply.liquid' } }),
      ),
      'blocks/templates/reply.liquid': new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        ...new TextEncoder().encode('Hi.'),
      ]),
    });
    const read = await readPackBlocks(packDir, BLOCKS);
    expect(read.errors).toEqual([]);
    expect(read.blocks[0]?.content).toEqual({ template: 'Hi.' });
  });

  test.each([
    [
      'both template and templateFile',
      { template: 'x', templateFile: 'reply.liquid' },
      'blocks/reply.json: give `content.template` or `content.templateFile`, not both',
    ],
    [
      'a missing template file',
      { templateFile: 'nope.liquid' },
      'blocks/reply.json: `content.templateFile` "nope.liquid" isn\'t a readable UTF-8 file (looked for blocks/nope.liquid)',
    ],
    [
      'a template file outside the blocks folder',
      { templateFile: '../secrets.txt' },
      'blocks/reply.json: `content.templateFile` "../secrets.txt" is outside the blocks folder (blocks/); keep a block\'s template next to it',
    ],
    [
      'an absolute template file',
      { templateFile: '/etc/hosts' },
      'blocks/reply.json: `content.templateFile` "/etc/hosts" must be a path relative to the block file, with forward slashes',
    ],
    [
      'a template file with backslashes',
      { templateFile: 'sub\\reply.liquid' },
      'blocks/reply.json: `content.templateFile` "sub\\reply.liquid" must be a path relative to the block file, with forward slashes',
    ],
    [
      'an empty template file',
      { templateFile: '' },
      'blocks/reply.json: `content.templateFile` must be a path relative to the block file',
    ],
    [
      'no template at all',
      { parameters: [] },
      'blocks/reply.json: a prompt needs `content.template` (a Liquid template) or `content.templateFile`',
    ],
  ])('refuses %s, naming the file', async (_, content, message) => {
    await write({
      'secrets.txt': 'not for the index',
      'blocks/reply.json': json(prompt({ content })),
      'blocks/other.json': json(settings()),
    });
    const read = await readPackBlocks(packDir, BLOCKS);
    expect(read.errors).toEqual([{ message, filePath: 'blocks/reply.json' }]);
    // The rest of the pack's blocks still index.
    expect(read.blocks.map((b) => b.id)).toEqual(['acme.reply-style']);
    expect(read.files).toEqual(['blocks/other.json']);
  });

  test('a template file that is a symbolic link is refused, even to a file inside the folder', async () => {
    await write({
      'blocks/reply.json': json(prompt({ content: { templateFile: 'linked.liquid' } })),
      'blocks/real.liquid': 'Hi.',
    });
    await fs.symlink(
      path.join(packDir, 'blocks/real.liquid'),
      path.join(packDir, 'blocks/linked.liquid'),
    );
    const read = await readPackBlocks(packDir, BLOCKS);
    expect(read.errors).toEqual([
      {
        message:
          'blocks/reply.json: `content.templateFile` "linked.liquid" is a symbolic link; keep the template itself in the blocks folder',
        filePath: 'blocks/reply.json',
      },
    ]);
  });

  test.each([
    ['not JSON', '{ "id": ', /^blocks\/b\.json: not a JSON file \(/],
    ['not UTF-8', new Uint8Array([0x7b, 0xff, 0x7d]), /^blocks\/b\.json: not a JSON file \(/],
    [
      'an array',
      json([prompt()]),
      /^blocks\/b\.json: a block file holds one JSON object: the block$/,
    ],
    [
      'an unknown field',
      json({ ...prompt(), projectId: 'p' }),
      /^blocks\/b\.json: unknown field "projectId" \(a block has id, version, kind, description and content\)$/,
    ],
    ['a bad id', json(prompt({ id: 'Reply' })), /`id` must be a dotted lowercase id/],
    [
      'a range for a version',
      json(prompt({ version: '^1.0.0' })),
      /`version` must be major\.minor\.patch/,
    ],
    ['another kind', json(prompt({ kind: 'tool' })), /`kind` must be "prompt" or "settings"/],
    [
      'a description that is not text',
      json(prompt({ description: 3 })),
      /`description` must be a string/,
    ],
    [
      'content that is not an object',
      json(prompt({ content: 'Hi' })),
      /`content` must be an object/,
    ],
    [
      "another kind's content",
      json(prompt({ content: { template: 'x', values: {} } })),
      /unknown field "content\.values" \(a prompt block's content has template, templateFile, parameters\)/,
    ],
    [
      'parameters that are not a list',
      json(prompt({ content: { template: 'x', parameters: {} } })),
      /`content\.parameters` must be an array/,
    ],
    [
      'settings without values',
      json(settings({ content: {} })),
      /settings need `content\.values`, an object/,
    ],
    [
      'a schema that is not an object',
      json(settings({ content: { values: {}, schema: true } })),
      /`content\.schema` must be a JSON Schema object/,
    ],
    [
      'a templateFile on settings',
      json(settings({ content: { values: {}, templateFile: 'x' } })),
      /unknown field "content\.templateFile" \(a settings block's content has values, schema\)/,
    ],
  ])('refuses %s', async (_, content, message) => {
    await write({ 'blocks/b.json': content });
    const read = await readPackBlocks(packDir, BLOCKS);
    expect(read.blocks).toEqual([]);
    expect(read.errors).toHaveLength(1);
    expect(read.errors[0]?.filePath).toBe('blocks/b.json');
    expect(read.errors[0]?.message).toMatch(message);
  });

  test('a block id twice: the first file (in path order) is kept, the second refused', async () => {
    await write({
      'blocks/a.json': json(prompt()),
      'blocks/b.json': json(prompt({ version: '2.0.0' })),
    });
    const read = await readPackBlocks(packDir, BLOCKS);
    expect(read.blocks.map((b) => [b.modulePath, b.version])).toEqual([['blocks/a.json', '1.2.0']]);
    expect(read.errors).toEqual([
      {
        message:
          "blocks/b.json: duplicate block 'acme.reply-prompt' (also defined in blocks/a.json); a pack holds one version of each block",
        filePath: 'blocks/b.json',
      },
    ]);
  });

  test('skips dot folders, node_modules, links and files the pattern does not match', async () => {
    await write({
      'blocks/.drafts/a.json': json(prompt()),
      'blocks/node_modules/a.json': json(prompt()),
      'blocks/notes.txt': 'notes',
      'blocks/real/style.json': json(settings()),
      'outside/linked.json': json(prompt()),
    });
    await fs.symlink(path.join(packDir, 'outside'), path.join(packDir, 'blocks/linked-dir'));
    await fs.symlink(
      path.join(packDir, 'outside/linked.json'),
      path.join(packDir, 'blocks/linked.json'),
    );
    const read = await readPackBlocks(packDir, BLOCKS);
    expect(read.errors).toEqual([]);
    expect(read.files).toEqual(['blocks/real/style.json']);
  });

  test('a pattern at the pack root keeps template files inside the pack', async () => {
    await write({
      'support/reply.block.json': json(
        prompt({ content: { templateFile: '../prompts/reply.liquid' } }),
      ),
      'prompts/reply.liquid': 'Hi.',
      'escape.block.json': json(
        prompt({ id: 'acme.escape', content: { templateFile: '../outside.liquid' } }),
      ),
    });
    const read = await readPackBlocks(packDir, '**/*.block.json');
    expect(read.blocks.map((b) => [b.id, b.content])).toEqual([
      ['acme.reply-prompt', { template: 'Hi.' }],
    ]);
    expect(read.errors.map((e) => e.message)).toEqual([
      'escape.block.json: `content.templateFile` "../outside.liquid" is outside the pack; keep a block\'s template next to it',
    ]);
  });

  test('no blocks folder: nothing to read, nothing refused', async () => {
    expect(await readPackBlocks(packDir, BLOCKS)).toEqual({ blocks: [], files: [], errors: [] });
  });
});

// -----------------------------------------------------------------------
// In the index
// -----------------------------------------------------------------------

const CONFIG = 'export default { pack: { id: "acme.pack", version: "1.0.0" } };\n';
const AGENT = {
  default: {
    id: 'acme.support',
    version: '1.0.0',
    name: 'Support agent',
    instructions: { prompt: 'acme.reply-prompt', version: '^1.0.0' },
    settings: [{ id: 'acme.reply-style', version: '^1.0.0' }],
    capabilities: [],
    tools: [],
  },
};

const PACK = { pack: { id: 'acme.pack', version: '1.0.0' } };

async function index(
  extra: Readonly<Record<string, string>> = {},
  modules: Readonly<Record<string, unknown>> = { 'agents/support.mjs': AGENT },
  config: Readonly<Record<string, unknown>> = PACK,
): Promise<{
  readonly outcome: Awaited<ReturnType<typeof runIndexer>>;
  readonly written: unknown;
}> {
  await write({ 'kindgi.config.mjs': CONFIG, ...extra });
  const byUrl = new Map<string, unknown>();
  for (const [rel, module] of Object.entries(modules)) {
    await write({ [rel]: '// stub for discovery\n' });
    byUrl.set(pathToFileURL(path.join(packDir, rel)).href, module);
  }
  const outcome = await runIndexer({
    packDir,
    publishedAt: '2026-10-20T21:00:00.000Z',
    artifactVersion: '20261020.1',
    importModule: async (url) => {
      if (url.endsWith('kindgi.config.mjs')) return { default: config };
      if (!byUrl.has(url)) throw new Error(`no module at ${url}`);
      return byUrl.get(url);
    },
  });
  const written =
    outcome.kind === 'ok'
      ? (JSON.parse(await fs.readFile(outcome.value.outputPath, 'utf8')) as unknown)
      : undefined;
  if (written !== undefined) {
    expect(validateIndexSpec(written) ? [] : validateIndexSpec.errors).toEqual([]);
  }
  return { outcome, written };
}

describe('runIndexer — blocks', () => {
  test("the index carries the pack's blocks, and the report counts them", async () => {
    const { outcome, written } = await index({
      'blocks/reply.json': json(prompt({ content: { templateFile: 'reply.liquid' } })),
      'blocks/reply.liquid': 'Reply to {{ customer_name }}.',
      'blocks/style.json': json(settings()),
    });
    if (outcome.kind !== 'ok') throw new Error(JSON.stringify(outcome.error));
    expect(outcome.value.fileErrors).toEqual([]);
    expect(outcome.value.counts).toEqual({
      tools: 0,
      guardrails: 0,
      agents: 1,
      flows: 0,
      blocks: 2,
    });
    expect((written as { blocks: unknown }).blocks).toEqual([
      {
        ...prompt({ content: { template: 'Reply to {{ customer_name }}.' } }),
        modulePath: 'blocks/reply.json',
      },
      { ...settings(), modulePath: 'blocks/style.json' },
    ]);
  });

  test('a pack without blocks has no `blocks` key, so its index is as before', async () => {
    const { outcome, written } = await index();
    if (outcome.kind !== 'ok') throw new Error(JSON.stringify(outcome.error));
    expect(written).not.toHaveProperty('blocks');
    expect(outcome.value.counts.blocks).toBe(0);
  });

  test('a refused block file is a file error; the rest of the pack indexes', async () => {
    const { outcome, written } = await index({
      'blocks/reply.json': json(prompt({ content: { templateFile: 'missing.liquid' } })),
      'blocks/style.json': json(settings()),
    });
    if (outcome.kind !== 'ok') throw new Error(JSON.stringify(outcome.error));
    expect(outcome.value.fileErrors).toEqual([
      {
        code: 'manifest-validation-failed',
        message:
          'blocks/reply.json: `content.templateFile` "missing.liquid" isn\'t a readable UTF-8 file (looked for blocks/missing.liquid)',
        filePath: 'blocks/reply.json',
      },
    ]);
    expect((written as { blocks: { id: string }[] }).blocks.map((b) => b.id)).toEqual([
      'acme.reply-style',
    ]);
  });

  test('a pack of blocks alone indexes (no discovery-empty)', async () => {
    const { outcome, written } = await index({ 'blocks/style.json': json(settings()) }, {});
    if (outcome.kind !== 'ok') throw new Error(JSON.stringify(outcome.error));
    expect((written as { agents: unknown[]; blocks: unknown[] }).agents).toEqual([]);
    expect((written as { blocks: unknown[] }).blocks).toHaveLength(1);
  });

  test('a pack with nothing at all is still discovery-empty', async () => {
    const { outcome } = await index({}, {});
    expect(outcome.kind === 'err' && outcome.error.code).toBe('discovery-empty');
  });

  test('`discovery.blocks` moves where blocks are found', async () => {
    const files = {
      'blocks/style.json': json(settings()),
      'kindgi/blocks/reply.json': json(prompt()),
    };
    const ids = (written: unknown): string[] =>
      (written as { blocks: { id: string }[] }).blocks.map((b) => b.id);
    // By default, blocks/ only.
    expect(ids((await index(files)).written)).toEqual(['acme.reply-style']);
    // The augment layout's pattern: kindgi/blocks/ only.
    const moved = await index(files, undefined, {
      ...PACK,
      discovery: { blocks: 'kindgi/blocks/**/*.json' },
    });
    expect(ids(moved.written)).toEqual(['acme.reply-prompt']);
  });

  test('indexing a build (a bundle map) still reads the blocks from the pack folder', async () => {
    await write({
      'kindgi.config.mjs': CONFIG,
      'dist/agents/support.mjs': '// bundle\n',
      'blocks/style.json': json(settings()),
    });
    const outcome = await runIndexer({
      packDir,
      publishedAt: '2026-10-20T21:00:00.000Z',
      artifactVersion: '20261020.1',
      moduleRoot: path.join(packDir, 'dist'),
      bundleMap: { 'agents/support.ts': 'agents/support.mjs' },
      importModule: async (url) => (url.endsWith('kindgi.config.mjs') ? { default: PACK } : AGENT),
    });
    if (outcome.kind !== 'ok') throw new Error(JSON.stringify(outcome.error));
    const written = JSON.parse(await fs.readFile(outcome.value.outputPath, 'utf8')) as {
      blocks: { modulePath: string }[];
    };
    expect(written.blocks.map((b) => b.modulePath)).toEqual(['blocks/style.json']);
  });
});
