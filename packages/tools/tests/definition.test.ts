// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { ToolId } from '@kindgi/types';

import { changedToolFields, sameToolDefinition, toolDefinition } from '../src/definition.js';
import type { ToolManifest } from '../src/types.js';

const base: ToolManifest = {
  id: 'acme.verify-citation' as ToolId,
  description: 'Verify a legal citation.',
  version: '1.0.0',
  input: { type: 'object', properties: { citation: { type: 'string' } } },
  output: { type: 'object', properties: { verified: { type: 'boolean' } } },
  mutating: false,
  needsSpec: {
    connections: { mail: { app: 'google', permissions: ['gmail.send'], as: 'person' } },
  },
  codeArtifactRef: {
    kind: 'oci',
    imageRef: 'ghcr.io/acme/aperture@sha256:aaa',
    modulePath: './tools/legal/verify-citation.js',
    artifactVersion: '20260920.1',
  },
};
const t = (patch: Record<string, unknown>) => ({ ...base, ...patch }) as unknown as ToolManifest;

describe('sameToolDefinition', () => {
  test.each([
    [
      'keys in another order',
      t({ output: { properties: { verified: { type: 'boolean' } }, type: 'object' } }),
    ],
    ['an undefined field', t({ effects: undefined })],
    [
      'another image and artifact version',
      t({
        codeArtifactRef: {
          kind: 'oci',
          artifactVersion: '20260921.1',
          modulePath: './tools/legal/verify-citation.js',
          imageRef: 'ghcr.io/acme/aperture@sha256:bbb',
        },
      }),
    ],
    [
      'what a registry adds (its project, its secret scopes)',
      t({ projectId: 'p-1', madeInProjectId: 'p-1', secretScopes: {}, unregisteredAt: 'x' }),
    ],
  ])('the same, with %s', (_why, other) => {
    expect(sameToolDefinition(base, other)).toBe(true);
    expect(changedToolFields(base, other)).toEqual([]);
  });

  test.each([
    ['another description', t({ description: 'Check a citation.' }), ['description']],
    ['another input', t({ input: { type: 'object' } }), ['input']],
    [
      'another `as` on a connection it needs',
      t({
        needsSpec: {
          connections: { mail: { app: 'google', permissions: ['gmail.send'], as: 'company' } },
        },
      }),
      ['needsSpec'],
    ],
    ['`mutating` left out', t({ mutating: undefined }), ['mutating']],
    ['metadata', t({ metadata: { team: 'legal' } }), ['metadata']],
    [
      'another module path',
      t({ codeArtifactRef: { ...(base.codeArtifactRef as object), modulePath: './other.js' } }),
      ['modulePath'],
    ],
    [
      'a spec instead of code',
      t({ codeArtifactRef: undefined, spec: { kind: 'http', method: 'GET', url: 'https://x' } }),
      ['spec', 'modulePath'],
    ],
    [
      'another input and approvals',
      t({ needsApprovalWhenUnattended: true, input: { type: 'object' } }),
      ['input', 'needsApprovalWhenUnattended'],
    ],
    ['its result marked outside data', t({ resultIsOutsideData: true }), ['resultIsOutsideData']],
    ['how its approval reads', t({ approval: { title: 'Verify {citation}' } }), ['approval']],
  ])('different, with %s, naming the fields in manifest order', (_why, other, fields) => {
    expect(sameToolDefinition(base, other)).toBe(false);
    expect(changedToolFields(base, other)).toEqual(fields);
  });
});

describe('toolDefinition', () => {
  test("is what the author declares, and the module path of the tool's code", () => {
    expect(toolDefinition(base)).toEqual({
      id: 'acme.verify-citation',
      description: 'Verify a legal citation.',
      version: '1.0.0',
      input: base.input,
      output: base.output,
      mutating: false,
      needsSpec: base.needsSpec,
      modulePath: './tools/legal/verify-citation.js',
    });
  });
});
