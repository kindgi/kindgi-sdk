// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * The HTTP API reference's input: `packages/api/openapi.json` with its tags
 * given display names ("signing-keys" → "Signing keys"), which the sidebar
 * and the pages show. Everything else is the spec as it is. The API's own
 * spec keeps its tag names: they're part of its contract.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Words that keep their own casing in a display name. */
const WORDS = { api: 'API', mcp: 'MCP', sse: 'SSE', id: 'ID', ids: 'IDs' };

export function displayName(tag) {
  return tag
    .split('-')
    .map((word, i) => WORDS[word] ?? (i === 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** Writes the docs copy of the spec to `outFile`; returns the tag count. */
export function writeOpenApiForDocs(specFile, outFile) {
  const spec = JSON.parse(readFileSync(specFile, 'utf8'));
  const rename = new Map((spec.tags ?? []).map((tag) => [tag.name, displayName(tag.name)]));
  spec.tags = (spec.tags ?? []).map((tag) => ({ ...tag, name: rename.get(tag.name) }));
  for (const path of Object.values(spec.paths ?? {})) {
    for (const operation of Object.values(path)) {
      if (operation && Array.isArray(operation.tags)) {
        operation.tags = operation.tags.map((name) => rename.get(name) ?? displayName(name));
      }
    }
  }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(spec, null, 2)}\n`);
  return rename.size;
}

export const OPENAPI_FOR_DOCS = join('generated', 'openapi.json');
