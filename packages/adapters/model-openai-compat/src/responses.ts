// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The adapter's OpenAI Responses API path (`POST /v1/responses`). OpenAI's
 * GPT-6 models call tools only here; Chat Completions stays the path for
 * the OpenAI-compatible servers (`OpenAICompatProviderOptions.api`).
 *
 * Stateless: every call sends the whole conversation with `store: false`,
 * so OpenAI keeps no conversation state for Kindgi's calls. A reasoning
 * model's reasoning between its tool calls travels with the calls
 * instead: the response's reasoning items (encrypted by OpenAI), and the
 * ids and `phase` that tie them to the message and calls after them, go
 * into the first call's `ModelToolCall.signature`. When the conversation
 * continues with the same model, they're sent back in their order.
 */

import type OpenAI from 'openai';

import type {
  ModelCallInput,
  ModelCallResult,
  ModelCallWarning,
  ModelInfo,
  ModelMessage,
  ModelToolCall,
  ModelToolDefinition,
  UsageCounters,
} from '@kindgi/capabilities';
import type { AttemptCounter } from '@kindgi/capabilities/attempts';

import { computeCost, decodeToolName, encodeToolName, parseArguments } from './wire.js';

type InputItem = OpenAI.Responses.ResponseInputItem;
type OutputItem = OpenAI.Responses.ResponseOutputItem;
type Phase = 'commentary' | 'final_answer';

/** Request fields the Responses path sets itself; `extraBody` can't override them. */
export const EXTRA_BODY_RESERVED_RESPONSES = [
  'model',
  'input',
  'tools',
  'text',
  'temperature',
  'max_output_tokens',
  'stream',
  'store',
] as const;

/** One call on the Responses path, as `invoke` hands it over. */
export interface ResponsesCall {
  readonly client: OpenAI;
  readonly attempts: AttemptCounter;
  readonly input: ModelCallInput;
  readonly modelInfo: ModelInfo;
  readonly providerId: string;
  readonly extraBody: Readonly<Record<string, unknown>>;
  /** The endpoint is a data-residency host: the model's uplift applies (`computeCost`). */
  readonly dataResidency: boolean;
  /** The temperature to send; absent sends none. */
  readonly temperature?: number;
  /**
   * The reasoning effort to send (`reasoning.effort`): the model's lowest,
   * when the call asks for as little thinking as it allows. Absent: the
   * model's default, or a registration's `extraBody.reasoning`.
   */
  readonly reasoningEffort?: string;
  /** Warnings about the call, for the answer's `warnings`. */
  readonly warnings?: readonly ModelCallWarning[];
  /** When the call started (`Date.now()`), for `durationMs`. */
  readonly startedAt: number;
}

/**
 * A call's per-request options, on both paths: its abort signal, and its
 * `traceparent` as a header when the caller set it (the provider's
 * registration opted in). A header only: never in the body, and never logged.
 */
export function requestOptions(
  input: ModelCallInput,
): { signal?: AbortSignal; headers?: Record<string, string> } | undefined {
  if (input.abortSignal === undefined && input.traceparent === undefined) return undefined;
  return {
    ...(input.abortSignal !== undefined && { signal: input.abortSignal }),
    ...(input.traceparent !== undefined && { headers: { traceparent: input.traceparent } }),
  };
}

