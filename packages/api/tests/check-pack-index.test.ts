// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `checkPackIndex`: a deploy's checks of a pack's `index.json`, on their
 * own, so whatever else takes a copy of an index checks it as a deploy
 * would. The deploy route's answers to each are in
 * deployments-routes.test.ts.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { type PackIndexCheckOptions, checkPackIndex } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const ARTIFACT = '20261107.1';

const TOOL = {
  id: 'acme.verify-citation',
  description: 'Verify a legal citation.',
  version: '1.0.0',
  input: { type: 'object', properties: { citation: { type: 'string' } } },
  output: { type: 'object', properties: { verified: { type: 'boolean' } } },
  modulePath: './tools/legal/verify-citation.js',
};

const GUARDRAIL = {
  id: 'acme.no-fabricated-quotes',
  kind: 'zero-llm',
  check: 'acme.aperture.checks.must-cite',
  action: { 'on-violation': 'halt' },
  checkModulePath: './guardrails/must-cite.js',
};

const BLOCK = {
  id: 'acme.reply',
  version: '1.0.0',
  kind: 'prompt',
  content: { template: 'Reply to {{ name }}.' },
  modulePath: 'blocks/reply.json',
};

function index(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    packId: 'acme.aperture',
    packVersion: '1.0.0',
    artifactVersion: ARTIFACT,
    publishedAt: '2026-11-07T08:00:00.000Z',
    tools: [TOOL],
    guardrails: [GUARDRAIL],
    agents: [],
    flows: [],
    ...over,
  };
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const OPTIONS: PackIndexCheckOptions = {
  image: { imageRef: 'registry.example/acme/aperture@sha256:abc', artifactVersion: ARTIFACT },
  tenantId,
  servesBlocks: true,
  requirePrefixedPackChecks: true,
};

