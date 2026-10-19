// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { referenceGaps } from './reference/completeness.mjs';
import { extraLinks } from './reference/errors.mjs';
import { commandOf, headingId, linkTo } from './reference/mentions.mjs';
import { operationSlug } from './reference/openapi.mjs';
import { markFragments } from './reference/packages.mjs';
import { commentCode, markSignatures } from './reference/typedoc-signatures.mjs';

/** A reference with nothing missing: one group, one command, one of everything. */
function complete() {
  return {
    commands: [
      { path: 'runs', runnable: false, description: 'Runs.', flags: [], examples: 0, seeAlso: 1 },
      {
        path: 'runs list',
        runnable: true,
        usage: 'kindgi runs list [--limit=<n>]',
        description: 'List runs.',
        flags: [{ name: 'limit', type: 'string', default: '`25`' }],
        examples: 1,
        seeAlso: 1,
      },
    ],
    globalFlags: [{ name: 'url', type: 'string', default: '`KINDGI_API_URL`' }],
    envVars: [
      { name: 'KINDGI_PORT', description: 'Port.', default: '`4000`', example: '8080', seeAlso: 1 },
    ],
    errorCodes: [{ code: 'run-not-found', description: 'No run.', details: [], seeAlso: 1 }],
    operations: [{ slug: 'reference/api/operations/runslist', seeAlso: 2 }],
    entries: {
      cliDefaults: ['runs list limit'],
      cliExamples: ['runs list'],
      cliGroups: ['runs'],
      globalDefaults: ['url'],
      envDefaults: ['KINDGI_PORT'],
      envExamples: [],
      envGroups: ['core'],
      errors: ['run-not-found'],
    },
    envGroupNames: ['core', 'other'],
  };
}

test('a complete reference has no gaps', () => {
  assert.deepEqual(referenceGaps(complete()), []);
});

test('each missing part of a command is a gap; a group needs no example', () => {
  const input = complete();
  input.commands[1] = {
    ...input.commands[1],
    usage: undefined,
    flags: [{ name: 'limit', type: 'string' }],
    examples: 0,
    seeAlso: 0,
  };
  assert.deepEqual(referenceGaps(input), [
    'kindgi runs list: no synopsis (usage)',
    'kindgi runs list --limit: no default stated',
    'kindgi runs list: no example',
    'kindgi runs list: no "see also"',
  ]);
});

test('a variable, an error code or an operation missing a part is a gap', () => {
  const input = complete();
  input.globalFlags = [{ name: 'url', type: 'string' }];
  input.envVars = [{ name: 'KINDGI_PORT', description: '', seeAlso: 0 }];
  input.errorCodes = [{ code: 'run-not-found', seeAlso: 0 }];
  input.operations = [{ slug: 'reference/api/operations/runslist', seeAlso: 0 }];
  assert.deepEqual(referenceGaps(input), [
    'global flag --url: no default stated',
    'KINDGI_PORT: no description',
    'KINDGI_PORT: no default stated',
    'KINDGI_PORT: no example',
    'KINDGI_PORT: no "see also"',
    'error code run-not-found: no description',
    'error code run-not-found: details not stated',
    'error code run-not-found: no "see also"',
    'reference/api/operations/runslist: no "see also"',
  ]);
});

test('an entry for something that is gone is a gap', () => {
  const input = complete();
  input.entries = {
    cliDefaults: ['runs list limit', 'runs list status'],
    cliExamples: ['runs list', 'runs', 'runs purge'],
    cliGroups: ['runs', 'jobs'],
    globalDefaults: ['url', 'verbose-ish'],
    envDefaults: ['KINDGI_PORT', 'KINDGI_OLD'],
    envExamples: ['KINDGI_GONE'],
    envGroups: ['core', 'mainframe'],
    errors: ['run-not-found', 'run-vanished'],
  };
  assert.deepEqual(referenceGaps(input), [
    "flag default runs list status: an entry for something that's gone",
    "example for runs: an entry for something that's gone",
    "example for runs purge: an entry for something that's gone",
    `"see also" for command group jobs: an entry for something that's gone`,
    "global flag default verbose-ish: an entry for something that's gone",
    "default for KINDGI_OLD: an entry for something that's gone",
    "example for KINDGI_GONE: an entry for something that's gone",
    `"see also" for env group mainframe: an entry for something that's gone`,
    "error code run-vanished: an entry for something that's gone",
  ]);
});

test('linkTo is relative to the page as it is served', () => {
  assert.equal(
    linkTo('reference/cli/runs', 'guides/runs/start-a-run'),
    '../../../guides/runs/start-a-run/',
  );
  assert.equal(
    linkTo('reference/cli/runs', 'reference/cli/index', 'global-flags'),
    '../#global-flags',
  );
  assert.equal(linkTo('reference/errors', 'reference/errors', 'run-not-found'), './#run-not-found');
  assert.equal(
    linkTo('reference/errors', 'reference/api/operations/runsget'),
    '../api/operations/runsget/',
  );
  assert.equal(linkTo('reference/env-vars', 'guides/runs/index'), '../../guides/runs/');
});

