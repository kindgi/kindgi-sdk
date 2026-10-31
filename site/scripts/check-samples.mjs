#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * Checks the code samples on the site's pages (the generated reference
 * pages included), and in the skills
 * `kindgi init` installs (`packages/sdk/skills/`) whose samples are whole
 * files (`"samples": "checked"` in `site/skills-sources.json`; a skill's
 * teaching fragments stay unchecked until it's revised to make them whole).
 *
 * A sample that is a whole file names it on its first line
 * (`// tools/lookup/index.ts`, `# tools/lookup.py`). For each page, its
 * TypeScript files are written over a fresh `sample` pack and typechecked
 * (`tsc --noEmit`, with every sample file listed: the pack's tsconfig
 * includes only its own folders, and an app file such as `// release.ts`
 * would otherwise be skipped). Its Python files go over a fresh `python`
 * pack: the pack's own modules are indexed (`python -m kindgi.pack index`,
 * which imports every module it discovers), with no file errors allowed,
 * and every other file (app code, `# derive.py`) is type-checked with
 * pyright against the pack's environment, since importing it would run its
 * calls. The pack's id is the one the samples use. Its Java files
 * (`// src/main/java/com/acme/Name.java`) are compiled together with
 * `javac --release 17` against the Java SDK this checkout builds
 * (`sdks/java`: the client's jar and what its published POM depends on,
 * and kindgi-pack's classes and dependencies), offline. When they're a
 * pack's (they use `com.kindgi.pack`), they go over a fresh `java` pack,
 * compile with its sources, and the pack is indexed
 * (`com.kindgi.pack.Main index`), with no file errors allowed. Its Scala
 * files (`// src/main/scala/acme/tools/Name.scala`) go over a fresh `scala`
 * pack, which sbt compiles against the Scala layer this checkout builds
 * (kindgi-pack in the local Maven repository, kindgi-pack-scala published
 * locally), and the pack is indexed the same way. A Java or Scala file that
 * doesn't import `com.kindgi.pack` is app code calling the Java client
 * (`com.kindgi.client`): Java compiles alone, and Scala compiles with sbt
 * over a fresh `scala` pack that also depends on kindgi-client, with no index.
 * A Java or Scala test (`// src/test/java/…`, `// src/test/scala/…`) goes
 * over a fresh pack too, and the pack's own build runs it (Maven's `test`
 * with JUnit, sbt's `test` with munit), so its asserts are checked.
 *
 * Snippets run as pasted: on a page, every code block is either offered for
 * copying and checked, or an excerpt (`excerpts.mjs`: its fence says
 * `excerpt`, or it contains `…`) or a signature (its fence says
 * `signature`: a reference page's declaration), which the site shows
 * without a copy button. So on a page, the check also fails on:
 *   - a TypeScript, Python, Java or Scala block that isn't a whole file and
 *     isn't an excerpt or a signature, and an excerpt or signature that
 *     names a file;
 *   - a shell block that's a transcript (a `$ ` prompt), that `bash -n`
 *     refuses (with `<placeholders>` filled in), or whose `kindgi` command
 *     names a command or a flag the CLI doesn't have (`kindgi`, `npx …
 *     @kindgi/cli`, `pnpm exec kindgi`, `uv run kindgi`, `uvx … kindgi`);
 *   - a JSON block that doesn't parse (`jsonc` allows comments), a TOML or XML
 *     block that doesn't parse (python3's tomllib and XML parser), a
 *     JavaScript block that `node --check` refuses;
 *   - a block in any other language (hcl, sql, …): it can't be checked, so
 *     it's an excerpt. Text blocks (output, a prompt to paste) aren't code
 *     and stay as they are.
 * Skills keep only the whole-file check: they aren't rendered with copy buttons.
 * The generated reference pages are git-ignored: `docs:build` writes them
 * (`generate-reference.mjs` the CLI's and the Python SDK's, the site's build
 * the TypeScript SDK's) before CI's `docs:samples`, and a run over every
 * page fails without them.
 *
 * A sample may import the reader's own app code (`@/lib/requests`,
 * `acme.orders`). The page gives the checker a stand-in for it in a comment
 * readers don't see, `<!-- check-samples: … -->` (`{/* check-samples: … *\/}`
 * in MDX), holding ordinary named-file blocks: they're written into the pack
 * with the samples but aren't counted as samples. A `tsconfig.json` there (a
 * `json` block named `// tsconfig.json`) replaces the pack's, for samples from
 * an app with its own settings (Next.js: `moduleResolution: "bundler"`, the
 * `@/*` paths).
 *
 * A sample may also import a library the reader adds to their app
 * (`from fastapi import FastAPI`). The same comment then holds the reader's
 * install step, a shell block of `uv add <library> …` (Python) or
 * `pnpm add <library> …` (TypeScript) lines. The check runs it as words,
 * without a shell, in that page's own copy of the pack before compiling, so
 * the sample is checked against the library itself and no other page's pack
 * gets it. Any other line there (a flag, a URL, a path, `;`, a pipe, `$(…)`)
 * is a problem and is never run. A library that no install command on the
 * page shows the reader is a problem too. Java and Scala samples have no such
 * step: they compile against their pack and the Java client only.
 *
 * Needs the workspace built (`pnpm run build`), uv for Python samples, for
 * Java samples a JDK 17 or later and the Java SDK built
 * (`cd sdks/java && ./mvnw package -DskipTests`), and for Scala samples sbt,
 * with kindgi-pack installed and the Scala layer published locally
 * (`./mvnw -pl kindgi-pack -am install -DskipTests` in sdks/java,
 * `sbt publishLocal` in sdks/scala). A missing tool fails the check; it's
 * never skipped. The page rules need bash and python3 (3.11 or later, for
 * tomllib), and the workspace built (`@kindgi/cli`, for its commands).
 *
 * Usage: node site/scripts/check-samples.mjs [--no-compile] [<page or skill file> …]
 *   (a page path is relative to site/src/content/docs; default: every page
 *   and skill, after `pnpm run docs:build`, which generates the reference)
 *   --no-compile: the page rules only, without compiling the whole files
 *   (no pack, JDK or sbt needed): the quick list for a page's author.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { EXCERPT, SIGNATURE, uncopied } from './excerpts.mjs';
import { docsVersion, fillVersion } from './versioned-pages.mjs';

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(site, '..');
const docs = join(site, 'src', 'content', 'docs');
/** `{{kindgi.version}}` in a page, as the build fills it. */
const version = docsVersion();
const cli = join(repo, 'packages', 'cli', 'dist', 'cli.js');
const skills = join(repo, 'packages', 'sdk', 'skills');
const pyright = join(site, 'node_modules', '.bin', 'pyright');
/** The folders a Python pack's indexer discovers by default: other files are app code. */
const PACK_PYTHON = /^(?:tools|agents|flows|guardrails)\//;

/**
 * The folders of generated reference pages (git-ignored) that a run over
 * every page needs: the CLI's and the Python SDK's, which
 * `generate-reference.mjs` writes, and the TypeScript SDK's, which the
 * site's build writes (starlight-typedoc). `docs:build` writes all three.
 */
const GENERATED = ['reference/cli', 'reference/python', 'reference/typescript'];
const PAGE = /\.mdx?$/;

const LANGUAGES = {
  ts: {
    template: 'sample',
    file: /^\/\/\s*(\S+\.(?:ts|tsx|mts))\s*$/,
    id: /\bid:\s*'([a-z0-9-]+)\.[^']+'/,
  },
  python: { template: 'python', file: /^#\s*(\S+\.py)\s*$/, id: /\bid="([a-z0-9-]+)\.[^"]+"/ },
  // A Java file: an app's (compiled against the Java SDK) or a pack's (over a `java` pack).
  java: {
    template: 'java',
    file: /^\/\/\s*(src\/(?:main|test)\/java\/\S+\.java)\s*$/,
    id: /\bdefine\("([a-z0-9-]+)\.[^"]+"\)/,
  },
  // A Scala file, over a `scala` pack: `Tool[I, O]("acme.x")`, `Agent("acme.x")`, …
  scala: {
    template: 'scala',
    file: /^\/\/\s*(src\/(?:main|test)\/scala\/\S+\.scala)\s*$/,
    id: /\b(?:Tool|Guardrail|Agent|Flow)(?:\[[^\]]*\])?(?:\.json)?\("([a-z0-9-]+)\.[^"]+"\)/,
  },
};
const FENCE_LANGUAGE = {
  ts: 'ts',
  typescript: 'ts',
  tsx: 'ts',
  python: 'python',
  py: 'python',
  java: 'java',
  scala: 'scala',
};
const javaSdk = join(repo, 'sdks', 'java');

/** Every page under `dir`, hand-written or generated. */
export function pages(dir = docs) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pages(path);
    return PAGE.test(entry.name) ? [path] : [];
  });
}