describe('checkPackIndex', () => {
  test('an index a deploy takes: its primitives, each pointing into the image, and its env', async () => {
    const checked = await checkPackIndex(
      bytes(index({ blocks: [BLOCK], env: { required: ['API_BASE'] } })),
      OPTIONS,
    );
    expect(checked.kind).toBe('ok');
    if (checked.kind !== 'ok') return;
    expect(checked.index.packId).toBe('acme.aperture');
    expect(checked.env).toEqual({ required: ['API_BASE'], optional: [] });
    expect(checked.primitives.tools.map((t) => t.id)).toEqual(['acme.verify-citation']);
    expect(checked.primitives.tools[0]?.codeArtifactRef).toEqual({
      kind: 'oci',
      imageRef: OPTIONS.image.imageRef,
      modulePath: './tools/legal/verify-citation.js',
      artifactVersion: ARTIFACT,
    });
    expect(checked.primitives.guardrails.map((g) => g.id)).toEqual(['acme.no-fabricated-quotes']);
    expect(checked.primitives.blocks.map((b) => b.id)).toEqual(['acme.reply']);
  });

  test('bytes that are no JSON object: not JSON, not UTF-8, an array, null', async () => {
    for (const raw of [
      new TextEncoder().encode('{"v": 1,'),
      new Uint8Array([0xff, 0xfe, 0x7b, 0x7d]),
      bytes([index()]),
      bytes(null),
    ]) {
      expect(await checkPackIndex(raw, OPTIONS)).toEqual({ kind: 'not-an-object' });
    }
  });

  test('an env the build would not write, with why', async () => {
    const checked = await checkPackIndex(bytes(index({ env: { required: 'API_BASE' } })), OPTIONS);
    expect(checked.kind).toBe('env-malformed');
    if (checked.kind === 'env-malformed') expect(checked.message.length).toBeGreaterThan(0);
  });

  test("another artifact version than the image's, naming the one it has", async () => {
    expect(await checkPackIndex(bytes(index({ artifactVersion: '20261106.9' })), OPTIONS)).toEqual({
      kind: 'artifact-version-mismatch',
      found: '20261106.9',
    });
    expect(
      await checkPackIndex(bytes(index({ artifactVersion: undefined })), OPTIONS),
    ).toMatchObject({ kind: 'artifact-version-mismatch' });
  });

  test("a primitive the registries wouldn't store, with each issue", async () => {
    const checked = await checkPackIndex(bytes(index({ tools: [{ ...TOOL, input: 7 }] })), OPTIONS);
    expect(checked.kind).toBe('invalid');
    if (checked.kind !== 'invalid') return;
    expect(checked.issues.length).toBeGreaterThan(0);
    expect(checked.issues[0]).toMatchObject({ primitive: 'tool', index: 0, id: TOOL.id });
  });

  test("a tool naming a reserved name, or a model provider's key, which it never may", async () => {
    const reserved = await checkPackIndex(
      bytes(
        index({
          tools: [
            { ...TOOL, needsSpec: { secrets: { 'kindgi.connection-token': { type: 'string' } } } },
          ],
        }),
      ),
      OPTIONS,
    );
    expect(reserved).toMatchObject({
      kind: 'invalid',
      issues: [
        { primitive: 'tool', index: 0, id: TOOL.id, path: '/secrets/kindgi.connection-token' },
      ],
    });

    const named = { ...TOOL, needsSpec: { secrets: { ANTHROPIC_API_KEY: { type: 'string' } } } };
    const keys = {
      of: async (t: TenantId) =>
        new Map(t === tenantId ? [['ANTHROPIC_API_KEY', 'anthropic-main']] : []),
    };
    expect(
      await checkPackIndex(bytes(index({ tools: [named] })), { ...OPTIONS, providerKeys: keys }),
    ).toMatchObject({
      kind: 'invalid',
      issues: [{ primitive: 'tool', id: TOOL.id, path: '/secrets/ANTHROPIC_API_KEY' }],
    });
    // Without the keys, or for another tenant, only the reserved names are refused.
    expect((await checkPackIndex(bytes(index({ tools: [named] })), OPTIONS)).kind).toBe('ok');
    expect(
      (
        await checkPackIndex(bytes(index({ tools: [named] })), {
          ...OPTIONS,
          tenantId: randomUUID() as TenantId,
          providerKeys: keys,
        })
      ).kind,
    ).toBe('ok');
  });

  test('data blocks, where the runtime takes none', async () => {
    const blocks = bytes(index({ blocks: [BLOCK] }));
    expect(await checkPackIndex(blocks, { ...OPTIONS, servesBlocks: false })).toEqual({
      kind: 'invalid',
      issues: [
        {
          primitive: 'block',
          index: 0,
          id: 'acme.reply',
          path: '',
          message: 'this runtime serves no data blocks',
        },
      ],
    });
    expect((await checkPackIndex(bytes(index()), { ...OPTIONS, servesBlocks: false })).kind).toBe(
      'ok',
    );
  });

  test("a check run in the pack not named with the pack's id, only when asked", async () => {
    const unprefixed = bytes(index({ guardrails: [{ ...GUARDRAIL, check: 'must-cite' }] }));
    expect(await checkPackIndex(unprefixed, OPTIONS)).toMatchObject({
      kind: 'invalid',
      issues: [{ primitive: 'guardrail', index: 0, id: GUARDRAIL.id, path: '/check' }],
    });
    expect(
      (await checkPackIndex(unprefixed, { ...OPTIONS, requirePrefixedPackChecks: false })).kind,
    ).toBe('ok');
  });

  test("in a deploy's order: the first check that fails is the answer", async () => {
    const everything = {
      env: { required: 'API_BASE' },
      artifactVersion: '20261106.9',
      tools: [{ ...TOOL, input: 7 }],
    };
    expect((await checkPackIndex(bytes(index(everything)), OPTIONS)).kind).toBe('env-malformed');
    const { env: _env, ...noEnv } = everything;
    expect((await checkPackIndex(bytes(index(noEnv)), OPTIONS)).kind).toBe(
      'artifact-version-mismatch',
    );
    // A reserved name is the answer before blocks or check names are looked at.
    const late = await checkPackIndex(
      bytes(
        index({
          tools: [
            { ...TOOL, needsSpec: { secrets: { 'kindgi.connection-token': { type: 'string' } } } },
          ],
          guardrails: [{ ...GUARDRAIL, check: 'must-cite' }],
          blocks: [BLOCK],
        }),
      ),
      { ...OPTIONS, servesBlocks: false },
    );
    expect(late).toMatchObject({ kind: 'invalid', issues: [{ primitive: 'tool' }] });
    const blocksFirst = await checkPackIndex(
      bytes(index({ guardrails: [{ ...GUARDRAIL, check: 'must-cite' }], blocks: [BLOCK] })),
      { ...OPTIONS, servesBlocks: false },
    );
    expect(blocksFirst).toMatchObject({ kind: 'invalid', issues: [{ primitive: 'block' }] });
  });
});
