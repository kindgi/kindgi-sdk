#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * No constructor with parameter properties calls `super` inside a block.
 * tsc assigns a derived class's parameter properties (`constructor(readonly
 * id: string)`) right after the constructor's root-level `super(...)` and
 * nowhere else, so an object built through a `super` in an `if` or a loop
 * has those fields unset in the built package. The tests don't show it:
 * vitest compiles with esbuild, which assigns them after every `super`.
 * (`PublishRefused` answered deploys without `primitive` and `id` this way.)
 *
 * This parses every tracked TypeScript file (declaration files aside) and
 * fails on each such `super`, naming the class and its parameter
 * properties. The fix is a single `super` at the constructor's root, or
 * fields declared on the class and assigned by hand.
 *
 * Usage: `pnpm run check:constructor-super` (CI's lint job runs it).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** This repository's tracked TypeScript sources, declaration files aside. */
export function trackedSources(root = ROOT) {
  const listed = execFileSync('git', ['ls-files', '-z', '--', '*.ts', '*.tsx', '*.mts', '*.cts'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0');
  // A file in a merge conflict is listed once per stage.
  return [...new Set(listed)].filter((file) => file !== '' && !/\.d\.[mc]?ts$/.test(file));
}

/** The `super(...)` calls a constructor body makes itself (a nested class's constructor is its own). */
function superCalls(body) {
  const calls = [];
  const visit = (node) => {
    if (ts.isClassLike(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return calls;
}

/**
 * Each `super` call outside the constructor's root, in a constructor with
 * parameter properties: `{ line, className, properties }` (1-based lines).
 */
export function nestedSupers(fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (ts.isConstructorDeclaration(node) && node.body !== undefined) {
      found.push(...inConstructor(node, source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** `nestedSupers` for one constructor (with a body). */
function inConstructor(ctor, source) {
  const properties = ctor.parameters
    .filter((p) => ts.isParameterPropertyDeclaration(p, ctor))
    .map((p) => p.name.getText(source));
  if (properties.length === 0) return [];
  return superCalls(ctor.body)
    .filter((call) => !(ts.isExpressionStatement(call.parent) && call.parent.parent === ctor.body))
    .map((call) => ({
      line: source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1,
      className: ctor.parent.name?.text ?? '(anonymous class)',
      properties,
    }));
}

function main() {
  const files = trackedSources();
  const found = files.flatMap((file) =>
    nestedSupers(file, readFileSync(join(ROOT, file), 'utf8')).map((at) => ({ file, ...at })),
  );
  if (found.length > 0) {
    console.error(`check:constructor-super: ${found.length} \`super\` call(s) inside a block:\n`);
    for (const { file, line, className, properties } of found) {
      console.error(
        `  ${file}:${line}: ${className} (parameter properties: ${properties.join(', ')})`,
      );
    }
    console.error(
      '\ntsc assigns parameter properties only after the root-level `super`, so they stay unset' +
        '\nafter one of these. Call `super` once at the constructor root, or declare the fields' +
        ' on the class and assign them by hand.',
    );
    process.exit(1);
  }
  console.log(
    `check:constructor-super: ${files.length} files: every constructor with parameter properties calls super at its root.`,
  );
}

// `argv[1]` as its real path, as `import.meta.url` is: run through a
// symlink (a checkout under macOS's `/tmp`), it's still this file.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