/** The generated folders (`GENERATED`) missing under `dir`: none once the reference is generated. */
export function missingGenerated(dir = docs) {
  return GENERATED.filter((folder) => !existsSync(join(dir, folder)));
}

/** The markdown files of every skill whose samples are checked: its `SKILL.md` and those beside it. */
function skillFiles() {
  const sources = JSON.parse(readFileSync(join(site, 'skills-sources.json'), 'utf8'));
  for (const [name, skill] of Object.entries(sources.skills)) {
    if (!existsSync(join(skills, name, 'SKILL.md'))) {
      throw new Error(`skills-sources.json: no skill ${name} in packages/sdk/skills/`);
    }
    for (const page of skill.pages) {
      if (!['.md', '.mdx'].some((extension) => existsSync(join(docs, `${page}${extension}`)))) {
        throw new Error(`skills-sources.json: ${name} lists ${page}, which isn't a page`);
      }
    }
  }
  return Object.entries(sources.skills)
    .filter(([, skill]) => skill.samples === 'checked')
    .flatMap(([name]) =>
      readdirSync(join(skills, name), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => join(skills, name, entry.name))
        .sort(),
    );
}

/**
 * Fenced blocks, `{ language, meta, line, lines, stub }`, including ones
 * indented in MDX. `meta`: the fence's text after the language; `line`: the
 * fence's line in the page (from 1). `stub`: the block is in a
 * `check-samples` comment (the reader's app code).
 */
