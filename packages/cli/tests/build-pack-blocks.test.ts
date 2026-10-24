// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pack's data blocks at `kindgi build` (`build/pack-blocks.ts`): after
 * the local index, each block holds up (`validateBlock`), no block file
 * is secret-shaped, and a pack whose own indexer is from before blocks
 * is refused rather than built without them. Their files go to the
 * image's indexer stage (`writeContextReal`, `blocks/`).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runIndexer } from '@kindgi/handler-runtime';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { writeContextReal } from '../src/build/defaults.js';
import type { HostInstall } from '../src/build/host-install.js';
import {
  checkPackBlocks,
  describeFiles,
  indexerPredatesBlocks,
  packIndexerName,
} from '../src/build/pack-blocks.js';

const BLOCKS = 'blocks/**/*.json';
let packDir: string;

beforeEach(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-build-blocks-'));
});
afterEach(async () => {
  await rm(packDir, { recursive: true, force: true });
});

async function write(files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(packDir, rel)), { recursive: true });
    await writeFile(join(packDir, rel), text, 'utf8');
  }
}

const REPLY = {
  id: 'acme.reply-prompt',
  version: '1.0.0',
  kind: 'prompt',
  content: { templateFile: 'reply.liquid' },
};
const STYLE = {
  id: 'acme.reply-style',
  version: '1.0.0',
  kind: 'settings',
  content: {
    values: { tone: 'warm' },
    schema: { type: 'object', properties: { tone: { enum: ['warm', 'brief'] } } },
  },
};

/** The pack indexed as `kindgi build` indexes it, its blocks then checked. */
async function check() {
  await write({
    'kindgi.config.mjs': "export default { pack: { id: 'acme', version: '1.0.0' } };\n",
  });
  const indexPath = join(packDir, 'out', 'index.json');
  const indexed = await runIndexer({
    packDir,
    outputPath: indexPath,
    artifactVersion: '20261020.1',
    publishedAt: '2026-10-20T21:00:00.000Z',
  });
  if (indexed.kind !== 'ok') throw new Error(indexed.error.message);
  expect(indexed.value.fileErrors).toEqual([]);
  return checkPackBlocks({
    packDir,
    pattern: BLOCKS,
    indexPath,
    blocksCounted: true,
    indexer: packIndexerName('python'),
    release: '0.1.11',
  });
}

