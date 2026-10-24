// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * "See also" for each HTTP API operation page, which starlight-openapi
 * renders from the spec: the operations on the same resource, the guides
 * that name the route, and the error codes its responses name.
 * `src/components/MarkdownContent.astro` puts it at the end of the page.
 *
 * Written to `generated/api-see-also.json`, keyed by the page's slug
 * (`reference/api/operations/agentsget`). Each link is `{ html, href }`,
 * `href` relative to the page.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { SLUG as ERRORS_SLUG, operationsByCode } from './errors.mjs';
import { distinctPages, linkTo } from './mentions.mjs';
import { operationSlug } from './openapi.mjs';

export const API_SEE_ALSO = 'generated/api-see-also.json';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
/** At most this many neighbouring operations and guides. */
const NEIGHBOURS = 4;
const GUIDE_LINKS = 3;

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Every operation in the spec: method, path, id, its page's slug. */
export function apiOperations(spec) {
  const operations = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation?.operationId) continue;
      operations.push({
        method: method.toUpperCase(),
        path,
        id: operation.operationId,
        summary: operation.summary ?? operation.operationId,
        slug: `reference/api/operations/${operationSlug(operation.operationId)}`,
      });
    }
  }
  return operations;
}

/** The resource a path is about: `/v1/agents/{agentId}/versions` → `/v1/agents/{agentId}`. */
function resourceOf(path) {
  return path.split('/').slice(0, 4).join('/');
}

/** "See also" for every operation, keyed by its page's slug. */
export function apiSeeAlso(spec, mentions, codes) {
  const operations = apiOperations(spec);
  const byCode = operationsByCode(spec, codes);
  const codesById = new Map();
  for (const [code, ops] of byCode) {
    for (const op of ops) {
      if (!codesById.has(op.id)) codesById.set(op.id, []);
      codesById.get(op.id).push(code);
    }
  }
  const out = {};
  for (const op of operations) {
    const links = [];
    const neighbours = [
      ...operations.filter((o) => o !== op && o.path === op.path),
      ...operations.filter((o) => o.path !== op.path && resourceOf(o.path) === resourceOf(op.path)),
    ].slice(0, NEIGHBOURS);
    for (const n of neighbours) {
      links.push({
        html: `<code>${escapeHtml(`${n.method} ${n.path}`)}</code>: ${escapeHtml(n.summary)}`,
        href: linkTo(op.slug, n.slug),
      });
    }
    const route = `${op.method} ${op.path}`;
    for (const page of distinctPages(mentions.routes.get(route), GUIDE_LINKS)) {
      links.push({ html: escapeHtml(page.title), href: linkTo(op.slug, page.slug) });
    }
    for (const code of (codesById.get(op.id) ?? []).sort()) {
      links.push({
        html: `Error code <code>${escapeHtml(code)}</code>`,
        href: linkTo(op.slug, ERRORS_SLUG, code),
      });
    }
    links.push({ html: 'Every error code', href: linkTo(op.slug, ERRORS_SLUG) });
    out[op.slug] = links;
  }
  return out;
}

export function writeApiSeeAlso(file, seeAlso) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(seeAlso, null, 2)}\n`);
}
