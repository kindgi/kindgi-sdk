// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { MCP_RESERVED_PREFIXES, mcpExposureIssues } from '../src/index.js';

describe('mcpExposureIssues', () => {
  test('absent: nothing to check', () => {
    expect(mcpExposureIssues(undefined, 'acme.intake', 'agent')).toEqual([]);
  });

  test.each([
    { expose: true },
    { expose: false },
    { expose: true, readOnly: true },
    { expose: true, readOnly: false, destructive: true },
  ])('%j is fine', (value) => {
    expect(mcpExposureIssues(value, 'acme.intake', 'agent')).toEqual([]);
    expect(mcpExposureIssues(value, 'acme.intake', 'flow')).toEqual([]);
  });

  test.each([null, true, 'expose', ['expose']])('%j is refused: not an object', (value) => {
    expect(mcpExposureIssues(value, 'acme.intake', 'agent')).toEqual([
      { path: '/mcp', message: 'mcp must be an object' },
    ]);
  });

  test('expose is required, and every field is true or false', () => {
    expect(mcpExposureIssues({ readOnly: 'yes' }, 'acme.intake', 'agent')).toEqual([
      { path: '/mcp/expose', message: 'mcp.expose must be true or false' },
      { path: '/mcp/readOnly', message: 'mcp.readOnly must be true or false' },
    ]);
    expect(mcpExposureIssues({ expose: 1, destructive: null }, 'acme.intake', 'flow')).toEqual([
      { path: '/mcp/expose', message: 'mcp.expose must be true or false' },
      { path: '/mcp/destructive', message: 'mcp.destructive must be true or false' },
    ]);
  });

  test('no other field', () => {
    expect(mcpExposureIssues({ expose: false, name: 'x' }, 'acme.intake', 'agent')).toEqual([
      { path: '/mcp/name', message: 'mcp takes only expose, readOnly and destructive' },
    ]);
  });

  test.each(MCP_RESERVED_PREFIXES.map((prefix) => [prefix]))(
    'an agent id starting %s is refused only when exposed, naming the prefix',
    (prefix) => {
      const id = `${prefix}intake`;
      expect(mcpExposureIssues({ expose: false }, id, 'agent')).toEqual([]);
      const [issue, ...rest] = mcpExposureIssues({ expose: true }, id, 'agent');
      expect(rest).toEqual([]);
      expect(issue?.path).toBe('/mcp/expose');
      expect(issue?.message).toContain(`starts with "${prefix}"`);
    },
  );

  test("a flow's id may start with a reserved prefix: its tool is flow.<id>", () => {
    expect(mcpExposureIssues({ expose: true }, 'kindgi.intake', 'flow')).toEqual([]);
  });

  test("an exposed id must be a tool's name; an unexposed one needn't", () => {
    for (const id of ['acme intake', 'acme/intake', 'é', 'a'.repeat(129)]) {
      expect(mcpExposureIssues({ expose: false }, id, 'agent')).toEqual([]);
      expect(mcpExposureIssues({ expose: true }, id, 'agent')[0]?.message).toContain(
        "can't be a tool's name",
      );
    }
    expect(mcpExposureIssues({ expose: true }, 'a'.repeat(128), 'agent')).toEqual([]);
    expect(mcpExposureIssues({ expose: true }, 'a'.repeat(123), 'flow')).toEqual([]);
    expect(mcpExposureIssues({ expose: true }, 'a'.repeat(124), 'flow')[0]?.message).toContain(
      'at most 123 characters',
    );
  });
});