test('an error entry\'s own "see also" links each item, or stops naming the one it cannot', () => {
  const context = {
    pagesBySlug: new Map([['guides/runs/start-a-run', { title: 'Start a run' }]]),
    spec: { paths: { '/v1/runs': { get: { operationId: 'runs.list' } } } },
  };
  assert.deepEqual(
    extraLinks(
      [
        'GET /v1/runs',
        '#run-not-found',
        '#build-job-gone',
        'reference/cli/runs',
        'reference/env-vars',
        'guides/runs/start-a-run',
      ],
      context,
      'database-busy',
    ),
    [
      '[`GET /v1/runs`](../api/operations/runslist/)',
      '[`run-not-found`](#run-not-found)',
      '[`build-job-gone`](#build-job-gone)',
      '[`kindgi runs`](../cli/runs/)',
      '[Environment variables](../env-vars/)',
      '[Start a run](../../guides/runs/start-a-run/)',
    ],
  );
  assert.throws(() => extraLinks(['GET /v1/runs', 'guides/gone'], context, 'database-busy'), {
    message:
      'database-busy: "see also" names guides/gone, which is no route in the spec, no code on this page and no page',
  });
  assert.throws(() => extraLinks(['#run-gone'], context, 'database-busy'), {
    message: /^database-busy: "see also" names #run-gone,/,
  });
  assert.throws(() => extraLinks(['DELETE /v1/runs'], context, 'access.kindgi.com unavailable'), {
    message: /^access\.kindgi\.com unavailable: "see also" names DELETE \/v1\/runs,/,
  });
});

test('headingId and operationSlug follow Starlight and starlight-openapi', () => {
  assert.equal(headingId('kindgi agents promote'), 'kindgi-agents-promote');
  assert.equal(headingId('KINDGI_API_URL'), 'kindgi_api_url');
  assert.equal(headingId('run-not-found'), 'run-not-found');
  assert.equal(operationSlug('agents.get'), 'agentsget');
  assert.equal(operationSlug('runs.cancel'), 'runscancel');
});

test('commandOf finds the longest command a line runs', () => {
  const commands = new Set(['agents', 'agents promote', 'runs', 'runs start']);
  assert.equal(
    commandOf('kindgi agents promote acme.order-desk 1.0.0 --tenant', commands),
    'agents promote',
  );
  assert.equal(
    commandOf('$ npx --yes @kindgi/cli runs start --agent=acme.order-desk', commands),
    'runs start',
  );
  assert.equal(commandOf('pnpm exec kindgi runs', commands), 'runs');
  assert.equal(commandOf('kindgi nothing-here', commands), undefined);
  assert.equal(commandOf('echo kindgi runs start', commands), undefined);
});

test("markFragments marks a README's TypeScript fragments, not its whole files", () => {
  const readme = [
    '```ts',
    'client.runs.list();',
    '```',
    '```ts',
    '// src/index.ts',
    "export const id = 'acme.lookup';",
    '```',
    '````md',
    '```ts',
    'inside();',
    '```',
    '````',
    '```sh',
    'npm install @kindgi/sdk',
    '```',
  ].join('\n');
  const marked = markFragments(readme).split('\n');
  assert.equal(marked[0], '```ts excerpt');
  assert.equal(marked[3], '```ts');
  assert.equal(marked[8], '```ts');
  assert.equal(marked[12], '```sh');
});

test("markSignatures fences typedoc's declarations, not the doc comments' code", () => {
  const example =
    "import { createClient } from '@kindgi/sdk/client';\n\nconst kindgi = createClient();";
  const project = {
    reflections: {
      1: {
        comment: {
          summary: [
            { kind: 'text', text: 'Make a client.' },
            { kind: 'code', text: '`createClient()`' },
          ],
          blockTags: [
            { tag: '@example', content: [{ kind: 'code', text: `\`\`\`ts\n${example}\n\`\`\`` }] },
          ],
        },
      },
      2: {},
    },
  };
  const fromComments = commentCode(project);
  assert.deepEqual([...fromComments], [example]);
  const page = [
    '```ts',
    'function createClient(options?): KindgiClient;',
    '```',
    '## Example',
    '```ts',
    example,
    '```',
    '```ts excerpt',
    'kindgi.runs;',
    '```',
    '```json',
    '{}',
    '```',
  ].join('\n');
  const marked = markSignatures(page, fromComments).split('\n');
  assert.equal(marked[0], '```ts signature');
  assert.equal(marked[4], '```ts');
  assert.equal(marked[9], '```ts excerpt');
  assert.equal(marked[12], '```json');
});
