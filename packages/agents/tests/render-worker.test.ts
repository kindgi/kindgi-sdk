// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/agents/render-worker` as it's installed: the built package
 * (`dist/`), whose worker script resolves next to its module. A turn's
 * instructions rendered in a worker give what they give in-process, byte
 * for byte, or the same failure: the engine's cases, the bounds' limits,
 * and the stock packs' instructions. An idle renderer doesn't keep the
 * process running. Build the package first (`pnpm build`).
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { HOSTED_BOUNDS, SELF_HOSTED_BOUNDS, type TenantInputBounds } from '@kindgi/bounds';
import { overrideTenantInputBounds } from '@kindgi/bounds/testing';
import type { TenantId } from '@kindgi/types';
import { afterEach, describe, expect, test } from 'vitest';

const dist = new URL('../dist/', import.meta.url);
const workerEntry = new URL('render-worker/index.js', dist);
if (!existsSync(workerEntry)) {
  throw new Error(`${fileURLToPath(workerEntry)} isn't built: run \`pnpm build\` first.`);
}
const { defineAgent, renderInstructions } = (await import(
  new URL('index.js', dist).href
)) as typeof import('../src/index.js');
const { renderInstructionsWith } = (await import(
  new URL('prompt.js', dist).href
)) as typeof import('../src/prompt.js');
const { createWorkerTemplateRenderer } = (await import(
  workerEntry.href
)) as typeof import('../src/render-worker/index.js');

type Agent = import('../src/index.js').Agent;
type Renderer = import('../src/render-worker/index.js').WorkerTemplateRenderer;
type RenderContext = import('../src/index.js').RenderContext;

let restore: (() => void) | undefined;
let renderer: Renderer | undefined;
afterEach(async () => {
  await renderer?.close();
  renderer = undefined;
  restore?.();
  restore = undefined;
});

/** A renderer of 2 workers under `bounds`, which a render in-process uses too. */
function under(bounds: TenantInputBounds): Renderer {
  restore = overrideTenantInputBounds(bounds);
  renderer = createWorkerTemplateRenderer({ workers: 2 });
  return renderer;
}

function withLiquid(liquid: Partial<TenantInputBounds['liquid']>): TenantInputBounds {
  return { ...SELF_HOSTED_BOUNDS, liquid: { ...SELF_HOSTED_BOUNDS.liquid, ...liquid } };
}

function agentWith(instructions: string, declared: Agent['parameters'] = []): Agent {
  const made = defineAgent({
    id: 'acme.assistant',
    version: '1.0.0',
    name: 'Assistant',
    instructions: 'Hello',
    capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
  });
  if (made.kind === 'err') throw new Error(made.error.message);
  // Stored as written, checked or not: the render is what's compared.
  return { ...made.value, instructions, parameters: declared };
}

const context: RenderContext = {
  parameters: { firm: 'A&B <Co>' },
  conversation: { id: 'c-1', turn: 2 },
  input: {
    order: { orderNumber: 1042, total: '59.90', currency: 'EUR', status: 'processing', flags: ['first order', 'high value'] },
    event: { change: 'updated', nodeId: 7, revisionId: 31, moderationState: 'draft', flags: [], houseStyle: ['world-class'] },
  },
  settings: { 'acme.weights': { recency: 0.4 } },
  clock: () => new Date('2026-10-12T00:00:00Z'),
};

/** What a render comes to: its output, or its error's code, message and parameter. */
type Outcome = string | { code: string; message: string; parameterName?: string };

function outcome(
  result: ReturnType<typeof renderInstructions>,
): Outcome {
  if (result.ok) return result.value.rendered;
  const { code, message } = result.error;
  return {
    code,
    message,
    ...('parameterName' in result.error && { parameterName: result.error.parameterName }),
  };
}

/** The same render in-process and in a worker: what each comes to. */
async function both(r: Renderer, agent: Agent, ctx: RenderContext = context) {
  const here = outcome(renderInstructions(agent, ctx));
  const there = outcome(await renderInstructionsWith(r, 'tenant-a' as TenantId, agent, ctx));
  return { here, there };
}

/** The engine's cases (`liquid.test.ts`), and failures before and during a render. */
const CASES: readonly (readonly [string, string])[] = [
  ['plain text', 'You rank filings.'],
  ['a variable and a filter', 'For {{ firm | upcase }}.'],
  ['a value with & and <, as written', 'For {{ firm }}.'],
  ['escape', 'For {{ firm | escape }}.'],
  ['a loop', '{% for i in (1..3) %}{{ i }}{% endfor %}'],
  ['a capture', '{% capture a %}Hi {{ firm }}{% endcapture %}{{ a }}'],
  ['whitespace control', 'a \n\n {%- if true -%} \n\n b \n\n {%- endif -%} \n\n c'],
  ['raw', '{% raw %}{{ y }} {% if %}{% endraw %}'],
  ['a missing variable', 'Hi {{ y }}'],
  ['an unknown filter', '{{ firm | nope }}'],
  ['invalid Liquid', 'Hi {% if %}'],
  ['a literal {{', 'Answer as JSON like {{"a": 1}}'],
  ['a literal {%', 'Use {% to start'],
  ['the auto-injected variables', '{{ today }} {{ now }} {{ agent.id }}@{{ agent.version }} {{ conversation.id }}#{{ conversation.turn }}'],
  ['input and settings', '{{ input.order.flags | join: ", " }} {{ settings["acme.weights"].recency }}'],
  ['a partial', "Hi {% include 'package.json' %}"],
  ['a partial by a variable', '{% assign name = "package.json" %}{% include name %}'],
];

