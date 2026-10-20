// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * The error codes reference: every `code` the HTTP API answers with, from
 * the API's own map of codes to statuses (`ERROR_CODE_TO_STATUS`, read from
 * the built `packages/api`), grouped by status.
 *
 * Each code's entry has the reference layout: synopsis (status and code),
 * description, the keys of its `details`, an example body, see also. The
 * description and the details are written in `entries/errors.mjs`. "See
 * also" is the operations whose documented responses name the code, the
 * guides that name it, and any pages its entry adds.
 *
 * Two more lists, written in `entries/errors.mjs`: the codes a response
 * can carry that aren't in the map (each its own status), and the errors
 * of access.kindgi.com, which answers in its own shape.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ACCESS_ERRORS, ERROR_ENTRIES, OUTSIDE_THE_MAP } from './entries/errors.mjs';
import { SLUG as ENV_VARS_SLUG, TITLE as ENV_VARS_TITLE } from './env-vars.mjs';
import { distinctPages, linkTo } from './mentions.mjs';
import { operationSlug } from './openapi.mjs';

export const SLUG = 'reference/errors';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** At most this many operations and guides in a code's "see also". */
const OPERATION_LINKS = 6;
const GUIDE_LINKS = 3;

const STATUS_NAMES = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  423: 'Locked',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/** The API's map of error codes to statuses, from the built `packages/api`. */
export async function errorCodeMap() {
  const errors = join(ROOT, 'packages', 'api', 'dist', 'errors.js');
  const { ERROR_CODE_TO_STATUS } = await import(pathToFileURL(errors).href);
  return ERROR_CODE_TO_STATUS;
}

/** The API spec, as the docs read it. */
export function apiSpec() {
  return JSON.parse(readFileSync(join(ROOT, 'packages', 'api', 'openapi.json'), 'utf8'));
}

/** Each code's operations: the ones whose documented responses name it in a code span. */
export function operationsByCode(spec, codes) {
  const byCode = new Map(codes.map((code) => [code, []]));
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (!operation?.responses || !operation.operationId) continue;
      const named = new Set();
      for (const response of Object.values(operation.responses)) {
        for (const match of (response?.description ?? '').matchAll(/`([a-z0-9-]+)`/g)) {
          named.add(match[1]);
        }
      }
      for (const code of named) {
        byCode.get(code)?.push({ method: method.toUpperCase(), path, id: operation.operationId });
      }
    }
  }
  return byCode;
}

function statusLine(status) {
  return `${status} ${STATUS_NAMES[status] ?? ''}`.trim();
}

/** JSON on one line, spaced as people write it: `{ "error": { "code": "…" } }`. */
function compactJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const inner = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${compactJson(v)}`);
  return `{ ${inner.join(', ')} }`;
}

/** The example body: the envelope with this code, and its details' keys. */
function exampleBody(code, details) {
  const error = { code, message: '…' };
  if (details.length > 0) error.details = Object.fromEntries(details.map((d) => [d.key, '…']));
  error.requestId = '…';
  return compactJson({ error });
}

/** The page links for a route like `POST /v1/runs`, or undefined when the spec has no such operation. */
function routeLink(route, spec) {
  const [method, path] = route.split(' ');
  const operation = spec.paths?.[path]?.[method.toLowerCase()];
  if (!operation?.operationId) return undefined;
  return `[\`${route}\`](${linkTo(SLUG, `reference/api/operations/${operationSlug(operation.operationId)}`)})`;
}

export function codeSeeAlso(code, context) {
  const { operations, mentions, spec } = context;
  const links = [];
  const ops = operations.get(code) ?? [];
  for (const op of ops.slice(0, OPERATION_LINKS)) {
    links.push(routeLink(`${op.method} ${op.path}`, spec));
  }
  if (ops.length > OPERATION_LINKS) {
    links.push(`${ops.length - OPERATION_LINKS} more operations name it in their responses`);
  }
  for (const page of distinctPages(mentions.codeSpans.get(code), GUIDE_LINKS)) {
    links.push(`[${page.title}](${linkTo(SLUG, page.slug)})`);
  }
  links.push(...extraLinks(ERROR_ENTRIES[code]?.seeAlso, context, code));
  return links.filter(Boolean);
}

/**
 * The codes a `#code` item can link: the written entries' (the reference
 * check holds them to the API's map, whose codes each have an entry here)
 * and the codes outside the map.
 */
const CODES_ON_PAGE = new Set([
  ...Object.keys(ERROR_ENTRIES),
  ...OUTSIDE_THE_MAP.map((entry) => entry.code),
]);

/**
 * Links for an entry's own "see also": routes (`POST /v1/runs`), `#code` on
 * this page, CLI commands, the environment variables reference, and the
 * hand-written pages' slugs. An item that is none of these (a route the spec
 * doesn't have, a code with no entry here, a slug no page has) stops the
 * generation, naming `name` (the entry) and the item, rather than dropping
 * out of the list unseen.
 */
export function extraLinks(list, { pagesBySlug, spec }, name) {
  return (list ?? []).map((item) => {
    const link = extraLink(item, pagesBySlug, spec);
    if (!link) {
      throw new Error(
        `${name}: "see also" names ${item}, which is no route in the spec, no code on this page and no page`,
      );
    }
    return link;
  });
}

