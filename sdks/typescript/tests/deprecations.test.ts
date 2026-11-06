// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
// reads-source: sdks/typescript/src/**/*.ts

/**
 * A deprecation names no version. Each `@deprecated` tag in the client's
 * source says what to use instead and, when it speaks of removal, says "a
 * later minor release, announced in advance" (runs.ts's form). A tag that
 * names a release ("removed in 0.2") ships in the d.ts and outlives that
 * release when the removal moves.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src');

// A version number anywhere in a tag's text: "0.2", "v0.6", "1.0.0".
const NAMES_A_VERSION = /\bv?\d+\.\d+/u;

interface Tag {
  readonly where: string;
  readonly text: string;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/**
 * Each `@deprecated` tag in `source`'s doc comments: its text runs from the
 * tag to the next tag or the comment's end, its lines joined, so a version
 * that wraps to the next line is still in it.
 */
function deprecatedTags(source: string, file: string): Tag[] {
  const tags: Tag[] = [];
  for (const comment of source.matchAll(/\/\*\*([\s\S]*?)\*\//gu)) {
    const startLine = source.slice(0, comment.index).split('\n').length;
    const lines = (comment[1] ?? '').split('\n').map((l) => l.replace(/^\s*\*?\s*/u, ''));
    let open: { line: number; parts: string[] } | undefined;
    const close = (): void => {
      if (open === undefined) return;
      tags.push({ where: `${file}:${open.line}`, text: open.parts.join(' ').trim() });
      open = undefined;
    };
    lines.forEach((line, i) => {
      if (line.startsWith('@')) {
        close();
        if (line.startsWith('@deprecated')) {
          open = { line: startLine + i, parts: [line.slice('@deprecated'.length)] };
        }
      } else if (open !== undefined) {
        open.parts.push(line);
      }
    });
    close();
  }
  return tags;
}

const offenders = (tags: readonly Tag[]): string[] =>
  tags.filter((t) => NAMES_A_VERSION.test(t.text)).map((t) => `${t.where}: ${t.text}`);

describe('@deprecated tags name no version', () => {
  const tags = sourceFiles(SRC).flatMap((path) =>
    deprecatedTags(readFileSync(path, 'utf8'), relative(SRC, path)),
  );

  it('no tag in src names a release', () => {
    expect(offenders(tags)).toEqual([]);
  });

  it('reads the tags it checks, runs.ts among them', () => {
    const runs = tags.find((t) => t.where.startsWith(join('resources', 'runs.ts')));
    expect(runs?.text).toMatch(
      /^Use `runs\.follow`, which does the same\. In a later minor release/u,
    );
  });

  it('fails a tag that names a version, on its line or wrapped to the next', () => {
    expect(
      offenders(deprecatedTags('/** @deprecated Use `x`; removed in 0.6. */', 'a.ts')),
    ).toEqual(['a.ts:1: Use `x`; removed in 0.6.']);
    const wrapped = [
      '/**',
      ' * Lists them.',
      ' *',
      ' * @deprecated Use `x`, which sends the same request. It goes away in',
      ' *   v0.6.',
      ' * @wire GET /v1/x',
      ' */',
    ].join('\n');
    expect(offenders(deprecatedTags(wrapped, 'b.ts'))).toEqual([
      'b.ts:4: Use `x`, which sends the same request. It goes away in v0.6.',
    ]);
  });

  it("passes runs.ts's form, and a version outside the tag", () => {
    const houseForm = [
      '/**',
      ' * Added in 0.3.',
      ' *',
      ' * @deprecated Use `runs.follow`, which does the same. In a later minor',
      ' *   release, announced in advance, `runs.stream` becomes the plain',
      ' *   call: it ends when the server closes the stream (after 5 minutes).',
      ' * @since 0.3.0',
      ' */',
    ].join('\n');
    const found = deprecatedTags(houseForm, 'c.ts');
    expect(found).toHaveLength(1);
    expect(offenders(found)).toEqual([]);
  });
});
