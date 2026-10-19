// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import {
  blocks,
  cliProblem,
  fileSamples,
  fillPlaceholders,
  generatedBaseline,
  jsonProblem,
  kindgiArgs,
  libraries,
  missingGenerated,
  pageRules,
  pages,
  shellCommands,
  shellProblems,
} from './check-samples.mjs';

/** A CLI shaped like `describeCommands()` and `describeGlobalFlags()`. */
const leaf = (path, flags = []) => ({
  name: path.at(-1),
  path,
  description: '',
  usage: `kindgi ${path.join(' ')}`,
  flags,
  subcommands: [],
});
const cli = {
  globals: [
    { name: 'help', type: 'boolean', short: 'h' },
    { name: 'json', type: 'boolean' },
    { name: 'url', type: 'string' },
    { name: 'version', type: 'boolean' },
  ],
  commands: [
    {
      name: 'runs',
      path: ['runs'],
      description: '',
      flags: [],
      subcommands: [
        leaf(['runs', 'list'], [{ name: 'status', type: 'string' }]),
        leaf(['runs', 'cancel'], [{ name: 'wait', type: 'boolean', short: 'w' }]),
      ],
    },
    leaf(['init'], [{ name: 'template', type: 'string' }]),
  ],
};

const fence = '```';

test('blocks: the fence line, its language and meta, indented MDX, stubs', () => {
  const page = [
    'Intro',
    `${fence}ts excerpt`,
    'run();',
    fence,
    '<Tabs>',
    `  ${fence}python title="x"`,
    '  run()',
    `  ${fence}`,
    '{/* check-samples:',
    `${fence}ts`,
    '// lib/requests.ts',
    fence,
    '*/}',
  ].join('\n');
  const found = blocks(page).map(({ language, meta, line, lines, stub }) => ({
    language,
    meta,
    line,
    lines,
    stub,
  }));
  assert.deepEqual(found, [
    { language: 'ts', meta: 'excerpt', line: 2, lines: ['run();'], stub: false },
    { language: 'python', meta: 'title="x"', line: 6, lines: ['run()'], stub: false },
    { language: 'ts', meta: '', line: 10, lines: ['// lib/requests.ts'], stub: true },
  ]);
});

