#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * Runs the tutorials: every page whose code blocks carry a `tutorial=`
 * marker is executed step by step, in order, against this checkout's CLI
 * and SDKs and the runtime image that CLI pins, in a fresh directory.
 *
 * Markers (in the fence's meta, after the language; readers don't see them):
 *
 *   ```sh tutorial=run                     run it; a non-zero exit fails the page
 *   ```sh tutorial=background ready="…"    start it (`kindgi dev`), wait until its
 *                                          output contains the ready text
 *   ```text tutorial=expect                every line must appear in the previous
 *                                          step's output (`…` elides: each part of
 *                                          the line must appear, in order)
 *   ```ts tutorial=write                   write the file its first line names
 *                                          (`// tools/x/index.ts`, `# tools/x.py`)
 *
 * The steps share a shell state: the working directory and exported
 * variables carry from one step to the next. `npx @kindgi/cli…` runs this
 * checkout's CLI (so a page is tested before its release is published), and
 * so do the PyPI CLI's forms, `uvx --from kindgi-cli… kindgi …` and
 * `uv run kindgi …` (as `kindgi-cli` runs it: `KINDGI_CLI_INSTALL=pypi`), and
 * a background `kindgi dev` gets a free `--port`, so a run never takes a
 * port another runtime holds. Steps that need a real model or a cloud
 * account stay unmarked: they're release checks, run by hand.
 *
 * The run brings its own Postgres: a throwaway pgvector container on a free
 * loopback port, removed at the end (on a failure and on Ctrl+C too), and
 * each page gets a fresh database in it through `KINDGI_DATABASE_URL`. Every
 * `kindgi dev` on the machine shares one bundled database, and this
 * checkout's runtime, newer than a released CLI's, would migrate it under the
 * apps pinned to that release.
 *
 * Needs the workspace built (`pnpm run build`), Docker with the pinned
 * runtime image available, uv for Python pages, and for Java pages (those
 * that make a `--template=java` pack) a JDK 17 or later: the run installs
 * this checkout's kindgi-pack into the local Maven repository first, as a
 * reader does from the SDK repository. Scala pages (`--template=scala`) also
 * need sbt: the run publishes this checkout's kindgi-pack-scala into the
 * local Ivy repository too.
 *
 * Usage: node site/scripts/run-tutorials.mjs [<page under site/src/content/docs> …]
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(site, '..');
const docs = join(site, 'src', 'content', 'docs');
const cli = join(repo, 'packages', 'cli', 'dist', 'cli.js');
const READY_TIMEOUT_MS = 10 * 60_000;
/** The image `kindgi dev`'s bundled Postgres runs (`docker-compose.dev.yml`). */
const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';
const FILE = /^(?:\/\/|#)\s*(\S+\.\w+)\s*$/;

function pages(dir = docs) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return dir === docs && entry.name === 'reference' ? [] : pages(path);
    return /\.mdx?$/.test(entry.name) ? [path] : [];
  });
}