export async function invokeResponses(call: ResponsesCall): Promise<ModelCallResult> {
  const { input } = call;
  const tools = input.tools?.map(toTool);
  const counted = await call.attempts.count(() =>
    call.client.responses.create(
      {
        ...call.extraBody,
        model: input.model,
        input: toInput(input.messages, input.model),
        ...(tools !== undefined && tools.length > 0 && { tools }),
        ...(input.structuredOutput !== undefined && {
          text: {
            format: {
              type: 'json_schema' as const,
              name: input.structuredOutput.name,
              schema: input.structuredOutput.schema,
              strict: true,
            },
          },
        }),
        ...(call.temperature !== undefined && { temperature: call.temperature }),
        ...(call.reasoningEffort !== undefined && {
          reasoning: {
            ...(isRecord(call.extraBody.reasoning) ? call.extraBody.reasoning : {}),
            effort: call.reasoningEffort as OpenAI.ReasoningEffort,
          },
        }),
        ...(input.maxOutputTokens !== undefined && { max_output_tokens: input.maxOutputTokens }),
        store: false,
        stream: false,
      },
      requestOptions(input),
    ),
  );
  const response = counted.value;
  const durationMs = Date.now() - call.startedAt;
  refuseUnfinished(response, call.providerId);

  const output = readOutput(response.output, input.model);
  const usage = toFrameworkUsage(response.usage);
  const warnings = call.warnings ?? [];
  return {
    message: {
      role: 'assistant',
      content: output.content,
      ...(output.toolCalls.length > 0 && { toolCalls: output.toolCalls }),
    },
    finishReason: finishReasonOf(response, output.toolCalls.length > 0),
    usage,
    costUsd: computeCost(call.modelInfo, usage, { dataResidency: call.dataResidency }),
    durationMs,
    provider: { id: call.providerId, model: input.model },
    ...(typeof response.model === 'string' &&
      response.model !== '' && { servedModel: response.model }),
    ...(typeof response._request_id === 'string' && {
      providerRequestId: response._request_id,
    }),
    // An injected client sends with its own fetch: nothing was counted.
    ...(counted.attempts > 0 && { attempts: counted.attempts }),
    ...(response.usage !== undefined && { rawUsage: { ...response.usage } }),
    ...(warnings.length > 0 && { warnings: [...warnings] }),
  };
}

// ---------------------------------------------------------------------------
// Request

/** The conversation as Responses input items, in order. */
function toInput(messages: readonly ModelMessage[], model: string): InputItem[] {
  const items: InputItem[] = [];
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        // The role OpenAI's Responses guides give an app's instructions.
        items.push({ role: 'developer', content: m.content });
        break;
      case 'user':
        items.push({ role: 'user', content: m.content });
        break;
      case 'tool':
        items.push({
          type: 'function_call_output',
          call_id: m.toolCallId ?? '',
          output: m.content,
        });
        break;
      case 'assistant':
        items.push(...assistantItems(m, model));
        break;
    }
  }
  return items;
}

/**
 * An assistant turn. With tool calls this model made, and their carried
 * output (`readCarried`), it goes back as the response gave it: reasoning,
 * message and calls in their order, linked by their ids. Otherwise as its
 * text and its calls, without ids: an item id names output the reasoning
 * belongs with, so none is sent without it.
 */
function assistantItems(m: ModelMessage, model: string): InputItem[] {
  const calls = m.toolCalls ?? [];
  const carried = readCarried(calls, model);
  if (carried === undefined) {
    return [
      ...(m.content !== '' ? [{ role: 'assistant' as const, content: m.content }] : []),
      ...calls.map((c) => functionCall(c, undefined)),
    ];
  }
  // Item ids link reasoning to what follows it; without reasoning, none are sent.
  const linked = carried.some((item) => item.type === 'reasoning');
  const byId = new Map(calls.map((c) => [c.id, c] as const));
  return carried.flatMap((item): InputItem[] => {
    switch (item.type) {
      case 'reasoning':
        return [
          {
            type: 'reasoning',
            id: item.id,
            summary: item.summary.map((s) => ({ type: 'summary_text' as const, text: s.text })),
            encrypted_content: item.encrypted_content,
          },
        ];
      case 'message':
        return m.content === '' ? [] : [carriedMessage(item, m.content, linked)];
      case 'function_call':
        // readCarried checked the turn has this call.
        return [
          functionCall(byId.get(item.call_id) as ModelToolCall, linked ? item.id : undefined),
        ];
    }
  });
}

/** The turn's text, as the carried message it came in. */
function carriedMessage(
  item: Extract<CarriedItem, { type: 'message' }>,
  text: string,
  linked: boolean,
): InputItem {
  const phase = item.phase !== undefined ? { phase: item.phase } : {};
  return linked
    ? {
        type: 'message',
        id: item.id,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
        ...phase,
      }
    : { role: 'assistant', content: text, ...phase };
}