test('a page: a compiled-language block is a whole file or an excerpt', () => {
  const page = [
    `${fence}ts`,
    '// tools/lookup/index.ts',
    "export const id = 'acme.lookup';",
    fence,
    `${fence}ts`,
    'await kindgi.runs.start(input);',
    fence,
    `${fence}python excerpt`,
    'kindgi.runs.start(input)',
    fence,
    `${fence}python`,
    'kindgi.runs.start(…)',
    fence,
    `${fence}java excerpt`,
    '// src/main/java/com/acme/app/StartRun.java',
    fence,
  ].join('\n');
  const { problems } = pageRules(page, cli);
  assert.deepEqual(
    problems.map(({ line }) => line),
    [5, 14],
  );
  assert.match(problems[0].message, /a ts block that isn't a whole file: name the file/);
  assert.match(problems[1].message, /marked `excerpt` but names a file/);
});

test('a page: a signature is offered for nothing, so it needs no file name', () => {
  const page = [
    `${fence}python signature`,
    'get(agent_id: str, /, *, timeout: float | None = None) -> Agent',
    fence,
    `${fence}ts signature`,
    'function start(input: StartRunInput): Promise<Run>',
    fence,
    `${fence}python signature`,
    '# tools/lookup.py',
    fence,
  ].join('\n');
  const { problems } = pageRules(page, cli);
  assert.deepEqual(
    problems.map(({ line }) => line),
    [7],
  );
  assert.match(problems[0].message, /marked `signature` but names a file/);
});

test("a page: text isn't checked, other languages are excerpts, JSON parses", () => {
  const page = [
    `${fence}text`,
    'Kindgi API server listening on http://localhost:4000',
    fence,
    `${fence}hcl`,
    'region = "us-central1"',
    fence,
    `${fence}hcl excerpt`,
    'region = "us-central1"',
    fence,
    `${fence}json`,
    '{ "status": "completed" }',
    fence,
    `${fence}json`,
    '"status": "completed",',
    fence,
    `${fence}json`,
    '{ "items": […] }',
    fence,
  ].join('\n');
  const { problems } = pageRules(page, cli);
  assert.deepEqual(
    problems.map(({ line }) => line),
    [4, 13],
  );
  assert.match(problems[0].message, /a `hcl` block, which nothing checks/);
  assert.match(problems[1].message, /part of a JSON document/);
});

test('a page: shell blocks go to `bash -n` only when their commands check', () => {
  const page = [
    `${fence}sh`,
    'kindgi runs list --status failed',
    fence,
    `${fence}sh`,
    'kindgi runs lst',
    fence,
    `${fence}sh`,
    '$ kindgi runs list',
    fence,
  ].join('\n');
  const { problems, shell } = pageRules(page, cli);
  assert.deepEqual(
    shell.map(({ line }) => line),
    [1],
  );
  assert.deepEqual(
    problems.map(({ line, message }) => [line, message.split(':')[0]]),
    [
      [4, '`kindgi runs` has no command `lst`'],
      [7, 'a transcript'],
    ],
  );
});

test('JSON: a document, JSON Lines, JSONC; a block with comments is jsonc', () => {
  assert.equal(jsonProblem('{"a": 1}', false), undefined);
  assert.equal(jsonProblem('{"a": 1}\n{"a": 2}\n', false), undefined);
  assert.equal(jsonProblem('{\n  // the id\n  "a": 1,\n}', true), undefined);
  assert.match(jsonProblem('{\n  // the id\n  "a": 1\n}', false), /is `jsonc`/);
  assert.match(jsonProblem('"a": 1,\n"b": 2', false), /part of a JSON document/);
  // One line, whatever the parser quotes; the jsonc hint only for a block with comments.
  const broken = jsonProblem('{\n  "data": [ ... ],\n  "next": null\n}', false);
  assert.match(broken, /^doesn't parse as JSON: /);
  assert.doesNotMatch(broken, /\n|jsonc/);
});

test('placeholders become one word for the shell', () => {
  assert.equal(
    fillPlaceholders("kindgi runs get <run-id> --url <the runtime's URL> > out.json"),
    'kindgi runs get __placeholder__ --url __placeholder__ > out.json',
  );
  assert.equal(fillPlaceholders('cat <<EOF > out.txt'), 'cat <<EOF > out.txt');
});

test("a shell block's commands: quotes, continuations, comments, redirections", () => {
  const code = [
    '# list the failed ones',
    'kindgi runs list \\',
    '  --status "failed" 2>&1 | jq \'.items[]\' > runs.json',
    'RUN=$(kindgi runs list --json) && kindgi runs cancel "$RUN" -w # stop it',
    'cat <<EOF > notes.txt',
    'kindgi is not a command here',
    'EOF',
    'echo done',
  ].join('\n');
  assert.deepEqual(shellCommands(code), [
    ['kindgi', 'runs', 'list', '--status', 'failed'],
    ['jq', '.items[]'],
    ['kindgi', 'runs', 'list', '--json'],
    ['RUN=__subst__'],
    ['kindgi', 'runs', 'cancel', '$RUN', '-w'],
    ['cat'],
    ['echo', 'done'],
  ]);
});

test("the CLI's launchers, and commands that only mention kindgi", () => {
  const args = (line) => kindgiArgs(shellCommands(line)[0]);
  assert.deepEqual(args('kindgi runs list'), ['runs', 'list']);
  assert.deepEqual(args('KINDGI_URL=x kindgi runs list'), ['runs', 'list']);
  assert.deepEqual(args('npx --yes @kindgi/cli@0.1.7 init acme'), ['init', 'acme']);
  assert.deepEqual(args('npx --no -- kindgi runs list'), ['runs', 'list']);
  assert.deepEqual(args('pnpm exec kindgi runs list'), ['runs', 'list']);
  assert.deepEqual(args('./kindgiw runs list'), ['runs', 'list']);
  assert.deepEqual(args('pnpm dlx @kindgi/cli init acme'), ['init', 'acme']);
  assert.deepEqual(args('uv run --with httpx kindgi runs list'), ['runs', 'list']);
  assert.deepEqual(args('uvx --from "kindgi-cli==0.1.7" kindgi runs list'), ['runs', 'list']);
  assert.equal(args('docker run -d --name kindgi quay.io/kindgi/runtime'), undefined);
  assert.equal(args('npx create-next-app kindgi'), undefined);
  assert.equal(args('uv run python -m kindgi.pack index'), undefined);
});

test("the CLI's commands and flags, as it parses them", () => {
  assert.equal(cliProblem(['runs', 'list', '--status', 'failed', '--json'], cli), undefined);
  assert.equal(
    cliProblem(['runs', 'list', '--status=failed', '--url', 'http://x'], cli),
    undefined,
  );
  assert.equal(cliProblem(['runs', 'cancel', '$RUN', '-w'], cli), undefined);
  assert.equal(cliProblem(['init', '__placeholder__', '--template', 'python'], cli), undefined);
  assert.equal(cliProblem(['--version'], cli), undefined);
  assert.equal(cliProblem(['runs', '--help'], cli), undefined);
  assert.equal(cliProblem(['runs', '__placeholder__'], cli), undefined);
  assert.equal(cliProblem(['run', 'list'], cli), '`kindgi` has no command `run`');
  assert.equal(cliProblem(['runs', 'lst'], cli), '`kindgi runs` has no command `lst`');
  assert.equal(
    cliProblem(['runs', 'list', '--wait'], cli),
    "`kindgi runs list`: Unknown option '--wait'",
  );
  assert.equal(cliProblem(['runs', 'list', '-w'], cli), "`kindgi runs list`: Unknown option '-w'");
  // A flag of the command, not the group: `runs` itself takes only global flags.
  assert.equal(
    cliProblem(['runs', '--status', 'x'], cli),
    "`kindgi runs`: Unknown option '--status'",
  );
});

test('shell problems: the commands of every launcher in a block', () => {
  const code = 'npx --yes @kindgi/cli@0.1.7 runs list --bogus\nuv run kindgi runs list';
  assert.deepEqual(shellProblems(code, cli), ["`kindgi runs list`: Unknown option '--bogus'"]);
});

test('a JVM test is a whole file too: src/test/java and src/test/scala', () => {
  const page = [
    `${fence}java`,
    '// src/test/java/mypack/tools/LookupOrderTest.java',
    'class LookupOrderTest {}',
    fence,
    `${fence}scala`,
    '// src/test/scala/mypack/tools/LookupOrderSuite.scala',
    'class LookupOrderSuite',
    fence,
    `${fence}java`,
    '// test/LookupOrderTest.java',
    fence,
  ].join('\n');
  assert.deepEqual(
    pageRules(page, cli).problems.map(({ line }) => line),
    [9],
  );
  assert.deepEqual(
    fileSamples(page).java.map((file) => file.path),
    ['src/test/java/mypack/tools/LookupOrderTest.java'],
  );
});

test("a page's whole files: excerpts and signatures stay out; a skill's files are all kept", () => {
  const page = [
    `${fence}ts`,
    '// tools/a/index.ts',
    'export {};',
    fence,
    `${fence}ts excerpt`,
    '// tools/b/index.ts',
    fence,
    `${fence}ts signature`,
    '// tools/c/index.ts',
    fence,
  ].join('\n');
  const paths = (files) => files.ts.map((file) => file.path);
  assert.deepEqual(paths(fileSamples(page, { offeredOnly: true })), ['tools/a/index.ts']);
  assert.deepEqual(paths(fileSamples(page)), [
    'tools/a/index.ts',
    'tools/b/index.ts',
    'tools/c/index.ts',
  ]);
});

test('every page, the generated reference included; a whole run needs it generated', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-samples-pages-'));
  try {
    // A page by its slug: its path under the docs, without the extension.
    const page = (slug, extension = 'md') => {
      mkdirSync(join(root, slug, '..'), { recursive: true });
      writeFileSync(join(root, `${slug}.${extension}`), '# A page\n');
    };
    page('start/install');
    page('guides/tools/write-a-tool', 'mdx');
    page('reference/index');
    page('contributing/repository');
    writeFileSync(join(root, 'reference', 'openapi.json'), '{}');
    assert.deepEqual(missingGenerated(root), [
      'reference/cli',
      'reference/python',
      'reference/typescript',
    ]);
    page('reference/cli/runs');
    assert.deepEqual(missingGenerated(root), ['reference/python', 'reference/typescript']);
    page('reference/python/client');
    assert.deepEqual(missingGenerated(root), ['reference/typescript']);
    page('reference/typescript/sdk/client/index');
    assert.deepEqual(missingGenerated(root), []);
    assert.deepEqual(
      pages(root)
        .map((path) => relative(root, path))
        .sort(),
      [
        'contributing/repository',
        'guides/tools/write-a-tool',
        'reference/cli/runs',
        'reference/index',
        'reference/python/client',
        'reference/typescript/sdk/client/index',
        'start/install',
      ].map((slug) => (slug.startsWith('guides/') ? `${slug}.mdx` : `${slug}.md`)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failing generated (ignored) page gets the baseline line that lets it pass; a written one gets none', () => {
  const failing = [
    { page: 'guides/tools/write-a-tool', lines: ['a', 'b'] },
    { page: 'reference/typescript/sdk/@kindgi/sdk/client/functions/newExport', lines: ['a'] },
    { page: 'reference/python/client', lines: ['a', 'b', 'c'] },
  ];
  const ignored = new Set([
    'reference/typescript/sdk/@kindgi/sdk/client/functions/newExport',
    'reference/python/client',
    'reference/python/runs',
  ]);
  assert.deepEqual(generatedBaseline(failing, ignored), [
    '  "reference/typescript/sdk/@kindgi/sdk/client/functions/newExport": 1,',
    '  "reference/python/client": 3,',
  ]);
  // A tracked page, or a new one not committed yet, isn't ignored.
  assert.deepEqual(generatedBaseline(failing.slice(0, 1), ignored), []);
});

/** A page's hidden `check-samples` comment around `lines`. */
const standIn = (...lines) => ['<!-- check-samples:', ...lines, '-->'];

test("a page's install step for the check: `uv add` and `pnpm add` lines in its check-samples comment", () => {
  const page = [
    `${fence}sh`,
    'uv add fastapi',
    fence,
    ...standIn(
      `${fence}sh`,
      '# The receiver imports FastAPI.',
      "uv add fastapi 'uvicorn[standard]>=0.30,<1'",
      '',
      'pnpm add hono @acme/client@^2',
      fence,
    ),
  ].join('\n');
  assert.deepEqual(libraries(page), {
    adds: [
      { language: 'python', libraries: ['fastapi', 'uvicorn[standard]>=0.30,<1'], line: 7 },
      { language: 'ts', libraries: ['hono', '@acme/client@^2'], line: 9 },
    ],
    problems: [],
  });
});

test('an install line for the check is exactly `uv add` or `pnpm add` and libraries: anything else is never run', () => {
  const refused = [
    'uv add --dev pytest',
    'uv add fastapi;',
    'uv add fastapi; touch /tmp/x',
    'uv add fastapi && rm -rf build',
    'uv add fastapi &',
    'uv add fastapi | sh',
    'uv add fastapi > out.txt',
    'uv add $(curl -s https://example.com/name)',
    'uv add `name`',
    'uv add fast\\',
    'uv add git+https://github.com/acme/receiver',
    'uv add ./vendor/receiver',
    'uv add https://example.com/receiver-1.0-py3-none-any.whl',
    "uv add 'fastapi",
    'uv add',
    'uv pip install fastapi',
    'pip install fastapi',
    'pnpm add -D vitest',
    'pnpm add github:acme/client',
    'pnpm add file:../client',
    'pnpm install hono',
    'npm install hono',
  ];
  for (const line of refused) {
    const { adds, problems } = libraries(standIn(`${fence}sh`, line, fence).join('\n'));
    assert.deepEqual(adds, [], line);
    assert.equal(problems.length, 1, line);
    assert.equal(problems[0].line, 3, line);
    assert.match(problems[0].message, /only adds the libraries the samples import/, line);
  }
});

test("a page's install step for the check: the page shows the reader the same step, for a whole file", () => {
  const receiver = [`${fence}python`, '# receiver.py', 'from fastapi import FastAPI', fence];
  const hidden = standIn(`${fence}sh`, "uv add fastapi 'uvicorn[standard]'", fence);
  const rules = (...lines) => pageRules(lines.join('\n'), cli).problems;
  // Shown: `uv add`, or `pip install` with flags and another case and separator.
  assert.deepEqual(
    rules(`${fence}sh`, 'uv add fastapi uvicorn', fence, ...receiver, ...hidden),
    [],
  );
  assert.deepEqual(
    rules(
      `${fence}sh`,
      'pip install --upgrade FastAPI "Uvicorn[standard]"',
      fence,
      ...receiver,
      ...hidden,
    ),
    [],
  );
  // Not shown: the hidden step is what makes the sample compile.
  const [notShown] = rules(`${fence}sh`, 'uv add uvicorn', fence, ...receiver, ...hidden);
  assert.equal(notShown.line, 10);
  assert.match(
    notShown.message,
    /adds `fastapi` for the check, but no install command on the page shows the reader that step/,
  );
  // A step in the other language's command doesn't count.
  assert.equal(
    rules(`${fence}sh`, 'pnpm add fastapi uvicorn', fence, ...receiver, ...hidden).length,
    1,
  );
  // A step for a language the page has no whole file in checks nothing.
  const [nothing] = rules(`${fence}sh`, 'uv add fastapi uvicorn', fence, ...hidden);
  assert.match(
    nothing.message,
    /adds Python libraries, but the page has no whole Python file to check with them/,
  );
});