describe('checkPackBlocks', () => {
  test('blocks that hold up: their files and templates, for the image', async () => {
    await write({
      'blocks/support/reply.json': JSON.stringify(REPLY),
      'blocks/support/reply.liquid': 'Reply to {{ customer_name }}.',
      'blocks/style.json': JSON.stringify(STYLE),
    });
    expect(await check()).toEqual({
      kind: 'ok',
      files: ['blocks/style.json', 'blocks/support/reply.json', 'blocks/support/reply.liquid'],
    });
  });

  test('a template that is no Liquid, or values outside their schema: refused, naming each file', async () => {
    await write({
      'blocks/support/reply.json': JSON.stringify(REPLY),
      'blocks/support/reply.liquid': 'Reply to {{ customer_name ',
      'blocks/style.json': JSON.stringify({
        ...STYLE,
        content: { ...STYLE.content, values: { tone: 'loud' } },
      }),
    });
    const checked = await check();
    if (checked.kind !== 'err') throw new Error('expected a refusal');
    const lines = checked.message.split('\n');
    expect(lines[0]).toBe("The pack's blocks don't hold up — fix them before building:");
    expect(lines.slice(1).map((l) => l.split(':')[0])).toEqual([
      '  blocks/style.json',
      '  blocks/support/reply.json',
    ]);
    expect(lines[2]).toMatch(/\(at \/content\/template\)$/);
  });

  test('a secret-shaped template file is refused: it would be in the image', async () => {
    await write({
      'blocks/reply.json': JSON.stringify({ ...REPLY, content: { templateFile: '.env' } }),
      'blocks/.env': 'Hi.',
    });
    const checked = await check();
    expect(checked).toMatchObject({ kind: 'err' });
    expect(checked.kind === 'err' && checked.message).toMatch(
      /^Refusing to put these block files in the image: blocks\/\.env \(.+\)\. Rename them\.$/,
    );
  });

  test('no blocks: nothing to copy, and the index is not read', async () => {
    for (const blocksCounted of [true, false]) {
      expect(
        await checkPackBlocks({
          packDir,
          pattern: BLOCKS,
          indexPath: join(packDir, 'no-index.json'),
          blocksCounted,
          indexer: packIndexerName('python'),
          release: '0.1.11',
        }),
      ).toEqual({ kind: 'ok', files: [] });
    }
  });

  test('an indexer from before blocks (its report counts none): refused, naming it and the release', async () => {
    await write({
      'blocks/style.json': JSON.stringify(STYLE),
      'blocks/broken.json': '{',
    });
    // The pack's own indexer leaves blocks out; this one reads them, so its file errors aren't the point.
    const predates = await indexerPredatesBlocks({
      packDir,
      pattern: BLOCKS,
      blocksCounted: false,
      indexer: packIndexerName('python'),
      release: '0.1.11',
    });
    expect(predates).toBe(
      "The pack has blocks (blocks/: 2 files), but the pack's `kindgi` Python package reads none: it's from before blocks in a pack. Upgrade it to Kindgi 0.1.11 or later.",
    );
    expect(
      await indexerPredatesBlocks({
        packDir,
        pattern: BLOCKS,
        blocksCounted: true,
        indexer: packIndexerName('java'),
        release: '0.1.11',
      }),
    ).toBeUndefined();
  });
});

describe('describeFiles and packIndexerName', () => {
  test('the folder, or the pattern itself at the pack root', () => {
    expect(describeFiles('blocks/**/*.json', 1)).toBe('blocks/: 1 file');
    expect(describeFiles('kindgi/blocks/**/*.json', 3)).toBe('kindgi/blocks/: 3 files');
    expect(describeFiles('**/*.block.json', 2)).toBe('**/*.block.json: 2 files');
  });

  test("each language's indexer", () => {
    expect(packIndexerName('node')).toBe("this CLI's indexer");
    expect(packIndexerName('python')).toBe("the pack's `kindgi` Python package");
    expect(packIndexerName('java')).toBe("the pack's com.kindgi:kindgi-pack");
    expect(packIndexerName('scala')).toBe("the pack's com.kindgi:kindgi-pack");
  });
});

describe('writeContextReal', () => {
  test("the block files go to the context's blocks/, at their pack-relative paths", async () => {
    await write({
      'package.json': '{}',
      'blocks/support/reply.json': JSON.stringify(REPLY),
      'blocks/support/reply.liquid': 'Hi.',
      'dist/kindgi-index.mjs': '',
      Containerfile: 'FROM scratch\n',
    });
    const contextDir = join(packDir, 'out', 'context');
    await writeContextReal({
      contextDir,
      packDir,
      install: {
        root: packDir,
        packRel: '',
        files: ['package.json'],
        projectManifests: [],
      } as unknown as HostInstall,
      bundleDir: join(packDir, 'dist'),
      containerfilePath: join(packDir, 'Containerfile'),
      includes: [],
      extensionFiles: [],
      blockFiles: ['blocks/support/reply.json', 'blocks/support/reply.liquid'],
    });
    expect(
      await readFile(join(contextDir, 'blocks', 'blocks', 'support', 'reply.liquid'), 'utf8'),
    ).toBe('Hi.');
    expect(
      JSON.parse(
        await readFile(join(contextDir, 'blocks', 'blocks', 'support', 'reply.json'), 'utf8'),
      ),
    ).toEqual(REPLY);
  });
});
