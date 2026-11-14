// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A helper module under a discovery folder: a file whose name starts with
 * `_` (`tools/_shared.ts`). It's skipped when it defines no primitive, as
 * in a Python pack, and indexed like any other file when it does. A file
 * without the `_` that defines no primitive fails, and its error says how
 * to name a helper.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runIndexer } from '../src/kindgi-index.js';

const FIXED_TIMESTAMP = '2026-09-20T14:32:07.104Z';
const HINT = "(a helper module's name starts with `_`)";

let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'kindgi-helper-modules-'));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

/** A pack whose files import as the given modules; a module that is an Error throws on import. */
async function index(files: Readonly<Record<string, unknown>>) {
  const packDir = await fs.mkdtemp(path.join(scratch, 'pack-'));
  const modules = new Map<string, unknown>();
  const all = {
    'kindgi.config.mjs': { default: { pack: { id: 'acme.pack', version: '1.0.0' } } },
    ...files,
  };
  for (const [relPath, module_] of Object.entries(all)) {
    const absPath = path.join(packDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, '// stub for indexer discovery\n');
    modules.set(pathToFileURL(absPath).href, module_);
  }
  const outcome = await runIndexer({
    packDir,
    publishedAt: FIXED_TIMESTAMP,
    importModule: async (url) => {
      const module_ = modules.get(url);
      if (module_ instanceof Error) throw module_;
      return module_;
    },
  });
  expect(outcome.kind).toBe('ok');
  if (outcome.kind !== 'ok') throw new Error('the indexer failed');
  const written = JSON.parse(await fs.readFile(outcome.value.outputPath, 'utf8')) as {
    readonly tools: readonly { readonly id: string }[];
  };
  return {
    errors: outcome.value.fileErrors.map((e) => ({ code: e.code, message: e.message })),
    tools: written.tools.map((t) => t.id),
  };
}

function tool(id: string): unknown {
  const schema = {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
    additionalProperties: false,
  };
  return {
    default: {
      id,
      description: 'echo',
      input: schema,
      output: schema,
      effects: [{ kind: 'reads', resource: 'kb' }],
      handler: async (input: unknown) => input,
    },
  };
}

const guardrail = {
  default: {
    id: 'acme.grounded',
    name: 'Response is grounded in retrieval',
    kind: 'zero-llm',
    check: 'acme.checks.grounded',
    action: { 'on-violation': 'halt' },
    severity: 'blocking',
  },
};

describe('a helper module under a discovery folder', () => {
  test('a `_` file with no default export, beside a tool, is skipped', async () => {
    const got = await index({
      'tools/echo.ts': tool('acme.echo'),
      'tools/_shared.ts': { format: (s: string) => s.trim() },
    });
    expect(got).toEqual({ errors: [], tools: ['acme.echo'] });
  });

  test("so is one in a tool's own folder", async () => {
    const got = await index({
      'tools/echo/index.ts': tool('acme.echo'),
      'tools/echo/_format.ts': { format: (s: string) => s.trim() },
    });
    expect(got).toEqual({ errors: [], tools: ['acme.echo'] });
  });

  test('and one whose default export is no primitive', async () => {
    const got = await index({
      'tools/echo.ts': tool('acme.echo'),
      'tools/_settings.ts': { default: { retries: 3 } },
    });
    expect(got).toEqual({ errors: [], tools: ['acme.echo'] });
  });

  test('a `_` file that defines a tool is indexed', async () => {
    const got = await index({ 'tools/_echo.ts': tool('acme.echo') });
    expect(got).toEqual({ errors: [], tools: ['acme.echo'] });
  });

  test('a `_` file that fails to import, or defines the wrong kind, still fails', async () => {
    const got = await index({
      'tools/echo.ts': tool('acme.echo'),
      'tools/_broken.ts': new Error('kaboom'),
      'tools/_grounded.ts': guardrail,
    });
    expect(got.tools).toEqual(['acme.echo']);
    expect(got.errors.map((e) => e.code).sort()).toEqual(['file-import-failed', 'kind-mismatch']);
  });
});

describe('a file without the `_` that defines no primitive', () => {
  test('with no default export: no-default-export, saying how to name a helper', async () => {
    const got = await index({
      'tools/echo.ts': tool('acme.echo'),
      'tools/shared.ts': { format: (s: string) => s.trim() },
    });
    expect(got).toEqual({
      errors: [
        {
          code: 'no-default-export',
          message: `File tools/shared.ts has no default export ${HINT}`,
        },
      ],
      tools: ['acme.echo'],
    });
  });

  test('whose default export is no primitive: ambiguous-kind, saying the same', async () => {
    const got = await index({
      'tools/echo.ts': tool('acme.echo'),
      'tools/settings.ts': { default: { retries: 3 } },
    });
    expect(got.errors).toEqual([
      {
        code: 'ambiguous-kind',
        message:
          "File tools/settings.ts default export does not match any primitive shape (tool / guardrail / agent / flow; a helper module's name starts with `_`)",
      },
    ]);
  });
});
