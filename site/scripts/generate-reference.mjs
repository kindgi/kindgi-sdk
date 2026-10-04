#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * Writes the generated reference pages into `src/content/docs/` before a
 * build: the CLI, the environment variables, … Each comes from Kindgi's
 * own sources (built workspace packages), so a release's reference
 * matches its tag. The pages are build output, gitignored, never edited
 * by hand. (The HTTP API reference is a Starlight plugin reading
 * `packages/api/openapi.json`; the TypeScript reference, typedoc.)
 *
 * Needs the workspace built first (`pnpm run build`).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliPages } from './reference/cli.mjs';
import { contributingPages } from './reference/contributing.mjs';
import { envVarsPage } from './reference/env-vars.mjs';
import { OPENAPI_FOR_DOCS, writeOpenApiForDocs } from './reference/openapi.mjs';
import { packagePages } from './reference/packages.mjs';
import { schemaPages } from './reference/schemas.mjs';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(site, 'src', 'content', 'docs');

/**
 * What the generators own, as slugs (a page) and directories, cleared first
 * so a removed page goes away. A page's file is its slug plus the markdown
 * extension.
 */
const GENERATED_DIRS = ['reference/cli', 'reference/schemas', 'reference/packages'];
const GENERATED_PAGES = ['reference/env-vars'];
const file = (slug) => join(docs, `${slug}.md`);

for (const dir of GENERATED_DIRS) rmSync(join(docs, dir), { recursive: true, force: true });
for (const slug of GENERATED_PAGES) rmSync(file(slug), { force: true });

const contributing = contributingPages();
// The contributing pages are slugs next to the hand-written overview.
for (const page of contributing) rmSync(file(page.slug), { force: true });

const pages = [...cliPages(), envVarsPage(), ...schemaPages(), ...packagePages(), ...contributing];
for (const page of pages) {
  const path = file(page.slug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, page.content);
}
// The Python SDK reference, generated in the SDK's own environment.
const python = spawnSync(
  'uv',
  [
    'run',
    '--project',
    join(site, '..', 'sdks', 'python'),
    '--frozen',
    'python',
    join(site, 'scripts', 'reference', 'python_reference.py'),
    docs,
  ],
  { stdio: 'inherit' },
);
if (python.status !== 0) {
  console.error(
    'generate-reference: the Python SDK reference failed (needs uv: `uv sync --project sdks/python`).',
  );
  process.exit(1);
}

const tags = writeOpenApiForDocs(
  join(site, '..', 'packages', 'api', 'openapi.json'),
  join(site, OPENAPI_FOR_DOCS),
);
console.log(`generate-reference: ${pages.length} pages; the API spec with ${tags} tag names.`);
