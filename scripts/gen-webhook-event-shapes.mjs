#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `parseEvent`'s shapes (`@kindgi/sdk/webhooks`), generated from the API's own schemas.
 *
 * `WebhookEvent` in `packages/api/openapi.json` is the JSON body of every webhook request. This
 * walks it, and everything it refers to, into plain data for `parseEvent`'s checker
 * (`packages/sdk/src/webhook-events.ts`): each field's type, whether it's required, its enum
 * or const, its format (`uuid`, `date-time`), its bounds and pattern, array items, and the
 * discriminated unions. So the parser checks what the schema says, as Python's generated models
 * do, with no runtime dependency. A keyword the checker doesn't know fails the generation,
 * naming where, instead of being skipped. Fields the schema doesn't name are allowed, as Python's
 * models allow them (`extra="allow"`), so a newer runtime's additions don't break a receiver.
 *
 * Usage:
 *   node scripts/gen-webhook-event-shapes.mjs          write the shapes
 *   node scripts/gen-webhook-event-shapes.mjs --check  fail if they're stale (CI)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OPENAPI = join(ROOT, 'packages/api/openapi.json');
export const OUT = join(ROOT, 'packages/sdk/src/webhook-event-shapes.generated.ts');

/** Keywords that say nothing a receiver checks; so does any `x-…` extension. */
const IGNORED = new Set([
  'description',
  'title',
  'examples',
  'example',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
]);
const ignored = (key) => IGNORED.has(key) || key.startsWith('x-');
const KNOWN = {
  string: ['type', 'enum', 'const', 'format', 'minLength', 'maxLength', 'pattern'],
  number: ['type', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'],
  integer: ['type', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'],
  boolean: ['type'],
  array: ['type', 'items', 'minItems', 'maxItems'],
  // `additionalProperties`: a field the schema doesn't name is allowed either way (see above).
  object: ['type', 'properties', 'required', 'additionalProperties'],
};
const FORMATS = new Set(['uuid', 'date-time']);

/** The shape of every event `WebhookEvent` names, by its `type`. */
export function shapesOf(openapi) {
  const schemas = openapi.components?.schemas ?? {};
  const root = schemas.WebhookEvent;
  if (root === undefined) throw new Error('openapi.json has no components.schemas.WebhookEvent');
  const union = shapeOf(root, schemas, 'WebhookEvent');
  if (union.kind !== 'union' || union.discriminator !== 'type') {
    throw new Error('WebhookEvent must be a oneOf with a `type` discriminator');
  }
  return union.variants;
}

function shapeOf(schema, schemas, path) {
  if (schema.$ref !== undefined) {
    const name = schema.$ref.replace('#/components/schemas/', '');
    const target = schemas[name];
    if (target === undefined) throw new Error(`${path}: $ref to ${name}, which isn't defined`);
    return shapeOf(target, schemas, name);
  }
  if (schema.oneOf !== undefined) return unionOf(schema, schemas, path);
  const { kind, nullable } = typeOf(schema, path);
  const shape = { kind, ...(nullable && { nullable: true }) };
  if (kind === 'string') return stringShape(shape, schema, path);
  if (kind === 'number' || kind === 'integer') return copy(shape, schema, KNOWN[kind].slice(1));
  if (kind === 'array') {
    return {
      ...copy(shape, schema, ['minItems', 'maxItems']),
      ...(schema.items !== undefined && { items: shapeOf(schema.items, schemas, `${path}[]`) }),
    };
  }
  if (kind === 'object') return objectShape(shape, schema, schemas, path);
  return shape;
}

/** The schema's one type besides `null`, refusing a keyword the checker doesn't read for it. */
function typeOf(schema, path) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const kinds = types.filter((t) => t !== 'null');
  const kind = kinds[0];
  if (kinds.length !== 1 || KNOWN[kind] === undefined) {
    throw new Error(`${path}: type ${JSON.stringify(schema.type)} isn't one the checker reads`);
  }
  const unread = Object.keys(schema).find((k) => !ignored(k) && !KNOWN[kind].includes(k));
  if (unread !== undefined) {
    throw new Error(`${path}: "${unread}" on a ${kind} isn't a keyword the checker reads`);
  }
  return { kind, nullable: types.includes('null') };
}

function stringShape(shape, schema, path) {
  if (schema.format !== undefined && !FORMATS.has(schema.format)) {
    throw new Error(`${path}: format "${schema.format}" isn't one the checker reads`);
  }
  if (schema.pattern !== undefined) {
    // As the checker compiles it (Unicode), so a pattern it can't run fails here, not in parseEvent.
    try {
      new RegExp(schema.pattern, 'u');
    } catch (cause) {
      throw new Error(`${path}: pattern ${schema.pattern} doesn't compile: ${cause.message}`);
    }
  }
  const values = schema.const !== undefined ? [schema.const] : schema.enum;
  return {
    ...copy(shape, schema, ['format', 'minLength', 'maxLength', 'pattern']),
    ...(values !== undefined && { enum: values }),
  };
}

function objectShape(shape, schema, schemas, path) {
  const required = new Set(schema.required ?? []);
  const fields = (want) =>
    Object.entries(schema.properties ?? {})
      .filter(([name]) => required.has(name) === want)
      .map(([name, field]) => [name, shapeOf(field, schemas, `${path}.${name}`)]);
  for (const name of required) {
    if (schema.properties?.[name] === undefined) {
      throw new Error(`${path}: "${name}" is required but has no property schema`);
    }
  }
  const req = fields(true);
  const opt = fields(false);
  return {
    ...shape,
    ...(req.length > 0 && { required: Object.fromEntries(req) }),
    ...(opt.length > 0 && { optional: Object.fromEntries(opt) }),
  };
}

/** A `oneOf` the checker can pick from by one property: its discriminator. */
function unionOf(schema, schemas, path) {
  const property = schema.discriminator?.propertyName;
  if (property === undefined) throw new Error(`${path}: a oneOf without a discriminator`);
  const variants = {};
  const mapping = schema.discriminator.mapping;
  for (const option of schema.oneOf) {
    const variant = shapeOf(option, schemas, path);
    const tag =
      mapping !== undefined
        ? Object.keys(mapping).find((k) => mapping[k] === option.$ref)
        : variant.required?.[property]?.enum?.length === 1
          ? variant.required[property].enum[0]
          : undefined;
    if (tag === undefined) throw new Error(`${path}: a variant with no single "${property}" value`);
    variants[tag] = variant;
  }
  return { kind: 'union', discriminator: property, variants };
}

function copy(shape, schema, keys) {
  const out = { ...shape };
  for (const key of keys) if (schema[key] !== undefined) out[key] = schema[key];
  return out;
}

/** The generated module, formatted as the repository formats TypeScript (Biome). */
export function render(shapes) {
  const source = `// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Generated by scripts/gen-webhook-event-shapes.mjs from packages/api/openapi.json (WebhookEvent).
// Don't edit: run \`pnpm run gen:webhook-shapes\`. CI checks it's current (\`check:webhook-shapes\`).

import type { WebhookEvent } from '@kindgi/client';

import type { EventShape } from './webhook-events.js';

/** Each event \`type\` the API sends, and its shape. */
export const WEBHOOK_EVENT_SHAPES = ${JSON.stringify(shapes, null, 2)} as const satisfies Readonly<
  Record<WebhookEvent['type'], EventShape>
>;
`;
  return execFileSync(
    'pnpm',
    ['exec', 'biome', 'format', `--stdin-file-path=${relative(ROOT, OUT)}`],
    {
      cwd: ROOT,
      input: source,
      encoding: 'utf8',
    },
  );
}

function main(argv) {
  const expected = render(shapesOf(JSON.parse(readFileSync(OPENAPI, 'utf8'))));
  if (argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUT, 'utf8');
    } catch {
      // Not written yet: stale.
    }
    if (current !== expected) {
      console.error(
        `${relative(ROOT, OUT)} is stale: packages/api/openapi.json's webhook events changed. Run: pnpm run gen:webhook-shapes`,
      );
      process.exit(1);
    }
    console.log(`Webhook event shapes current (${relative(ROOT, OUT)}).`);
    return;
  }
  writeFileSync(OUT, expected);
  console.log(`Wrote ${relative(ROOT, OUT)}.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
