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
  DEFAULT_JAVA_DISCOVERY,
  DEFAULT_PYTHON_DISCOVERY,
  DEFAULT_SCALA_DISCOVERY,
  KINDGI_CONFIG_FILENAMES,
  findKindgiConfig,
  isJvmLanguage,
  loadKindgiConfig,
  packLanguage,
  resolveDiscovery,
  runIndexer,
} from '../src/index.js';
import type { KindgiConfig } from '../src/index.js';

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

  test('`project` and `providers` come through, typed (KindgiConfig)', async () => {
    await write(
      'kindgi.config.mjs',
      "export default { pack: { id: 'acme.pack', version: '1.0.0' }, project: 'acme-app', providers: [{ preset: 'anthropic' }, { spec: { adapter_id: '@kindgi/adapter-model-openai-compat' } }] };",
    );
    const r = await loadKindgiConfig(dir);
    if (r.kind !== 'ok') throw new Error(r.error.message);
    const config: KindgiConfig = r.value;
    expect(config.project).toBe('acme-app');
    expect(config.providers).toEqual([
      { preset: 'anthropic' },
      { spec: { adapter_id: '@kindgi/adapter-model-openai-compat' } },
    ]);
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

  test('`project` and `[[tool.kindgi.providers]]` load as KindgiConfig.project and .providers', async () => {
    await write(
      'pyproject.toml',
      `[project]
name = "ledger"

[tool.kindgi]
project = "acme-app"

[tool.kindgi.pack]
id = "acme.ledger"
version = "1.0.0"

[[tool.kindgi.providers]]
preset = "gemini"
project = "acme-gcp"
models = ["gemini-2.5-pro"]
maxOutputTokens = 16384

[[tool.kindgi.providers]]
preset = "anthropic"
`,
    );
    const r = await loadKindgiConfig(dir);
    expect(r.kind === 'ok' && r.value.project).toBe('acme-app');
    expect(r.kind === 'ok' && r.value.providers).toEqual([
      { preset: 'gemini', project: 'acme-gcp', models: ['gemini-2.5-pro'], maxOutputTokens: 16384 },
      { preset: 'anthropic' },
    ]);
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

describe('a Java pack: kindgi.config.json', () => {
  const CONFIG = JSON.stringify({
    language: 'java',
    pack: { id: 'acme.ledger', version: '1.0.0' },
    env: { required: ['DATABASE_URL'] },
    providers: [{ preset: 'anthropic' }],
  });

  test('loads the JSON as the config, a Java pack', async () => {
    await write('kindgi.config.json', CONFIG);
    expect(await findKindgiConfig(dir)).toEqual({
      path: path.join(dir, 'kindgi.config.json'),
      format: 'json',
    });
    const r = await loadKindgiConfig(dir);
    expect(r.kind === 'ok' && r.value).toEqual(JSON.parse(CONFIG));
    expect(r.kind === 'ok' && packLanguage(r.value)).toBe('java');
  });

  test('an explicit --config path to a .json reads it as JSON', async () => {
    await write('acme-pack.json', CONFIG);
    const r = await loadKindgiConfig(dir, { configPath: path.join(dir, 'acme-pack.json') });
    expect(r.kind === 'ok' && packLanguage(r.value)).toBe('java');
  });

  test.each([
    ['kindgi.config.ts', 'TypeScript'],
    ['kindgi.config.mjs', 'TypeScript'],
    ['pyproject.toml', 'Python'],
  ])('next to %s: refused, naming both and which to keep', async (other, kind) => {
    await write('kindgi.config.json', CONFIG);
    await write(
      other,
      other === 'pyproject.toml'
        ? '[tool.kindgi.pack]\nid = "acme"\nversion = "1.0.0"\n'
        : "export default { pack: { id: 'acme', version: '1.0.0' } };",
    );
    expect((await findKindgiConfig(dir))?.conflictsWith).toBe(path.join(dir, other));
    const r = await loadKindgiConfig(dir);
    expect(r.kind === 'err' && r.error.code).toBe('config-invalid');
    expect(r.kind === 'err' && r.error.message).toBe(
      `${dir} has two pack configs, kindgi.config.json and ${other}; a pack has one. ` +
        `Keep kindgi.config.json for a Java or Scala pack, or ${other} for a ${kind} one, and remove the other.`,
    );
  });

  test('a pyproject.toml without [tool.kindgi] next to it is no conflict', async () => {
    await write('kindgi.config.json', CONFIG);
    await write('pyproject.toml', '[project]\nname = "app"\n');
    const r = await loadKindgiConfig(dir);
    expect(r.kind === 'ok' && packLanguage(r.value)).toBe('java');
  });

  test.each([
    [
      '{"pack": {"id": "a", "version": "1"}}',
      /is a JVM pack's config; it says "language": "java" or "scala"/,
    ],
    [
      '{"language": "node", "pack": {"id": "a", "version": "1"}}',
      /it says "language": "java" or "scala"/,
    ],
    ['{"language": "java", "pack": {"id": "a"}}', /'pack.version' is missing/],
    ['[1, 2]', /the file must hold a JSON object/],
    ['{"language": "java",', /Failed to read/],
  ])('%s: config-parse-failed', async (text, message) => {
    await write('kindgi.config.json', text);
    const r = await loadKindgiConfig(dir);
    expect(r.kind === 'err' && r.error.code).toBe('config-parse-failed');
    expect(r.kind === 'err' && r.error.message).toMatch(message);
  });

  test('"java" belongs to kindgi.config.json, not a module', async () => {
    await write(
      'kindgi.config.mjs',
      "export default { pack: { id: 'a', version: '1.0.0' }, language: 'java' };",
    );
    const r = await loadKindgiConfig(dir);
    expect(r.kind === 'err' && r.error.message).toMatch(/'language' must be "node" or "python"/);
  });

  test('Java discovery defaults', () => {
    expect(resolveDiscovery(undefined, 'java')).toEqual(DEFAULT_JAVA_DISCOVERY);
    expect(DEFAULT_JAVA_DISCOVERY.tools).toBe('src/main/java/**/tools/**/*.java');
    expect(
      resolveDiscovery({ flows: 'src/main/java/com/acme/kindgi/**/*.java' }, 'java').flows,
    ).toBe('src/main/java/com/acme/kindgi/**/*.java');
  });

  test('the TypeScript indexer refuses a Java pack, naming the Java indexer', async () => {
    await write('kindgi.config.json', CONFIG);
    const r = await runIndexer({ packDir: dir });
    expect(r.kind === 'err' && r.error.code).toBe('language-mismatch');
    expect(r.kind === 'err' && r.error.message).toContain('com.kindgi.pack.Main index');
  });
});

describe('a Scala pack: kindgi.config.json', () => {
  const CONFIG = JSON.stringify({
    language: 'scala',
    pack: { id: 'acme.ledger', version: '1.0.0' },
  });

  test('loads as a Scala pack, a JVM language', async () => {
    await write('kindgi.config.json', CONFIG);
    const r = await loadKindgiConfig(dir);
    expect(r.kind === 'ok' && packLanguage(r.value)).toBe('scala');
    expect(isJvmLanguage('scala')).toBe(true);
    expect(isJvmLanguage('java')).toBe(true);
    expect(isJvmLanguage('python')).toBe(false);
  });

  test('Scala discovery defaults', () => {
    expect(resolveDiscovery(undefined, 'scala')).toEqual(DEFAULT_SCALA_DISCOVERY);
    expect(DEFAULT_SCALA_DISCOVERY).toEqual({
      tools: 'src/main/scala/**/tools/**/*.scala',
      guardrails: 'src/main/scala/**/guardrails/**/*.scala',
      agents: 'src/main/scala/**/agents/**/*.scala',
      flows: 'src/main/scala/**/flows/**/*.scala',
    });
  });

  test('"scala" belongs to kindgi.config.json, not a module', async () => {
    await write(
      'kindgi.config.mjs',
      "export default { pack: { id: 'a', version: '1.0.0' }, language: 'scala' };",
    );
    const r = await loadKindgiConfig(dir);
    expect(r.kind === 'err' && r.error.message).toMatch(/'language' must be "node" or "python"/);
  });

  test("the TypeScript indexer refuses a Scala pack, naming kindgi-pack's indexer", async () => {
    await write('kindgi.config.json', CONFIG);
    const r = await runIndexer({ packDir: dir });
    expect(r.kind === 'err' && r.error.code).toBe('language-mismatch');
    expect(r.kind === 'err' && r.error.message).toContain(
      'is a scala pack; index it with its own indexer (java -cp <classpath> com.kindgi.pack.Main index)',
    );
  });
});
