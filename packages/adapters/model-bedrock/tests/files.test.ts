// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

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

const PDF = new TextEncoder().encode('%PDF-1.7 tiny');
const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** An image the fake store holds as `size` zero bytes. */
const jpeg = (id: string, size: number): MessageFile => ({
  artifactId: id,
  name: `${id}.jpg`,
  contentType: 'image/jpeg',
  size,
  sha256: sha256Of(new Uint8Array(size)),
});
const pdf = (id: string): MessageFile => ({
  artifactId: id,
  name: `${id}.pdf`,
  contentType: 'application/pdf',
  size: PDF.byteLength,
  sha256: sha256Of(PDF),
  pages: 1,
});

/** The request body Bedrock is sent; each file id the call reads goes in `read`. */
async function converse(
  files: readonly MessageFile[],
  messages: ModelCallInput['messages'] = [{ role: 'user', content: 'Here they are.', files }],
  read: string[] = [],
): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = [];
  const provider = bedrockAdapterFactory({
    metadata,
    config: { auth: 'api-key' },
    fetch: capturingFetch(bodies),
    resolveApiKey: async () => 'bedrock-key',
  });
  const input: ModelCallInput = {
    model: MODEL,
    messages,
    // Bedrock drops tool calls and their results from a call that offers no tools.
    tools: [
      { name: 'mail.attachment', description: 'An attachment.', inputSchema: { type: 'object' } },
    ],
    readFile: async (id) => {
      read.push(id);
      return id.startsWith('d')
        ? PDF
        : new Uint8Array(files.find((f) => f.artifactId === id)?.size ?? 0);
    },
  };
  await provider.invoke(input);
  return bodies[0] as Record<string, unknown>;
}

type ConverseMessage = { role: string; content: Record<string, unknown>[] };

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
    const content = (body.messages as ConverseMessage[])[0]?.content ?? [];
    expect(content.filter((block) => 'image' in block)).toHaveLength(1);
  });

  test("a PDF over 4.5 MB is a line, though under Kindgi's 10 MB; nothing is read", async () => {
    const big: MessageFile = { ...pdf('dbig'), size: 5_000_000 };
    const read: string[] = [];
    const body = await converse([pdf('d1'), big], undefined, read);
    expect(JSON.stringify(body)).toContain(
      'File \\"dbig.pdf\\" (application/pdf, 5.0 MB): not shown: too large.',
    );
    const content = (body.messages as ConverseMessage[])[0]?.content ?? [];
    expect(content.filter((block) => 'document' in block)).toHaveLength(1);
    expect(read).toEqual(['d1']);
  });

  test("a tool result's file rides in the user message after it, with a text block beside it", async () => {
    const photo = jpeg('photo', 8);
    const body = await converse(
      [photo],
      [
        { role: 'user', content: 'Look at the attachment.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'mail.attachment', arguments: {} }],
        },
        { role: 'tool', toolCallId: 'c1', content: 'one photo', files: [photo] },
      ],
    );
    const messages = body.messages as ConverseMessage[];
    // Converse takes images and documents only in a user message, and a
    // document only beside a text block.
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const last = messages[2]?.content ?? [];
    expect(last.some((block) => 'toolResult' in block)).toBe(true);
    expect(last.some((block) => 'image' in block)).toBe(true);
    expect(last.some((block) => 'text' in block)).toBe(true);
    expect(messages.slice(0, 2).every((m) => !JSON.stringify(m).includes('"image"'))).toBe(true);
  });

  test('at most five documents a call, the newest kept', async () => {
    const body = await converse(['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map(pdf));
    const content = (body.messages as ConverseMessage[])[0]?.content ?? [];
    expect(content.filter((block) => 'document' in block)).toHaveLength(5);
    expect(JSON.stringify(body)).toContain(
      'File \\"d1.pdf\\" (application/pdf, 13 bytes): not shown: over this call\'s file limit.',
    );
  });
});
