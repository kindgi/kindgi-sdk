// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `scripts/ai-sdk-candidate.mjs`: a candidate is a pinned `@ai-sdk/*`
 * package at a stable version, named once; nothing else gets past
 * `validate`, and `apply` moves only the pin's text.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { adapterPins, applyToManifest, parseCandidates, summarize } from './ai-sdk-candidate.mjs';

const SCRIPT = fileURLToPath(new URL('./ai-sdk-candidate.mjs', import.meta.url));
const ALLOWED = new Set(['@ai-sdk/amazon-bedrock', '@ai-sdk/azure', '@ai-sdk/provider']);

describe('parseCandidates', () => {
  test('pinned packages at stable versions pass', () => {
    assert.deepEqual(
      parseCandidates('@ai-sdk/amazon-bedrock@5.0.120  @ai-sdk/provider@4.1.0', ALLOWED),
      {
        kind: 'ok',
        candidates: [
          { name: '@ai-sdk/amazon-bedrock', version: '5.0.120' },
          { name: '@ai-sdk/provider', version: '4.1.0' },
        ],
      },
    );
  });

  test('pre-releases, ranges, tags, other packages and shell text are refused', () => {
    for (const bad of [
      '@ai-sdk/azure@4.1.0-beta.1',
      '@ai-sdk/azure@^4.1.0',
      '@ai-sdk/azure@latest',
      '@ai-sdk/azure@04.1.0',
      '@ai-sdk/openai@1.0.0',
      'left-pad@1.0.0',
      '@ai-sdk/azure@4.1.0;curl evil.example',
      '$(id)',
      '@ai-sdk/azure@4.1.0`id`',
    ]) {
      const parsed = parseCandidates(bad, ALLOWED);
      assert.equal(parsed.kind, 'err', bad);
    }
  });

  test('a package named twice, none, or too many: refused', () => {
    assert.equal(parseCandidates('@ai-sdk/azure@4.1.0 @ai-sdk/azure@4.1.1', ALLOWED).kind, 'err');
    assert.equal(parseCandidates('   ', ALLOWED).kind, 'err');
    assert.equal(parseCandidates(undefined, ALLOWED).kind, 'err');
    const many = Array.from({ length: 11 }, (_, i) => `@ai-sdk/azure@4.1.${i}`).join(' ');
    assert.equal(parseCandidates(many, ALLOWED).kind, 'err');
  });

  test('a refused token is printed without its control characters', () => {
    const parsed = parseCandidates('@ai-sdk/azure@4.1.0\u001b[31m', ALLOWED);
    assert.equal(parsed.kind, 'err');
    assert.ok(!parsed.problems.join('\n').includes('\u001b'));
  });
});

describe('applyToManifest', () => {
  test("only the pin's text moves; the layout stays", () => {
    const before =
      '{\n  "name": "x",\n  "files": ["dist"],\n  "dependencies": {\n    "@ai-sdk/azure": "4.0.97",\n    "zod": "4.6.5"\n  }\n}\n';
    const after = applyToManifest(before, [{ name: '@ai-sdk/azure', version: '4.1.0' }]);
    assert.equal(after, before.replace('"@ai-sdk/azure": "4.0.97"', '"@ai-sdk/azure": "4.1.0"'));
  });
});

describe('summarize', () => {
  test('a failed test is named; no failure is a pass; no reports, or no tests, is no pass', () => {
    const candidates = [{ name: '@ai-sdk/azure', version: '4.1.0' }];
    const ok = {
      testResults: [
        {
          name: 'a.test.ts',
          status: 'passed',
          assertionResults: [{ status: 'passed', fullName: 't' }],
        },
      ],
    };
    const bad = {
      testResults: [
        {
          name: 'b.test.ts',
          status: 'failed',
          assertionResults: [{ status: 'failed', fullName: 'it breaks' }],
        },
      ],
    };
    assert.deepEqual(summarize(candidates, [ok]), {
      candidates,
      passed: true,
      tests: 1,
      failed: [],
    });
    assert.deepEqual(summarize(candidates, [ok, bad]).failed, [
      { file: 'b.test.ts', test: 'it breaks' },
    ]);
    assert.equal(summarize(candidates, []).passed, false);
    assert.equal(
      summarize(candidates, [
        { testResults: [{ name: 'a.test.ts', status: 'passed', assertionResults: [] }] },
      ]).passed,
      false,
    );
  });
});

describe('the script on a repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdk-candidate-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = (deps) => `${JSON.stringify({ name: 'a', dependencies: deps }, null, 2)}\n`;
  mkdirSync(join(root, 'packages', 'adapters', 'model-azure'), { recursive: true });
  mkdirSync(join(root, 'packages', 'adapters', 'model-plain'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'adapters', 'model-azure', 'package.json'),
    manifest({ '@ai-sdk/azure': '4.0.97' }),
  );
  writeFileSync(
    join(root, 'packages', 'adapters', 'model-plain', 'package.json'),
    manifest({ zod: '4.6.5' }),
  );

  const run = (command, candidates, requestId) =>
    spawnSync(process.execPath, [SCRIPT, command], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        CANDIDATES: candidates,
        ...(requestId !== undefined && { REQUEST_ID: requestId }),
      },
      encoding: 'utf8',
    });

  test('the pins are read from the adapters', () => {
    assert.deepEqual(
      adapterPins(root).map((p) => p.pins),
      [{ '@ai-sdk/azure': '4.0.97' }],
    );
  });

  test('validate refuses an unpinned package, and apply changes nothing then', () => {
    const r = run('apply', '@ai-sdk/openai@1.0.0');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /isn't pinned by a model adapter/);
    assert.match(
      readFileSync(join(root, 'packages', 'adapters', 'model-azure', 'package.json'), 'utf8'),
      /"4\.0\.97"/,
    );
  });

  test('a request id is empty or lowercase hex; anything else refuses before the pins move', () => {
    assert.equal(run('validate', '@ai-sdk/azure@4.1.0', '').status, 0);
    assert.equal(run('validate', '@ai-sdk/azure@4.1.0', '3f2a9c0d1e4b5a67').status, 0);
    for (const bad of ['3F2A9C0D', 'abc', '$(id)', `${'a'.repeat(65)}`, '3f2a9c0d 1e4b']) {
      const r = run('apply', '@ai-sdk/azure@4.1.0', bad);
      assert.equal(r.status, 1, bad);
      assert.match(r.stderr, /isn't a request id/);
    }
    assert.match(
      readFileSync(join(root, 'packages', 'adapters', 'model-azure', 'package.json'), 'utf8'),
      /"4\.0\.97"/,
    );
  });

  test('apply moves the pin', () => {
    const r = run('apply', '@ai-sdk/azure@4.1.0');
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      readFileSync(join(root, 'packages', 'adapters', 'model-azure', 'package.json'), 'utf8'),
      /"@ai-sdk\/azure": "4\.1\.0"/,
    );
  });
});
