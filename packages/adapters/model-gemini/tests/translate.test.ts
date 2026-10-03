// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { GenerateContentResponse } from '@google/genai';
import { describe, expect, test } from 'vitest';

import {
  checkFunctionName,
  fromGeminiResponse,
  mapFinishReason,
  toGeminiFunctions,
  toGeminiRequest,
} from '../src/index.js';

describe('toGeminiRequest', () => {
  test('system messages lift into systemInstruction; user and assistant turns map to user / model', () => {
    const r = toGeminiRequest([
      { role: 'system', content: 'Be brief.' },
      { role: 'system', content: 'Answer in JSON.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
    ]);
    expect(r.systemInstruction).toBe('Be brief.\n\nAnswer in JSON.');
    expect(r.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
      { role: 'user', parts: [{ text: 'again' }] },
    ]);
  });

  test('tool calls replay as functionCall parts with their signature; results answer them by name', () => {
    const r = toGeminiRequest([
      { role: 'user', content: 'rank' },
      {
        role: 'assistant',
        content: 'Looking it up.',
        toolCalls: [
          { id: 'c1', name: 'acme.rank-cases', arguments: { limit: 2 }, signature: 'sig-1' },
          { id: 'c2', name: 'acme.lookup', arguments: {} },
        ],
      },
      { role: 'tool', toolCallId: 'c1', content: '{"ranked":["case-1"]}' },
      { role: 'tool', toolCallId: 'c2', content: 'not json' },
    ]);
    expect(r.systemInstruction).toBeUndefined();
    expect(r.contents).toEqual([
      { role: 'user', parts: [{ text: 'rank' }] },
      {
        role: 'model',
        parts: [
          { text: 'Looking it up.' },
          {
            functionCall: { id: 'c1', name: 'acme.rank-cases', args: { limit: 2 } },
            thoughtSignature: 'sig-1',
          },
          { functionCall: { id: 'c2', name: 'acme.lookup', args: {} } },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'c1',
              name: 'acme.rank-cases',
              response: { output: { ranked: ['case-1'] } },
            },
          },
          { functionResponse: { id: 'c2', name: 'acme.lookup', response: { output: 'not json' } } },
        ],
      },
    ]);
  });

  test('a tool result for a call no assistant turn made is refused', () => {
    expect(() => toGeminiRequest([{ role: 'tool', toolCallId: 'ghost', content: '{}' }])).toThrow(
      /answers call "ghost"/,
    );
  });

  test('an empty assistant turn is dropped', () => {
    expect(toGeminiRequest([{ role: 'assistant', content: '' }]).contents).toEqual([]);
  });
});

describe('function names', () => {
  test('pack tool ids pass unchanged; invalid names are refused', () => {
    expect(checkFunctionName('acme-app.rank-cases')).toBe('acme-app.rank-cases');
    expect(() => checkFunctionName('1starts-with-digit')).toThrow(/valid Gemini function name/);
    expect(() => checkFunctionName(`a${'b'.repeat(64)}`)).toThrow(/at most 64/);
    expect(() => checkFunctionName('has space')).toThrow();
  });

  test('tool definitions become declarations with the JSON Schema as parametersJsonSchema', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
    expect(
      toGeminiFunctions([{ name: 'acme.search', description: 'Search', inputSchema: schema }]),
    ).toEqual([{ name: 'acme.search', description: 'Search', parametersJsonSchema: schema }]);
  });
});

function response(fields: Partial<GenerateContentResponse>): GenerateContentResponse {
  return fields as GenerateContentResponse;
}

describe('fromGeminiResponse', () => {
  test('text parts join; thinking parts are left out', () => {
    const r = fromGeminiResponse(
      response({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'weighing it…', thought: true }, { text: '{"a":' }, { text: '1}' }],
            },
            finishReason: 'STOP' as never,
          },
        ],
      }),
    );
    expect(r).toEqual({ message: { role: 'assistant', content: '{"a":1}' }, finishReason: 'stop' });
  });

  test('function calls become tool calls with their signature; a missing id is generated', () => {
    const r = fromGeminiResponse(
      response({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: { id: 'f1', name: 'acme.rank', args: { n: 1 } },
                  thoughtSignature: 'sig',
                },
                { functionCall: { name: 'acme.lookup' } },
              ],
            },
            finishReason: 'STOP' as never,
          },
        ],
      }),
    );
    expect(r.finishReason).toBe('tool-use');
    expect(r.message.toolCalls?.[0]).toEqual({
      id: 'f1',
      name: 'acme.rank',
      arguments: { n: 1 },
      signature: 'sig',
    });
    expect(r.message.toolCalls?.[1]).toMatchObject({ name: 'acme.lookup', arguments: {} });
    expect(r.message.toolCalls?.[1]?.id).toMatch(/^gemini-call-/);
    expect(r.message.toolCalls?.[1]).not.toHaveProperty('signature');
  });

  test('a blocked prompt (no candidates) is content-filter; no candidates otherwise is error', () => {
    expect(
      fromGeminiResponse(response({ promptFeedback: { blockReason: 'SAFETY' as never } })),
    ).toEqual({ message: { role: 'assistant', content: '' }, finishReason: 'content-filter' });
    expect(fromGeminiResponse(response({})).finishReason).toBe('error');
  });
});

describe('mapFinishReason', () => {
  test.each([
    [undefined, 'stop'],
    ['STOP', 'stop'],
    ['FINISH_REASON_UNSPECIFIED', 'stop'],
    ['MAX_TOKENS', 'length'],
    ['SAFETY', 'content-filter'],
    ['RECITATION', 'content-filter'],
    ['PROHIBITED_CONTENT', 'content-filter'],
    ['SPII', 'content-filter'],
    ['MALFORMED_FUNCTION_CALL', 'error'],
    ['TOO_MANY_TOOL_CALLS', 'error'],
    ['OTHER', 'error'],
  ])('%s → %s', (reason, expected) => {
    expect(mapFinishReason(reason)).toBe(expected);
  });
});