function functionCall(call: ModelToolCall, id: string | undefined): InputItem {
  return {
    type: 'function_call',
    call_id: call.id,
    // Encode when replaying prior assistant turns — see `encodeToolName`.
    name: encodeToolName(call.name),
    arguments: JSON.stringify(call.arguments),
    ...(id !== undefined && { id }),
  };
}

function toTool(tool: ModelToolDefinition): OpenAI.Responses.FunctionTool {
  return {
    type: 'function',
    name: encodeToolName(tool.name),
    description: tool.description,
    parameters: tool.inputSchema as Record<string, unknown>,
    // As on the Chat Completions path: tools' schemas needn't meet strict mode.
    strict: false,
  };
}

// ---------------------------------------------------------------------------
// Response

/** A `failed` (or never finished) response throws, naming OpenAI's error. */
function refuseUnfinished(response: OpenAI.Responses.Response, providerId: string): void {
  const status = response.status ?? 'completed';
  if (status === 'completed' || status === 'incomplete') return;
  const error = response.error;
  const why = error != null ? `${error.code}: ${error.message}` : `status "${status}"`;
  throw new Error(
    `@kindgi/adapter-model-openai-compat: provider "${providerId}": the response ${status === 'failed' ? 'failed' : `ended "${status}"`} (${why}).`,
  );
}

interface Output {
  readonly content: string;
  readonly toolCalls: readonly ModelToolCall[];
}

/** What `readOutput` has read so far. */
interface Reading {
  text: string;
  refusal: string;
  readonly calls: ModelToolCall[];
  readonly carried: CarriedItem[];
  reasoning: number;
  messages: number;
  phased: boolean;
  /** Something the next call couldn't send back as it came. */
  unlinkable: boolean;
}

/**
 * The answer's text (its refusal when it has no text) and tool calls.
 * The first call carries what the next call needs back.
 */
function readOutput(output: readonly OutputItem[], model: string): Output {
  const read: Reading = {
    text: '',
    refusal: '',
    calls: [],
    carried: [],
    reasoning: 0,
    messages: 0,
    phased: false,
    unlinkable: false,
  };
  for (const item of output) {
    if (item.type === 'reasoning') readReasoning(item, read);
    else if (item.type === 'message') readMessage(item, read);
    else if (item.type === 'function_call') readFunctionCall(item, read);
  }
  // Carried when there's something to send back (reasoning, or a phase)
  // and the next call can send it as it came: every reasoning item with
  // its encrypted content, every call with its id, and at most one
  // message (the turn keeps one text, so two can't be told apart).
  const carry =
    read.calls.length > 0 &&
    (read.reasoning > 0 || read.phased) &&
    !read.unlinkable &&
    read.messages <= 1
      ? writeSignature({ model, items: read.carried })
      : undefined;
  return {
    content: read.text !== '' ? read.text : read.refusal,
    toolCalls: read.calls.map((c, i) =>
      i === 0 && carry !== undefined ? { ...c, signature: carry } : c,
    ),
  };
}

function readReasoning(item: OpenAI.Responses.ResponseReasoningItem, read: Reading): void {
  read.reasoning += 1;
  if (typeof item.encrypted_content !== 'string' || item.encrypted_content === '') {
    read.unlinkable = true;
    return;
  }
  read.carried.push({
    type: 'reasoning',
    id: item.id,
    summary: item.summary.map((s) => ({ text: s.text })),
    encrypted_content: item.encrypted_content,
  });
}

function readMessage(item: OpenAI.Responses.ResponseOutputMessage, read: Reading): void {
  read.messages += 1;
  for (const part of item.content) {
    if (part.type === 'output_text') read.text += part.text;
    else if (part.type === 'refusal') read.refusal += part.refusal;
  }
  const phase = item.phase ?? undefined;
  if (phase !== undefined) read.phased = true;
  read.carried.push({ type: 'message', id: item.id, ...(phase !== undefined && { phase }) });
}

function readFunctionCall(item: OpenAI.Responses.ResponseFunctionToolCall, read: Reading): void {
  // Decode: the wire returns the encoded name; the framework
  // expects the canonical dotted form.
  read.calls.push({
    id: item.call_id,
    name: decodeToolName(item.name),
    arguments: parseArguments(item.arguments),
  });
  if (item.id === undefined) read.unlinkable = true;
  else read.carried.push({ type: 'function_call', id: item.id, call_id: item.call_id });
}

