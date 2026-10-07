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
  /** The python template's dev group, quoted and comma-separated (`kindgi-cli` too, from the PyPI CLI). */
  readonly DEV_DEPENDENCIES?: string;
  /** The java template's package (`acme.billing`), from the pack id. */
  readonly JAVA_PACKAGE?: string;
  /** The java template's package as a path (`acme/billing`): also what `__PACKAGE__` in a file's path becomes. */
  readonly JAVA_PACKAGE_PATH?: string;
  /** The java template's `com.kindgi:kindgi-pack` version. */
  readonly KINDGI_JAVA_VERSION?: string;
  /** The java template's pinned CLI (`"cli"` in kindgi.config.json, which kindgiw runs). */
  readonly KINDGI_CLI_VERSION?: string;
}

/** Java's reserved words, which a package segment can't be. */
const JAVA_KEYWORDS = new Set(
  'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record yield sealed permits'.split(
    ' ',
  ),
);

/** A pack id as a Java package: `acme.billing` → `acme.billing`, `my-pack` → `mypack`. */
export function javaPackageOf(packId: string): string {
  return packId
    .split('.')
    .map((segment) => {
      let s = segment.toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (s === '') s = 'pack';
      if (/^[0-9]/.test(s)) s = `_${s}`;
      return JAVA_KEYWORDS.has(s) ? `${s}_` : s;
    })
    .join('.');
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

/**
 * A template file's path (relative to its template) as written into the
 * pack. A `__PACKAGE__` directory becomes `packagePath` (the java
 * template's sources).
 */
export function templateTarget(rel: string, packagePath?: string): string {
  const unsuffixed = rel.endsWith('.tmpl') ? rel.slice(0, -'.tmpl'.length) : rel;
  const path =
    packagePath === undefined
      ? unsuffixed
      : unsuffixed.split('/__PACKAGE__/').join(`/${packagePath}/`);
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
    .replaceAll('{{UV_REQUIRED_VERSION}}', subs.UV_REQUIRED_VERSION ?? '')
    .replaceAll('{{DEV_DEPENDENCIES}}', subs.DEV_DEPENDENCIES ?? '"pytest>=8"')
    .replaceAll('{{JAVA_PACKAGE_PATH}}', subs.JAVA_PACKAGE_PATH ?? '')
    .replaceAll('{{JAVA_PACKAGE}}', subs.JAVA_PACKAGE ?? '')
    .replaceAll('{{KINDGI_JAVA_VERSION}}', subs.KINDGI_JAVA_VERSION ?? '')
    .replaceAll('{{KINDGI_CLI_VERSION}}', subs.KINDGI_CLI_VERSION ?? '');
}
