#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
//
// The referee for the Java pack service's JSON Schema validator: runs every
// schema and value of the corpus (src/test/resources/ajv/corpus.json, plus
// the derived schemas in src/test/resources/derive/golden.json) through
// Ajv, configured as the TypeScript pack service configures it (Ajv 2020,
// strict, allErrors, allowUnionTypes, ajv-formats), and writes Ajv's verdicts and issues to
// src/test/resources/ajv/oracle.json. The Java test (AjvOracleTest) requires
// the same verdicts and the same issues.
//
//   node sdks/java/kindgi-pack/scripts/ajv-oracle.mjs           # write the oracle
//   node sdks/java/kindgi-pack/scripts/ajv-oracle.mjs --check   # fail when it's stale

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
// Ajv as the TypeScript pack service has it.
const require = createRequire(join(repo, 'packages', 'handler-runtime', 'package.json'));
const { Ajv2020 } = require('ajv/dist/2020.js');
const addFormatsModule = require('ajv-formats');
const addFormats = addFormatsModule.default ?? addFormatsModule;

const resources = join(here, '..', 'src', 'test', 'resources', 'ajv');
const corpus = JSON.parse(readFileSync(join(resources, 'corpus.json'), 'utf8'));
// Schemas the Java deriver writes (SchemaDeriverTest): Ajv must compile each
// one in strict mode, and corpus cases name them with "schemaFrom".
const derived = JSON.parse(readFileSync(join(resources, '..', 'derive', 'golden.json'), 'utf8'));
for (const [name, schema] of Object.entries(derived)) {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  try {
    ajv.compile(schema);
  } catch (e) {
    console.error(`ajv-oracle: Ajv refuses the derived schema ${name}: ${e.message}`);
    process.exit(1);
  }
}
const oraclePath = join(resources, 'oracle.json');

const cases = [];
for (const entry of corpus.cases) {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  const schema = entry.schemaFrom ? derived[entry.schemaFrom] : entry.schema;
  if (!schema) throw new Error(`${entry.name}: no derived schema ${entry.schemaFrom}`);
  const validate = ajv.compile(schema);
  entry.values.forEach((value, i) => {
    const valid = validate(value);
    const issues = (validate.errors ?? []).map((e) => {
      const issue = {
        instancePath: e.instancePath,
        schemaPath: e.schemaPath,
        keyword: e.keyword,
        params: e.params,
        message: e.message,
      };
      if (e.propertyName !== undefined) issue.propertyName = e.propertyName;
      return issue;
    });
    cases.push({ name: entry.name, value: i, valid, issues });
  });
}
// Canonical JSON: each JSON text, parsed, then written as the TypeScript
// indexer writes an index (keys sorted, two-space indent).
const sortKeys = (v) =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sortKeys(v[k])]),
        )
      : v;
const canonical = (corpus.canonical ?? []).map((text) => ({
  text,
  json: JSON.stringify(sortKeys(JSON.parse(text)), null, 2),
}));
const text = `${JSON.stringify({ cases, canonical }, null, 2)}\n`;
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(oraclePath, 'utf8');
  } catch {
    // No oracle yet: stale.
  }
  if (current !== text) {
    console.error(
      'ajv-oracle: oracle.json is stale: run node sdks/java/kindgi-pack/scripts/ajv-oracle.mjs',
    );
    process.exit(1);
  }
  console.log(`ajv-oracle: oracle.json is current (${cases.length} cases)`);
} else {
  writeFileSync(oraclePath, text);
  console.log(`ajv-oracle: wrote ${cases.length} cases`);
}
