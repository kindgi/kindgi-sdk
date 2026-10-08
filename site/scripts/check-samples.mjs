#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * Checks the code samples on the hand-written pages, and in the skills
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
 * locally), and the pack is indexed the same way. A sample without a file
 * name is a fragment and isn't checked.
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
 * Needs the workspace built (`pnpm run build`), uv for Python samples, for
 * Java samples a JDK 17 or later and the Java SDK built
 * (`cd sdks/java && ./mvnw package -DskipTests`), and for Scala samples sbt,
 * with kindgi-pack installed and the Scala layer published locally
 * (`./mvnw -pl kindgi-pack -am install -DskipTests` in sdks/java,
 * `sbt publishLocal` in sdks/scala). A missing tool fails the check; it's
 * never skipped.
 *
 * Usage: node site/scripts/check-samples.mjs [<page or skill file> …]
 *   (a page path is relative to site/src/content/docs; default: every page and skill)
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** Hand-written pages: everything but the generated sections. */
const GENERATED = ['reference', 'contributing'];
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
    file: /^\/\/\s*(src\/main\/java\/\S+\.java)\s*$/,
    id: /\bdefine\("([a-z0-9-]+)\.[^"]+"\)/,
  },
  // A Scala file, over a `scala` pack: `Tool[I, O]("acme.x")`, `Agent("acme.x")`, …
  scala: {
    template: 'scala',
    file: /^\/\/\s*(src\/main\/scala\/\S+\.scala)\s*$/,
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

function pages(dir = docs) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return dir === docs && GENERATED.includes(entry.name) ? [] : pages(path);
    }
    return PAGE.test(entry.name) ? [path] : [];
  });
}

/** The `SKILL.md` of every skill whose samples are checked. */
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
    .map(([name]) => join(skills, name, 'SKILL.md'));
}

/**
 * Fenced blocks, `{ language, lines, stub }`, including ones indented in MDX.
 * `stub`: the block is in a `check-samples` comment (the reader's app code).
 */
function blocks(markdown) {
  const found = [];
  let open;
  let stubs = false;
  for (const line of markdown.split('\n')) {
    if (open === undefined) {
      if (/^\s*(?:<!--|\{\/\*)\s*check-samples\b/.test(line)) stubs = true;
      if (stubs && /(?:-->|\*\/\})\s*$/.test(line)) stubs = false;
      const start = line.match(/^(\s*)(`{3,}|~{3,})\s*([\w-]*)/);
      if (start) {
        open = {
          indent: start[1].length,
          fence: start[2],
          language: start[3],
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

/** A page's samples that are whole files, by language: `{ path, content }[]`. */
function fileSamples(markdown) {
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
    const name = block.lines[0]?.match(LANGUAGES[language].file);
    if (name) {
      const content = `${block.lines.join('\n')}\n`;
      byLanguage[language].push({ path: name[1], content, stub: block.stub });
    }
  }
  return byLanguage;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const work = mkdtempSync(join(tmpdir(), 'kindgi-samples-'));
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
  // A pack's samples go over a fresh `java` pack and are indexed; an app's compile alone.
  const pack = files.some((file) => /\bimport com\.kindgi\.pack\./.test(file.content));
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
  return indexJvmPack(dir, [classes, classpath].join(delimiter));
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
  const outcome = (() => {
    try {
      return JSON.parse(index.output.slice(index.output.indexOf('{')));
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

/**
 * sbt, and the Scala layer this checkout builds where a fresh `scala` pack
 * resolves it (kindgi-pack in the local Maven repository, kindgi-pack-scala
 * in the local Ivy one): found once; a missing one fails the check, saying what to do.
 */
let scalaReady = false;
function scala() {
  if (scalaReady) return;
  const sbt = run('sbt', ['--script-version'], repo);
  if (!sbt.ok) {
    throw new Error('Scala samples need sbt on PATH (https://www.scala-sbt.org/download).');
  }
  const version = JSON.parse(
    readFileSync(join(repo, 'packages', 'sdk', 'package.json'), 'utf8'),
  ).version;
  const home = process.env.HOME ?? '';
  const pack = join(home, '.m2', 'repository', 'com', 'kindgi', 'kindgi-pack', version);
  const layer = join(home, '.ivy2', 'local', 'com.kindgi', 'kindgi-pack-scala_3', version);
  if (!existsSync(pack) || !existsSync(layer)) {
    throw new Error(
      `Scala samples compile against the Scala layer this checkout builds (${version}), and it isn't published locally: run \`cd sdks/java && ./mvnw -pl kindgi-pack -am install -DskipTests\` and \`cd sdks/scala && sbt publishLocal\` first.`,
    );
  }
  scalaReady = true;
}

function checkScala(files) {
  scala();
  const packId = files.map((file) => file.content.match(LANGUAGES.scala.id)?.[1]).find(Boolean);
  const dir = freshPack('scala', packId ?? 'my-pack');
  for (const file of files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  // sbt compiles the pack and prints its runtime classpath as the last line.
  const exported = run('sbt', ['-batch', '-error', 'export Runtime/fullClasspath'], dir);
  if (!exported.ok) return exported.output;
  const classpath = exported.output.trim().split('\n').at(-1);
  return indexJvmPack(dir, classpath);
}

function check(language, files, packDir) {
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

const selected = process.argv.slice(2).map((page) => resolve(docs, page));
const failures = [];
let checked = 0;
try {
  for (const page of selected.length > 0 ? selected : [...pages(), ...skillFiles()]) {
    const markdown = fillVersion(readFileSync(page, 'utf8'), version);
    for (const [language, files] of Object.entries(fileSamples(markdown))) {
      if (files.length === 0) continue;
      let error;
      if (language === 'java') {
        error = checkJava(files);
      } else if (language === 'scala') {
        error = checkScala(files);
      } else {
        const { template, id } = LANGUAGES[language];
        const packId = files.map((file) => file.content.match(id)?.[1]).find(Boolean) ?? 'my-pack';
        error = check(language, files, freshPack(template, packId));
      }
      const samples = files.filter((file) => !file.stub);
      checked += samples.length;
      const where = `${relative(repo, page)} (${language}: ${samples.map((file) => file.path).join(', ')})`;
      if (error) failures.push(`${where}\n${error.trim()}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`check-samples: ${failures.length} page(s) with samples that don't check:\n`);
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log(`check-samples: ${checked} file samples check.`);
