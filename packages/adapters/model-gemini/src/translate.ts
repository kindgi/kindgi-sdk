// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import type {
  Content,
  FunctionCall,
  FunctionDeclaration,
  GenerateContentResponse,
  Part,
} from '@google/genai';
import type {
  ModelCallResult,
  ModelMessage,
  ModelToolCall,
  ModelToolDefinition,
} from '@kindgi/capabilities';

/**
 * Gemini function names: a letter or `_` first, then letters, digits,
 * `_ . : -`, at most 64 characters. The framework's `<pack>.<tool>` ids
 * fit as they are, so names go over the wire unchanged.
 */
const FUNCTION_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;

export function checkFunctionName(name: string): string {
  if (!FUNCTION_NAME.test(name)) {
    throw new Error(
      `@kindgi/adapter-model-gemini: tool "${name}" isn't a valid Gemini function name (a letter or _ first, then letters, digits, _ . : -, at most 64 characters).`,
    );
  }
  return name;
}

/**
 * The framework's message trail as a Gemini request:
 *
 *   - `system` messages lift into `systemInstruction` (several join with
 *     a blank line, in order);
 *   - `user` messages become `user` turns; `assistant` messages become
 *     `model` turns — text, then one `functionCall` part per tool call,
 *     carrying the call's thought signature back;
 *   - `tool` messages become `functionResponse` parts in a `user` turn.
 *     Gemini names the function it answers, so the name comes from the
 *     assistant tool call with the same id. The tool's output goes under
 *     `response.output` (parsed when it is JSON).
 *
 * Consecutive turns of the same role merge into one `Content`.
 */
export function toGeminiRequest(messages: readonly ModelMessage[]): {
  readonly systemInstruction: string | undefined;
  readonly contents: readonly Content[];
} {
  const systemParts: string[] = [];
  const contents: Content[] = [];
  const callNames = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (msg.content.length > 0) systemParts.push(msg.content);
    } else if (msg.role === 'user') {
      append(contents, 'user', [{ text: msg.content }]);
    } else if (msg.role === 'assistant') {
      const parts = modelParts(msg, callNames);
      // An empty model turn is invalid; the agent loop never produces one.
      if (parts.length > 0) append(contents, 'model', parts);
    } else {
      append(contents, 'user', [functionResponsePart(msg, callNames)]);
    }
  }

  return {
    systemInstruction: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    contents,
  };
}

/** An assistant message's parts: its text, then a `functionCall` per tool call. */
function modelParts(msg: ModelMessage, callNames: Map<string, string>): Part[] {
  const parts: Part[] = msg.content.length > 0 ? [{ text: msg.content }] : [];
  for (const call of msg.toolCalls ?? []) {
    callNames.set(call.id, call.name);
    parts.push({
      functionCall: {
        id: call.id,
        name: checkFunctionName(call.name),
        args: { ...call.arguments },
      },
      ...(call.signature !== undefined && { thoughtSignature: call.signature }),
    });
  }
  return parts;
}

/** A tool result, named after the call it answers. */
function functionResponsePart(msg: ModelMessage, callNames: ReadonlyMap<string, string>): Part {
  const id = msg.toolCallId ?? '';
  const name = callNames.get(id);
  if (name === undefined) {
    throw new Error(
      `@kindgi/adapter-model-gemini: a tool result answers call "${id}", which no earlier assistant turn made.`,
    );
  }
  return { functionResponse: { id, name, response: { output: parseOutput(msg.content) } } };
}

function append(contents: Content[], role: 'user' | 'model', parts: readonly Part[]): void {
  const last = contents[contents.length - 1];
  if (last !== undefined && last.role === role) {
    last.parts = [...(last.parts ?? []), ...parts];
    return;
  }
  contents.push({ role, parts: [...parts] });
}

/** A tool's output: its JSON value when it is JSON, else the text. */
function parseOutput(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/**
 * Tool definitions as Gemini function declarations. The input schema is
 * full JSON Schema, which `parametersJsonSchema` takes as it is.
 */
export function toGeminiFunctions(
  tools: readonly ModelToolDefinition[],
): readonly FunctionDeclaration[] {
  return tools.map((t) => ({
    name: checkFunctionName(t.name),
    description: t.description,
    parametersJsonSchema: t.inputSchema,
  }));
}

/**
 * A Gemini response as the framework's assistant message: the text of
 * the first candidate (thinking parts left out), and a tool call per
 * `functionCall` part, with its thought signature. Gemini may omit the
 * call id; one is generated then, so the tool result can refer to it.
 */
export function fromGeminiResponse(response: GenerateContentResponse): {
  readonly message: ModelMessage;
  readonly finishReason: ModelCallResult['finishReason'];
} {
  const candidate = response.candidates?.[0];
  if (candidate === undefined) {
    // No candidate: the prompt itself was blocked.
    const blocked = response.promptFeedback?.blockReason !== undefined;
    return {
      message: { role: 'assistant', content: '' },
      finishReason: blocked ? 'content-filter' : 'error',
    };
  }

  const parts = candidate.content?.parts ?? [];
  const text = parts
    .filter((part) => part.functionCall === undefined && part.thought !== true)
    .map((part) => part.text ?? '');
  const toolCalls = parts.flatMap((part) =>
    part.functionCall !== undefined ? [toToolCall(part.functionCall, part.thoughtSignature)] : [],
  );

  return {
    message: {
      role: 'assistant',
      content: text.join(''),
      ...(toolCalls.length > 0 && { toolCalls }),
    },
    finishReason: toolCalls.length > 0 ? 'tool-use' : mapFinishReason(candidate.finishReason),
  };
}

function toToolCall(call: FunctionCall, signature: string | undefined): ModelToolCall {
  return {
    id: call.id ?? `gemini-call-${randomUUID()}`,
    name: call.name ?? '',
    arguments: (call.args ?? {}) as Readonly<Record<string, unknown>>,
    ...(signature !== undefined && { signature }),
  };
}

const FILTERED = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
]);

/**
 * Gemini's `finishReason` as the framework's:
 *   - `STOP`, unspecified or absent → `stop` (a response with function
 *     calls is `tool-use` before this is consulted);
 *   - `MAX_TOKENS` → `length`;
 *   - the safety, recitation, blocklist and sensitive-data stops →
 *     `content-filter`;
 *   - anything else (a malformed or unexpected function call, too many
 *     tool calls, an unsupported language, `OTHER`) → `error`.
 */
export function mapFinishReason(reason: string | undefined): ModelCallResult['finishReason'] {
  if (reason === undefined || reason === 'STOP' || reason === 'FINISH_REASON_UNSPECIFIED') {
    return 'stop';
  }
  if (reason === 'MAX_TOKENS') return 'length';
  if (FILTERED.has(reason)) return 'content-filter';
  return 'error';
}
