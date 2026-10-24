// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi dev`'s pack service writes a block version made live in the
 * console into the pack's own file, through its front (`POST /v1/blocks`).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { PackBlockWrite } from '@kindgi/handler-runtime';
import { PACK_HEADERS } from '@kindgi/handler-runtime/protocol';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createPackServiceReal } from '../src/dev/defaults.js';
import { showBlockWritten } from '../src/dev/pack-service.js';
import type { DevPackService, PackBlockWritten } from '../src/dev/runners.js';

const BLOCKS = 'blocks/**/*.json';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const PROMPT = {
  id: 'acme.reply-prompt',
  version: '1.2.0',
  kind: 'prompt',
  content: { template: 'Reply to {{ customer_name }}.', parameters: [] },
};

let packDir: string;
let service: DevPackService | undefined;

beforeEach(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-dev-block-write-'));
});

afterEach(async () => {
  await service?.close();
  service = undefined;
  await rm(packDir, { recursive: true, force: true });
});

async function write(files: Readonly<Record<string, string>>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(packDir, rel)), { recursive: true });
    await writeFile(join(packDir, rel), content);
  }
}

/** The dev pack service's front, listening, and what it said it wrote. */
async function front() {
  const written: [PackBlockWrite, PackBlockWritten][] = [];
  service = createPackServiceReal({
    packDir,
    // No child starts here: a Python pack's command needs no resolving (a
    // Node pack's resolves its entrypoint, which Vitest can't).
    code: { language: 'python', python: ['python3'] },
    env: async () => ({}),
    onLog: () => undefined,
    onEvent: () => undefined,
    blocks: { pattern: BLOCKS, onWritten: (w, out) => written.push([w, out]) },
  });
  const { url } = await service.listen();
  const token = service.token;
  const post = (body: unknown) =>
    fetch(`${url}/v1/blocks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PACK_HEADERS.token]: token },
      body: JSON.stringify(body),
    });
  return { post, written };
}

describe('kindgi dev: a block made live is written into the pack', () => {
  test("the front writes the new version into the block's file and says so", async () => {
    await write({ 'blocks/reply.json': json(PROMPT) });
    const { post, written } = await front();
    const change = {
      id: 'acme.reply-prompt',
      version: '1.2.1',
      content: { template: 'Reply to {{ customer_name }}, briefly.', parameters: [] },
    };
    const res = await post(change);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ file: 'blocks/reply.json', replaced: '1.2.0' });
    expect(await readFile(join(packDir, 'blocks/reply.json'), 'utf8')).toBe(
      json({ ...PROMPT, version: '1.2.1', content: change.content }),
    );
    expect(written).toEqual([
      [change, { kind: 'ok', file: 'blocks/reply.json', replaced: '1.2.0' }],
    ]);
  });

  test('a write the file refuses leaves it as it was, and nothing is said', async () => {
    await write({ 'blocks/reply.json': json(PROMPT) });
    const { post, written } = await front();
    const res = await post({ id: 'acme.reply-prompt', version: '1.1.0', content: PROMPT.content });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: 'not-newer' });
    expect((await post({ id: 'acme.other', version: '1.0.0', content: {} })).status).toBe(404);
    expect(await readFile(join(packDir, 'blocks/reply.json'), 'utf8')).toBe(json(PROMPT));
    expect(written).toEqual([]);
  });

  test("a block outside the pack's blocks pattern is not the pack's (404)", async () => {
    await write({ 'other/reply.json': json(PROMPT) });
    const { post } = await front();
    const res = await post({ id: 'acme.reply-prompt', version: '1.2.1', content: PROMPT.content });
    expect(res.status).toBe(404);
    expect(await readFile(join(packDir, 'other/reply.json'), 'utf8')).toBe(json(PROMPT));
  });
});

describe('showBlockWritten', () => {
  const change = { id: 'acme.reply-prompt', version: '1.2.1', content: {} };

  test('names the block, its version, its file and the version it replaced', () => {
    expect(
      showBlockWritten(change, { kind: 'ok', file: 'blocks/reply.json', replaced: '1.2.0' }),
    ).toBe('✎ acme.reply-prompt 1.2.1 made live: written into blocks/reply.json (was 1.2.0)');
  });

  test('names the template file too when the prompt keeps one', () => {
    expect(
      showBlockWritten(change, {
        kind: 'ok',
        file: 'blocks/reply.json',
        templateFile: 'blocks/reply.liquid',
        replaced: '1.2.0',
      }),
    ).toBe(
      '✎ acme.reply-prompt 1.2.1 made live: written into blocks/reply.json and blocks/reply.liquid (was 1.2.0)',
    );
  });
});