function extraLink(item, pagesBySlug, spec) {
  if (/^(GET|POST|PUT|PATCH|DELETE) \//.test(item)) return routeLink(item, spec);
  if (item.startsWith('#')) {
    return CODES_ON_PAGE.has(item.slice(1)) ? `[\`${item.slice(1)}\`](${item})` : undefined;
  }
  const command = item.match(/^reference\/cli\/([a-z-]+)$/)?.[1];
  if (command) return `[\`kindgi ${command}\`](${linkTo(SLUG, item)})`;
  if (item === ENV_VARS_SLUG) return `[${ENV_VARS_TITLE}](${linkTo(SLUG, item)})`;
  const page = pagesBySlug.get(item);
  return page ? `[${page.title}](${linkTo(SLUG, item)})` : undefined;
}

function codeEntry(code, status, context) {
  const entry = ERROR_ENTRIES[code] ?? {};
  const details = entry.details ?? [];
  const lines = [`### \`${code}\``, ''];
  lines.push('**Synopsis**', '', `\`${statusLine(status)}\`, code \`${code}\``, '');
  lines.push(entry.description ?? '', '');
  lines.push('**Details**', '');
  if (details.length === 0) lines.push('None.', '');
  else {
    for (const detail of details) lines.push(`- \`${detail.key}\`: ${detail.meaning}`);
    lines.push('');
  }
  lines.push('**Example**', '', '```json', exampleBody(code, details), '```', '');
  lines.push('**See also**', '');
  for (const link of codeSeeAlso(code, context)) lines.push(`- ${link}`);
  lines.push('');
  return lines.join('\n');
}

export async function errorsPage({ mentions, pages }) {
  const map = await errorCodeMap();
  const spec = apiSpec();
  const codes = Object.keys(map);
  const context = {
    operations: operationsByCode(spec, codes),
    mentions,
    pagesBySlug: new Map(pages.map((page) => [page.slug, page])),
    spec,
  };
  const statuses = [...new Set(Object.values(map))].sort((a, b) => a - b);
  const out = [
    '---',
    'title: Error codes',
    'description: Every error code the HTTP API answers with, its status, what it means and what its details hold.',
    '---',
    '',
    'When the API refuses a request, the response body is an error envelope:',
    '',
    '```json',
    '{',
    '  "error": {',
    '    "code": "agent-not-found",',
    '    "message": "…",',
    '    "requestId": "…"',
    '  }',
    '}',
    '```',
    '',
    '- `code` says what went wrong. Match on it: it stays the same, while',
    '  `message` is written for people and can change.',
    '- `details`, when present, holds the facts the code needs: a limit, the',
    '  field at fault, when to retry.',
    "- `requestId` identifies the request in the runtime's logs. Quote it when",
    '  you report a problem.',
    '',
    'The TypeScript and Python clients raise these as typed errors with the',
    'same `code`. The codes below are grouped by their HTTP status.',
    '',
  ];
  for (const status of statuses) {
    out.push(`## ${statusLine(status)}`, '');
    for (const code of codes.filter((c) => map[c] === status).sort()) {
      out.push(codeEntry(code, status, context));
    }
  }
  out.push(...outsideTheMapSection(context), ...accessSection(context));
  return { slug: SLUG, content: `${out.join('\n').trimEnd()}\n` };
}

function outsideTheMapSection(context) {
  const lines = [
    '## Codes with their own status',
    '',
    "These come from parts of a deployment that answer outside the API's",
    'routes: the build service, the console under `kindgi dev`, and sign-in.',
    'Each has the status shown, and the envelope without `requestId`.',
    '',
  ];
  for (const entry of OUTSIDE_THE_MAP) {
    lines.push(`### \`${entry.code}\``, '');
    lines.push('**Synopsis**', '', `\`${statusLine(entry.status)}\`, code \`${entry.code}\``, '');
    lines.push(entry.description, '');
    lines.push('**Details**', '', 'None.', '');
    const body = compactJson({ error: { code: entry.code, message: '…' } });
    lines.push('**Example**', '', '```json', body, '```', '');
    lines.push('**See also**', '');
    for (const link of extraLinks(entry.seeAlso, context, entry.code)) lines.push(`- ${link}`);
    lines.push('');
  }
  return lines;
}

function accessSection(context) {
  const lines = [
    '## access.kindgi.com',
    '',
    ACCESS_ERRORS.intro,
    '',
    '```json',
    '{ "error": "unavailable", "message": "…" }',
    '```',
    '',
  ];
  for (const entry of ACCESS_ERRORS.errors) {
    lines.push(`### \`${entry.error}\``, '');
    lines.push('**Synopsis**', '', `\`${statusLine(entry.status)}\`, error \`${entry.error}\``, '');
    lines.push(entry.description, '');
    lines.push('**Details**', '', 'None: the body has `error` and `message` only.', '');
    lines.push(
      '**Example**',
      '',
      '```json',
      compactJson({ error: entry.error, message: '…' }),
      '```',
      '',
    );
    lines.push('**See also**', '');
    for (const link of extraLinks(entry.seeAlso, context, `access.kindgi.com ${entry.error}`)) {
      lines.push(`- ${link}`);
    }
    lines.push('');
  }
  return lines;
}
