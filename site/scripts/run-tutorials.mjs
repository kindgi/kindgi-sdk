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
 * a background `kindgi dev` gets a free `--port`, so a run never takes a
 * port another runtime holds. Steps that need a real model or a cloud
 * account stay unmarked: they're release checks, run by hand.
 *
 * Needs the workspace built (`pnpm run build`), Docker with the pinned
 * runtime image available, and uv for Python pages.
 *
 * Usage: node site/scripts/run-tutorials.mjs [<page under site/src/content/docs> …]
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
const KINDGI_DEV = /(?:\bkindgi|@kindgi\/cli(?:@\S+)?)\s+dev\b/;

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

/** A PATH directory whose `npx` runs this checkout's CLI for `@kindgi/cli`. */
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

async function runPage(page) {
  const work = mkdtempSync(join(tmpdir(), 'kindgi-tutorial-'));
  const env = { ...process.env, PATH: `${shimDir(work)}:${process.env.PATH}` };
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
    for (const child of background) await stop(child);
    removeOurContainers(work);
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
let failed = 0;
for (const page of targets) {
  const name = relative(docs, page);
  const started = Date.now();
  const result = await runPage(page);
  const seconds = Math.round((Date.now() - started) / 1000);
  if (result.ok) {
    console.log(`run-tutorials: ✓ ${name} (${seconds}s)`);
  } else {
    failed += 1;
    console.error(`run-tutorials: ✗ ${name} (${seconds}s)\n${result.error}\n`);
  }
}
if (targets.length === 0) console.log('run-tutorials: no page has tutorial steps.');
process.exit(failed > 0 ? 1 : 0);
