// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A `defineCheck` check, run by the pack service, gets the config its
 * schema resolves. The sample guardrail's shape ("fail when the text is
 * shorter than `config.minLength`") with no config declared: the schema's
 * default applies, so the check fails a short response. Before, it got
 * `{}`, compared against `undefined`, and passed everything.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { type RunningPackService, startPackService } from '../src/pack-service/index.js';
import { PACK_PROTOCOL_VERSION } from '../src/protocol.js';

const TOKEN = 'pack-token';
// The built guardrails package, as a pack reaches it through `@kindgi/sdk/define`.
const GUARDRAILS = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'guardrails', 'dist', 'index.js'),
).href;

const MIN_LENGTH_CHECK = `import { defineCheck } from '${GUARDRAILS}';
export const check = defineCheck({
  id: 'pack.checks.min-length',
  kind: 'zero-llm',
  configSchema: {
    type: 'object',
    properties: { minLength: { type: 'integer', minimum: 0, default: 5 } },
    additionalProperties: false,
  },
  evaluate: async (config, trace) => {
    const text = typeof trace.output === 'string' ? trace.output.trim() : '';
    if (text.length < config.minLength) {
      return { passed: false, reason: 'shorter than ' + config.minLength };
    }
    return { passed: true };
  },
});
export default { id: 'pack.min-length', check };
`;

let dir: string;
let running: RunningPackService;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-check-config-'));
  await mkdir(join(dir, 'guardrails'), { recursive: true });
  await writeFile(join(dir, 'guardrails', 'min-length.mjs'), MIN_LENGTH_CHECK, 'utf8');
  const indexPath = join(dir, 'index.json');
  await writeFile(
    indexPath,
    JSON.stringify({
      v: 1,
      packId: 'pack',
      packVersion: '0.1.0',
      artifactVersion: '20261004.1',
      publishedAt: '2026-10-04T00:00:00.000Z',
      tools: [],
      guardrails: [
        {
          id: 'pack.min-length',
          kind: 'zero-llm',
          action: { 'on-violation': 'halt' },
          checkModulePath: 'guardrails/min-length.mjs',
          checkId: 'pack.checks.min-length',
        },
      ],
      agents: [],
      flows: [],
    }),
    'utf8',
  );
  const started = await startPackService({ indexPath, moduleRoot: dir, token: TOKEN, port: 0 });
  if (started.kind === 'err') throw new Error(started.problems.join('; '));
  running = started.value;
});

afterAll(async () => {
  await running?.stop(1000);
  await rm(dir, { recursive: true, force: true });
});

async function check(config: unknown, output: string): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${running.port}/v1/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'kindgi-pack-token': TOKEN },
    body: JSON.stringify({
      v: PACK_PROTOCOL_VERSION,
      kind: 'check-invoke',
      check: { id: 'pack.checks.min-length' },
      config,
      trace: { output },
    }),
  });
  return (await res.json()) as Record<string, unknown>;
}

describe("pack service: a check's config, resolved by its schema", () => {
  test('no config: the default applies, so a short response fails', async () => {
    expect(await check({}, 'hi')).toEqual({
      v: 2,
      kind: 'check-result',
      result: { passed: false, reason: 'shorter than 5' },
    });
    expect(await check({}, 'hello there')).toEqual({
      v: 2,
      kind: 'check-result',
      result: { passed: true },
    });
  });

  test('a declared config wins over the default', async () => {
    expect(await check({ minLength: 1 }, 'hi')).toMatchObject({ result: { passed: true } });
  });

  test("a config that doesn't fit fails the check, naming where", async () => {
    const answer = await check({ minLength: -1 }, 'hi');
    expect(answer.kind).not.toBe('check-result');
    expect(JSON.stringify(answer)).toContain(
      "the guardrail's config doesn't fit its configSchema at /minLength",
    );
  });
});
