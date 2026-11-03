#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
//
// The Unicode data of the SDKs' regular-expression syntax check (sdks/python/src/kindgi/_regexp.py
// and the Java SDK's RegExp.java), taken from the RegExp of the Node that runs this, so the tables
// say what the engine accepts:
//
//   - the characters a group name may start and go on with: every code point is tried as
//     (?<\u{…}>) and (?<a\u{…}>);
//   - the names \p{…} takes: every property and value name in the Unicode Character Database
//     files PropertyAliases.txt and PropertyValueAliases.txt, and the names outside them (Any,
//     ASCII, Assigned), tried alone and as name=value.
//
// The UCD files aren't kept in the repository. Take them from
// https://www.unicode.org/Public/<version>/ucd/ for the version process.versions.unicode names.
// CI checks the tables on the Node of the runtime's image (.github/workflows/ci.yml), so write
// them with that Node.
//
//   node scripts/regexp-tables.mjs <ucd dir>   # write the tables
//   node scripts/regexp-tables.mjs --check     # fail when they're stale (no UCD needed)
//
// --check reads the names back from the written file and tries each again where it's listed
// and where it isn't, tries the near misses that must be refused (another case, a value of
// another property), enumerates the group-name characters again, and compares the file with a
// fresh rendering of it.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

// Each output, rendered from the same tables.
const writers = [
  { path: join(repo, 'sdks/python/src/kindgi/_regexp_tables.py'), render: python },
  {
    path: join(
      repo,
      'sdks/java/kindgi-pack/src/main/java/com/kindgi/pack/internal/RegExpTables.java',
    ),
    render: java,
  },
];

// Names \p{…} takes that aren't in the UCD files.
const EXTRA_NAMES = ['Any', 'ASCII', 'Assigned'];
// Names that must be refused, whatever the tables say.
const NEAR_MISSES = [
  'letter',
  'lu',
  'LU',
  'any',
  'ascii',
  'L&',
  'Script=greek',
  'Script=Hrkt',
  'sc=Hrkt',
  'script=Greek',
  'General_Category=letter',
  'gc=Latin',
  'sc=Lu',
  'Alpha=Y',
  'blk=ASCII',
  'Basic_Emoji',
  'RGI_Emoji',
  'Is_Greek',
  'In_Greek',
];

Error.stackTraceLimit = 0;

function compiles(source) {
  try {
    new RegExp(source, 'u');
    return true;
  } catch {
    return false;
  }
}

const has = (name) => compiles(`\\p{${name}}`) && compiles(`\\P{${name}}`);

function fail(message) {
  console.error(`regexp-tables: ${message}`);
  process.exit(1);
}

// The UCD file's rows: fields split at ';', comments and blank lines dropped.
function rows(dir, file) {
  return readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((line) => line.split(';').map((field) => field.trim()));
}

function fromUcd(dir) {
  const properties = rows(dir, 'PropertyAliases.txt');
  const values = rows(dir, 'PropertyValueAliases.txt');
  const names = new Set([...properties.flat(), ...values.flatMap((row) => row.slice(1))]);
  for (const name of EXTRA_NAMES) names.add(name);
  return names;
}

function tables(candidates) {
  const sorted = [...candidates].sort();
  for (const name of sorted) {
    if (compiles(`\\p{${name}}`) !== compiles(`\\P{${name}}`)) {
      fail(`\\p{${name}} and \\P{${name}} disagree; the check takes them as one`);
    }
  }
  const lone = sorted.filter((name) => compiles(`\\p{${name}}`));
  // The names that take a value, found with a value of each kind; each must take the values one
  // of General_Category and Script takes, as the check reads them.
  const valueSets = new Map();
  for (const name of sorted) {
    if (['Lu', 'Latn', 'Y'].some((value) => compiles(`\\p{${name}=${value}}`))) {
      valueSets.set(
        name,
        sorted.filter((value) => compiles(`\\p{${name}=${value}}`)),
      );
    }
  }
  const generalCategories = valueSets.get('General_Category') ?? fail('no General_Category');
  const scripts = valueSets.get('Script') ?? fail('no Script');
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const generalCategoryNames = [];
  const scriptNames = [];
  for (const [name, accepted] of valueSets) {
    if (same(accepted, generalCategories)) generalCategoryNames.push(name);
    else if (same(accepted, scripts)) scriptNames.push(name);
    else fail(`\\p{${name}=…} takes values neither General_Category nor Script takes`);
  }
  const missing = generalCategories.filter((name) => !lone.includes(name));
  if (missing.length > 0) fail(`general categories refused alone: ${missing.join(' ')}`);
  const binary = lone.filter((name) => !generalCategories.includes(name));
  return {
    idStart: idRanges(
      (ch) => `(?<${ch}>)`,
      (ch) => ch,
    ),
    idContinue: idRanges(
      (ch) => `(?<a${ch}>)`,
      (ch) => `a${ch}`,
    ),
    generalCategories,
    binaryProperties: binary,
    scripts,
    generalCategoryNames,
    scriptNames,
  };
}

