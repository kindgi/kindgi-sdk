#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * Builds a private preview of the docs from this checkout (usually `main`):
 * what's merged but not released, checked before a release. It's a separate
 * site at its own root, marked as a preview on every page and never indexed,
 * and it isn't part of the public site (`build-versions.mjs` builds only
 * releases). Deploy it only behind a login: `site/wrangler.preview.jsonc`.
 *
 * Usage: node site/scripts/build-preview.mjs [--out <dir>]
 *   --out   where to write the site (default: site/dist-preview)
 *
 * Needs the workspace built (`pnpm run build`).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const at = args.indexOf('--out');
const out = resolve(at >= 0 ? args[at + 1] : join(site, 'dist-preview'));

const build = spawnSync('pnpm', ['run', 'site:build'], {
  cwd: site,
  stdio: 'inherit',
  env: { ...process.env, PUBLIC_KINDGI_DOCS_PREVIEW: '1', KINDGI_DOCS_REF: 'main' },
});
if (build.status !== 0) process.exit(build.status ?? 1);

rmSync(out, { recursive: true, force: true });
cpSync(join(site, 'dist'), out, { recursive: true });
console.log(`build-preview: ${out}`);
