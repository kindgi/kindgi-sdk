// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * The JSON Schemas reference, from `@kindgi/specs`: one page per schema
 * (the pack index, the pack protocol, flows, tools, …) with every field,
 * its type, whether it's required and what it means. `$ref`s to the
 * schema's own `$defs` link to their section on the same page.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const SCHEMAS = join(dirname(require.resolve('@kindgi/specs/package.json')), 'schemas');

/** Prose from a schema description: `<`/`>` escaped outside code. */
function prose(text) {
  if (!text) return '';
  return text
    .split(/(`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/</g, '&lt;').replace(/>/g, '&gt;')))
    .join('');
}

/** A heading's anchor, as Starlight makes it: lowercase, dashes. */
function anchor(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function refName(ref) {
  return ref.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length) : undefined;
}

/** A schema's type, in words, with links to definitions on the page. */
function typeOf(schema) {
  if (schema === true || schema === undefined) return 'any';
  if (schema.$ref) {
    const name = refName(schema.$ref);
    return name ? `[${name}](#${anchor(name)})` : `\`${schema.$ref}\``;
  }
  if (schema.const !== undefined) return `\`${JSON.stringify(schema.const)}\``;
  if (schema.enum) return schema.enum.map((v) => `\`${JSON.stringify(v)}\``).join(' \\| ');
  for (const key of ['oneOf', 'anyOf']) {
    if (schema[key]) return schema[key].map(typeOf).join(' or ');
  }
  if (schema.allOf) return schema.allOf.map(typeOf).join(' and ');
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const words = types.map((type) => {
    if (type === 'array') return `array of ${schema.items ? typeOf(schema.items) : 'any'}`;
    if (type === 'object' && schema.additionalProperties && !schema.properties) {
      return `map of ${typeOf(schema.additionalProperties)}`;
    }
    return type;
  });
  const format = schema.format ? ` (${schema.format})` : '';
  return (words.join(' or ') || 'object') + format;
}

/** Nested object fields to render under a field, if it has its own. */
function nestedObject(schema) {
  if (!schema || schema.$ref) return undefined;
  if (schema.properties) return schema;
  if (schema.type === 'array' && schema.items?.properties) return schema.items;
  return undefined;
}

function fields(schema, indent = '') {
  const required = new Set(schema.required ?? []);
  const lines = [];
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    const marks = [typeOf(field), required.has(name) ? 'required' : undefined]
      .filter(Boolean)
      .join(', ');
    const description = field.description ? `: ${prose(field.description)}` : '';
    lines.push(`${indent}- \`${name}\` (${marks})${description}`);
    const nested = nestedObject(field);
    if (nested) lines.push(...fields(nested, `${indent}  `));
  }
  return lines;
}

function section(schema, heading) {
  const lines = [];
  if (heading) lines.push(heading, '');
  if (schema.description) lines.push(prose(schema.description), '');
  if (schema.properties) {
    lines.push(...fields(schema), '');
  } else {
    lines.push(`Type: ${typeOf(schema)}`, '');
  }
  return lines;
}

function page(file) {
  const schema = JSON.parse(readFileSync(join(SCHEMAS, file), 'utf8'));
  const slug = file.replace(/\.schema\.json$/, '');
  const version = /schema-version:\s*([\d.]+)/.exec(schema.$comment ?? '')?.[1];
  const title = schema.title ?? slug;
  const summary = (schema.description ?? title).split(/(?<=\.)\s/)[0];
  const lines = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(summary.replace(/`/g, ''))}`,
    '---',
    '',
    `\`@kindgi/specs/${file}\`${version ? `, schema version ${version}` : ''}.`,
    '',
    ...section({ ...schema, title: undefined }),
  ];
  const defs = Object.entries(schema.$defs ?? {});
  if (defs.length > 0) {
    lines.push('## Definitions', '');
    for (const [name, def] of defs) lines.push(...section(def, `### ${name}`));
  }
  return { slug: `reference/schemas/${slug}`, content: `${lines.join('\n').trimEnd()}\n` };
}

export function schemaPages() {
  const files = readdirSync(SCHEMAS)
    .filter((f) => f.endsWith('.schema.json'))
    .sort();
  const pages = files.map(page);
  const overview = [
    '---',
    'title: JSON Schemas',
    'description: The JSON Schemas of Kindgi documents (packs, flows, tools, events, the pack protocol).',
    'sidebar:',
    '  order: 0',
    '  label: Overview',
    '---',
    '',
    'The shapes Kindgi reads and writes, as JSON Schema (draft 2020-12), from',
    '`@kindgi/specs`. Validate against them with any JSON Schema validator; each',
    'is also importable as `@kindgi/specs/<name>.schema.json`.',
    '',
    ...files.map((f) => {
      const slug = f.replace(/\.schema\.json$/, '');
      const title = JSON.parse(readFileSync(join(SCHEMAS, f), 'utf8')).title ?? slug;
      return `- [${title}](${slug}/): \`${f}\``;
    }),
    '',
  ];
  return [{ slug: 'reference/schemas/index', content: overview.join('\n') }, ...pages];
}
