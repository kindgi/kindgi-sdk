// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The one template check, wherever a template comes in (an agent's
 * definition, a prompt block's publish, a drafted template), and the
 * render: the same verdict and message at each, under the bounds' limits.
 */

import { HOSTED_BOUNDS, SELF_HOSTED_BOUNDS, type TenantInputBounds } from '@kindgi/bounds';
import { overrideTenantInputBounds } from '@kindgi/bounds/testing';
import { afterEach, describe, expect, test } from 'vitest';

import {
  type Agent,
  checkDraftedTemplate,
  defineAgent,
  renderInstructions,
  templateProblem,
  tenantLiquid,
  validateBlock,
} from '../src/index.js';

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
      // `package.json` would resolve from the package's directory, where the tests run.
      expect(() => tenantLiquid().parseFileSync(name)).toThrow(`Failed to lookup "${name}"`);
    },
  );
});
