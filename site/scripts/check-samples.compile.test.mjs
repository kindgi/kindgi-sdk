// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// A page's install step for its samples' libraries, through the real check:
// `kindgi init`'s packs, uv, pnpm and pyright, as `docs:samples` runs them.
// It needs what that needs for TypeScript and Python (the workspace built,
// uv), and the network or warm caches for the libraries.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-samples.mjs');
const fence = '```';
/** A page's hidden `check-samples` comment around `lines`. */
const standIn = (...lines) => ['<!-- check-samples:', ...lines, '-->'];

const receiver = [
  `${fence}python`,
  '# receiver.py',
  'from fastapi import FastAPI',
  '',
  'app = FastAPI()',
  '',
  '',
  '@app.get("/health")',
  'def health() -> dict[str, str]:',
  '    return {"status": "ok"}',
  fence,
];
const app = [
  `${fence}ts`,
  '// app.ts',
  "import { nanoid } from 'nanoid';",
  '',
  'export const requestId: string = nanoid();',
  fence,
];

/** The check's report on each page: its failure's text, or undefined when it checks. */
function failures(stderr, names) {
  const chunks = stderr.split('\n\n');
  return Object.fromEntries(
    names.map((name) => [
      name,
      chunks.find((chunk) => chunk.split('\n')[0].includes(`/${name} (`)),
    ]),
  );
}

test(
  "a page's install step: the library is added in that page's pack only, and nothing else is run",
  {
    timeout: 15 * 60_000,
  },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-samples-libraries-'));
    const marker = join(dir, 'ran');
    try {
      const pages = {
        'no-step.mdx': receiver,
        'step.mdx': [...receiver, ...standIn(`${fence}sh`, 'uv add fastapi', fence)],
        // After `step.mdx`: its pack's copy got FastAPI, the fresh pack didn't.
        'after-step.mdx': receiver,
        'refused-step.mdx': [
          ...receiver,
          ...standIn(`${fence}sh`, `uv add fastapi; touch ${marker}`, fence),
        ],
        'ts-step.mdx': [...app, ...standIn(`${fence}sh`, 'pnpm add nanoid', fence)],
        'ts-after-step.mdx': app,
      };
      for (const [name, lines] of Object.entries(pages)) {
        writeFileSync(join(dir, name), `${lines.join('\n')}\n`);
      }
      const names = Object.keys(pages);
      const result = spawnSync('node', [script, ...names.map((name) => join(dir, name))], {
        encoding: 'utf8',
      });
      const failed = failures(result.stderr, names);
      const unresolved = /Import "fastapi" could not be resolved/;

      assert.equal(result.status, 1, result.stderr);
      assert.match(failed['no-step.mdx'] ?? '', unresolved);
      assert.equal(failed['step.mdx'], undefined);
      assert.match(failed['after-step.mdx'] ?? '', unresolved);
      // The refused line isn't run, neither as a command nor as `uv add`'s words.
      assert.match(failed['refused-step.mdx'] ?? '', unresolved);
      assert.doesNotMatch(failed['refused-step.mdx'] ?? '', /to the pack failed/);
      assert.equal(existsSync(marker), false);
      assert.equal(failed['ts-step.mdx'], undefined);
      assert.match(failed['ts-after-step.mdx'] ?? '', /Cannot find module 'nanoid'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