export function blocks(markdown) {
  const found = [];
  let open;
  let stubs = false;
  let number = 0;
  for (const line of markdown.split('\n')) {
    number += 1;
    if (open === undefined) {
      if (/^\s*(?:<!--|\{\/\*)\s*check-samples\b/.test(line)) stubs = true;
      if (stubs && /(?:-->|\*\/\})\s*$/.test(line)) stubs = false;
      const start = line.match(/^(\s*)(`{3,}|~{3,})\s*([\w-]*)(.*)$/);
      if (start) {
        open = {
          indent: start[1].length,
          fence: start[2],
          language: start[3],
          meta: start[4].trim(),
          line: number,
          lines: [],
          stub: stubs,
        };
      }
    } else if (line.trim() === open.fence && line.indexOf(open.fence) === open.indent) {
      found.push(open);
      open = undefined;
    } else {
      open.lines.push(line.slice(Math.min(open.indent, line.length - line.trimStart().length)));
    }
  }
  return found;
}

/** Whether a block's first line names a whole file in its language. */
function named(block) {
  const language = FENCE_LANGUAGE[block.language];
  return language !== undefined && LANGUAGES[language].file.test(block.lines[0] ?? '');
}

/**
 * What a block is when it isn't offered for copying (`excerpts.mjs`):
 * `'excerpt'`, `'signature'`, or undefined.
 */
function notOffered(block) {
  return uncopied({
    language: block.language,
    meta: block.meta,
    code: block.lines.join('\n'),
    named: named(block),
  });
}

/**
 * A page's samples that are whole files, by language: `{ path, content }[]`.
 * `offeredOnly`: only the blocks offered for copying, without excerpts and
 * signatures (a page's: one that names a file is a problem of its own).
 */
export function fileSamples(markdown, { offeredOnly = false } = {}) {
  const byLanguage = { ts: [], python: [], java: [], scala: [] };
  for (const block of blocks(markdown)) {
    if (block.stub && ['json', 'jsonc'].includes(block.language)) {
      const config = block.lines[0]?.match(/^\/\/\s*(\S+\.json)\s*$/);
      if (config) {
        const content = `${block.lines.slice(1).join('\n')}\n`;
        byLanguage.ts.push({ path: config[1], content, stub: true });
      }
      continue;
    }
    const language = FENCE_LANGUAGE[block.language];
    if (language === undefined) continue;
    if (offeredOnly && !block.stub && notOffered(block)) continue;
    const name = block.lines[0]?.match(LANGUAGES[language].file);
    if (name) {
      const content = `${block.lines.join('\n')}\n`;
      byLanguage[language].push({ path: name[1], content, stub: block.stub });
    }
  }
  return byLanguage;
}

const SHELL = new Set(['sh', 'bash', 'shell', 'zsh']);
/** Not code: output, or a prompt to paste. Offered for copying, nothing to check. */
const TEXT = new Set(['', 'text', 'txt', 'plaintext']);
/** Parsed by a subprocess: python3's tomllib and XML parser, `node --check`. */
const PARSED = { toml: 'toml', xml: 'xml', js: 'js', javascript: 'js', mjs: 'js' };
/** How a whole file's first line names it, by language, for the problem's text. */
const FILE_EXAMPLE = {
  ts: '`// tools/lookup/index.ts`',
  python: '`# tools/lookup.py`',
  java: '`// src/main/java/com/acme/app/Name.java`',
  scala: '`// src/main/scala/acme/app/Name.scala`',
};

/**
 * What a page's rules say of one block: `{ problems, shell, parsed }`.
 * `problems`: messages; `shell`: it goes to `bash -n`; `parsed`: to the
 * TOML, XML or JavaScript parser.
 */
function blockRules(block, cli) {
  const code = block.lines.join('\n');
  const language = FENCE_LANGUAGE[block.language];
  const whole = named(block);
  const kind = notOffered(block);
  if (kind !== undefined) {
    return whole
      ? {
          problems: [
            `marked \`${kind}\` but names a file: a whole file is offered for copying and compiled, so drop \`${kind}\`, or drop the file name`,
          ],
        }
      : {};
  }
  if (language !== undefined) {
    return whole
      ? {}
      : {
          problems: [
            `a ${block.language} block that isn't a whole file: name the file on its first line (${FILE_EXAMPLE[language]}) and give it what it imports, so it's compiled, or mark it \`excerpt\``,
          ],
        };
  }
  if (SHELL.has(block.language)) {
    const problems = shellProblems(code, cli);
    return { problems, shell: problems.length === 0 };
  }
  if (block.language === 'json' || block.language === 'jsonc') {
    const problem = jsonProblem(code, block.language === 'jsonc');
    return { problems: problem === undefined ? [] : [problem] };
  }
  if (PARSED[block.language] !== undefined) return { parsed: true };
  if (TEXT.has(block.language)) return {};
  return {
    problems: [
      `a \`${block.language}\` block, which nothing checks, so it can't be offered for copying: mark it \`excerpt\``,
    ],
  };
}

/**
 * A page's rules for snippets run as pasted, without subprocesses:
 * `{ problems, shell, parsed }`. `problems`: `{ line, message }[]`;
 * `shell` and `parsed`: the blocks for `bash -n` and for the parsers, which
 * need a subprocess. `cli`: `{ commands, globals }`, `@kindgi/cli`'s
 * `describeCommands()` and `describeGlobalFlags()`.
 */
export function pageRules(markdown, cli) {
  const result = { problems: [], shell: [], parsed: [] };
  for (const block of blocks(markdown)) {
    if (block.stub) continue;
    const { problems = [], shell = false, parsed = false } = blockRules(block, cli);
    for (const message of problems) result.problems.push({ line: block.line, message });
    if (shell) result.shell.push(block);
    if (parsed) result.parsed.push(block);
  }
  const { adds, problems } = libraries(markdown);
  result.problems.push(...problems);
  const files = fileSamples(markdown, { offeredOnly: true });
  const shown = installed(markdown);
  for (const { language, libraries: names, line } of adds) {
    const { name, install } = INSTALL_HINT[language];
    if (!files[language].some((file) => !file.stub)) {
      result.problems.push({
        line,
        message: `adds ${name} libraries, but the page has no whole ${name} file to check with them`,
      });
    }
    const hidden = names.filter((spec) => !shown[language].has(libraryName(language, spec)));
    if (hidden.length > 0) {
      result.problems.push({
        line,
        message: `adds ${hidden.map((spec) => `\`${spec}\``).join(', ')} for the check, but no install command on the page shows the reader that step: show it (${install})`,
      });
    }
  }
  return result;
}

/** The command that adds a library in a `check-samples` comment, by the pack it adds to. */
const ADD = { uv: 'python', pnpm: 'ts' };
/**
 * A library as an install command names it, by language: for Python, a
 * name with extras and version specifiers (`fastapi`, `uvicorn[standard]`,
 * `'fastapi>=0.115'`); for TypeScript, an npm name, scoped or not, with a
 * version (`hono`, `@acme/client@^2`). No flags, URLs, paths or git specs.
 */
const LIBRARY = {
  python:
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[[A-Za-z0-9._,-]+\])?(?:(?:==|~=|!=|>=|<=|>|<)[A-Za-z0-9.*+!-]+(?:,(?:==|~=|!=|>=|<=|>|<)[A-Za-z0-9.*+!-]+)*)?$/,
  ts: /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[A-Za-z0-9.^~*+-]+)?$/,
};
/** What an install line in a `check-samples` comment can't have: the shell's operators, substitutions, escapes. */
const SHELL_SYNTAX = /[;&|()`$\\]/;
const INSTALL_HINT = {
  python: { name: 'Python', install: '`uv add …` or `pip install …`' },
  ts: { name: 'TypeScript', install: '`pnpm add …` or `npm install …`' },
};

/**
 * One line of a `check-samples` comment's shell block, as the libraries it
 * adds (`{ language, libraries }`), or undefined when it's anything but
 * `uv add <library> …` or `pnpm add <library> …`.
 */
function addLine(command) {
  const unquoted = command.replace(/'[^']*'|"[^"]*"/g, '');
  if (SHELL_SYNTAX.test(command) || /[<>'"]/.test(unquoted)) return undefined;
  const commands = shellCommands(command);
  if (commands.length !== 1) return undefined;
  const [tool, verb, ...names] = commands[0];
  const language = ADD[tool];
  if (language === undefined || verb !== 'add' || names.length === 0) return undefined;
  return names.every((name) => LIBRARY[language].test(name))
    ? { language, libraries: names }
    : undefined;
}

/**
 * The libraries a page's samples import that the reader adds to their app
 * (`from fastapi import FastAPI`): `{ adds, problems }`. The page's
 * `check-samples` comment has the reader's install step, in a shell block
 * of `uv add <library> …` (Python) or `pnpm add <library> …` (TypeScript)
 * lines, which the check runs in that page's own copy of the pack.
 * `adds`: `{ language, libraries, line }[]`; `problems`: `{ line, message }[]`,
 * for any other line in such a block, which is never run.
 */
export function libraries(markdown) {
  const result = { adds: [], problems: [] };
  for (const block of blocks(markdown)) {
    if (!block.stub || !SHELL.has(block.language)) continue;
    block.lines.forEach((text, index) => {
      const command = text.trim();
      if (command === '' || command.startsWith('#')) return;
      const line = block.line + 1 + index;
      const add = addLine(command);
      if (add !== undefined) {
        result.adds.push({ ...add, line });
        return;
      }
      result.problems.push({
        line,
        message:
          'a `check-samples` shell block only adds the libraries the samples import, a command a line: `uv add <library> …` (Python) or `pnpm add <library> …` (TypeScript), with no flags, URLs, paths or shell syntax',
      });
    });
  }
  return result;
}

/** The words an install command installs, and the language it installs them for. */
function installCommand(words) {
  const [first, second, third, fourth] = words;
  if (first === 'uv' && second === 'add') return { language: 'python', words: words.slice(2) };
  if (first === 'uv' && second === 'pip' && third === 'install') {
    return { language: 'python', words: words.slice(3) };
  }
  if (/^pip3?$/.test(first) && second === 'install') {
    return { language: 'python', words: words.slice(2) };
  }
  if (/^python3?$/.test(first) && second === '-m' && third === 'pip' && fourth === 'install') {
    return { language: 'python', words: words.slice(4) };
  }
  if (['pnpm', 'yarn'].includes(first) && second === 'add') {
    return { language: 'ts', words: words.slice(2) };
  }
  if (first === 'npm' && ['install', 'i'].includes(second)) {
    return { language: 'ts', words: words.slice(2) };
  }
  return undefined;
}

/** A library's name without its extras or version (Python's in PEP 503's normal form). */
function libraryName(language, spec) {
  if (language === 'python') {
    return spec
      .split(/[[=<>!~,\s]/)[0]
      .replace(/[-_.]+/g, '-')
      .toLowerCase();
  }
  const version = spec.indexOf('@', 1);
  return (version === -1 ? spec : spec.slice(0, version)).toLowerCase();
}

/**
 * The libraries the install commands the reader sees on a page add, by
 * language (`uv add`, `uv pip install`, `pip install` and
 * `python -m pip install` for Python; `pnpm add`, `yarn add`, `npm install`
 * for TypeScript), by name.
 */
function installed(markdown) {
  const found = { python: new Set(), ts: new Set() };
  const commands = blocks(markdown)
    .filter((block) => !block.stub && SHELL.has(block.language))
    .flatMap((block) => shellCommands(block.lines.join('\n')));
  for (const install of commands.map(installCommand)) {
    if (install === undefined) continue;
    for (const word of install.words.filter((word) => !word.startsWith('-'))) {
      found[install.language].add(libraryName(install.language, word));
    }
  }
  return found;
}

/** `<run-id>`, `<your pack's digest>`: a placeholder the reader fills in. */
const PLACEHOLDER = /<[A-Za-z][\w'’.:/@-]*(?: [\w'’.:/@-]+)*>/g;
/** What a placeholder becomes before a shell block is parsed. */
const FILLED = '__placeholder__';
/** What a `$(…)` becomes in the word it's in. */
const SUBSTITUTED = '__subst__';

/** A shell block's text with its placeholders filled in, as `bash -n` reads it. */
export function fillPlaceholders(code) {
  return code.replace(PLACEHOLDER, FILLED);
}

/**
 * A shell block's problems: a transcript, or a `kindgi` command the CLI
 * doesn't have (a command, a subcommand, a flag, a flag's missing value).
 */
export function shellProblems(code, cli) {
  if (code.split('\n').some((line) => /^\s*\$ /.test(line))) {
    return [
      'a transcript: a `$ ` prompt fails when pasted. Put the commands in a shell block without prompts and the output in a text block, or mark it `excerpt`',
    ];
  }
  const problems = [];
  for (const words of shellCommands(code)) {
    const args = kindgiArgs(words);
    const problem = args === undefined ? undefined : cliProblem(args, cli);
    if (problem !== undefined) problems.push(problem);
  }
  return problems;
}

/** The index of the quote closing the one at `at`. */
function endOfQuote(text, at) {
  const quote = text[at];
  for (let i = at + 1; i < text.length; i++) {
    if (quote === '"' && text[i] === '\\') i += 1;
    else if (text[i] === quote) return i;
  }
  return text.length;
}

/** The index of the `)` closing the `(` at `open`, skipping quoted text. */
function closing(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      i = endOfQuote(text, i);
    } else if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** What the lexer does at each of the shell's special characters. */
const SHELL_ACTIONS = {
  '\\': 'escaped',
  "'": 'quoted',
  '"': 'quoted',
  '\n': 'newline',
  ' ': 'endWord',
  '\t': 'endWord',
  ';': 'endCommand',
  '|': 'endCommand',
  '&': 'endCommand',
  '(': 'endCommand',
  ')': 'endCommand',
  '>': 'redirection',
  '<': 'redirection',
};

/**
 * A small shell lexer, enough to find commands and their words: quotes
 * removed, comments, redirections and here-documents left out, and a
 * `$(…)`'s commands listed on their own. `bash -n` checks the syntax.
 */
class ShellWords {
  constructor(text) {
    this.text = text;
    this.i = 0;
    this.commands = [];
    this.words = [];
    this.word = '';
    this.started = false;
    this.dropNext = false;
    this.heredoc = undefined;
  }

  run() {
    for (; this.i < this.text.length; this.i += 1) this.step(this.text[this.i]);
    this.endCommand();
    return this.commands;
  }

  step(c) {
    const next = this.next();
    if (c === '$' && next === '(') this.substitution();
    else if (c === '<' && next === '<') this.hereDocument();
    else if (c === '#' && !this.started) this.comment();
    else if (SHELL_ACTIONS[c] !== undefined) this[SHELL_ACTIONS[c]](c);
    else this.add(c);
  }

  next() {
    return this.text[this.i + 1];
  }

  add(text) {
    this.word += text;
    this.started = true;
  }

  escaped() {
    this.i += 1;
    this.add(this.text[this.i] ?? '');
  }

  quoted(quote) {
    this.started = true;
    for (this.i += 1; this.i < this.text.length && this.text[this.i] !== quote; this.i += 1) {
      const c = this.text[this.i];
      if (quote === '"' && c === '\\') this.escaped();
      else if (quote === '"' && c === '$' && this.next() === '(') this.substitution();
      else this.add(c);
    }
  }

  substitution() {
    const end = closing(this.text, this.i + 1);
    this.commands.push(...new ShellWords(this.text.slice(this.i + 2, end)).run());
    this.add(SUBSTITUTED);
    this.i = end;
  }

  comment() {
    const end = this.text.indexOf('\n', this.i);
    this.i = (end === -1 ? this.text.length : end) - 1;
  }

  newline() {
    this.endCommand();
    if (this.heredoc === undefined) return;
    // The here-document's body runs to the line that is its word.
    const lines = this.text.slice(this.i + 1).split('\n');
    const last = lines.findIndex((line) => line.trim() === this.heredoc);
    const body = last === -1 ? lines : lines.slice(0, last + 1);
    this.i += body.reduce((sum, line) => sum + line.length + 1, 0);
    this.heredoc = undefined;
  }

  hereDocument() {
    const marker = this.text.slice(this.i).match(/^<<-?\s*['"]?([\w-]+)['"]?/);
    this.endWord();
    if (marker === null) {
      this.i += 1;
      return;
    }
    this.heredoc = marker[1];
    this.i += marker[0].length - 1;
  }

  // A redirection: its file descriptor, the operator and its target aren't arguments.
  redirection() {
    if (this.started && /^\d+$/.test(this.word)) {
      this.word = '';
      this.started = false;
    }
    this.endWord();
    while (/[>&<|]/.test(this.next() ?? '')) this.i += 1;
    this.dropNext = true;
  }

  endWord() {
    if (this.started && !this.dropNext) this.words.push(this.word);
    if (this.started) this.dropNext = false;
    this.word = '';
    this.started = false;
  }

  endCommand() {
    this.endWord();
    if (this.words.length > 0) this.commands.push(this.words);
    this.words = [];
  }
}

/**
 * The simple commands in a shell block, each as its words, placeholders
 * filled and continuation lines joined: enough to find `kindgi` commands
 * and their arguments.
 */
export function shellCommands(code) {
  return new ShellWords(fillPlaceholders(code).replace(/\\\r?\n/g, ' ')).run();
}

/** `npx` flags that take a value as the next word. */
const NPX_VALUE = new Set(['-p', '--package', '-c', '--call']);
/** `uv run`'s and `uvx`'s flags that take a value as the next word. */
const UV_VALUE = new Set([
  '--from',
  '--with',
  '--with-requirements',
  '--python',
  '-p',
  '--project',
  '--directory',
  '--env-file',
  '--package',
  '--group',
  '--extra',
]);

/** The index of the first word after `from` that isn't a launcher's flag. */
function afterFlags(words, from, takesValue) {
  let i = from;
  while (i < words.length && words[i].startsWith('-') && words[i] !== '--') {
    i += takesValue.has(words[i]) ? 2 : 1;
  }
  return words[i] === '--' ? i + 1 : i;
}

/** The words after the program at `i`, when it's one of `programs`. */
function after(words, i, programs) {
  return programs.some((program) => program.test(words[i] ?? '')) ? words.slice(i + 1) : undefined;
}

const KINDGI = /^kindgi$/;
const PACKAGE = /^(?:kindgi|@kindgi\/cli(?:@\S+)?)$/;
const PYPI = /^kindgi(?:-cli)?$/;

/** The arguments a launcher passes the CLI, or undefined when it doesn't run it. */
function launched(w) {
  if (w[0] === 'kindgi' || w[0] === './kindgiw') return w.slice(1);
  if (w[0] === 'npx') return after(w, afterFlags(w, 1, NPX_VALUE), [PACKAGE]);
  if (w[0] === 'pnpm' && w[1] === 'dlx') return after(w, afterFlags(w, 2, NPX_VALUE), [PACKAGE]);
  if (w[0] === 'pnpm' || w[0] === 'yarn') return after(w, w[1] === 'exec' ? 2 : 1, [KINDGI]);
  if (w[0] === 'uv' && w[1] === 'run') return after(w, afterFlags(w, 2, UV_VALUE), [KINDGI]);
  if (w[0] === 'uvx') return after(w, afterFlags(w, 1, UV_VALUE), [PYPI]);
  return undefined;
}

/**
 * A command's arguments to the Kindgi CLI, or undefined when the command
 * isn't the CLI: `kindgi …`, `./kindgiw …` (a Java or Scala project's
 * wrapper, which passes its arguments on), `npx [flags] [--]
 * @kindgi/cli[@v] …` (or `kindgi`), `pnpm [exec|dlx] kindgi …`, `uv run
 * [flags] kindgi …`, `uvx [flags] kindgi …`, after any `NAME=value` words.
 */
export function kindgiArgs(words) {
  let start = 0;
  while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start])) start += 1;
  return launched(words.slice(start));
}

/** A word the reader fills in, or the shell does: not a command name to check. */
function filledIn(word) {
  return word.includes(FILLED) || word.includes(SUBSTITUTED) || word.startsWith('$');
}

/**
 * The command the arguments name: `{ path, command, rest }`, `command`
 * undefined at the root, or `{ problem }` for a command the CLI doesn't have.
 */
function commandPath(args, cli) {
  let commands = cli.commands;
  let command;
  const path = [];
  let i = 0;
  while (i < args.length && !args[i].startsWith('-') && !filledIn(args[i])) {
    const next = commands.find((candidate) => candidate.name === args[i]);
    if (next === undefined) {
      return { problem: `\`${['kindgi', ...path].join(' ')}\` has no command \`${args[i]}\`` };
    }
    path.push(args[i]);
    command = next;
    i += 1;
    if (next.subcommands.length === 0) break;
    commands = next.subcommands;
  }
  return { path, command, rest: args.slice(i) };
}

/** `parseArgs`'s options for these flags. */
function parseOptions(flags) {
  return Object.fromEntries(
    flags.map((flag) => [
      flag.name,
      {
        type: flag.type,
        ...(flag.short !== undefined && { short: flag.short }),
        ...(flag.multiple !== undefined && { multiple: flag.multiple }),
      },
    ]),
  );
}

/**
 * Whether the CLI takes these arguments: each word of the command's path is
 * a command it has, and the flags are the command's own or global ones,
 * parsed as the CLI parses them (`parseArgs`, strict). The message, or
 * undefined when it does.
 */
export function cliProblem(args, cli) {
  const found = commandPath(args, cli);
  if (found.problem !== undefined) return found.problem;
  const { path, command, rest } = found;
  const leaf = command?.subcommands.length === 0 ? command : undefined;
  const flags = [...cli.globals, ...(leaf?.flags ?? [])];
  // A string flag with no value after it: the CLI's optional-value flags take
  // that, and the reference doesn't say which flags those are.
  const strings = new Set(
    flags
      .filter((flag) => flag.type === 'string')
      .flatMap((flag) => [`--${flag.name}`, ...(flag.short ? [`-${flag.short}`] : [])]),
  );
  const words = rest.map((word, j) => {
    const next = rest[j + 1];
    return strings.has(word) && (next === undefined || next.startsWith('-')) ? `${word}=` : word;
  });
  try {
    parseArgs({ args: words, options: parseOptions(flags), strict: true, allowPositionals: true });
    return undefined;
  } catch (error) {
    return `\`${['kindgi', ...path].join(' ')}\`: ${String(error.message).split(/\.\s/)[0]}`;
  }
}

/** Comments and trailing commas out of JSONC, strings kept. */
function stripJsonc(code) {
  return code
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match) =>
      match.startsWith('"') ? match : '',
    )
    .replace(/,(\s*[}\]])/g, '$1');
}

function parses(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Why a JSON (or, with `comments`, JSONC) block doesn't parse, or undefined.
 * JSON Lines (a log, a stream's events: one document per line) parse line by line.
 */
export function jsonProblem(code, comments) {
  const text = comments ? stripJsonc(code) : code;
  try {
    JSON.parse(text);
    return undefined;
  } catch (error) {
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    if (lines.length > 1 && lines.every(parses)) return undefined;
    if (/^\s*"[^"]*"\s*:/.test(text)) {
      return 'part of a JSON document (it starts with a member, not `{`): mark it `excerpt`, or show the whole document';
    }
    const hint = !comments && /\/\/|\/\*/.test(text) ? ' (a block with comments is `jsonc`)' : '';
    // On one line: the parser's message can quote the block, line breaks included.
    return `doesn't parse as JSON: ${error.message.replace(/\s+/g, ' ')}${hint}`;
  }
}

/** `bash -n` on each shell block, placeholders filled: `{ block, message }[]`. */
function bashProblems(shellBlocks) {
  const found = [];
  for (const block of shellBlocks) {
    const result = spawnSync('bash', ['-n'], {
      input: fillPlaceholders(block.lines.join('\n')),
      encoding: 'utf8',
    });
    if (result.error) throw new Error(`Shell blocks need bash: ${result.error.message}`);
    if (result.status !== 0) {
      const first = result.stderr
        .trim()
        .split('\n')[0]
        .replace(/^bash: /, '');
      found.push({ block, message: `\`bash -n\` refuses it: ${first}` });
    }
  }
  return found;
}

/** The TOML and XML blocks, parsed by python3: `{ block, message }[]`. */
function pythonParsed(blocksToParse) {
  if (blocksToParse.length === 0) return [];
  const script = [
    'import json, sys, tomllib, xml.etree.ElementTree as ET',
    'out = {}',
    'for i, item in enumerate(json.load(sys.stdin)):',
    '    try:',
    "        if item['kind'] == 'toml': tomllib.loads(item['code'])",
    "        elif item['code'].lstrip().startswith('<?xml'): ET.fromstring(item['code'])",
    "        else: ET.fromstring('<root>' + item['code'] + '</root>')",
    '    except Exception as error:',
    '        out[str(i)] = str(error)',
    'print(json.dumps(out))',
  ].join('\n');
  const input = JSON.stringify(
    blocksToParse.map((block) => ({ kind: PARSED[block.language], code: block.lines.join('\n') })),
  );
  const result = spawnSync('python3', ['-c', script], { input, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `TOML and XML blocks need python3 3.11 or later: ${result.error?.message ?? result.stderr}`,
    );
  }
  return Object.entries(JSON.parse(result.stdout)).map(([i, message]) => {
    const block = blocksToParse[Number(i)];
    const kind = PARSED[block.language].toUpperCase();
    return { block, message: `doesn't parse as ${kind}: ${message}` };
  });
}

/** The TOML, XML and JavaScript blocks parsed: `{ block, message }[]`. */
function parsedProblems(parsedBlocks, dir) {
  const found = pythonParsed(parsedBlocks.filter((block) => PARSED[block.language] !== 'js'));
  parsedBlocks
    .filter((block) => PARSED[block.language] === 'js')
    .forEach((block, i) => {
      const file = join(dir, `block-${i}.mjs`);
      writeFileSync(file, `${block.lines.join('\n')}\n`);
      const result = run(process.execPath, ['--check', file], dir);
      if (!result.ok) {
        const reason =
          result.output.split('\n').find((line) => /Error/.test(line)) ?? result.output;
        found.push({ block, message: `\`node --check\` refuses it: ${reason.trim()}` });
      }
    });
  return found;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    stdout: result.stdout ?? '',
  };
}

/** The check's scratch directory, made when it starts and removed when it ends. */
let work;
const scaffolds = new Map();

/** A pristine pack for this template and id, scaffolded once and copied. */
function freshPack(template, packId) {
  const key = `${template}:${packId}`;
  if (!scaffolds.has(key)) {
    const dir = join(work, 'scaffold', key.replace(':', '-'));
    mkdirSync(dirname(dir), { recursive: true });
    const init = run(
      'node',
      [cli, 'init', packId, `--template=${template}`, `--path=${dir}`],
      work,
    );
    if (!init.ok)
      throw new Error(`kindgi init ${packId} --template=${template} failed:\n${init.output}`);
    // A Java pack compiles against the SDK this checkout built (`java()`): nothing to install.
    const prepare =
      template === 'python'
        ? run('uv', ['sync', '--quiet'], dir)
        : template === 'java' || template === 'scala'
          ? { ok: true, output: '' }
          : run('pnpm', ['install', '--prefer-offline', '--silent'], dir);
    if (!prepare.ok) throw new Error(`preparing the ${template} pack failed:\n${prepare.output}`);
    scaffolds.set(key, dir);
  }
  const copy = mkdtempSync(join(work, 'page-'));
  cpSync(scaffolds.get(key), copy, { recursive: true, verbatimSymlinks: true });
  return copy;
}

/**
 * The JDK's javac (JAVA_HOME's, else PATH's) and the classpath of the Java SDK
 * this checkout built: found once; a missing one fails the check, saying what to do.
 */
let javaToolchain;
function java() {
  if (javaToolchain) return javaToolchain;
  const javac = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'javac') : 'javac';
  const version = run(javac, ['-version'], repo);
  const major = Number(version.output.match(/javac (\d+)/)?.[1] ?? 0);
  if (!version.ok || major < 17) {
    const found = version.ok ? version.output.trim() : 'no javac';
    throw new Error(
      `Java samples need a JDK 17 or later (found: ${found}). Install one (Temurin 17, say) and set JAVA_HOME or put javac on PATH.`,
    );
  }
  const target = (module) => join(javaSdk, module, 'target');
  const client = existsSync(target('kindgi-client'))
    ? readdirSync(target('kindgi-client')).find((f) =>
        /^kindgi-client-[^/]+(?<!-sources|-javadoc)\.jar$/.test(f),
      )
    : undefined;
  const classpathFile = join(target('kindgi-client'), 'samples-classpath.txt');
  const packClasspathFile = join(target('kindgi-pack'), 'classpath.txt');
  if (client === undefined || !existsSync(classpathFile) || !existsSync(packClasspathFile)) {
    throw new Error(
      'Java samples compile against the Java SDK this checkout builds, and it is not built: run `cd sdks/java && ./mvnw package -DskipTests` first.',
    );
  }
  const classpath = [
    join(target('kindgi-client'), client),
    ...readFileSync(classpathFile, 'utf8').trim().split(delimiter),
    join(target('kindgi-pack'), 'classes'),
    ...readFileSync(packClasspathFile, 'utf8').trim().split(delimiter),
  ];
  javaToolchain = { javac, classpath: classpath.join(delimiter) };
  return javaToolchain;
}

/** Every `.java` file under `dir`, relative to it. */
function javaSources(dir, rel = '') {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) return javaSources(dir, child);
    return entry.name.endsWith('.java') ? [child] : [];
  });
}

