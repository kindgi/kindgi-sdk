// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The one template check, wherever a template comes in (an agent's
 * definition, a prompt block's publish, a drafted template), and the
 * render: the same verdict and message at each, under the bounds' limits.
 */

import { HOSTED_BOUNDS, SELF_HOSTED_BOUNDS, type TenantInputBounds } from '@kindgi/bounds';
import { overrideTenantInputBounds } from '@kindgi/bounds/testing';
import { Liquid } from 'liquidjs';
import { afterEach, describe, expect, test } from 'vitest';

import {
  type Agent,
  checkDraftedTemplate,
  defineAgent,
  renderInstructions,
  templateProblem,
  validateBlock,
} from '../src/index.js';
import { renderTenantTemplate, tenantLiquid } from '../src/liquid.js';

const NO_PARTIALS = "templates can't use include, render or layout";

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

function withLiquid(liquid: Partial<TenantInputBounds['liquid']>): void {
  restore = overrideTenantInputBounds({
    ...SELF_HOSTED_BOUNDS,
    liquid: { ...SELF_HOSTED_BOUNDS.liquid, ...liquid },
  });
}

function defined(instructions: string) {
  return defineAgent({
    id: 'acme.assistant',
    version: '1.0.0',
    name: 'Assistant',
    instructions,
    capabilities: [{ needs: [{ feature: 'structured-output' as const }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
  });
}

/** What each way in says about a template. */
function doors(template: string) {
  const agent = defined(template);
  const block = validateBlock({
    id: 'acme.prompt',
    version: '1.0.0',
    kind: 'prompt',
    content: { template },
  });
  const drafted = checkDraftedTemplate(template, {
    current: { template: 'Hello' },
    settingsBlocks: [],
    knownIds: [],
  });
  return {
    agent: agent.kind === 'err' ? agent.error.issues.map((i) => `${i.path} ${i.message}`) : [],
    block: block.kind === 'err' ? block.error.issues.map((i) => `${i.path} ${i.message}`) : [],
    drafted: drafted.map((i) => `${i.path} ${i.message}`),
  };
}

function refusedEverywhere(message: string) {
  return {
    agent: [`/instructions ${message}`],
    block: [`/content/template ${message}`],
    drafted: [`/template ${message}`],
  };
}

/** An agent stored before its template was checked: the render is its last line. */
function stored(template: string): Agent {
  const agent = defined('Hello');
  if (agent.kind === 'err') throw new Error(agent.error.message);
  return { ...agent.value, instructions: template };
}

/** `s` doubled `n` times by a capture, then `tail`. */
function doubling(n: number, tail: string): string {
  return `{% assign s = "x" %}{% for i in (1..${n}) %}{% capture s %}{{ s }}{{ s }}{% endcapture %}{% endfor %}${tail}`;
}

function rendered(template: string): string {
  const r = renderInstructions(stored(template), {
    parameters: {},
    clock: () => new Date('2026-10-12T00:00:00Z'),
  });
  return r.ok ? r.value.rendered : r.error.message;
}

describe('one check at every way in', () => {
  test.each([
    ['include', "Hi {% include 'package.json' %}"],
    ['render', "Hi {% render 'constructor' %}"],
    ['layout', "{% layout '__proto__' %}Hi"],
    ['in a block', "{% if true %}{% include 'package.json' %}{% endif %}"],
    ['in a liquid tag', "{% liquid\n  render 'package.json' %}"],
    ['by a variable', '{% assign name = "package.json" %}{% include name %}'],
  ])('a partial (%s) is refused alike at each, and fails the render', (_, template) => {
    expect(templateProblem(template)).toBe(NO_PARTIALS);
    expect(doors(template)).toEqual(refusedEverywhere(NO_PARTIALS));
    expect(rendered(template)).toBe(`Template render failed: ${NO_PARTIALS}`);
  });

  test("Liquid the renderer won't parse is refused alike at each, an unknown filter included", () => {
    for (const template of ["{{ 'a' | nope }}", '{% if %}']) {
      const problem = templateProblem(template);
      expect(problem).toMatch(/^the template isn't valid Liquid: /);
      expect(doors(template)).toEqual(refusedEverywhere(problem as string));
    }
    expect(templateProblem("{{ 'a' | nope }}")).toBe(
      "the template isn't valid Liquid: undefined filter: nope, line:1, col:1",
    );
  });

  test('a partial in raw text or a comment is only text: accepted at each, and rendered as written', () => {
    const template =
      "Hi {% raw %}{% include 'x' %}{% endraw %}{% comment %}{% render 'y' %}{% endcomment %}";
    expect(templateProblem(template)).toBeUndefined();
    expect(doors(template)).toEqual({ agent: [], block: [], drafted: [] });
    expect(rendered(template)).toBe("Hi {% include 'x' %}");
  });
});

describe('a stored template renders as before', () => {
  /** The engine every release before this one rendered with, failing as `renderInstructions` says it. */
  function before(template: string): string {
    try {
      return new Liquid({ strictVariables: true, strictFilters: true }).parseAndRenderSync(
        template,
        { firm: 'Acme' },
      );
    } catch (cause) {
      return `Template render failed: ${(cause as Error).message}`;
    }
  }

  test.each([
    ['plain text', 'You rank filings.'],
    ['a variable and a filter', 'For {{ firm | upcase }}.'],
    ['a loop', '{% for i in (1..3) %}{{ i }}{% endfor %}'],
    ['an unknown filter, refused at render before as now', '{{ firm | nope }}'],
    ['invalid Liquid', 'Hi {% if %}'],
  ])('without a partial, the same output or the same failure: %s', (_, template) => {
    const agent = { ...stored(template), parameters: [{ name: 'firm', type: 'string' as const }] };
    const r = renderInstructions(agent, {
      parameters: { firm: 'Acme' },
      clock: () => new Date('2026-10-12T00:00:00Z'),
    });
    expect(r.ok ? r.value.rendered : r.error.message).toBe(before(template));
  });
});

describe('the engine renders as the previous one did', () => {
  /** The engine every release before this one rendered with, as it was. */
  const before = () => new Liquid({ strictVariables: true, strictFilters: true });
  const scope = { firm: 'A&B <Co>' };

  /** What a render gives: its output, or its error's name and message. */
  function outcome(render: () => string): string {
    try {
      return render();
    } catch (cause) {
      return `${(cause as Error).name}: ${(cause as Error).message}`;
    }
  }

  test.each([
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
  ])('the same output or the same error: %s', (_, template) => {
    expect(outcome(() => renderTenantTemplate(template, scope))).toBe(
      outcome(() => before().parseAndRenderSync(template, scope)),
    );
  });
});

describe("the bounds' limits", () => {
  test('a template over parseLimit is refused alike at each, and fails the render', () => {
    withLiquid({ parseLimit: 10 });
    const message = 'the template is 11 characters, over the limit of 10';
    expect(doors('Hello there')).toEqual(refusedEverywhere(message));
    expect(doors('Hello ther')).toEqual({ agent: [], block: [], drafted: [] });
    expect(rendered('Hello there')).toBe(
      'Template render failed: the template is over the limit of 10 characters',
    );
  });

  test('a render over renderLimitMs fails, naming the limit', () => {
    withLiquid({ renderLimitMs: 20 });
    expect(
      rendered('{% for i in (1..1000) %}{% for j in (1..1000) %}{{ j }}{% endfor %}{% endfor %}'),
    ).toBe('Template render failed: the render took over the limit of 20 ms');
  });

  test('a render over memoryLimit fails, naming the limit', () => {
    withLiquid({ memoryLimit: 100 });
    expect(rendered('{% for i in (1..1000) %}a{% endfor %}')).toBe(
      'Template render failed: the render went over its memory limit of 100',
    );
  });

  test('a capture counts toward memoryLimit', () => {
    withLiquid({ memoryLimit: 1000 });
    // Captured, never written out: only the capture's charge can stop it.
    expect(rendered(doubling(8, '{{ s.size }}'))).toBe('256');
    expect(rendered(doubling(12, '{{ s.size }}'))).toBe(
      'Template render failed: the render went over its memory limit of 1000',
    );
  });

  test('what a filter returns counts toward memoryLimit, not only what it was given', () => {
    withLiquid({ memoryLimit: 1000 });
    // url_encode is charged nothing for what it's given, and gives back 6 characters for each é.
    const encoded = (n: number) => `{% assign e = "${'é'.repeat(n)}" | url_encode %}{{ e | size }}`;
    expect(rendered(encoded(150))).toBe('900');
    expect(rendered(encoded(200))).toBe(
      'Template render failed: the render went over its memory limit of 1000',
    );
    // split is charged n for a string of n characters, and gives back n items.
    const items = (n: number) => `{% assign a = "${'x'.repeat(n)}" | split: "" %}{{ a.size }}`;
    expect(rendered(items(400))).toBe('400');
    expect(rendered(items(600))).toBe(
      'Template render failed: the render went over its memory limit of 1000',
    );
  });

  test('what the output writes counts toward memoryLimit as it is written', () => {
    withLiquid({ memoryLimit: 600 });
    // The range is charged 1 a number, and each `x` written 1.
    const repeated = (n: number) => `{% for i in (1..${n}) %}xxxxxxxxxx{% endfor %}`;
    expect(rendered(repeated(50))).toHaveLength(500);
    expect(rendered(repeated(60))).toBe(
      'Template render failed: the render went over its memory limit of 600',
    );
  });

  test.each([
    [
      'an array holding one string many times',
      `{% assign s = "${'x'.repeat(100)}" %}{% assign a = "" | split: "," %}{% for i in (1..20) %}{% assign a = a | push: s %}{% endfor %}`,
      '{{ a }}',
    ],
    ['a range', '', '{{ (1..400) }}'],
  ])('%s, written out or captured, is charged as it is written', (_, setup, write) => {
    withLiquid({ memoryLimit: 1000 });
    for (const template of [
      `${setup}${write}`,
      `${setup}{% capture c %}${write}{% endcapture %}{{ c.size }}`,
    ]) {
      expect(rendered(template)).toBe(
        'Template render failed: the render went over its memory limit of 1000',
      );
    }
  });

  test.each([
    [
      'a joined range written 80 times',
      '{% assign s = (1..1000000) | join: "" %}{% for i in (1..80) %}{{ s }}{% endfor %}',
    ],
    ['a capture doubled 28 times', doubling(28, '{{ s.size }}')],
    [
      'a capture doubled 27 times, then replaced',
      doubling(27, '{{ s | replace: "x", "y" | size }}'),
    ],
    [
      'an output past the longest string',
      doubling(21, '{% for i in (1..300) %}{{ s }}{% endfor %}'),
    ],
  ])(
    'on a hosted or a self-hosted server, what grew past memoryLimit fails at it: %s',
    (_, template) => {
      for (const [bounds, limit] of [
        [HOSTED_BOUNDS, 8_388_608],
        [SELF_HOSTED_BOUNDS, 16_777_216],
      ] as const) {
        restore?.();
        restore = overrideTenantInputBounds(bounds);
        expect(templateProblem(template)).toBeUndefined();
        expect(rendered(template)).toBe(
          `Template render failed: the render went over its memory limit of ${limit}`,
        );
      }
    },
  );

  test.each([
    ['the hosted bounds', HOSTED_BOUNDS, 8_388_608],
    ['the self-hosted bounds', SELF_HOSTED_BOUNDS, 16_777_216],
  ])(
    'an array holding the same arrays many times is refused fast, under %s',
    (_, bounds, limit) => {
      restore = overrideTenantInputBounds(bounds);
      // Each pass holds the last array twice: 2^26 arrays to walk, 26 distinct.
      const build =
        '{% assign e = "" | split: "," %}{% assign a = e %}{% for i in (1..26) %}{% assign a = e | push: a | push: a %}{% endfor %}';
      // Refused as it's built, either way. The second never writes the array
      // out (`==` stops at the lengths), so only what each `push` makes, charged
      // by all it holds, refuses it.
      for (const template of [`${build}[{{ a }}]`, `${build}{% if a == e %}same{% endif %}`]) {
        expect(templateProblem(template)).toBeUndefined();
        const started = performance.now();
        expect(rendered(template)).toBe(
          `Template render failed: the render went over its memory limit of ${limit}`,
        );
        expect(performance.now() - started).toBeLessThan(500);
      }
    },
  );

  test('ordinary templates over a full-size input render at the self-hosted limit, and are refused at the hosted one', () => {
    const doc = '<p>Orders for <b>Acme &amp; Co</b>, "tenant-a" and tenant-b.</p>\n'.repeat(29_500);
    const items = Array.from({ length: 9_000 }, (_, i) =>
      `Order ${i} from <Acme & Co>: ${'two widgets, one gadget; '.repeat(8)}`.padEnd(213, '.'),
    );
    expect(doc.length).toBeGreaterThan(1.8 * 1024 * 1024);
    expect(items.join('').length).toBeGreaterThan(1.8 * 1024 * 1024);
    const chains: [string, object, RegExp][] = [
      [
        '{{ doc | strip_html | escape | strip }}',
        { doc },
        /^Orders for Acme &amp;amp; Co, &#34;tenant-a&#34; and tenant-b\./,
      ],
      [
        '{% for item in items %}{{ item | escape | strip | truncate: 150 }}{% endfor %}',
        { items },
        /^Order 0 from &lt;Acme &amp; Co&gt;/,
      ],
    ];
    restore = overrideTenantInputBounds(SELF_HOSTED_BOUNDS);
    for (const [template, scope, start] of chains) {
      expect(renderTenantTemplate(template, scope)).toMatch(start);
    }
    // Each filter is charged for what it's given and what it gives back,
    // and the output once more: through three filters, about six times the input.
    restore?.();
    restore = overrideTenantInputBounds(HOSTED_BOUNDS);
    for (const [template, scope] of chains) {
      expect(() => renderTenantTemplate(template, scope)).toThrow('memory alloc limit exceeded');
    }
  });

  test("an array from the render's input is weighed through its nested arrays", () => {
    withLiquid({ memoryLimit: 1000 });
    const nested = [Array.from({ length: 20 }, () => 'x'.repeat(100))];
    expect(() => renderTenantTemplate('{{ nested }}', { nested })).toThrow(
      'memory alloc limit exceeded',
    );
    expect(renderTenantTemplate('{{ nested }}', { nested: [['x'.repeat(100)]] })).toHaveLength(100);
  });

  test('an item that writes nothing still counts 1, for the place it takes', () => {
    withLiquid({ memoryLimit: 450 });
    const nils = (length: number) => Array.from({ length }, () => null);
    const empties = (length: number) => Array.from({ length }, () => '');
    for (const items of [nils, empties]) {
      expect(() => renderTenantTemplate('{{ items }}', { items: items(500) })).toThrow(
        'memory alloc limit exceeded',
      );
      expect(renderTenantTemplate('{{ items }}', { items: items(400) })).toBe('');
    }
  });

  test('with no memory limit, an output past the longest string says so', () => {
    withLiquid({ memoryLimit: Number.POSITIVE_INFINITY });
    expect(rendered(doubling(21, '{% for i in (1..300) %}{{ s }}{% endfor %}'))).toBe(
      'Template render failed: the render made a string longer than JavaScript allows',
    );
  });

  test('the limits are read when a template is checked, not when the module loaded', () => {
    const long = `Hi ${'x'.repeat(300_000)}`;
    expect(templateProblem(long)).toBeUndefined();
    restore = overrideTenantInputBounds(HOSTED_BOUNDS);
    expect(templateProblem(long)).toBe(
      'the template is 300003 characters, over the limit of 262144',
    );
  });
});

describe('tenantLiquid', () => {
  test.each(['package.json', 'constructor', '__proto__'])(
    'no name resolves to a partial, past the refusing tags too (%s)',
    (name) => {
      // `package.json` is a file that exists, so this fails if partials ever resolve.
      expect(() => tenantLiquid().parseFileSync(name)).toThrow(`Failed to lookup "${name}"`);
    },
  );
});