/** The page's marked blocks, in order: `{ kind, ready, lines }`. */
function steps(markdown) {
  const found = [];
  let open;
  for (const line of markdown.split('\n')) {
    if (open === undefined) {
      const start = line.match(/^(\s*)(`{3,}|~{3,})\s*([\w-]*)(.*)$/);
      if (start) open = { indent: start[1].length, fence: start[2], meta: start[4], lines: [] };
    } else if (line.trim() === open.fence && line.indexOf(open.fence) === open.indent) {
      const kind = open.meta.match(/\btutorial=(\w+)/)?.[1];
      if (kind)
        found.push({ kind, ready: open.meta.match(/\bready="([^"]+)"/)?.[1], lines: open.lines });
      open = undefined;
    } else {
      open.lines.push(line.slice(Math.min(open.indent, line.length - line.trimStart().length)));
    }
  }
  return found;
}

/** A `kindgi dev` command, however the CLI is invoked. */
const KINDGI_DEV = /(?:\bkindgiw?|@kindgi\/cli(?:@\S+)?)\s+dev\b/;

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * A PATH directory whose `npx` runs this checkout's CLI for `@kindgi/cli`,
 * and whose `uvx` and `uv` do for `kindgi-cli` (`uvx --from kindgi-cli…
 * kindgi`, `uv run kindgi`); anything else goes to the real command.
 */
function shimDir(work) {
  const dir = join(work, '.bin');
  mkdirSync(dir);
  const realNpx = execFileSync('bash', ['-lc', 'command -v npx'], { encoding: 'utf8' }).trim();
  const shim = [
    '#!/usr/bin/env bash',
    "# `npx [npx flags] @kindgi/cli[@version] <args>` runs this checkout's CLI with <args>.",
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    @kindgi/cli|@kindgi/cli@*)',
    '      args=()',
    '      seen=0',
    '      for each in "$@"; do',
    '        if [ "$seen" = 1 ]; then args+=("$each"); fi',
    '        case "$each" in @kindgi/cli|@kindgi/cli@*) seen=1 ;; esac',
    '      done',
    `      exec node ${JSON.stringify(cli)} "\${args[@]}"`,
    '      ;;',
    '  esac',
    'done',
    `exec ${JSON.stringify(realNpx)} "$@"`,
    '',
  ].join('\n');
  writeFileSync(join(dir, 'npx'), shim);
  chmodSync(join(dir, 'npx'), 0o755);
  // The PyPI CLI's forms, where uv is installed (Python pages need it).
  const which = (name) =>
    spawnSync('bash', ['-lc', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
  const pypiCli = `KINDGI_CLI_INSTALL=pypi exec node ${JSON.stringify(cli)}`;
  const realUvx = which('uvx');
  if (realUvx) {
    const uvx = [
      '#!/usr/bin/env bash',
      "# `uvx [uvx flags] --from kindgi-cli[<spec>] kindgi <args>` runs this checkout's CLI with <args>.",
      'from=0; pypi=0; seen=0; args=()',
      'for each in "$@"; do',
      '  if [ "$seen" = 1 ]; then args+=("$each"); continue; fi',
      '  if [ "$from" = 1 ]; then case "$each" in kindgi-cli*) pypi=1 ;; esac; from=0; continue; fi',
      '  case "$each" in',
      '    --from) from=1 ;;',
      '    --from=kindgi-cli*) pypi=1 ;;',
      '    kindgi) if [ "$pypi" = 1 ]; then seen=1; fi ;;',
      '  esac',
      'done',
      `if [ "$seen" = 1 ]; then ${pypiCli} "\${args[@]}"; fi`,
      `exec ${JSON.stringify(realUvx)} "$@"`,
      '',
    ].join('\n');
    writeFileSync(join(dir, 'uvx'), uvx);
    chmodSync(join(dir, 'uvx'), 0o755);
  }
  const realUv = which('uv');
  if (realUv) {
    const uv = [
      '#!/usr/bin/env bash',
      "# `uv run kindgi <args>` runs this checkout's CLI with <args>, as kindgi-cli would in the pack's environment.",
      `if [ "$1" = run ] && [ "$2" = kindgi ]; then shift 2; ${pypiCli} "$@"; fi`,
      `exec ${JSON.stringify(realUv)} "$@"`,
      '',
    ].join('\n');
    writeFileSync(join(dir, 'uv'), uv);
    chmodSync(join(dir, 'uv'), 0o755);
  }
  return dir;
}

/** Each part of an expected line (split on `…`) appears, in order, in one output line. */
function expectation(expected, output) {
  const outputLines = output.split('\n').map((line) => line.trim());
  const missing = [];
  for (const line of expected.map((text) => text.trim()).filter(Boolean)) {
    const parts = line
      .split('…')
      .map((part) => part.trim())
      .filter(Boolean);
    const found = outputLines.some((candidate) => {
      let from = 0;
      for (const part of parts) {
        const at = candidate.indexOf(part, from);
        if (at < 0) return false;
        from = at + part.length;
      }
      return true;
    });
    if (!found) missing.push(line);
  }
  return missing;
}

/** Whether any process of the group led by `pid` is still running. */
function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Send `name` to the group led by `pid`; false when the group is gone. */
function signal(pid, name) {
  try {
    process.kill(-pid, name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a background step: SIGINT to its whole process group (the CLI and
 * what it started, such as the pack service), then wait until every one of
 * them has exited, with SIGKILL after a minute.
 */
async function stop(child) {
  if (!signal(child.pid, 'SIGINT')) return;
  const deadline = Date.now() + 60_000;
  while (groupAlive(child.pid) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 250));
  }
  if (signal(child.pid, 'SIGKILL')) {
    while (groupAlive(child.pid)) await new Promise((done) => setTimeout(done, 100));
  }
}

/** Runtime containers `kindgi dev` started for a pack under `work` (only ours). */
function removeOurContainers(work) {
  const names = spawnSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter((name) => name.startsWith('kindgi-dev-runtime-'));
  for (const name of names) {
    const mounts = spawnSync(
      'docker',
      ['inspect', name, '--format', '{{range .Mounts}}{{.Source}} {{end}}'],
      { encoding: 'utf8' },
    ).stdout;
    if (mounts.includes(work)) spawnSync('docker', ['rm', '-f', name]);
  }
}

/** Start the run's own Postgres and wait until it takes connections. */
async function startPostgres() {
  const name = `kindgi-tutorials-postgres-${process.pid}-${randomBytes(3).toString('hex')}`;
  const password = randomBytes(16).toString('hex');
  const started = spawnSync(
    'docker',
    [
      'run',
      '--detach',
      '--name',
      name,
      '--env',
      'POSTGRES_USER=kindgi',
      // The value comes from this process's environment, never the command line.
      '--env',
      'POSTGRES_PASSWORD',
      '--publish',
      '127.0.0.1::5432',
      POSTGRES_IMAGE,
    ],
    { encoding: 'utf8', env: { ...process.env, POSTGRES_PASSWORD: password } },
  );
  if (started.status !== 0) throw new Error(`couldn't start Postgres:\n${started.stderr}`);
  const postgres = { name, password, port: undefined };
  const deadline = Date.now() + 2 * 60_000;
  // Over TCP: the image's first-start setup runs a server on the socket only.
  while (
    spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'kindgi']).status !==
    0
  ) {
    if (Date.now() > deadline) {
      removePostgres(postgres);
      throw new Error(`Postgres (${name}) didn't start in time`);
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  const published = spawnSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).stdout;
  postgres.port = published.match(/127\.0\.0\.1:(\d+)/)?.[1];
  if (postgres.port === undefined) {
    removePostgres(postgres);
    throw new Error(`Postgres (${name}) has no port on 127.0.0.1: ${published}`);
  }
  return postgres;
}

/** A fresh database for one page, as the URL `kindgi dev` takes. */
function createDatabase(postgres, database) {
  const created = spawnSync(
    'docker',
    ['exec', postgres.name, 'createdb', '-U', 'kindgi', database],
    {
      encoding: 'utf8',
    },
  );
  if (created.status !== 0)
    throw new Error(`couldn't create database ${database}:\n${created.stderr}`);
  return `postgres://kindgi:${postgres.password}@127.0.0.1:${postgres.port}/${database}`;
}

function removePostgres(postgres) {
  spawnSync('docker', ['rm', '--force', '--volumes', postgres.name]);
}

/** What's running now, so Ctrl+C can stop it: background steps and their pages' directories. */
const live = { children: new Set(), works: new Set() };

async function runPage(page, databaseUrl) {
  const work = mkdtempSync(join(tmpdir(), 'kindgi-tutorial-'));
  live.works.add(work);
  const env = {
    ...process.env,
    PATH: `${shimDir(work)}:${process.env.PATH}`,
    KINDGI_DATABASE_URL: databaseUrl,
  };
  const state = join(work, '.state');
  writeFileSync(join(work, '.env-state'), '');
  let cwd = work;
  let lastOutput = '';
  const background = [];
  const log = [];
  try {
    for (const [index, step] of steps(readFileSync(page, 'utf8')).entries()) {
      const where = `step ${index + 1} (${step.kind})`;
      const body = step.lines.join('\n');
      if (step.kind === 'write') {
        const target = step.lines[0]?.match(FILE)?.[1];
        if (!target) throw new Error(`${where}: the block's first line doesn't name a file`);
        mkdirSync(dirname(join(cwd, target)), { recursive: true });
        writeFileSync(join(cwd, target), `${body}\n`);
      } else if (step.kind === 'expect') {
        const missing = expectation(step.lines, lastOutput);
        if (missing.length > 0) {
          throw new Error(
            `${where}: not in the previous step's output:\n  ${missing.join('\n  ')}\n--- output ---\n${lastOutput}`,
          );
        }
      } else if (step.kind === 'run') {
        const script = [
          'set -euo pipefail',
          `cd ${JSON.stringify(cwd)}`,
          `set -a; source ${JSON.stringify(join(work, '.env-state'))}; set +a`,
          body,
          `pwd > ${JSON.stringify(state)}`,
          // Exported variables carry to the next step (not bash's own read-only ones).
          `export -p | grep -v -E '^declare -[a-zA-Z]*x[a-zA-Z]* (BASHOPTS|SHELLOPTS|SHLVL|PWD|OLDPWD|_)=' > ${JSON.stringify(join(work, '.env-state'))}`,
        ].join('\n');
        const result = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' });
        lastOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        log.push(`$ ${body}\n${lastOutput}`);
        if (result.status !== 0)
          throw new Error(`${where} exited ${result.status}:\n${body}\n${lastOutput}`);
        cwd = readFileSync(state, 'utf8').trim();
      } else if (step.kind === 'background') {
        if (!step.ready) throw new Error(`${where}: a background step needs ready="…"`);
        // Every form of `kindgi dev` (`kindgi dev`, `pnpm exec kindgi dev`,
        // `npx @kindgi/cli@0.1 dev`) gets its own free port, so two runs at
        // once never both reach for the default.
        const command = KINDGI_DEV.test(body) ? `${body} --port ${await freePort()}` : body;
        const child = spawn('bash', ['-c', `cd ${JSON.stringify(cwd)} && exec ${command}`], {
          env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        background.push(child);
        live.children.add(child);
        let output = '';
        await new Promise((ready, fail) => {
          const timer = setTimeout(
            () => fail(new Error(`${where}: not ready in time:\n${output}`)),
            READY_TIMEOUT_MS,
          );
          const onData = (chunk) => {
            output += chunk;
            if (output.includes(step.ready)) {
              clearTimeout(timer);
              ready();
            }
          };
          child.stdout.on('data', onData);
          child.stderr.on('data', onData);
          child.once('exit', (code) => {
            clearTimeout(timer);
            fail(new Error(`${where} exited ${code} before it was ready:\n${output}`));
          });
        });
        lastOutput = output;
        log.push(`$ ${command} &\n${output}`);
      } else {
        throw new Error(`${where}: unknown marker tutorial=${step.kind}`);
      }
    }
    return { ok: true, log };
  } catch (error) {
    return { ok: false, error: error.message, log };
  } finally {
    for (const child of background) {
      await stop(child);
      live.children.delete(child);
    }
    removeOurContainers(work);
    live.works.delete(work);
    // A process the page started (the pack service, a compile) can still be
    // writing as it exits: retry, and never fail a page on its cleanup.
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      console.warn(`run-tutorials: couldn't remove ${work}: ${error.message}`);
    }
  }
}

if (!existsSync(cli)) {
  console.error('run-tutorials: build the workspace first (`pnpm run build`).');
  process.exit(1);
}
const selected = process.argv.slice(2).map((page) => resolve(docs, page));
const targets = (selected.length > 0 ? selected : pages()).filter(
  (page) => steps(readFileSync(page, 'utf8')).length > 0,
);
if (targets.length === 0) {
  console.log('run-tutorials: no page has tutorial steps.');
  process.exit(0);
}
const postgres = await startPostgres();
// Ctrl+C or a kill: stop what the current page started, then the Postgres.
for (const signalName of ['SIGINT', 'SIGTERM']) {
  process.once(signalName, () => {
    for (const child of live.children) signal(child.pid, 'SIGKILL');
    for (const work of live.works) {
      removeOurContainers(work);
      rmSync(work, { recursive: true, force: true });
    }
    removePostgres(postgres);
    process.exit(130);
  });
}
/** A Java page's packs need this checkout's kindgi-pack in the local Maven repository. */
function installJavaSdk() {
  const installed = spawnSync(
    'sh',
    ['./mvnw', '-q', '-B', 'install', '-DskipTests', '-pl', 'kindgi-pack', '-am'],
    {
      cwd: join(repo, 'sdks', 'java'),
      encoding: 'utf8',
    },
  );
  if (installed.status !== 0) {
    throw new Error(
      `couldn't install kindgi-pack from sdks/java (a JDK 17 or later, with JAVA_HOME set, is needed):\n${installed.stdout}${installed.stderr}`,
    );
  }
}
/** A Scala page's packs also need this checkout's kindgi-pack-scala in the local Ivy repository. */
function installScalaSdk() {
  const published = spawnSync('sbt', ['-batch', '+publishLocal'], {
    cwd: join(repo, 'sdks', 'scala'),
    encoding: 'utf8',
  });
  if (published.status !== 0) {
    throw new Error(
      `couldn't publish kindgi-pack-scala from sdks/scala (sbt, and a JDK 17 or later, are needed):\n${published.stdout}${published.stderr}`,
    );
  }
}
let javaInstalled = false;
let scalaInstalled = false;
let failed = 0;
try {
  for (const [index, page] of targets.entries()) {
    const text = readFileSync(page, 'utf8');
    if (!javaInstalled && /--template=(java|scala)\b/.test(text)) {
      installJavaSdk();
      javaInstalled = true;
    }
    if (!scalaInstalled && text.includes('--template=scala')) {
      installScalaSdk();
      scalaInstalled = true;
    }
    const name = relative(docs, page);
    const started = Date.now();
    const result = await runPage(page, createDatabase(postgres, `tutorial_${index + 1}`));
    const seconds = Math.round((Date.now() - started) / 1000);
    if (result.ok) {
      console.log(`run-tutorials: ✓ ${name} (${seconds}s)`);
    } else {
      failed += 1;
      console.error(`run-tutorials: ✗ ${name} (${seconds}s)\n${result.error}\n`);
    }
  }
} finally {
  removePostgres(postgres);
}
process.exit(failed > 0 ? 1 : 0);
