// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `loadKindgiConfig` against real files — no `importModule` override,
 * so the actual dynamic import, lookup order and cache-busting run.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  DEFAULT_PYTHON_DISCOVERY,
  KINDGI_CONFIG_FILENAMES,
  findKindgiConfig,
  loadKindgiConfig,
  packLanguage,
  resolveDiscovery,
  runIndexer,
} from '../src/index.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindgi-load-config-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const write = (name: string, body: string): Promise<void> =>
  fs.writeFile(path.join(dir, name), body);

describe('loadKindgiConfig', () => {
  test('loads the default export and returns it whole (unknown fields kept)', async () => {
    await write(
      'kindgi.config.mjs',
      "export default { pack: { id: 'acme.pack', version: '1.0.0' }, dev: { envFiles: ['.env'] } };",
    );
    const r = await loadKindgiConfig(dir);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.pack.id).toBe('acme.pack');
    expect(r.value.dev).toEqual({ envFiles: ['.env'] });
  });

  test('no config file → config-not-found', async () => {
    const r = await loadKindgiConfig(dir);
    expect(r.kind === 'err' && r.error.code).toBe('config-not-found');
  });

  test('a config that throws on import → config-parse-failed carrying the cause', async () => {
    await write('kindgi.config.mjs', "throw new Error('boom in config');");
    const r = await loadKindgiConfig(dir);
    expect(r.kind === 'err' && r.error.code).toBe('config-parse-failed');
    expect(r.kind === 'err' && r.error.message).toContain('boom in config');
  });

  test('missing pack.id → config-parse-failed naming the field', async () => {
    await write('kindgi.config.mjs', "export default { pack: { version: '1.0.0' } };");
    const r = await loadKindgiConfig(dir);
    expect(r.kind === 'err' && r.error.message).toContain('pack.id');
  });

  test('lookup order follows KINDGI_CONFIG_FILENAMES (.mjs before .js)', async () => {
    expect(KINDGI_CONFIG_FILENAMES.indexOf('kindgi.config.mjs')).toBeLessThan(
      KINDGI_CONFIG_FILENAMES.indexOf('kindgi.config.js'),
    );
    await write('kindgi.config.js', "export default { pack: { id: 'from-js', version: '1' } };");
    await write('kindgi.config.mjs', "export default { pack: { id: 'from-mjs', version: '1' } };");
    await fs.writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
    const r = await loadKindgiConfig(dir);
    expect(r.kind === 'ok' && r.value.pack.id).toBe('from-mjs');
  });

  test('an edited config is re-read (cache-busted by mtime)', async () => {
    await write('kindgi.config.mjs', "export default { pack: { id: 'v1', version: '1' } };");
    expect((await loadKindgiConfig(dir)).kind === 'ok').toBe(true);
    await write('kindgi.config.mjs', "export default { pack: { id: 'v2', version: '1' } };");
    const later = new Date(Date.now() + 5000);
    await fs.utimes(path.join(dir, 'kindgi.config.mjs'), later, later);
    const r = await loadKindgiConfig(dir);
    expect(r.kind === 'ok' && r.value.pack.id).toBe('v2');
  });
});

describe('a Python pack: [tool.kindgi] in pyproject.toml', () => {
  const PYPROJECT = `[project]
name = "ledger"

[tool.kindgi.pack]
id = "acme.ledger"
version = "1.0.0"

[tool.kindgi.dev]
envFiles = [".env", ".env.local"]
`;

  test('loads the table as the config, a Python pack', async () => {
    await write('pyproject.toml', PYPROJECT);
    expect(await findKindgiConfig(dir)).toEqual({
      path: path.join(dir, 'pyproject.toml'),
      format: 'pyproject',
    });
    const r = await loadKindgiConfig(dir);
    expect(r.kind === 'ok' && r.value).toEqual({
      pack: { id: 'acme.ledger', version: '1.0.0' },
      dev: { envFiles: ['.env', '.env.local'] },
      language: 'python',
    });
    expect(r.kind === 'ok' && packLanguage(r.value)).toBe('python');
  });

  test('a kindgi.config.* wins over pyproject.toml', async () => {
    await write('pyproject.toml', PYPROJECT);
    await write(
      'kindgi.config.mjs',
      "export default { pack: { id: 'acme.node', version: '1.0.0' } };",
    );
    const r = await loadKindgiConfig(dir);
    expect(r.kind === 'ok' && r.value.pack.id).toBe('acme.node');
    expect(r.kind === 'ok' && packLanguage(r.value)).toBe('node');
  });

  test('a pyproject.toml without [tool.kindgi] is not a pack', async () => {
    await write('pyproject.toml', '[project]\nname = "app"\n');
    expect(await findKindgiConfig(dir)).toBeUndefined();
    const r = await loadKindgiConfig(dir);
    expect(r.kind === 'err' && r.error.code).toBe('config-not-found');
  });

  test('broken TOML that meant to be a pack: config-parse-failed', async () => {
    await write('pyproject.toml', '[tool.kindgi.pack]\nid = "acme\n');
    const r = await loadKindgiConfig(dir);
    expect(r.kind === 'err' && r.error.code).toBe('config-parse-failed');
  });

  test("'language' is node or python", async () => {
    await write(
      'kindgi.config.mjs',
      "export default { pack: { id: 'a', version: '1.0.0' }, language: 'ruby' };",
    );
    const r = await loadKindgiConfig(dir);
    expect(r.kind === 'err' && r.error.message).toMatch(/'language' must be "node" or "python"/);
  });

  test('Python discovery defaults', () => {
    expect(resolveDiscovery(undefined, 'python')).toEqual(DEFAULT_PYTHON_DISCOVERY);
    expect(resolveDiscovery({ tools: 'kindgi/tools/**/*.py' }, 'python').tools).toBe(
      'kindgi/tools/**/*.py',
    );
    expect(resolveDiscovery(undefined).tools).toBe('tools/**/*.{ts,js,mjs}');
  });

  test('the TypeScript indexer refuses a Python pack', async () => {
    await write('pyproject.toml', PYPROJECT);
    const r = await runIndexer({ packDir: dir });
    expect(r.kind === 'err' && r.error.code).toBe('language-mismatch');
  });
});
