// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Parity with the parsers applications actually use.
 *
 *   - Parse: `dotenv@16.3.1` — the version Next.js 16 bundles. Every
 *     input must produce the identical record.
 *   - Expand: `dotenv-expand` 10 (Next.js 16) and 12 (Vite). Where the
 *     two agree, Kindgi must agree with both. Where they disagree, the
 *     unit tests in `expand.test.ts` pin Kindgi's choice.
 */

import { createRequire } from 'node:module';

import { describe, expect, test } from 'vitest';

import {
  envLinesToRecord,
  expandEnv,
  parseEnvFile,
  serializeEnvFile,
  setKey,
} from '../src/index.js';

const require = createRequire(import.meta.url);
const dotenv = require('dotenv') as { parse(src: string): Record<string, string> };
const expand10 = require('dotenv-expand-10') as {
  expand(c: { parsed: Record<string, string>; ignoreProcessEnv: boolean }): {
    parsed: Record<string, string>;
  };
};
const expand12 = require('dotenv-expand-12') as {
  expand(c: { parsed: Record<string, string>; processEnv: Record<string, string> }): {
    parsed: Record<string, string>;
  };
};

const ours = (src: string): Record<string, string> => envLinesToRecord(parseEnvFile(src));

// ---------------------------------------------------------------------
// Parse parity — hand-picked corpus
// ---------------------------------------------------------------------

const PARSE_CORPUS: readonly (readonly [string, string])[] = [
  ['plain', 'A=1\nB=two\n'],
  ['no trailing newline', 'A=1\nB=2'],
  ['CRLF + lone CR', 'A=1\r\nB=2\rC=3\r\n'],
  ['spaces around =', 'A = 1\nB=  2  \nC  =3'],
  ['colon separator', 'A: 1\nB:  two words\nC:x\n'],
  ['export prefix', 'export A=1\nexport  B="x y"\nexport=3\nexportC=4\n'],
  ['lowercase, dots, dashes', 'a=1\nsome.key=2\nsome-key=3\nMiXeD_1=4\n'],
  ['leading whitespace', '   A=1\n\tB=2\n'],
  ['empty values', 'A=\nB=""\nC=\'\'\nD=``\nE=   \nF= # only a comment\n'],
  [
    'inline comments',
    'A=value # comment\nB=value#nospace\nC="quoted # kept" # dropped\nD=\'a#b\'\n',
  ],
  ['hash at start of value', 'A=#notvalue\nB= #also\n'],
  [
    'double quotes expand \\n \\r only',
    'A="line1\\nline2"\nB="tab\\tstays"\nC="cr\\rx"\nD="q\\"uote"\n',
  ],
  ['single quotes literal', "A='line1\\nline2'\nB='it\\'s'\nC='$HOME'\n"],
  ['backticks literal', 'A=`has "double" and \'single\'`\nB=`a\\nb`\n'],
  ['multi-line double', 'A="line1\nline2\nline3"\nB=after\n'],
  ['multi-line single', "A='one\ntwo'\nB=after\n"],
  ['multi-line backtick', 'A=`one\n  two\n`\nB=after\n'],
  ['closing quote then junk → unquoted', 'A="x" junk\nB=\'y\'z\nC=`w` more\n'],
  ['unterminated quote → unquoted', 'A="abc\nB=\'def\nC=`ghi\nD=ok\n'],
  ['outer quotes on unquoted fallback', 'A="a" "b"\nB=\'a\'b\'\n'],
  ['escaped quote as closing (backtrack)', 'A="abc\\"\nB="x\\" y\\"\n'],
  ['double backslash before quote', 'A="a\\\\"\nB=\'b\\\\\'\n'],
  ['duplicates: last wins', 'A=1\nA=2\nB=x\nB=\nC=1\n'],
  ['comments + blanks', '# header\n\nA=1\n  # indented comment\nB=2\n\n'],
  [
    'malformed lines ignored',
    'not an entry\nA=1\n=novalue\nkey with space=1\nB=2\n9LEADING=digit\n',
  ],
  ['quote inside unquoted', 'A=it\'s\nB=say "hi"\nC=a`b\n'],
  ['url + special chars', 'A=postgres://u:p@h:5432/db?sslmode=disable\nB=a=b=c\nC=100%\n'],
  ['dollar signs verbatim at parse', 'A=$B\nB=${C}\nC=\\$literal\n'],
  ['quoted value with trailing comment', 'A="x"   # trailing\nB=\'y\'#t\n'],
  ['quote swallowing lines (closing at EOL)', 'A="start\nB=looks like entry\nend"\nC=3\n'],
  ['whitespace inside quotes preserved', 'A="  padded  "\nB=\'  also  \'\n'],
  ['unicode', 'A=héllo\nB="日本語"\nC=emoji🎉\n'],
];

