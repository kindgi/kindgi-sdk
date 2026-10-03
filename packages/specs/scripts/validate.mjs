#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Validates every JSON Schema in schemas/ against the Draft 2020-12 meta-schema
// and this package's $id / schema-version conventions (see README.md). Fails CI
// if any schema is malformed. Also loads example fixtures if present
// (examples/<schema>.example.*.json) and validates each against its schema.
//
// Runs from source, before any build: `pnpm run spec:validate` at the repo
// root, or `pnpm run validate` in this package.

import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import addFormats from 'ajv-formats';
import Ajv from 'ajv/dist/2020.js';

const SCHEMAS_DIR = fileURLToPath(new URL('../schemas/', import.meta.url));
const EXAMPLES_DIR = fileURLToPath(new URL('../examples/', import.meta.url));

// Every schema's $id must match this pattern. The <name> segment must equal the filename.
// Enforced by the validator so filename ↔ $id drift is caught before it corrupts consumers.
const ID_PATTERN = /^https:\/\/kindgi\.com\/schemas\/v(\d+)\/([a-z][a-z0-9-]*)\.schema\.json$/;
const SCHEMA_VERSION_PATTERN = /^schema-version: \d+\.\d+\.\d+$/;

const AjvCtor = Ajv.default ?? Ajv;
const addFormatsFn = addFormats.default ?? addFormats;

const ajv = new AjvCtor({
  strict: true,
  allErrors: true,
  allowUnionTypes: false,
});
addFormatsFn(ajv);

let failed = 0;
const passed = [];

async function listSchemaFiles() {
  const entries = await readdir(SCHEMAS_DIR);
  return entries
    .filter((name) => name.endsWith('.schema.json'))
    .sort()
    .map((name) => ({ name, path: join(SCHEMAS_DIR, name) }));
}

async function loadExamplesFor(schemaFileName) {
  if (!existsSync(EXAMPLES_DIR)) return [];
  const base = basename(schemaFileName, '.schema.json');
  const entries = await readdir(EXAMPLES_DIR);
  return entries
    .filter((name) => name.startsWith(`${base}.example.`) && name.endsWith('.json'))
    .sort()
    .map((name) => ({ name, path: join(EXAMPLES_DIR, name) }));
}

async function loadAndParse({ name, path }) {
  let raw;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    console.error(`✗ ${name}: cannot read file — ${err.message}`);
    failed += 1;
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`✗ ${name}: invalid JSON — ${err.message}`);
    failed += 1;
    return null;
  }
}

async function validateExamplesFor(name, validator) {
  const examples = await loadExamplesFor(name);
  let exampleFailures = 0;
  for (const ex of examples) {
    let exampleJson;
    try {
      exampleJson = JSON.parse(await readFile(ex.path, 'utf-8'));
    } catch (err) {
      console.error(`  ✗ example ${ex.name}: invalid JSON — ${err.message}`);
      exampleFailures += 1;
      continue;
    }
    if (!validator(exampleJson)) {
      console.error(
        `  ✗ example ${ex.name} does not validate against ${name}:`,
        JSON.stringify(validator.errors, null, 2),
      );
      exampleFailures += 1;
    } else {
      console.log(`  ✓ example ${ex.name}`);
    }
  }
  return { count: examples.length, failures: exampleFailures };
}

// Validates that a schema's $id conforms to the versioned filename convention.
// Returns null on success, or an error message on violation.
function checkIdConvention(file, schema) {
  if (typeof schema.$id !== 'string' || schema.$id.length === 0) {
    return 'schema is missing top-level $id (required for cross-references)';
  }
  const match = ID_PATTERN.exec(schema.$id);
  if (match === null) {
    return `$id "${schema.$id}" does not match https://kindgi.com/schemas/v<N>/<name>.schema.json`;
  }
  const [, , idName] = match;
  const fileBase = basename(file.name, '.schema.json');
  if (idName !== fileBase) {
    return `$id name "${idName}" does not match filename "${fileBase}"`;
  }
  if (typeof schema.$comment !== 'string' || !SCHEMA_VERSION_PATTERN.test(schema.$comment)) {
    return '$comment is missing or does not match "schema-version: X.Y.Z"';
  }
  return null;
}

// Pass 1: parse every schema and register with Ajv by $id.
// This allows cross-schema $ref (e.g. pack.schema.json → tool.schema.json) to resolve.
async function registerOne(file) {
  const schema = await loadAndParse(file);
  if (schema === null) return null;
  const violation = checkIdConvention(file, schema);
  if (violation !== null) {
    console.error(`✗ ${file.name}: ${violation}`);
    failed += 1;
    return null;
  }
  try {
    ajv.addSchema(schema, schema.$id);
  } catch (err) {
    console.error(`✗ ${file.name}: cannot register schema — ${err.message}`);
    failed += 1;
    return null;
  }
  return { ...file, schema };
}

async function registerAll(files) {
  const registered = [];
  for (const file of files) {
    const entry = await registerOne(file);
    if (entry !== null) registered.push(entry);
  }
  return registered;
}

// Pass 2: compile each schema and validate any example fixtures.
async function validateOne({ name, schema }) {
  let validator;
  try {
    validator = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  } catch (err) {
    console.error(`✗ ${name}: schema does not compile — ${err.message}`);
    failed += 1;
    return;
  }

  const { count, failures } = await validateExamplesFor(name, validator);
  if (failures > 0) {
    failed += 1;
    console.error(`✗ ${name} (${failures} example failure(s))`);
  } else {
    passed.push(name);
    console.log(`✓ ${name}${count > 0 ? ` (${count} example(s))` : ''}`);
  }
}

async function validateAll(schemas) {
  for (const entry of schemas) {
    await validateOne(entry);
  }
}

async function ensureSpecsDir() {
  try {
    await stat(SCHEMAS_DIR);
  } catch {
    console.error(`No schemas/ directory at ${SCHEMAS_DIR}`);
    process.exit(1);
  }
}

function reportAndExit() {
  console.log('');
  if (failed > 0) {
    console.error(`FAILED: ${failed} spec(s) or example(s) did not validate.`);
    process.exit(1);
  }
  console.log(`OK: ${passed.length} spec(s) validated.`);
}

async function main() {
  await ensureSpecsDir();

  const files = await listSchemaFiles();
  if (files.length === 0) {
    console.log(`No *.schema.json files found in ${SCHEMAS_DIR}. Nothing to validate.`);
    return;
  }

  console.log(`Validating ${files.length} spec(s) in ${SCHEMAS_DIR}\n`);

  const schemas = await registerAll(files);
  await validateAll(schemas);
  reportAndExit();
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
