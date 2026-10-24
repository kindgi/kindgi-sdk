#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * Fails the docs build when the reference doesn't cover everything Kindgi
 * has: every CLI command, every HTTP API operation, every environment
 * variable and every error code needs an entry in the reference layout
 * (synopsis, description, options with their defaults, examples, see
 * also). The lists come from Kindgi's own sources, as the generator's do;
 * the gaps are listed by `reference/completeness.mjs`.
 *
 * Runs after `generate-reference.mjs`, and also checks that its pages hold
 * an entry for each item. Needs the workspace built (`pnpm run build`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeGlobalFlags } from '@kindgi/cli';
import { ENV_GROUPS, KINDGI_ENV_SCHEMA } from '@kindgi/env-schema';

import { API_SEE_ALSO, apiOperations, apiSeeAlso } from './reference/api-see-also.mjs';
import { allCommands, examples, flagDefault, seeAlso } from './reference/cli.mjs';
import { completenessInput } from './reference/completeness-input.mjs';
import { referenceGaps } from './reference/completeness.mjs';
import * as CLI from './reference/entries/cli.mjs';
import * as ENV from './reference/entries/env-vars.mjs';
import { ACCESS_ERRORS, ERROR_ENTRIES, OUTSIDE_THE_MAP } from './reference/entries/errors.mjs';
import { envDefault, envExample, envSeeAlso } from './reference/env-vars.mjs';
import {
  apiSpec,
  codeSeeAlso,
  errorCodeMap,
  extraLinks,
  operationsByCode,
} from './reference/errors.mjs';
import { collectMentions, handWrittenPages, headingId } from './reference/mentions.mjs';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(site, 'src', 'content', 'docs');

const guides = handWrittenPages(docs);
const pagesBySlug = new Map(guides.map((page) => [page.slug, page]));
const commands = allCommands();
const mentions = collectMentions(
  guides,
  commands.map((command) => command.path.join(' ')),
);
const map = await errorCodeMap();
const spec = apiSpec();
const codes = Object.keys(map);
/** The error codes' own "see also" items that link nowhere, as gaps. */
const unlinked = [];

const input = completenessInput({
  commands,
  globalFlags: describeGlobalFlags(),
  envSchema: KINDGI_ENV_SCHEMA,
  envGroupNames: [...Object.keys(ENV_GROUPS), 'other'],
  codes,
  errorEntries: ERROR_ENTRIES,
  operations: apiOperations(spec),
  apiSeeAlso: apiSeeAlso(spec, mentions, codes),
  cliEntries: CLI,
  envEntries: ENV,
  parts: {
    flagDefault,
    commandExamples: (command) => {
      const { written, fromGuides } = examples(command, mentions);
      return written.length + fromGuides.length;
    },
    commandSeeAlso: (command, slug) => seeAlso(command, mentions, pagesBySlug, slug).length,
    envDefault,
    envExample,
    envSeeAlso: (variable) => envSeeAlso(variable, mentions, pagesBySlug).length,
    codeSeeAlso: (code) => {
      try {
        return codeSeeAlso(code, {
          operations: operationsByCode(spec, codes),
          mentions,
          pagesBySlug,
          spec,
        }).length;
      } catch (error) {
        // The gap is the item it can't link, not a missing "see also".
        unlinked.push(error.message);
        return undefined;
      }
    },
  },
});
const gaps = [...referenceGaps(input), ...unlinked];

// The two hand-written lists: codes outside the map, and access.kindgi.com's.
const topCommands = new Set(commands.filter((c) => c.path.length === 1).map((c) => c.name));
for (const entry of [...OUTSIDE_THE_MAP, ...ACCESS_ERRORS.errors]) {
  const name = entry.code ?? `access.kindgi.com ${entry.error}`;
  if (!entry.description) gaps.push(`${name}: no description`);
  if (!entry.status) gaps.push(`${name}: no status`);
  // extraLinks refuses a route, a code or a page that doesn't exist; a command it doesn't check.
  const missing = (entry.seeAlso ?? []).filter((item) => {
    const command = item.match(/^reference\/cli\/([a-z-]+)$/)?.[1];
    return command && !topCommands.has(command);
  });
  for (const item of missing) gaps.push(`${name}: "see also" names ${item}, which doesn't exist`);
  try {
    if (extraLinks(entry.seeAlso, { pagesBySlug, spec }, name).length === 0) {
      gaps.push(`${name}: no "see also"`);
    }
  } catch (error) {
    gaps.push(error.message);
  }
}
if (!ACCESS_ERRORS.intro) gaps.push('access.kindgi.com: no introduction');

// The generator's pages hold an entry for each item.
const read = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};
/** A generated page's Markdown, by its slug. */
const page = (slug) => read(join(docs, `${slug}.md`));
const ids = (markdown) =>
  new Set([...markdown.matchAll(/^#{2,4} (.+)$/gm)].map((m) => headingId(m[1].replace(/`/g, ''))));
const cliIds = new Map();
for (const command of commands.filter((c) => c.path.length === 1)) {
  cliIds.set(command.name, ids(page(`reference/cli/${command.name}`)));
}
for (const command of commands) {
  const name = `kindgi ${command.path.join(' ')}`;
  if (!cliIds.get(command.path[0])?.has(headingId(name)))
    gaps.push(`${name}: no entry on its page`);
}
const envIds = ids(page('reference/env-vars'));
for (const variable of KINDGI_ENV_SCHEMA) {
  if (!envIds.has(headingId(variable.name))) gaps.push(`${variable.name}: no entry on its page`);
}
const errorIds = ids(page('reference/errors'));
for (const code of codes) {
  if (!errorIds.has(headingId(code))) gaps.push(`error code ${code}: no entry on its page`);
}
const written = JSON.parse(read(join(site, API_SEE_ALSO)) || '{}');
for (const operation of apiOperations(spec)) {
  if (!written[operation.slug]?.length) gaps.push(`${operation.slug}: no "see also" generated`);
}

if (gaps.length > 0) {
  console.error(`check-reference: ${gaps.length} gaps in the reference:`);
  for (const gap of gaps) console.error(`- ${gap}`);
  console.error(
    'Write the missing parts in site/scripts/reference/entries/, then run `node scripts/generate-reference.mjs`.',
  );
  process.exit(1);
}
console.log(
  `check-reference: ${commands.length} commands, ${input.operations.length} operations, ` +
    `${input.envVars.length} variables and ${codes.length} error codes, each with every part.`,
);