describe('a render in a worker gives what it gives in-process', () => {
  test.each(CASES)('self-hosted bounds: %s', async (_, template) => {
    const r = under(SELF_HOSTED_BOUNDS);
    const { here, there } = await both(r, agentWith(template, [{ name: 'firm', type: 'string' }]));
    expect(there).toEqual(here);
  });

  test.each(CASES)('hosted bounds: %s', async (_, template) => {
    const r = under(HOSTED_BOUNDS);
    const { here, there } = await both(r, agentWith(template, [{ name: 'firm', type: 'string' }]));
    expect(there).toEqual(here);
  });

  test('a required parameter missing fails before any render, the same', async () => {
    const r = under(HOSTED_BOUNDS);
    const agent = agentWith('For {{ client }}.', [{ name: 'client', type: 'string', required: true }]);
    const { here, there } = await both(r, agent);
    expect(here).toEqual({
      code: 'missing-parameter',
      message: 'Required parameter missing: client',
      parameterName: 'client',
    });
    expect(there).toEqual(here);
  });

  test.each([
    ['parseLimit', withLiquid({ parseLimit: 10 }), 'Hello there, {{ firm }}'],
    [
      'renderLimitMs, checked by liquidjs between nodes',
      withLiquid({ renderLimitMs: 20 }),
      '{% for i in (1..1000) %}{% for j in (1..1000) %}{{ j }}{% endfor %}{% endfor %}',
    ],
    ['memoryLimit', withLiquid({ memoryLimit: 100 }), '{% for i in (1..1000) %}a{% endfor %}'],
    [
      'memoryLimit, a capture',
      withLiquid({ memoryLimit: 1000 }),
      '{% assign s = "x" %}{% for i in (1..12) %}{% capture s %}{{ s }}{{ s }}{% endcapture %}{% endfor %}{{ s.size }}',
    ],
  ])('over %s: the same failure, naming the limit', async (_, bounds, template) => {
    const r = under(bounds);
    const { here, there } = await both(r, agentWith(template, [{ name: 'firm', type: 'string' }]));
    expect(here).toMatchObject({ code: 'render-failure', message: expect.stringMatching(/limit/) });
    expect(there).toEqual(here);
  });
});

/** The stock packs' agents' instructions, as `kindgi init` writes them for a pack named `acme`. */
function stockInstructions(): { readonly name: string; readonly template: string }[] {
  const templates = new URL('../../cli/src/templates/', import.meta.url);
  const found: { name: string; template: string }[] = [];
  for (const pack of readdirSync(templates)) {
    const agents = new URL(`${pack}/agents/`, templates);
    if (!existsSync(agents)) continue;
    for (const agent of readdirSync(agents)) {
      const file = new URL(`${agent}/index.ts.tmpl`, agents);
      if (!existsSync(file)) continue;
      const source = readFileSync(file, 'utf8')
        .replaceAll('{{PACK_ID}}', 'acme')
        .replaceAll('{{PACK_VERSION}}', '0.1.0');
      const block =
        /\binstructions:\s*\[([\s\S]*?)\]\.join\('\\n'\)/.exec(source)?.[1] ??
        /\binstructions:\s*(\n\s*'.*',)/.exec(source)?.[1];
      if (block === undefined) throw new Error(`${pack}/${agent}: no instructions found`);
      const lines = [...block.matchAll(/^\s*(['"`])(.*)\1,?\s*$/gm)].map(([, quote, text]) =>
        // A tool's name, where the template computes one.
        quote === '`' ? (text as string).replace(/\$\{[^}]*\}/g, 'acme.tool') : (text as string),
      );
      if (lines.length === 0) throw new Error(`${pack}/${agent}: no instruction lines found`);
      found.push({ name: `${pack}/${agent}`, template: lines.join('\n') });
    }
  }
  return found;
}

const STOCK = stockInstructions();

describe("the stock packs' instructions", () => {
  test('are all found, the Liquid ones among them', () => {
    expect(STOCK.length).toBeGreaterThanOrEqual(5);
    expect(STOCK.filter(({ template }) => template.includes('{{ input.')).length).toBeGreaterThanOrEqual(2);
  });

  test.each(STOCK.map(({ name, template }) => [name, template] as const))(
    '%s renders byte for byte the same in a worker as in-process, under the hosted bounds',
    async (_, template) => {
      const r = under(HOSTED_BOUNDS);
      const { here, there } = await both(r, agentWith(template));
      expect(typeof here).toBe('string');
      expect(there).toBe(here);
    },
  );
});

describe('the built renderer', () => {
  test('renders, and an idle renderer left open doesn’t keep the process running', async () => {
    const started = Date.now();
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/idle-renderer.mjs', import.meta.url)), workerEntry.href],
      { timeout: 20_000 },
    );
    expect(stdout.trim()).toBe('DONE');
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});
