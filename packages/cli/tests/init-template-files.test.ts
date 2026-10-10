// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Template file names as `kindgi init` writes them, and the names the
 * templates may not use because npm changes them when it installs the CLI.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { collectTemplateFiles, javaPackageOf, templateTarget } from '../src/init/template-files.js';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'templates');
const TEMPLATE_NAMES = ['java', 'minimal', 'python', 'sample', 'woocommerce'];

describe('templateTarget', () => {
  test('strips .tmpl and restores the dot of a stored dotfile', () => {
    expect(templateTarget('gitignore')).toBe('.gitignore');
    expect(templateTarget('nested/gitignore')).toBe('nested/.gitignore');
    expect(templateTarget('README.md.tmpl')).toBe('README.md');
    expect(templateTarget('tools/greet/index.ts')).toBe('tools/greet/index.ts');
    expect(templateTarget('.nvmrc')).toBe('.nvmrc');
    expect(templateTarget('my-gitignore')).toBe('my-gitignore');
  });

  test("the java template's __PACKAGE__ folder becomes the package's path", () => {
    expect(templateTarget('src/main/java/__PACKAGE__/tools/Echo.java.tmpl', 'acme/billing')).toBe(
      'src/main/java/acme/billing/tools/Echo.java',
    );
    expect(templateTarget('src/main/java/__PACKAGE__/tools/Echo.java.tmpl')).toBe(
      'src/main/java/__PACKAGE__/tools/Echo.java',
    );
  });

  test('a pack id as a Java package: lowercase segments, no hyphens, no keywords, no leading digit', () => {
    expect(javaPackageOf('acme.billing')).toBe('acme.billing');
    expect(javaPackageOf('my-pack')).toBe('mypack');
    expect(javaPackageOf('acme.new')).toBe('acme.new_');
    expect(javaPackageOf('acme.2fa-tools')).toBe('acme._2fatools');
    expect(javaPackageOf('acme.-')).toBe('acme.pack');
  });
});

describe('the templates as published', () => {
  test('no template file is named .gitignore or .npmignore (npm renames or drops them)', async () => {
    for (const name of TEMPLATE_NAMES) {
      const files = await collectTemplateFiles(join(TEMPLATES, name));
      const mangled = files.filter((rel) => /(^|\/)\.(git|npm)ignore$/.test(rel));
      expect(mangled, `${name}: store it as \`gitignore\``).toEqual([]);
    }
  });

  test("every template's .gitignore keeps the dev token and env files out of git", async () => {
    for (const name of TEMPLATE_NAMES) {
      const text = await readFile(join(TEMPLATES, name, 'gitignore'), 'utf8');
      const lines = text.split('\n');
      expect(lines, name).toContain('.kindgirc.json');
      expect(lines, name).toContain('.env');
      expect(lines, name).toContain('.kindgi/');
    }
  });
});