// The code points a group name takes, as [first, last] ranges: those the name keeps as written.
function idRanges(source, name) {
  const ranges = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const escaped = source(`\\u{${cp.toString(16)}}`);
    let groups;
    try {
      groups = new RegExp(escaped, 'u').exec('')?.groups;
    } catch {
      continue;
    }
    // A name the escape ends (\u{3e} is '>') leaves a pattern that doesn't match ''.
    if (groups === undefined || !Object.hasOwn(groups, name(String.fromCodePoint(cp)))) continue;
    const last = ranges.at(-1);
    if (last && last[1] === cp - 1) last[1] = cp;
    else ranges.push([cp, cp]);
  }
  return ranges;
}

function python(t) {
  const hex = (n) => `0x${n.toString(16).toUpperCase()}`;
  const ranges = (name, list) =>
    [
      `${name}: tuple[tuple[int, int], ...] = (`,
      ...list.map(([lo, hi]) => `    (${hex(lo)}, ${hex(hi)}),`),
      ')',
    ].join('\n');
  const names = (name, list) =>
    [`${name} = frozenset(`, '    {', ...list.map((n) => `        "${n}",`), '    }', ')'].join(
      '\n',
    );
  return [
    '# SPDX-License-Identifier: Apache-2.0',
    '# Copyright (C) 2026 Kindgi Inc.',
    '#',
    `# Generated by scripts/regexp-tables.mjs from Node's RegExp (Unicode ${process.versions.unicode}) — do not edit.`,
    '',
    '"""The Unicode data `_regexp` reads, as V8 reads it.',
    '',
    '`ID_START` and `ID_CONTINUE` are the code points a group name may start and go on with, as',
    'inclusive ranges. `GENERAL_CATEGORIES` and `BINARY_PROPERTIES` are the names `\\\\p{…}` takes',
    'alone; `GENERAL_CATEGORY_NAMES` take a general category after `=`, `SCRIPT_NAMES` a',
    'script. Names are matched exactly: no other case, spaces or hyphens.',
    '"""',
    '',
    ranges('ID_START', t.idStart),
    '',
    ranges('ID_CONTINUE', t.idContinue),
    '',
    names('GENERAL_CATEGORIES', t.generalCategories),
    '',
    names('BINARY_PROPERTIES', t.binaryProperties),
    '',
    names('SCRIPTS', t.scripts),
    '',
    names('GENERAL_CATEGORY_NAMES', t.generalCategoryNames),
    '',
    names('SCRIPT_NAMES', t.scriptNames),
    '',
  ].join('\n');
}

