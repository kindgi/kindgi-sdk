// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An agent's or a flow's id is the pack's own id, a dot, and a kebab-case
 * name with no dot. `kindgi dev` and `kindgi build` warn about any other
 * shape, for every language's indexer, and the pack runs as it is.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runLocalIndexerReal } from '../src/build/defaults.js';
import { runPythonIndexer } from '../src/dev/defaults.js';
import { idShapeWarnings } from '../src/dev/id-shape.js';

const entry = (id: string) => ({ id, modulePath: `agents/${id}.ts` });

const message = (kind: 'agent' | 'flow', id: string, packId: string) =>
  `agents/${id}.ts: ${kind} "${id}" isn't named "${packId}.<name>" (this pack's id, a dot, then a lowercase kebab-case name with no dot). An id is hard to change once something calls it, so rename it while it's new. The pack runs as it is.`;

describe('idShapeWarnings', () => {
  test('the pack id, a dot and a kebab-case name: no warning', () => {
    expect(
      idShapeWarnings('acme', {
        agents: [entry('acme.order-desk'), entry('acme.brief-writer2')],
        flows: [entry('acme.review-order')],
      }),
    ).toEqual([]);
  });

  test('a pack id with dots of its own is the prefix as a whole', () => {
    expect(
      idShapeWarnings('acme.legal', {
        agents: [entry('acme.legal.contract-reader')],
        flows: [entry('acme.legal.review-contract')],
      }),
    ).toEqual([]);
  });

  test('a name with a dot warns, naming the file, the id and the shape', () => {
    expect(idShapeWarnings('acme', { flows: [entry('acme.ledger.record-flow')] })).toEqual([
      {
        code: 'flow-id-shape',
        message: message('flow', 'acme.ledger.record-flow', 'acme'),
        filePath: 'agents/acme.ledger.record-flow.ts',
      },
    ]);
  });

  test("another pack's prefix, upper case, a leading digit and no name each warn", () => {
    const ids = ['acme-shop.order-desk', 'acme.OrderDesk', 'acme.2nd-desk', 'acme.', 'order-desk'];
    const warnings = idShapeWarnings('acme', { agents: ids.map(entry) });
    expect(warnings.map((w) => w.code)).toEqual(ids.map(() => 'agent-id-shape'));
    expect(warnings.map((w) => w.message)).toEqual(ids.map((id) => message('agent', id, 'acme')));
  });

  test('an id the index lists once per version warns once', () => {
    const warnings = idShapeWarnings('acme', {
      agents: [entry('acme.echo.agent'), entry('acme.echo.agent')],
    });
    expect(warnings).toHaveLength(1);
  });

  test('an entry without a module path warns without one', () => {
    expect(idShapeWarnings('acme', { agents: [{ id: 'shop.order-desk' }] })).toEqual([
      {
        code: 'agent-id-shape',
        message: `agent "shop.order-desk" isn't named "acme.<name>" (this pack's id, a dot, then a lowercase kebab-case name with no dot). An id is hard to change once something calls it, so rename it while it's new. The pack runs as it is.`,
      },
    ]);
  });

  test('no pack id, or no index to read: nothing', () => {
    expect(idShapeWarnings('', { agents: [entry('shop.order-desk')] })).toEqual([]);
    expect(idShapeWarnings('acme', null)).toEqual([]);
    expect(idShapeWarnings('acme', [entry('shop.order-desk')])).toEqual([]);
    expect(idShapeWarnings('acme', { agents: 'shop.order-desk', flows: [{ id: 7 }] })).toEqual([]);
  });
});

describe("the indexer's result carries the warnings, after the indexer's own", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'id-shape-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const checkWarning = {
    code: 'check-id-unprefixed',
    message: 'guardrails/cites.ts: check "cites" needs a prefix.',
    filePath: 'guardrails/cites.ts',
  };

  const report = (outputPath: string) => ({
    outputPath,
    packId: 'acme',
    packVersion: '0.1.0',
    counts: { tools: 0, guardrails: 1, agents: 1, flows: 1 },
    fileErrors: [],
    warnings: [checkWarning],
  });

  const index = {
    packId: 'acme',
    agents: [entry('acme.order-desk')],
    flows: [entry('acme.ledger.record-flow')],
  };

  const expected = [
    checkWarning,
    {
      code: 'flow-id-shape',
      message: message('flow', 'acme.ledger.record-flow', 'acme'),
      filePath: 'agents/acme.ledger.record-flow.ts',
    },
  ];

  test('kindgi dev, and the Python and JVM builds: the indexer child', async () => {
    const outputPath = join(dir, 'index.json');
    const script = join(dir, 'stand-in.mjs');
    await writeFile(
      script,
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(outputPath)}, ${JSON.stringify(JSON.stringify(index))});
process.stdout.write(${JSON.stringify(`${JSON.stringify({ kind: 'ok', value: report(outputPath) })}\n`)});
`,
      'utf8',
    );
    const result = await runPythonIndexer({
      packDir: dir,
      outputPath,
      python: [process.execPath, script],
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(result).toMatchObject({ kind: 'ok', packId: 'acme', warnings: expected });
  });

  test("kindgi build's TypeScript pack: the bundled indexer", async () => {
    const outputPath = join(dir, 'expected-index.json');
    await writeFile(
      join(dir, 'kindgi-index.mjs'),
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(outputPath)}, ${JSON.stringify(JSON.stringify(index))});
process.stdout.write(${JSON.stringify(JSON.stringify(report(outputPath)))});
`,
      'utf8',
    );
    const result = await runLocalIndexerReal({
      packDir: dir,
      bundleDir: dir,
      outputPath,
      artifactVersion: '0.1.0',
      publishedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result).toMatchObject({ kind: 'ok', packId: 'acme', warnings: expected });
  });
});
