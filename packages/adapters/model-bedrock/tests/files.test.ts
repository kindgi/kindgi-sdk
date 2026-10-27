// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { MessageFile, ModelCallInput, ProviderMetadata } from '@kindgi/capabilities';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { bedrockAdapterFactory } from '../src/index.js';

const MODEL = 'us.anthropic.claude-test-v1:0';
const metadata = {
  id: 'bedrock-acme',
  region: 'us-east-2',
  models: [
    {
      name: MODEL,
      contextWindow: 200_000,
      features: ['vision', 'tool-use'],
      cost: { promptUsdPer1kTokens: 0.003, completionUsdPer1kTokens: 0.015 },
    },
  ],
} as unknown as ProviderMetadata;

const CONVERSE_BODY = {
  output: { message: { role: 'assistant', content: [{ text: 'Seen.' }] } },
  stopReason: 'end_turn',
  usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45 },
  metrics: { latencyMs: 120 },
};

/** Each Converse request's body, and a fixed answer. */
function capturingFetch(bodies: Record<string, unknown>[]): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify(CONVERSE_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const jpeg = (id: string, size: number): MessageFile => ({
  artifactId: id,
  name: `${id}.jpg`,
  contentType: 'image/jpeg',
  size,
  sha256: 'a'.repeat(64),
});
const pdf = (id: string): MessageFile => ({
  artifactId: id,
  name: `${id}.pdf`,
  contentType: 'application/pdf',
  size: 13,
  sha256: 'b'.repeat(64),
});

async function converse(files: readonly MessageFile[]): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = [];
  const provider = bedrockAdapterFactory({
    metadata,
    config: { auth: 'api-key' },
    fetch: capturingFetch(bodies),
    resolveApiKey: async () => 'bedrock-key',
  });
  const input: ModelCallInput = {
    model: MODEL,
    messages: [{ role: 'user', content: 'Here they are.', files }],
    readFile: async (id) =>
      id.startsWith('d')
        ? new TextEncoder().encode('%PDF-1.7 tiny')
        : new Uint8Array(files.find((f) => f.artifactId === id)?.size ?? 0),
  };
  await provider.invoke(input);
  return bodies[0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'env-bearer-must-not-be-sent');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Bedrock's own file limits", () => {
  test("an image over 3.75 MB is a line, though under Kindgi's 5 MB", async () => {
    const body = await converse([jpeg('small', 8), jpeg('big', 4_000_000)]);
    const sent = JSON.stringify(body);
    expect(sent).toContain('File \\"big.jpg\\" (image/jpeg, 4.0 MB): not shown: too large.');
    const content = (body.messages as { content: Record<string, unknown>[] }[])[0]?.content ?? [];
    expect(content.filter((block) => 'image' in block)).toHaveLength(1);
  });

  test('at most five documents a call, the newest kept', async () => {
    const body = await converse(['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map(pdf));
    const content = (body.messages as { content: Record<string, unknown>[] }[])[0]?.content ?? [];
    expect(content.filter((block) => 'document' in block)).toHaveLength(5);
    expect(JSON.stringify(body)).toContain(
      'File \\"d1.pdf\\" (application/pdf, 13 bytes): not shown: over this call\'s file limit.',
    );
  });
});
