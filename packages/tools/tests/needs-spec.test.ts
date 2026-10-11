// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A tool's `needsSpec` schemas compile as the runtime compiles them when it loads the tool. One
 * that wouldn't is refused where the tool is defined, registered or deployed, naming the tool, the
 * slot and the name, rather than accepted and then left out by the runtime.
 */

import { describe, expect, test } from 'vitest';

import type { ToolId } from '@kindgi/types';

import { defineTool, validateToolManifest } from '../src/index.js';
import type { JsonSchema, Tool } from '../src/index.js';

const tool = (needsSpec: Record<string, unknown>): Tool =>
  ({
    id: 'acme.sign' as ToolId,
    description: 'Signs a receipt.',
    version: '0.1.0',
    input: { type: 'object' } as JsonSchema,
    output: { type: 'object' } as JsonSchema,
    needsSpec,
    handler: async () => ({}),
  }) as unknown as Tool;

/** Both ways a tool is checked: defined in a pack, or a manifest sent to the API or a deploy. */
const checks = (needsSpec: Record<string, unknown>) => {
  const candidate = tool(needsSpec);
  const { handler: _handler, ...manifest } = candidate;
  return [
    ['defineTool', defineTool(candidate)],
    ['validateToolManifest', validateToolManifest(manifest)],
  ] as const;
};

describe('needsSpec schemas compile as the runtime compiles them', () => {
  test('a secret schema that would not compile is refused, naming the tool, slot and name', () => {
    for (const [label, r] of checks({
      secrets: { SIGNING_KEY: { type: 'string', 'x-unknown': true } },
    })) {
      expect(r.kind, label).toBe('err');
      if (r.kind !== 'err') continue;
      expect(r.error).toMatchObject({
        code: 'invalid-tool-definition',
        message: expect.stringContaining(
          'Tool "acme.sign": the schema for needsSpec.secrets.SIGNING_KEY doesn\'t compile: strict mode: unknown keyword: "x-unknown"',
        ),
        issues: [
          {
            path: '/needsSpec/secrets/SIGNING_KEY',
            message: expect.stringContaining('unknown keyword'),
          },
        ],
      });
    }
  });

  test('an env schema likewise; and an env default that is not a string', () => {
    for (const [label, r] of checks({ env: { REGION: { type: 'strng' } } })) {
      expect(r.kind === 'err' && r.error.code, label).toBe('invalid-tool-definition');
      if (r.kind === 'err') {
        expect((r.error as unknown as { issues: { path: string }[] }).issues[0]?.path, label).toBe(
          '/needsSpec/env/REGION',
        );
      }
    }
    for (const [label, r] of checks({ env: { RETRIES: { type: 'string', default: 3 } } })) {
      expect(r.kind === 'err' && r.error.message, label).toBe(
        'Tool "acme.sign": needsSpec.env.RETRIES\'s default must be a string: env values are strings.',
      );
    }
  });

  test('what compiles is accepted: a required secret, an optional one (nullable), an env default', () => {
    for (const [label, r] of checks({
      secrets: {
        SIGNING_KEY: { type: 'string', minLength: 32 },
        STAMP_KEY: { type: ['string', 'null'], minLength: 32 },
      },
      env: { REGION: { type: 'string', enum: ['eu', 'us'], default: 'eu' } },
    })) {
      expect(r.kind, label).toBe('ok');
    }
  });
});
