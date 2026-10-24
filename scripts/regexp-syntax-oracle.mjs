#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
//
// The referee for the SDKs' regular-expression syntax check: compiles every source of
// packages/specs/test-vectors/regexp-syntax/corpus.json with this Node's own RegExp, with the u
// flag and with no flags, and writes what it says to answers.json beside it: null when the
// source compiles, else the reason without its "Invalid regular expression: /<source>/<flags>: "
// prefix. The SDKs replay the answers (test-vectors/README.md).
//
//   node scripts/regexp-syntax-oracle.mjs           # write the answers
//   node scripts/regexp-syntax-oracle.mjs --check   # fail when they're stale
//
// Run it on the Node of .nvmrc: the reasons and the Unicode names are that V8's.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = join(here, '..', 'packages', 'specs', 'test-vectors', 'regexp-syntax');
const corpus = JSON.parse(readFileSync(join(vectors, 'corpus.json'), 'utf8'));

// A case is a source, or a list of parts joined: a string, or [string, times].
const source = (value) =>
  typeof value === 'string'
    ? value
    : value.map((part) => (typeof part === 'string' ? part : part[0].repeat(part[1]))).join('');

function reason(text, flags) {
  try {
    new RegExp(text, flags);
    return null;
  } catch (error) {
    const prefix = `Invalid regular expression: /${text}/${flags}: `;
    if (error instanceof SyntaxError && error.message.startsWith(prefix)) {
      return error.message.slice(prefix.length);
    }
    throw error;
  }
}

const answers = {};
for (const [name, value] of Object.entries(corpus)) {
  const text = source(value);
  answers[name] = { u: reason(text, 'u'), plain: reason(text, '') };
}

const answersPath = join(vectors, 'answers.json');
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
      'regexp-syntax-oracle: answers.json is stale; run node scripts/regexp-syntax-oracle.mjs',
    );
    process.exit(1);
  }
  console.log(
    `regexp-syntax-oracle: answers.json is current (${Object.keys(corpus).length} cases)`,
  );
} else {
  writeFileSync(answersPath, text);
  console.log(`regexp-syntax-oracle: wrote ${answersPath}`);
}