describe('parse parity with dotenv@16.3.1 (Next.js 16)', () => {
  test.each(PARSE_CORPUS)('%s', (_name, src) => {
    expect(ours(src)).toEqual(dotenv.parse(src));
  });
});

// ---------------------------------------------------------------------
// Parse parity — generated inputs
// ---------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  'A',
  'b',
  'KEY_1',
  'x.y',
  'k-z',
  'export ',
  '=',
  ' = ',
  ': ',
  ':',
  ' ',
  '  ',
  '\t',
  '#',
  ' # c',
  '"',
  "'",
  '`',
  '\\',
  '\\"',
  "\\'",
  '\\n',
  'val',
  'two words',
  '$X',
  '${Y}',
  '\n',
  '\n',
  '\n',
  '\r\n',
] as const;

/**
 * Inputs where dotenv's regex lets a key's separator, or an empty
 * value's leading whitespace, cross a newline — the one documented
 * divergence (see parse.ts). Excluded from the generated comparison.
 */
function crossesLineAtSeparator(src: string): boolean {
  const s = src.replace(/\r\n?/g, '\n');
  return (
    /(^|\n)[ \t]*(export\s+)?[\w.-]+\s*\n\s*=/.test(s) ||
    /(^|\n)[ \t]*(export\s+)?[\w.-]+:\n/.test(s) ||
    /(^|\n)[ \t]*(export\s+)?[\w.-]+(\s*=|:\s)[ \t]*\n\s*['"`]/.test(s) ||
    /(^|\n)[ \t]*export\s*\n/.test(s)
  );
}

describe('parse parity — 3000 generated inputs', () => {
  test('identical records (excluding the documented cross-line separator divergence)', () => {
    const next = rng(20260929);
    let compared = 0;
    for (let n = 0; n < 3000; n += 1) {
      const len = 1 + Math.floor(next() * 14);
      let src = '';
      for (let i = 0; i < len; i += 1) src += FRAGMENTS[Math.floor(next() * FRAGMENTS.length)];
      if (crossesLineAtSeparator(src)) continue;
      compared += 1;
      expect(ours(src), JSON.stringify(src)).toEqual(dotenv.parse(src));
    }
    expect(compared).toBeGreaterThan(2000);
  });
});

// ---------------------------------------------------------------------
// Expansion parity — where dotenv-expand 10 and 12 agree
// ---------------------------------------------------------------------

const EXPAND_CORPUS: readonly (readonly [string, string])[] = [
  ['backward braced + unbraced', 'HOST=db\nPORT=5432\nURL=postgres://${HOST}:$PORT/app\n'],
  ['chain of backward refs', 'A=1\nB=${A}2\nC=${B}3\n'],
  ['unset ref → empty', 'A=pre-${MISSING}-post\nB=$MISSING\n'],
  ['default when unset', 'A=${MISSING:-fallback}\nB=${ALSO_MISSING:-}\n'],
  ['default when empty (backward)', 'EMPTY=\nA=${EMPTY:-fallback}\n'],
  ['escaped dollar', 'A=\\$HOME\nB=cost \\$5\nC="\\${NOT_EXPANDED}"\n'],
  ['literal dollar not followed by a name', 'A=5$\nB=$ alone\n'],
  ['quoted values expand too', 'A=x\nB="${A} in double"\nC=\'${A} in single\'\n'],
  ['repeated ref', 'A=ab\nB=$A-$A-${A}\n'],
];

describe('expansion parity with dotenv-expand 10 (Next.js) and 12 (Vite)', () => {
  test.each(EXPAND_CORPUS)('%s', (_name, src) => {
    const parsed = dotenv.parse(src);
    const v10 = expand10.expand({ parsed: { ...parsed }, ignoreProcessEnv: true }).parsed;
    const v12 = expand12.expand({ parsed: { ...parsed }, processEnv: {} }).parsed;
    expect(v10, 'oracles must agree for a corpus entry').toEqual(v12);
    expect(expandEnv(ours(src)).values).toEqual(v12);
  });
});

// A key that refers to itself, with the environment holding it: both
// versions take the environment's value (T377). Without it, dotenv-expand
// 10 overflows its stack, so those cases aren't compared. Not compared
// either: `PATH=$PATH:/extra`. The hosts keep any name the environment
// has and ignore the file's line (`/bin`); here a file's value is the
// source, so it's the shell's reading, `/bin:/extra` (expand.test.ts).
const SELF_CORPUS: readonly (readonly [string, string, Record<string, string>])[] = [
  ['braced', 'KEY=${KEY}\n', { KEY: 'from-shell' }],
  ['unbraced', 'KEY=$KEY\n', { KEY: 'from-shell' }],
  ['with a default', 'KEY=${KEY:-fallback}\n', { KEY: 'from-shell' }],
];

describe('a self-reference, with the environment holding it: parity with dotenv-expand 10 and 12', () => {
  test.each(SELF_CORPUS)('%s', (_name, src, env) => {
    const parsed = dotenv.parse(src);
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    let v10: Record<string, string>;
    try {
      v10 = expand10.expand({ parsed: { ...parsed }, ignoreProcessEnv: false }).parsed;
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const v12 = expand12.expand({ parsed: { ...parsed }, processEnv: { ...env } }).parsed;
    expect(v10, 'oracles must agree for a corpus entry').toEqual(v12);
    expect(expandEnv(ours(src), { env }).values).toEqual(v12);
  });
});

// ---------------------------------------------------------------------
// Writer round-trip through the reference pipeline
// ---------------------------------------------------------------------

const TRICKY_VALUES = [
  'plain',
  '',
  ' leading and trailing ',
  'has # hash',
  'multi\nline',
  'windows\r\nline',
  'say "hi"',
  "it's",
  `mixed "double" and 'single'`,
  'dollar $HOME and ${BRACED}',
  'backslash \\ and \\n literal',
  'ends with backslash\\',
  'tab\there',
  'postgres://u:p@h:5432/db?sslmode=disable',
  'sk-ant-api03-AbC_dEf-123==',
  '日本語 🎉',
];

describe('writer round-trip: setKey → dotenv.parse → dotenv-expand reads the exact value', () => {
  test.each(TRICKY_VALUES.map((v) => [JSON.stringify(v), v] as const))('%s', (_label, value) => {
    const { contents } = setKey('# existing\nOTHER=1\n', 'KEY', value);
    // What an application sees (Next.js pipeline):
    const parsed = dotenv.parse(contents);
    const appSees = expand12.expand({ parsed: { ...parsed }, processEnv: {} }).parsed;
    expect(appSees.KEY).toBe(value);
    expect(appSees.OTHER).toBe('1');
    // What Kindgi sees:
    expect(expandEnv(ours(contents)).values.KEY).toBe(value);
    // And re-serializing changes nothing.
    expect(serializeEnvFile(parseEnvFile(contents))).toBe(contents);
  });
});
