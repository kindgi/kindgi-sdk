#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
//
// The referee for the SDKs' definition-time schema checks: compiles every schema of
// packages/specs/test-vectors/strict-schemas/corpus.json with the runtime's own
// compileInlineSchema (the built @kindgi/schema) and writes what it says to answers.json beside
// it: null when the schema compiles, else the refusal without its "Inline schema failed to
// compile: " prefix. The SDKs replay the answers (test-vectors/README.md).
//
//   pnpm run build && node scripts/strict-schemas-oracle.mjs           # write the answers
//   pnpm run build && node scripts/strict-schemas-oracle.mjs --check   # fail when they're stale

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const { compileInlineSchema } = await import(
  pathToFileURL(join(repo, 'packages', 'schema', 'dist', 'index.js')).href
);

const strict = join(repo, 'packages', 'specs', 'test-vectors', 'strict-schemas');
const corpus = JSON.parse(readFileSync(join(strict, 'corpus.json'), 'utf8'));
const prefix = 'Inline schema failed to compile: ';
const answers = {};
for (const [group, cases] of Object.entries(corpus)) {
  answers[group] = {};
  for (const [name, schema] of Object.entries(cases)) {
    const compiled = compileInlineSchema(schema);
    if (compiled.kind === 'ok') {
      answers[group][name] = null;
    } else if (compiled.error.message.startsWith(prefix)) {
      answers[group][name] = compiled.error.message.slice(prefix.length);
    } else {
      throw new Error(`${name}: ${compiled.error.message}`);
    }
  }
}
for (const name of Object.keys(answers.unchecked ?? {})) {
  if (answers.unchecked[name] === null) {
    console.error(
      `strict-schemas-oracle: the runtime compiles the unchecked case ${name}; move it to parity`,
    );
    process.exit(1);
  }
}

const answersPath = join(strict, 'answers.json');
const text = `${JSON.stringify(answers, null, 2)}\n`;
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(answersPath, 'utf8');
  } catch {
    // No answers yet: stale.
  }
  if (current !== text) {
    console.error(
      'strict-schemas-oracle: answers.json is stale; run node scripts/strict-schemas-oracle.mjs',
    );
    process.exit(1);
  }
  console.log(
    `strict-schemas-oracle: answers.json is current (${Object.keys(corpus.parity).length} parity cases)`,
  );
} else {
  writeFileSync(answersPath, text);
  console.log(`strict-schemas-oracle: wrote ${answersPath}`);
}
