// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Template files, as `kindgi init` writes them. Files ending in `.tmpl`
 * are rendered (suffix stripped, placeholders replaced); others are
 * copied as they are. A few dotfiles are stored without their dot (see
 * {@link templateTarget}).
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** What a template's placeholders become. */
export interface Substitutions {
  readonly PACK_NAME: string;
  readonly PACK_ID: string;
  readonly PACK_VERSION: string;
  /** The python template's `kindgi` dependency, quoted (`"kindgi>=0.1,<0.2"` from a published CLI). */
  readonly KINDGI_REQUIREMENT?: string;
  /** The python template's `[tool.uv.sources]` block for `kindgi` (from a checkout; empty when published). */
  readonly KINDGI_PYTHON_SOURCE?: string;
  /** The python template's `[tool.uv] required-version`. */
  readonly UV_REQUIRED_VERSION?: string;
}

/** Every file under `root`, as paths relative to it. */
export async function collectTemplateFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  await walk(root, '');
  return out;
}

/**
 * Dotfiles a template stores under another name. npm renames a package's
 * `.gitignore` to `.npmignore` when it installs it, so a template's own
 * `.gitignore` would never reach a pack scaffolded by `npx @kindgi/cli`.
 */
const STORED_AS: Readonly<Record<string, string>> = { gitignore: '.gitignore' };

/** A template file's path (relative to its template) as written into the pack. */
export function templateTarget(rel: string): string {
  const path = rel.endsWith('.tmpl') ? rel.slice(0, -'.tmpl'.length) : rel;
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  const stored = STORED_AS[name];
  return stored === undefined ? path : `${path.slice(0, slash + 1)}${stored}`;
}

export function substitute(raw: string, subs: Substitutions): string {
  return raw
    .replaceAll('{{PACK_NAME}}', subs.PACK_NAME)
    .replaceAll('{{PACK_ID}}', subs.PACK_ID)
    .replaceAll('{{PACK_VERSION}}', subs.PACK_VERSION)
    .replaceAll('{{KINDGI_REQUIREMENT}}', subs.KINDGI_REQUIREMENT ?? '"kindgi"')
    .replaceAll('{{KINDGI_PYTHON_SOURCE}}', subs.KINDGI_PYTHON_SOURCE ?? '')
    .replaceAll('{{UV_REQUIRED_VERSION}}', subs.UV_REQUIRED_VERSION ?? '');
}
