// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
// reads-source: sdks/java/**/src/test/** sdks/scala/**/src/test/** .github/workflows/java.yml .github/workflows/scala.yml

/**
 * The Java and Scala workflows do their work only when their paths change
 * (changed-paths.mjs), so every repository file a JVM test reads must be one
 * of their paths. Otherwise a change to that file, a TypeScript one say, goes
 * through the merge queue without the test that reads it, and main finds out.
 *
 * The reads are found, not listed: each string literal in a test source that
 * is a path starting with `../`, resolved against the directory the test runs
 * in. Any other `..` in a literal is a path this check can't follow, so it's
 * refused however it's spelled (`".."`, `".." + "/x"`, `"x/../y"`), unless its
 * line ends with `// not-a-repo-read: <why>`: a path inside the test's own
 * files, a temporary directory say. A marked path starting with `../` that
 * names something in the repository is refused too, so the marker can't hide a
 * read.
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

/** A literal that is a path starting with `../`: a read. */
const READ = /^(?:\.\.\/)+[^"\s]*$/;
/** A `..` path segment: no `.`, letter, digit, `_` or `-` on either side. */
const SEGMENT = /(?<![-.\p{L}\p{N}_])\.\.(?![-.\p{L}\p{N}_])/u;
/** The text of a `//` comment that says its line isn't a repository read, and why. */
const MARKER = /^\s*not-a-repo-read:\s*\S/;
/** Scala's keywords: one before a `"` isn't an interpolator (`return"x"`). */
const SCALA_KEYWORDS = new Set(
  `abstract case catch class def do else enum export extends false final finally for given if
  implicit import lazy match new null object override package private protected return sealed
  super then this throw trait true try type val var while with yield`.split(/\s+/),
);
const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', s: ' ', '\n': '' };

/**
 * Whether a Scala `"` right after this text opens an interpolated string: the
 * word before it is an identifier, not a number or a keyword.
 *
 * @param {string} before the text before the `"`
 * @returns {boolean}
 */
function interpolator(before) {
  const word = /[\p{L}\p{N}_$]+$/u.exec(before)?.[0];
  return word !== undefined && !/^\p{N}/u.test(word) && !SCALA_KEYWORDS.has(word);
}

/**
 * A literal's text with its escapes decoded, as Java and Scala decode them.
 *
 * @param {string} text
 * @returns {string}
 */
function decoded(text) {
  return text.replace(
    /\\(?:u+([0-9a-fA-F]{4})|([0-3][0-7]{0,2}|[4-7][0-7]?)|([\s\S]))/g,
    (_, hex, octal, other) =>
      hex
        ? String.fromCharCode(Number.parseInt(hex, 16))
        : octal
          ? String.fromCharCode(Number.parseInt(octal, 8))
          : (ESCAPES[other] ?? other),
  );
}

/**
 * The string literals and `//` comments of a Java or Scala source, which a
 * regex over the text gets wrong: a `"` in a char literal, a comment or a
 * `"""` literal throws the pairing off, and `"http://…"` isn't a comment.
 *
 * - A literal is `{ value, written, line, end }`: its text with its escapes
 *   decoded, the same with them as written, and the lines it starts and ends
 *   on. A comment is `{ text, line }`.
 * - `"""` is a Java text block or a Scala multi-line string. A text block is
 *   taken as written: neither its first line break nor its indentation is
 *   stripped, so a `..` in one is refused rather than followed.
 * - Scala only: an interpolated string (`s"…"`, `s"""…"""`, any `id"…"`) gives
 *   a literal for each piece of its text, and the code in a `${…}` is read as
 *   code, so a string inside it is a literal of its own. As Scala 3's scanner
 *   reads it, `$$` and `$"` are a dollar and a quote, and a `\"` doesn't end a
 *   one-line string. In Java, `${` is text.
 * - In a Scala `"""` a backslash is only a backslash, and only `"""` ends it.
 *   Elsewhere `\"` and `\\` don't end a literal.
 *
 * @param {string} source
 * @param {boolean} scala whether it's a Scala source
 * @returns {{ literals: { value: string, written: string, line: number, end: number }[], comments: { text: string, line: number }[] }}
 */
function lex(source, scala) {
  const literals = [];
  const comments = [];
  let at = 0;
  let line = 1;
  const step = (n = 1) => {
    for (const c of source.slice(at, at + n)) if (c === '\n') line += 1;
    at += n;
  };

  const blockComment = () => {
    step(2);
    for (let depth = 1; depth > 0 && at < source.length; ) {
      if (source.startsWith('*/', at)) {
        depth -= 1;
        step(2);
      } else if (scala && source.startsWith('/*', at)) {
        depth += 1;
        step(2);
      } else step();
    }
  };

  const lineComment = () => {
    const stop = source.indexOf('\n', at);
    const to = stop === -1 ? source.length : stop;
    comments.push({ text: source.slice(at + 2, to), line });
    at = to;
  };

  // A char literal, `'"'` or `'\''`. Any other `'` is code: a Scala symbol or quote.
  const charLiteral = () =>
    step(/^'(?:\\.[^'\n]*|[^\\\n])'/u.exec(source.slice(at))?.[0].length ?? 1);

  // At a literal's closing quotes: steps past them. A run of more than three
  // quotes closes a `"""` at its last three.
  const closes = (triple, add) => {
    if (!source.startsWith(triple ? '"""' : '"', at)) return false;
    for (; triple && source[at + 3] === '"'; step()) add('"');
    step(triple ? 3 : 1);
    return true;
  };

  // At a backslash: it, and the `"` or `\` after it, which then doesn't end the literal.
  const backslash = () => {
    const n = source[at + 1] === '"' || source[at + 1] === '\\' ? 2 : 1;
    const text = source.slice(at, at + n);
    step(n);
    return text;
  };

  // In an interpolated string, at a `$`: false if it's only text. `$$` and `$"`
  // are a dollar and a quote, and `$name` and `${…}` end a piece of its text.
  const dollar = (pieces, add) => {
    const next = source[at + 1];
    if (next === '$' || next === '"') {
      add(next);
      step(2);
      return true;
    }
    const name = next === '{' ? '{' : /^[\p{L}_][\p{L}\p{N}_]*/u.exec(source.slice(at + 1))?.[0];
    if (name === undefined) return false;
    pieces.push('');
    step(1 + name.length);
    if (name === '{') {
      code(true);
      step();
    }
    return true;
  };

  const string = () => {
    const interpolated = scala && interpolator(source.slice(Math.max(0, at - 64), at));
    const triple = source.startsWith('"""', at);
    const escapes = !(scala && triple);
    const first = line;
    const pieces = [''];
    const add = (text) => {
      pieces[pieces.length - 1] += text;
    };
    step(triple ? 3 : 1);
    while (at < source.length && (triple || source[at] !== '\n') && !closes(triple, add)) {
      if (escapes && source[at] === '\\') add(backslash());
      else if (!(interpolated && source[at] === '$' && dollar(pieces, add))) {
        add(source[at]);
        step();
      }
    }
    for (const piece of pieces) {
      literals.push({ value: decoded(piece), written: piece, line: first, end: line });
    }
  };

  // Code, to the end of the source or, in a `${`, to the `}` that closes it.
  const code = (inBraces) => {
    for (let depth = 0; at < source.length; ) {
      const c = source[at];
      if (inBraces && c === '}' && depth === 0) return;
      if (source.startsWith('//', at)) lineComment();
      else if (source.startsWith('/*', at)) blockComment();
      else if (c === "'") charLiteral();
      else if (c === '"') string();
      else {
        if (c === '{') depth += 1;
        if (c === '}') depth -= 1;
        step();
      }
    }
  };

  code(false);
  return { literals, comments };
}