// The Java tables keep the ranges and the names as strings read once when the class loads: the
// JVM takes no more than 64 KB of bytecode in a method, and an array of this many numbers is
// more than that. A range is `first-last` in hex, or `first` alone; names and ranges are
// separated by spaces.
function java(t) {
  const lines = (words) => {
    const out = [];
    let line = '';
    for (const word of words) {
      if (line !== '' && line.length + word.length > 88) {
        out.push(line);
        line = '';
      }
      line += line === '' ? word : ` ${word}`;
    }
    out.push(line);
    return out.map((text, i) => `"${text}${i < out.length - 1 ? ' ' : ''}"`);
  };
  const field = (type, name, parse, words) =>
    `  static final ${type} ${name} =\n      ${parse}(\n          ${lines(words).join('\n              + ')});`;
  const ranges = (name, list) =>
    field(
      'int[]',
      name,
      'ranges',
      list.map(([lo, hi]) =>
        lo === hi ? lo.toString(16) : `${lo.toString(16)}-${hi.toString(16)}`,
      ),
    );
  const names = (name, list) => field('Set<String>', name, 'names', list);
  return [
    '// SPDX-License-Identifier: Apache-2.0',
    '// Copyright (C) 2026 Kindgi Inc.',
    '//',
    `// Generated by scripts/regexp-tables.mjs from Node's RegExp (Unicode ${process.versions.unicode}) — do not edit.`,
    '',
    'package com.kindgi.pack.internal;',
    '',
    'import java.util.Set;',
    '',
    '/**',
    ' * The Unicode data {@link RegExp} reads, as V8 reads it.',
    ' *',
    ' * <p>{@code ID_START} and {@code ID_CONTINUE} are the code points a group name may start and go on',
    ' * with, as inclusive ranges: {@code first, last} pairs, ascending. {@code GENERAL_CATEGORIES} and',
    ' * {@code BINARY_PROPERTIES} are the names {@code \\p{…}} takes alone; {@code GENERAL_CATEGORY_NAMES}',
    ' * take a general category after {@code =}, {@code SCRIPT_NAMES} a script. Names are matched exactly:',
    ' * no other case, spaces or hyphens.',
    ' */',
    'final class RegExpTables {',
    '  private RegExpTables() {}',
    '',
    ranges('ID_START', t.idStart),
    '',
    ranges('ID_CONTINUE', t.idContinue),
    '',
    names('GENERAL_CATEGORIES', t.generalCategories),
    '',
    names('BINARY_PROPERTIES', t.binaryProperties),
    '',
    names('SCRIPTS', t.scripts),
    '',
    names('GENERAL_CATEGORY_NAMES', t.generalCategoryNames),
    '',
    names('SCRIPT_NAMES', t.scriptNames),
    '',
    '  private static int[] ranges(String text) {',
    '    String[] parts = text.split(" ");',
    '    int[] out = new int[2 * parts.length];',
    '    for (int i = 0; i < parts.length; i++) {',
    "      int dash = parts[i].indexOf('-');",
    '      int first = Integer.parseInt(dash < 0 ? parts[i] : parts[i].substring(0, dash), 16);',
    '      out[2 * i] = first;',
    '      out[2 * i + 1] = dash < 0 ? first : Integer.parseInt(parts[i].substring(dash + 1), 16);',
    '    }',
    '    return out;',
    '  }',
    '',
    '  private static Set<String> names(String text) {',
    '    return Set.of(text.split(" "));',
    '  }',
    '}',
    '',
  ].join('\n');
}

// The names a written Python file lists, by set.
function listed(text) {
  const sets = {};
  for (const [, name, body] of text.matchAll(/^(\w+) = frozenset\(\n {4}\{\n([^}]*) {4}\}\n\)/gm)) {
    sets[name] = [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  }
  return sets;
}

function check() {
  const path = writers[0].path;
  const text = readFileSync(path, 'utf8');
  const sets = listed(text);
  const universe = new Set(Object.values(sets).flat());
  for (const name of EXTRA_NAMES) universe.add(name);
  const t = tables(universe);
  const accepted = [
    ...t.generalCategories,
    ...t.binaryProperties,
    ...t.generalCategoryNames.flatMap((p) => t.generalCategories.map((v) => `${p}=${v}`)),
    ...t.scriptNames.flatMap((p) => t.scripts.map((v) => `${p}=${v}`)),
  ];
  const wrong = NEAR_MISSES.filter((name) => has(name) || accepted.includes(name));
  if (wrong.length > 0) fail(`near misses taken: ${wrong.join(' ')}`);
  let stale = false;
  for (const writer of writers) {
    let current = '';
    try {
      current = readFileSync(writer.path, 'utf8');
    } catch {
      // Not written yet: stale.
    }
    if (current !== writer.render(t)) {
      const written = /\(Unicode ([\d.]+)\)/.exec(current)?.[1] ?? 'none';
      console.error(
        `regexp-tables: ${writer.path} is stale: this Node (${process.version}, Unicode ${process.versions.unicode}) renders it otherwise; the file says Unicode ${written}`,
      );
      stale = true;
    }
  }
  if (stale) {
    // The UCD's directories name a release in full: Unicode 17.0 is 17.0.0.
    const release = process.versions.unicode.split('.').concat('0', '0').slice(0, 3).join('.');
    console.error(
      `regexp-tables: the tables follow the Node of the runtime's image, which .github/workflows/ci.yml checks them on. If that's this Node, take PropertyAliases.txt and PropertyValueAliases.txt from https://www.unicode.org/Public/${release}/ucd/ and run node scripts/regexp-tables.mjs <their dir>; if it isn't, check them on that Node`,
    );
    process.exit(1);
  }
  console.log(
    `regexp-tables: the tables are current (Unicode ${process.versions.unicode}, ${universe.size} names)`,
  );
}

if (process.argv[2] === '--check') {
  check();
} else if (process.argv[2]) {
  const t = tables(fromUcd(process.argv[2]));
  for (const writer of writers) {
    writeFileSync(writer.path, writer.render(t));
    console.log(`regexp-tables: wrote ${writer.path}`);
  }
} else {
  fail('usage: node scripts/regexp-tables.mjs <ucd dir> | --check');
}