function checkJava(files) {
  // A pack's samples go over a fresh `java` pack and are indexed; an app's
  // compile alone. A test (src/test/java) is a pack's: the pack's own tests run.
  const tests = files.some(testFile);
  const pack = tests || files.some(packFile);
  const packId = files.map((file) => file.content.match(LANGUAGES.java.id)?.[1]).find(Boolean);
  const dir = pack ? freshPack('java', packId ?? 'my-pack') : mkdtempSync(join(work, 'java-'));
  for (const file of files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  const { javac, classpath } = java();
  const sources = pack ? javaSources(dir, 'src/main/java') : files.map((f) => f.path);
  const classes = join(dir, 'target', 'classes');
  const compiled = run(
    javac,
    ['--release', '17', '-Xlint:none', '-d', classes, '-cp', classpath, ...sources],
    dir,
  );
  if (!compiled.ok || !pack) return compiled.ok ? undefined : compiled.output;
  const indexed = indexJvmPack(dir, [classes, classpath].join(delimiter));
  if (indexed !== undefined || !tests) return indexed;
  // The pack's Maven build compiles and runs its tests (JUnit, from its pom).
  const tested = run('sh', [join(dir, 'mvnw'), '-B', '-q', '-ntp', 'test'], dir);
  return tested.ok ? undefined : tested.output;
}

/** A JVM pack indexed with kindgi-pack's indexer: its problems, or undefined when it has none. */
function indexJvmPack(dir, classpath) {
  const javaBin = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java') : 'java';
  const index = run(
    javaBin,
    [
      '-cp',
      classpath,
      'com.kindgi.pack.Main',
      'index',
      '--pack-dir',
      dir,
      '--output',
      join(dir, 'target', 'index.json'),
      '--json',
    ],
    dir,
  );
  // The indexer's outcome is its stdout's JSON line; stderr may carry the JVM's own lines.
  const outcome = (() => {
    try {
      const line = index.stdout
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .at(-1);
      return line === undefined ? undefined : JSON.parse(line);
    } catch {
      return undefined;
    }
  })();
  if (outcome?.kind !== 'ok') return index.output;
  const errors = outcome.value.fileErrors ?? [];
  return errors.length > 0
    ? errors.map((error) => `${error.filePath}: ${error.code}: ${error.message}`).join('\n')
    : undefined;
}

/** The JVM SDK's version: kindgi-pack, kindgi-pack-scala and kindgi-client carry the SDK's. */
function jvmVersion() {
  return JSON.parse(readFileSync(join(repo, 'packages', 'sdk', 'package.json'), 'utf8')).version;
}

/**
 * sbt, and the Scala layer this checkout builds where a fresh `scala` pack
 * resolves it (kindgi-pack in the local Maven repository, kindgi-pack-scala
 * in the local Ivy one), and with `client`, kindgi-client in the local Maven
 * repository too: found once; a missing one fails the check, saying what to do.
 */
let scalaReady = false;
let scalaClientReady = false;
function scala({ client }) {
  const home = process.env.HOME ?? '';
  const sdk = jvmVersion();
  if (!scalaReady) {
    const sbt = run('sbt', ['--script-version'], repo);
    if (!sbt.ok) {
      throw new Error('Scala samples need sbt on PATH (https://www.scala-sbt.org/download).');
    }
    const pack = join(home, '.m2', 'repository', 'com', 'kindgi', 'kindgi-pack', sdk);
    const layer = join(home, '.ivy2', 'local', 'com.kindgi', 'kindgi-pack-scala_3', sdk);
    if (!existsSync(pack) || !existsSync(layer)) {
      throw new Error(
        `Scala samples compile against the Scala layer this checkout builds (${sdk}), and it isn't published locally: run \`cd sdks/java && ./mvnw -pl kindgi-pack -am install -DskipTests\` and \`cd sdks/scala && sbt publishLocal\` first.`,
      );
    }
    scalaReady = true;
  }
  if (client && !scalaClientReady) {
    if (!existsSync(join(home, '.m2', 'repository', 'com', 'kindgi', 'kindgi-client', sdk))) {
      throw new Error(
        `Scala samples that call the Java client compile against the kindgi-client this checkout builds (${sdk}), and it isn't installed locally: run \`cd sdks/java && ./mvnw install -DskipTests\` first.`,
      );
    }
    scalaClientReady = true;
  }
}

/** Whether a JVM file is a pack's (it uses `com.kindgi.pack`), not app code calling the client. */
function packFile(file) {
  return /\bimport com\.kindgi\.pack\b/.test(file.content);
}

/** Whether a JVM file is a test (src/test/…), which runs in a pack's own build. */
function testFile(file) {
  return file.path.startsWith('src/test/');
}

function checkScala(files) {
  // App code calling the Java client goes over the same fresh pack, with
  // kindgi-client added to its build; only a pack's own files are indexed.
  const tests = files.some(testFile);
  const client = files.some((file) => !file.stub && !testFile(file) && !packFile(file));
  const pack = files.some((file) => !testFile(file) && packFile(file));
  scala({ client });
  const packId = files.map((file) => file.content.match(LANGUAGES.scala.id)?.[1]).find(Boolean);
  const dir = freshPack('scala', packId ?? 'my-pack');
  for (const file of files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  if (client) {
    appendFileSync(
      join(dir, 'build.sbt'),
      `\nlibraryDependencies += "com.kindgi" % "kindgi-client" % "${jvmVersion()}"\n`,
    );
  }
  // A test (src/test/scala, munit from the pack's build) is compiled and run.
  const test = tests ? ['test'] : [];
  if (!pack) {
    const compiled = run('sbt', ['-batch', '-error', ...test, 'compile'], dir);
    return compiled.ok ? undefined : compiled.output;
  }
  // sbt compiles the pack and prints its runtime classpath as the last line of its stdout. Its
  // stderr can carry a line of its own after it (the JVM's "Picked up JAVA_TOOL_OPTIONS: …", a
  // launcher's warning), which isn't the classpath.
  const exported = run('sbt', ['-batch', '-error', ...test, 'export Runtime/fullClasspath'], dir);
  if (!exported.ok) return exported.output;
  const classpath = exported.stdout
    .trim()
    .split('\n')
    .filter((line) => line.includes('.jar'))
    .at(-1);
  if (classpath === undefined) return `sbt printed no classpath:\n${exported.output}`;
  return indexJvmPack(dir, classpath.trim());
}

/**
 * A page's TypeScript or Python files written over its own copy of a fresh
 * pack and checked; `added`: the libraries the page's `check-samples`
 * comment adds (`libraries`), installed in that copy first, the reader's
 * install step run as words (no shell).
 */
function check(language, files, packDir, added = []) {
  if (added.length > 0) {
    const add =
      language === 'ts'
        ? run('pnpm', ['add', '--prefer-offline', '--silent', ...added], packDir)
        : run('uv', ['add', '--quiet', ...added], packDir);
    if (!add.ok) return `adding ${added.join(' ')} to the pack failed:\n${add.output}`;
  }
  for (const file of files) {
    const target = join(packDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  if (language === 'ts') {
    const base = JSON.parse(readFileSync(join(packDir, 'tsconfig.json'), 'utf8'));
    const include = [...(base.include ?? []), ...files.map((file) => file.path)];
    writeFileSync(
      join(packDir, 'tsconfig.samples.json'),
      JSON.stringify({ extends: './tsconfig.json', include }),
    );
    const tsc = run(
      join(packDir, 'node_modules', '.bin', 'tsc'),
      ['--noEmit', '-p', 'tsconfig.samples.json'],
      packDir,
    );
    return tsc.ok ? undefined : tsc.output;
  }
  const index = run(
    'uv',
    ['run', '--quiet', 'python', '-m', 'kindgi.pack', 'index', '--pack-dir', '.'],
    packDir,
  );
  if (!index.ok) return index.output;
  const errors = JSON.parse(index.output.slice(index.output.indexOf('{'))).fileErrors ?? [];
  if (errors.length > 0) {
    return errors.map((error) => `${error.filePath}: ${error.code}: ${error.message}`).join('\n');
  }
  const app = files.map((file) => file.path).filter((path) => !PACK_PYTHON.test(path));
  if (app.length === 0) return undefined;
  const python = join(packDir, '.venv', 'bin', 'python');
  const checked = run(pyright, ['--pythonpath', python, ...app], packDir);
  return checked.ok ? undefined : checked.output;
}

/** The baseline file, next to this script. */
const BASELINE = 'check-samples-baseline.json';

/**
 * The baseline: problems allowed per page, by its slug (its path under the
 * docs, without the extension: generated pages aren't tracked files), when
 * there is one.
 */
function readBaseline() {
  const file = join(site, 'scripts', BASELINE);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

/**
 * The slugs of the pages git ignores (the generated reference), or
 * `undefined` outside a git checkout. A new page that isn't committed yet is
 * neither tracked nor ignored, so it isn't taken for a generated one.
 */
function ignoredPages() {
  const listed = run(
    'git',
    ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'],
    docs,
  );
  if (!listed.ok) return undefined;
  return new Set(
    listed.stdout
      .split('\0')
      .filter((path) => PAGE.test(path))
      .map((path) => path.replace(PAGE, '')),
  );
}

/**
 * The baseline lines for the failing pages git ignores: the generated
 * reference pages. A change to the code one documents (a new export, method
 * or command) adds blocks to a page its author never wrote; until the page's
 * generator marks them, these lines let them pass.
 */
export function generatedBaseline(failing, ignored) {
  return failing
    .filter(({ page }) => ignored.has(page))
    .map(({ page, lines }) => `  ${JSON.stringify(page)}: ${lines.length},`);
}

/** The CLI's commands and global flags, from the workspace's built `@kindgi/cli`. */
async function cliDescription() {
  const { describeCommands, describeGlobalFlags } = await import('@kindgi/cli');
  return { commands: describeCommands(), globals: describeGlobalFlags() };
}

/**
 * A page's rules, with the subprocess checks: `{ problems, copyable,
 * excerpts, signatures }`. `problems`: `<file>:<line>: <message>` lines, in
 * page order; the rest, counts of the page's code blocks.
 */
function checkPage(page, markdown, cli) {
  const rules = pageRules(markdown, cli);
  const located = ({ block, message }) => ({ line: block.line, message });
  const found = [
    ...rules.problems,
    ...bashProblems(rules.shell).map(located),
    ...parsedProblems(rules.parsed, work).map(located),
  ];
  const code = blocks(markdown).filter((block) => !block.stub && !TEXT.has(block.language));
  const kinds = code.map(notOffered);
  const excerpts = kinds.filter((kind) => kind === EXCERPT).length;
  const signatures = kinds.filter((kind) => kind === SIGNATURE).length;
  return {
    problems: found
      .sort((a, b) => a.line - b.line)
      .map(({ line, message }) => `${relative(repo, page)}:${line}: ${message}`),
    copyable: code.length - excerpts - signatures,
    excerpts,
    signatures,
  };
}

/** A page's or skill's whole files compiled: `{ checked, failures }`. */
function compileSamples(page, markdown, isPage) {
  let checked = 0;
  const failures = [];
  const { adds } = libraries(markdown);
  for (const [language, files] of Object.entries(fileSamples(markdown, { offeredOnly: isPage }))) {
    if (files.length === 0) continue;
    let error;
    if (language === 'java') {
      error = checkJava(files);
    } else if (language === 'scala') {
      error = checkScala(files);
    } else {
      const { template, id } = LANGUAGES[language];
      const packId = files.map((file) => file.content.match(id)?.[1]).find(Boolean) ?? 'my-pack';
      const added = adds.filter((add) => add.language === language).flatMap((add) => add.libraries);
      error = check(language, files, freshPack(template, packId), added);
    }
    const samples = files.filter((file) => !file.stub);
    checked += samples.length;
    const where = `${relative(repo, page)} (${language}: ${samples.map((file) => file.path).join(', ')})`;
    if (error) failures.push(`${where}\n${error.trim()}`);
  }
  return { checked, failures };
}

/**
 * The report, and whether it fails. A page's rule problems within its
 * count in the baseline (the pages' problems when these rules came in) are
 * reported but don't fail; the pages' owners fix them, and the baseline is emptied.
 */
function report({ ruleProblems, failures }, ignored) {
  const baseline = readBaseline();
  const failing = ruleProblems.filter(({ page, lines }) => lines.length > (baseline[page] ?? 0));
  const known = ruleProblems.filter((entry) => !failing.includes(entry));
  const count = (entries) => entries.reduce((sum, { lines }) => sum + lines.length, 0);
  const sections = [];
  if (failing.length > 0) {
    sections.push(
      `check-samples: ${count(failing)} code block(s) that can't be pasted as they are. Make each whole and checked, or mark it \`excerpt\` (a reference page's declaration: \`signature\`; site/scripts/excerpts.mjs):\n\n${failing.flatMap(({ lines }) => lines).join('\n')}`,
    );
    const generated = ignored ? generatedBaseline(failing, ignored) : [];
    if (generated.length > 0) {
      sections.push(
        `check-samples: ${generated.length} of these page(s) are generated (git-ignored; \`pnpm run docs:build\` writes them), so a change to the code they document can add blocks to them. Until their generator marks those blocks, set these counts in site/scripts/${BASELINE}:\n\n${generated.join('\n')}`,
      );
    }
  }
  if (known.length > 0) {
    sections.push(
      `check-samples: ${count(known)} known block(s) on ${known.length} page(s), within ${BASELINE}, to fix the same way:\n\n${known.flatMap(({ lines }) => lines).join('\n')}`,
    );
  }
  if (failures.length > 0) {
    sections.push(
      `check-samples: ${failures.length} page(s) with samples that don't check:\n\n${failures.join('\n\n')}`,
    );
  }
  if (sections.length > 0) console.error(sections.join('\n\n'));
  return failing.length > 0 || failures.length > 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const compile = !argv.includes('--no-compile');
  const selected = argv.filter((arg) => arg !== '--no-compile').map((page) => resolve(docs, page));
  const missing = missingGenerated();
  if (selected.length === 0 && missing.length > 0) {
    console.error(
      `check-samples: the generated reference pages aren't there (${missing.join(', ')} in site/src/content/docs): run \`pnpm run docs:build\` first, which generates them.`,
    );
    process.exit(1);
  }
  const onSite = new Set(pages());
  const cli = await cliDescription();
  const totals = {
    checked: 0,
    copyable: 0,
    excerpts: 0,
    signatures: 0,
    ruleProblems: [],
    failures: [],
  };
  work = mkdtempSync(join(tmpdir(), 'kindgi-samples-'));
  try {
    for (const page of selected.length > 0 ? selected : [...pages(), ...skillFiles()]) {
      const markdown = fillVersion(readFileSync(page, 'utf8'), version);
      const isPage = onSite.has(page);
      if (isPage) {
        const { problems, copyable, excerpts, signatures } = checkPage(page, markdown, cli);
        if (problems.length > 0) {
          totals.ruleProblems.push({
            page: relative(docs, page).replace(PAGE, ''),
            lines: problems,
          });
        }
        totals.copyable += copyable;
        totals.excerpts += excerpts;
        totals.signatures += signatures;
      }
      if (!compile) continue;
      const { checked, failures } = compileSamples(page, markdown, isPage);
      totals.checked += checked;
      totals.failures.push(...failures);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (report(totals, ignoredPages())) process.exit(1);
  const compiled = compile ? `${totals.checked} file samples check; ` : '';
  console.log(
    `check-samples: ${compiled}${totals.copyable} code blocks on the pages are offered for copying and checked; not offered: ${totals.excerpts} excerpt(s), ${totals.signatures} signature(s).`,
  );
}

// Run only as a script: the tests import the rules.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main();
}