/**
 * What a test source reads from the repository, relative to its root, and the
 * `..` paths in it this check can't follow. A test runs in its module's
 * directory, the one holding `src/`: Maven runs a module's tests there, and sbt
 * forks them there (`Test / fork := true`).
 *
 * - A read is a literal that is a path starting with `../`.
 * - Any other literal with a `..` segment is a problem, however it's spelled.
 * - Neither counts on a line with a `// not-a-repo-read: <why>` comment (the
 *   line a literal starts or ends on), with one exception: a marked literal
 *   starting with `../` that names a file or directory in the repository is a
 *   problem, so the marker can't hide a read.
 *
 * @param {string} source the test source's text
 * @param {string} file its path, relative to the repository's root
 * @returns {{ reads: { literal: string, path: string }[], problems: string[] }}
 */
function readsOf(source, file) {
  const at = file.indexOf('/src/test/');
  assert.notEqual(at, -1, `${file} is a test source`);
  const module = file.slice(0, at);
  const repositoryPath = (literal) =>
    relative(ROOT, resolve(ROOT, module, literal))
      .split(sep)
      .join('/');
  // A marked literal's path, if it starts with ../ and names something in the repository.
  const hidden = (value) => {
    const path = value.startsWith('../') ? repositoryPath(value) : '..';
    const inside = path !== '..' && !path.startsWith('../');
    return inside && existsSync(join(ROOT, path)) ? path : undefined;
  };
  const { literals, comments } = lex(source, file.endsWith('.scala'));
  const marked = new Set(comments.filter(({ text }) => MARKER.test(text)).map(({ line }) => line));
  const reads = [];
  const problems = [];
  for (const { value, written, line, end } of literals) {
    if (marked.has(line) || marked.has(end)) {
      const path = hidden(value);
      if (path !== undefined) {
        problems.push(
          `${file}:${line} marks ${JSON.stringify(value)} as not a repository read, but ${path || '.'} is in the repository: drop the marker, so this check follows it`,
        );
      }
    } else if (READ.test(value)) {
      reads.push({ literal: value, path: repositoryPath(value) });
    } else if (SEGMENT.test(value) || SEGMENT.test(written)) {
      problems.push(
        `${file}:${line} has a .. path this check can't follow (${JSON.stringify(value)}): write a repository read as one string starting with ../, or end the line with // not-a-repo-read: <why> for a path in the test's own files`,
      );
    }
  }
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
  });

  test("a .. this check can't follow is refused however it's spelled, unless its line says it isn't a repository read", () => {
    const java = 'sdks/java/x/src/test/java/A.java';
    const scala = 'sdks/scala/x/src/test/scala/A.scala';
    const refused = (value) =>
      `${java}:1 has a .. path this check can't follow (${JSON.stringify(value)}): write a repository read as one string starting with ../, or end the line with // not-a-repo-read: <why> for a path in the test's own files`;
    const marks = (value, path) =>
      `${java}:1 marks ${JSON.stringify(value)} as not a repository read, but ${path} is in the repository: drop the marker, so this check follows it`;
    // [source, file, reads, problems]
    const rows = [
      ['Path.of("..", "..", "packages")', java, [], [refused('..'), refused('..')]],
      ['String UP = "..";', java, [], [refused('..')]],
      ['Path p = Path.of(".." + "/x");', java, [], [refused('..')]],
      ['Path.of("x/../y", "..\\\\x")', java, [], [refused('x/../y'), refused('..\\x')]],
      ['String s = "\\u002e\\u002e";', java, [], [refused('..')]],
      ['String UP = ".."; // not-a-repo-read: a TempDir path', java, [], []],
      ['String UP = ".."; // not-a-repo-read:', java, [], [refused('..')]],
      ['Path.of("..", "// not-a-repo-read: x")', java, [], [refused('..')]],
      ['Path.of("../tmp/x"); // not-a-repo-read: inside the TempDir', java, [], []],
      [
        'Path.of("../../../.github/workflows/java.yml"); // not-a-repo-read: x',
        java,
        [],
        [marks('../../../.github/workflows/java.yml', '.github/workflows/java.yml')],
      ],
      [
        'Path.of("../kindgi-pack/src/test"); // not-a-repo-read: x',
        java,
        [],
        [marks('../kindgi-pack/src/test', 'sdks/java/kindgi-pack/src/test')],
      ],
      ['// see "../x"\n/* "../x" */\nvoid f(Object... kv) {}', java, [], []],
      [
        'String j = """\n  a "quote\n  """ + Path.of("../a");',
        java,
        [{ literal: '../a', path: 'sdks/java/a' }],
        [],
      ],
      ['String j = """\n  {"dir": "../a"}\n  """;', java, [], [refused('\n  {"dir": "../a"}\n  ')]],
      [
        'val a = s"${read("../a")}: ${e.get("code")}"',
        scala,
        [{ literal: '../a', path: 'sdks/scala/a' }],
        [],
      ],
      [
        'val a = s"say \\"hi\\" $"" + "../a"',
        scala,
        [{ literal: '../a', path: 'sdks/scala/a' }],
        [],
      ],
    ];
    for (const [source, file, reads, problems] of rows) {
      assert.deepEqual(readsOf(source, file), { reads, problems }, source);
    }
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
