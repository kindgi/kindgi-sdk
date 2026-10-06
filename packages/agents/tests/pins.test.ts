// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An agent version's pins digest is one string for one set of pins:
 * key order doesn't change it, any version does, and the Python SDK's
 * `pins_digest` computes the same string (the literal below is asserted
 * in `sdks/python/tests/test_pins.py` too).
 */

import { describe, expect, test } from 'vitest';

import { type AgentPins, pinChanges, pinsDigest } from '../src/index.js';

const pins: AgentPins = {
  tools: { 'acme.lookup': '1.2.0', 'acme.score': '2.0.0', 'acme.ä-tool': '0.1.0' },
  prompts: {},
  settings: { 'acme.weights': '3.1.4' },
};

describe('pinsDigest', () => {
  test('is the sha256 of the canonical pins, the same string Python computes', () => {
    expect(pinsDigest(pins)).toBe(
      'sha256:9c6cc0500541a8d9120df89781d6abb173c249711fda3545b0bb6011327d85cc',
    );
  });

  test("key order doesn't change it; a version does", () => {
    const reordered: AgentPins = {
      settings: { 'acme.weights': '3.1.4' },
      tools: { 'acme.ä-tool': '0.1.0', 'acme.score': '2.0.0', 'acme.lookup': '1.2.0' },
      prompts: {},
    };
    expect(pinsDigest(reordered)).toBe(pinsDigest(pins));
    expect(pinsDigest({ ...pins, tools: { ...pins.tools, 'acme.score': '2.0.1' } })).not.toBe(
      pinsDigest(pins),
    );
  });
});

describe('pinChanges', () => {
  test('each pin that differs, by kind then id; none when equal', () => {
    const later: AgentPins = {
      tools: { 'acme.lookup': '1.3.0', 'acme.score': '2.0.0', 'acme.new': '0.1.0' },
      prompts: {},
      settings: {},
    };
    expect(pinChanges(pins, later)).toEqual([
      { kind: 'tool', id: 'acme.lookup', from: '1.2.0', to: '1.3.0' },
      { kind: 'tool', id: 'acme.new', to: '0.1.0' },
      { kind: 'tool', id: 'acme.ä-tool', from: '0.1.0' },
      { kind: 'setting', id: 'acme.weights', from: '3.1.4' },
    ]);
    expect(pinChanges(pins, pins)).toEqual([]);
  });

  test('without earlier pins, every pin is a change', () => {
    expect(
      pinChanges(undefined, { tools: { 'acme.lookup': '1.2.0' }, prompts: {}, settings: {} }),
    ).toEqual([{ kind: 'tool', id: 'acme.lookup', to: '1.2.0' }]);
  });
});
