// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Java and Scala workflows do their work only when their paths change
 * (changed-paths.mjs), so every repository file a JVM test reads must be one
 * of their paths. Otherwise a change to that file, a TypeScript one say, goes
 * through the merge queue without the test that reads it, and main finds out.
 *
 * The reads are found, not listed: each string literal in a test source that
 * starts with `../`, resolved against the directory the test runs in.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { matches } from './changed-paths.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = `${sep}src${sep}test${sep}`;

const WORKFLOWS = [
  { workflow: '.github/workflows/java.yml', sources: 'sdks/java', ext: '.java' },
  { workflow: '.github/workflows/scala.yml', sources: 'sdks/scala', ext: '.scala' },
];

/**
 * The paths a workflow passes to changed-paths.mjs: the words after it, to the
 * end of its folded `run:`.
 *
 * @param {string} text the workflow
 * @returns {string[]}
 */
function workflowPaths(text) {
  const lines = text.split('\n');
  const starts = lines.flatMap((line, i) =>
    line.trim() === 'node scripts/changed-paths.mjs' ? [i] : [],
  );
  assert.equal(starts.length, 1, 'the workflow runs changed-paths.mjs once, on a line of its own');
  const indent = lines[starts[0]].search(/\S/);
  const paths = [];
  for (const line of lines.slice(starts[0] + 1)) {
    if (line.trim() === '' || line.search(/\S/) < indent) break;
    paths.push(
      ...line
        .trim()
        .split(/\s+/)
        .map((word) => word.replace(/^'(.*)'$/, '$1')),
    );
  }
  return paths;
}

/**
 * The test sources under a directory: files with the extension under a
 * `src/test/` directory, leaving out build output.
 *
 * @param {string} dir relative to the repository's root
 * @param {string} ext
 * @returns {string[]} absolute paths
 */
function testSources(dir, ext) {
  const found = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name === 'target' || entry.name.startsWith('.')) continue;
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(ext) && path.includes(TEST_DIR)) found.push(path);
    }
  };
  walk(join(ROOT, dir));
  return found;
}

/**
 * What a test source reads from the repository, relative to its root. A test
 * runs in its module's directory, the one holding `src/`: Maven runs a
 * module's tests there, and sbt forks them there (`Test / fork := true`). A
 * path written as parts (`"..", "..", …`) can't be followed, so it's a
 * problem to fix by writing it as one string.
 *
 * @param {string} source the test source's text
 * @param {string} file its path, relative to the repository's root
 * @returns {{ reads: { literal: string, path: string }[], problems: string[] }}
 */
function readsOf(source, file) {
  const at = file.indexOf('/src/test/');
  assert.notEqual(at, -1, `${file} is a test source`);
  const module = file.slice(0, at);
  const reads = [...source.matchAll(/"((?:\.\.\/)+[^"\s]*)"/g)].map(([, literal]) => ({
    literal,
    path: relative(ROOT, resolve(ROOT, module, literal))
      .split(sep)
      .join('/'),
  }));
  const problems = /"\.\."\s*,/.test(source)
    ? [
        `${file} writes a path as parts ("..", …); write it as one string, so this check can follow it`,
      ]
    : [];
  return { reads, problems };
}

describe('the JVM workflows run when a file their tests read changes', () => {
  test("a workflow's paths are the words after changed-paths.mjs, quoted or not", () => {
    const workflow = [
      '      - id: paths',
      '        run: >-',
      '          node scripts/changed-paths.mjs',
      "          'sdks/java/**' packages/api/openapi.json",
      '          scripts/check-jars.mjs',
      '',
      '  java:',
    ].join('\n');
    assert.deepEqual(workflowPaths(workflow), [
      'sdks/java/**',
      'packages/api/openapi.json',
      'scripts/check-jars.mjs',
    ]);
  });

  test("a test's reads are its literals starting with ../, from its module's directory", () => {
    const source = [
      'Path a = Path.of("../../../packages/api/openapi.json");',
      'Path b = Path.of(System.getProperty("x", "../kindgi-client/pom.xml"));',
      'String c = "packages/not-a-read.json";',
    ].join('\n');
    assert.deepEqual(readsOf(source, 'sdks/java/kindgi-pack/src/test/java/A.java'), {
      reads: [
        { literal: '../../../packages/api/openapi.json', path: 'packages/api/openapi.json' },
        { literal: '../kindgi-client/pom.xml', path: 'sdks/java/kindgi-client/pom.xml' },
      ],
      problems: [],
    });
    assert.deepEqual(
      readsOf('Path.of("..", "..", "packages")', 'sdks/java/x/src/test/java/A.java').problems,
      [
        'sdks/java/x/src/test/java/A.java writes a path as parts ("..", …); write it as one string, so this check can follow it',
      ],
    );
  });

  for (const { workflow, sources, ext } of WORKFLOWS) {
    test(`${workflow}'s paths cover every file a test under ${sources} reads`, () => {
      const { problems, count } = coverage(workflow, sources, ext);
      assert.deepEqual(problems, []);
      // The Java tests read the API document, the log vectors and the built-in checks.
      if (ext === '.java') assert.ok(count > 0, `found no reads under ${sources}`);
    });
  }
});

/**
 * Each read under `sources` that isn't a repository file or isn't one of the
 * workflow's paths, and how many reads there were.
 *
 * @param {string} workflow
 * @param {string} sources
 * @param {string} ext
 * @returns {{ problems: string[], count: number }}
 */
function coverage(workflow, sources, ext) {
  const patterns = workflowPaths(readFileSync(join(ROOT, workflow), 'utf8'));
  const problems = [];
  let count = 0;
  for (const absolute of testSources(sources, ext)) {
    const file = relative(ROOT, absolute).split(sep).join('/');
    const found = readsOf(readFileSync(absolute, 'utf8'), file);
    problems.push(...found.problems);
    count += found.reads.length;
    for (const { literal, path } of found.reads) {
      if (path.startsWith('../') || !existsSync(join(ROOT, path))) {
        problems.push(`${file} reads "${literal}", which isn't a file in the repository`);
      } else if (!matches(path, patterns)) {
        problems.push(`${file} reads ${path}, which isn't one of ${workflow}'s paths`);
      }
    }
  }
  return { problems, count };
}
