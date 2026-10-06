// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { defineAgent } from '../src/define.js';
import { renderInstructions } from '../src/prompt.js';

const baseCapabilities = [{ needs: [{ feature: 'structured-output' as const }] }];

function make(instructions: string, parameters?: Parameters<typeof defineAgent>[0]['parameters']) {
  const r = defineAgent({
    id: 'acme.test',
    version: '1.0.0',
    name: 'Test',
    instructions,
    capabilities: baseCapabilities,
    tools: [],
    retrieval: [],
    guardrails: [],
    ...(parameters !== undefined && { parameters }),
  });
  if (r.kind === 'err') throw new Error(`spec invalid: ${r.error.message}`);
  return r.value;
}

const fixedClock = () => new Date('2026-09-17T15:30:00Z');

describe('renderInstructions — basic substitution', () => {
  test('renders a bare literal instructions with no parameters', () => {
    const agent = make('You are a legal assistant.');
    const r = renderInstructions(agent, { parameters: {}, clock: fixedClock });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.rendered).toBe('You are a legal assistant.');
  });

  test('substitutes a single declared parameter', () => {
    const agent = make('You draft for {{ firmName }}.', [{ name: 'firmName', type: 'string' }]);
    const r = renderInstructions(agent, {
      parameters: { firmName: 'Wilson Sonsini' },
      clock: fixedClock,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.rendered).toBe('You draft for Wilson Sonsini.');
  });

  test('substitutes multiple parameters + framework auto-vars', () => {
    const agent = make(
      'You are {{ agent.name }} for {{ firmName }} in {{ jurisdiction }}. Today is {{ today }}.',
      [
        { name: 'firmName', type: 'string' },
        { name: 'jurisdiction', type: 'string' },
      ],
    );
    const r = renderInstructions(agent, {
      parameters: { firmName: 'Acme LLP', jurisdiction: 'CA' },
      clock: fixedClock,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.rendered).toBe('You are Test for Acme LLP in CA. Today is 2026-09-17.');
    }
  });

  test('conversation.* is populated when a conversation context is supplied', () => {
    const agent = make('Turn {{ conversation.turn }} of {{ conversation.id }}.');
    const r = renderInstructions(agent, {
      parameters: {},
      conversation: { id: 'c-42', turn: 3 },
      clock: fixedClock,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.rendered).toBe('Turn 3 of c-42.');
  });
});

describe('renderInstructions — conditionals and filters', () => {
  test('supports {% if %} blocks', () => {
    const agent = make(
      '{% if jurisdiction == "CA" %}California-specific note.{% else %}General.{% endif %}',
      [{ name: 'jurisdiction', type: 'string' }],
    );
    const r = renderInstructions(agent, {
      parameters: { jurisdiction: 'CA' },
      clock: fixedClock,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.rendered).toBe('California-specific note.');

    const r2 = renderInstructions(agent, {
      parameters: { jurisdiction: 'NY' },
      clock: fixedClock,
    });
    if (r2.ok) expect(r2.value.rendered).toBe('General.');
  });

  test('supports filters like upcase', () => {
    const agent = make('For {{ firmName | upcase }}.', [{ name: 'firmName', type: 'string' }]);
    const r = renderInstructions(agent, {
      parameters: { firmName: 'wilson sonsini' },
      clock: fixedClock,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.rendered).toBe('For WILSON SONSINI.');
  });
});

describe('renderInstructions — required + defaults', () => {
  test('applies default when caller omits an optional parameter', () => {
    const agent = make('Tone: {{ tone }}.', [
      { name: 'tone', type: 'string', required: false, default: 'formal' },
    ]);
    const r = renderInstructions(agent, { parameters: {}, clock: fixedClock });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.rendered).toBe('Tone: formal.');
  });

  test('caller value overrides default', () => {
    const agent = make('Tone: {{ tone }}.', [
      { name: 'tone', type: 'string', required: false, default: 'formal' },
    ]);
    const r = renderInstructions(agent, {
      parameters: { tone: 'plain-language' },
      clock: fixedClock,
    });
    if (r.ok) expect(r.value.rendered).toBe('Tone: plain-language.');
  });

  test('required parameter with no default + no caller value → missing-parameter', () => {
    const agent = make('For {{ firmName }}.', [{ name: 'firmName', type: 'string' }]);
    const r = renderInstructions(agent, { parameters: {}, clock: fixedClock });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('missing-parameter');
      if (r.error.code === 'missing-parameter') {
        expect(r.error.parameterName).toBe('firmName');
      }
    }
  });

  test('an unresolved settings block is named in full, hyphens included', () => {
    const agent = make('At most {{ settings["acme.reply-style"].maxSentences }} sentences.', []);
    const r = renderInstructions(agent, { parameters: {}, settings: {}, clock: fixedClock });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toBe(
        'Template references an unresolved variable: settings.acme.reply-style',
      );
    }
  });

  test('reports all missing required params at once', () => {
    const agent = make('{{ a }} + {{ b }}', [
      { name: 'a', type: 'string' },
      { name: 'b', type: 'string' },
    ]);
    const r = renderInstructions(agent, { parameters: {}, clock: fixedClock });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'missing-parameter') {
      expect(r.error.message).toContain('a');
      expect(r.error.message).toContain('b');
    }
  });
});

describe('renderInstructions — strict variables', () => {
  test('template references an undeclared variable → missing-parameter', () => {
    const agent = make('Hello {{ mystery }}.');
    const r = renderInstructions(agent, { parameters: {}, clock: fixedClock });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('missing-parameter');
  });
});

describe('renderInstructions — provenance context capture', () => {
  test('returned context includes both caller params and auto-vars', () => {
    const agent = make('For {{ firmName }}.', [{ name: 'firmName', type: 'string' }]);
    const r = renderInstructions(agent, {
      parameters: { firmName: 'Acme LLP' },
      clock: fixedClock,
    });
    if (r.ok) {
      expect(r.value.context.firmName).toBe('Acme LLP');
      expect(r.value.context.today).toBe('2026-09-17');
      expect(r.value.context.now).toBe('2026-09-17T15:30:00.000Z');
      expect((r.value.context.agent as { id: string }).id).toBe('acme.test');
    }
  });
});
