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
type AgentsModule = typeof import('../src/index.js');
type PromptModule = typeof import('../src/prompt.js');
type RenderWorkerModule = typeof import('../src/render-worker/index.js');
const { defineAgent, renderInstructions } = (await import(
  new URL('index.js', dist).href
)) as AgentsModule;
const { renderInstructionsWith } = (await import(new URL('prompt.js', dist).href)) as PromptModule;
const { createWorkerTemplateRenderer } = (await import(workerEntry.href)) as RenderWorkerModule;

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
    order: {
      orderNumber: 1042,
      total: '59.90',
      currency: 'EUR',
      status: 'processing',
      flags: ['first order', 'high value'],
    },
    event: {
      change: 'updated',
      nodeId: 7,
      revisionId: 31,
      moderationState: 'draft',
      flags: [],
      houseStyle: ['world-class'],
    },
  },
  settings: { 'acme.weights': { recency: 0.4 } },
  clock: () => new Date('2026-10-12T00:00:00Z'),
};

/** What a render comes to: its output, or its error's code, message and parameter. */
type Outcome = string | { code: string; message: string; parameterName?: string };

function outcome(result: ReturnType<typeof renderInstructions>): Outcome {
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
  [
    'the auto-injected variables',
    '{{ today }} {{ now }} {{ agent.id }}@{{ agent.version }} {{ conversation.id }}#{{ conversation.turn }}',
  ],
  [
    'input and settings',
    '{{ input.order.flags | join: ", " }} {{ settings["acme.weights"].recency }}',
  ],
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
    const agent = agentWith('For {{ client }}.', [
      { name: 'client', type: 'string', required: true },
    ]);
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

/** A stock pack's file as `kindgi init` writes it for a pack named `acme`. */
function scaffolded(file: URL): string {
  return readFileSync(file, 'utf8')
    .replaceAll('{{PACK_ID}}', 'acme')
    .replaceAll('{{PACK_VERSION}}', '0.1.0');
}

/** Instructions an agent's source gives inline: its lines, joined with newlines. */
function inlineInstructions(name: string, source: string): string {
  const block =
    /\binstructions:\s*\[([\s\S]*?)\]\.join\('\\n'\)/.exec(source)?.[1] ??
    /\binstructions:\s*(\n\s*'.*',)/.exec(source)?.[1];
  if (block === undefined) throw new Error(`${name}: no instructions found`);
  const lines = [...block.matchAll(/^\s*(['"`])(.*)\1,?\s*$/gm)].map(([, quote, text]) =>
    // A tool's name, where the template computes one.
    quote === '`' ? (text as string).replace(/\$\{[^}]*\}/g, 'acme.tool') : (text as string),
  );
  if (lines.length === 0) throw new Error(`${name}: no instruction lines found`);
  return lines.join('\n');
}

/** The prompt block `id`'s template in a stock pack's `blocks/`, as the pack's index reads it. */
function promptTemplate(blocks: URL, id: string): string {
  for (const name of existsSync(blocks) ? readdirSync(blocks) : []) {
    if (!name.endsWith('.json.tmpl')) continue;
    const block = JSON.parse(scaffolded(new URL(name, blocks))) as {
      readonly id: string;
      readonly kind: string;
      readonly content: { readonly template?: string; readonly templateFile?: string };
    };
    if (block.id !== id || block.kind !== 'prompt') continue;
    if (block.content.template !== undefined) return block.content.template;
    if (block.content.templateFile !== undefined) {
      return scaffolded(new URL(`${block.content.templateFile}.tmpl`, blocks));
    }
  }
  throw new Error(`${id}: no prompt block with a template in ${fileURLToPath(blocks)}`);
}

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
      const source = scaffolded(file);
      const name = `${pack}/${agent}`;
      // Instructions a prompt block of the pack holds: the block's template.
      const prompt = /\binstructions:\s*\{\s*prompt:\s*'([^']+)'/.exec(source)?.[1];
      const template =
        prompt === undefined
          ? inlineInstructions(name, source)
          : promptTemplate(new URL(`${pack}/blocks/`, templates), prompt);
      found.push({ name, template });
    }
  }
  return found;
}

const STOCK = stockInstructions();

describe("the stock packs' instructions", () => {
  test('are all found, the Liquid ones among them', () => {
    expect(STOCK.length).toBeGreaterThanOrEqual(5);
    expect(
      STOCK.filter(({ template }) => template.includes('{{ input.')).length,
    ).toBeGreaterThanOrEqual(2);
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

  test('close() settles after an idle render, so a top-level await on it doesn’t hang', async () => {
    // The fixture renders, then `await`s close() and prints DONE. An idle
    // worker is unref'd, so unless stop() holds the loop with its own ref'd
    // timer while it waits, the process could exit before close() settled —
    // execFile would then see a non-zero exit (an unsettled top-level await)
    // and no DONE.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL('./fixtures/closing-renderer.mjs', import.meta.url)),
        workerEntry.href,
      ],
      { timeout: 20_000 },
    );
    expect(stdout.trim()).toBe('DONE');
  }, 30_000);

  test('a worker renders dates in the server’s timezone and locale, as in-process', async () => {
    // Under a timezone and locale unlike the machine's: the in-process render
    // reads them, and the worker must too (liquidjs's `date` filter formats
    // in the local zone and the default locale). They match only because the
    // fork forwards the timezone and locale variables.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL('./fixtures/locale-render-check.mjs', import.meta.url)),
        workerEntry.href,
      ],
      {
        timeout: 20_000,
        env: { ...process.env, TZ: 'Asia/Tokyo', LANG: 'fr_FR.UTF-8', LC_ALL: 'fr_FR.UTF-8' },
      },
    );
    const { here, there } = JSON.parse(stdout) as { here: string; there: string };
    expect(there).toBe(here);
    // The set zone took effect (08:30 UTC is 17:30 +0900), so this isn't two
    // identically-wrong renders from a timezone the fork failed to forward.
    expect(here).toContain('+0900');
  }, 30_000);

  // Node takes the locale from LC_ALL, then LC_MESSAGES, then LANG, so a
  // server may set any one of them alone. Each is forwarded on its own:
  // with only that one set (every other LC_* and LANG left out), the
  // in-process render is French, and the worker's must be too.
  test.each(['LC_ALL', 'LC_MESSAGES', 'LANG'])(
    'a worker takes the locale from %s alone, as in-process',
    async (name) => {
      const env: Record<string, string> = { TZ: 'UTC', [name]: 'fr_FR.UTF-8' };
      for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined || key === 'LANG' || key.startsWith('LC_') || key in env) continue;
        env[key] = value;
      }
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(new URL('./fixtures/locale-render-check.mjs', import.meta.url)),
          workerEntry.href,
        ],
        { timeout: 20_000, env },
      );
      const { here, there } = JSON.parse(stdout) as { here: string; there: string };
      expect(there).toBe(here);
      // The locale took effect in-process (2026-10-15 is a Thursday), so this
      // isn't two renders in the default locale from a variable never read.
      expect(here).toContain('jeudi 15 octobre 2026');
    },
    30_000,
  );
});