function finishReasonOf(
  response: OpenAI.Responses.Response,
  hasToolCalls: boolean,
): ModelCallResult['finishReason'] {
  if (response.status === 'incomplete') {
    switch (response.incomplete_details?.reason) {
      case 'max_output_tokens':
        return 'length';
      case 'content_filter':
        return 'content-filter';
    }
  }
  return hasToolCalls ? 'tool-use' : 'stop';
}

/**
 * The response's usage as the framework's counters. `input_tokens`
 * include the cached ones (`input_tokens_details`), and `output_tokens`
 * the reasoning ones (`output_tokens_details.reasoning_tokens`): reported
 * apart when the response gives them.
 */
function toFrameworkUsage(usage: OpenAI.Responses.ResponseUsage | undefined): UsageCounters {
  const cacheRead = usage?.input_tokens_details?.cached_tokens;
  const cacheWrite = usage?.input_tokens_details?.cache_write_tokens;
  const reasoning = usage?.output_tokens_details?.reasoning_tokens;
  return {
    promptTokens: usage?.input_tokens ?? 0,
    completionTokens: usage?.output_tokens ?? 0,
    // A part the response reports is kept, 0 included.
    ...(typeof cacheRead === 'number' && { cacheReadTokens: cacheRead }),
    ...(typeof cacheWrite === 'number' && { cacheWriteTokens: cacheWrite }),
    ...(typeof reasoning === 'number' && { reasoningTokens: reasoning }),
  };
}

// ---------------------------------------------------------------------------
// The carried output (`ModelToolCall.signature`)

type CarriedItem =
  | {
      readonly type: 'reasoning';
      readonly id: string;
      readonly summary: readonly { readonly text: string }[];
      readonly encrypted_content: string;
    }
  | { readonly type: 'message'; readonly id: string; readonly phase?: Phase }
  | { readonly type: 'function_call'; readonly id: string; readonly call_id: string };

interface Carried {
  /** The model that answered: only that model gets it back. */
  readonly model: string;
  /** The response's output, in order, without the text and arguments the turn keeps. */
  readonly items: readonly CarriedItem[];
}

/** Versioned, so a later shape can tell this one apart. */
const SIGNATURE_PREFIX = 'oair1.';

function writeSignature(carried: Carried): string {
  return SIGNATURE_PREFIX + Buffer.from(JSON.stringify(carried), 'utf8').toString('base64url');
}

/**
 * The output carried on an assistant turn's first call, when it's this
 * adapter's, for `model`, and names exactly the turn's calls in order.
 * Anything else (another adapter's signature, another model's, one that
 * doesn't parse) is ignored: the turn goes back without it.
 */
function readCarried(
  calls: readonly ModelToolCall[],
  model: string,
): readonly CarriedItem[] | undefined {
  const signature = calls[0]?.signature;
  if (signature === undefined || !signature.startsWith(SIGNATURE_PREFIX)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(signature.slice(SIGNATURE_PREFIX.length), 'base64url').toString('utf8'),
    );
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.model !== model || !Array.isArray(parsed.items)) {
    return undefined;
  }
  const items = parsed.items as unknown[];
  if (!items.every(isCarriedItem)) return undefined;
  const callIds = items.flatMap((item) => (item.type === 'function_call' ? [item.call_id] : []));
  if (callIds.length !== calls.length || callIds.some((id, i) => id !== calls[i]?.id)) {
    return undefined;
  }
  return items;
}

function isCarriedItem(value: unknown): value is CarriedItem {
  if (!isRecord(value) || typeof value.id !== 'string') return false;
  switch (value.type) {
    case 'reasoning':
      return (
        typeof value.encrypted_content === 'string' &&
        Array.isArray(value.summary) &&
        value.summary.every((s) => isRecord(s) && typeof s.text === 'string')
      );
    case 'message':
      return (
        value.phase === undefined || value.phase === 'commentary' || value.phase === 'final_answer'
      );
    case 'function_call':
      return typeof value.call_id === 'string';
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
