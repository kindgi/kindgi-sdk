// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Today's engine: Kindgi's `ModelProvider` over an AI SDK provider model (provider spec V4),
 * called at the spec level (`doGenerate`), never the `ai` package, its agent loop or Vercel's
 * gateway. This module is the only place in the package that
 * knows the AI SDK: an adapter hands in its model (`languageModel`), its provider options and
 * its cost formula, and gets a plain `ModelProvider` back. It does, the same way for each:
 *   - our retries (`../retries.ts`), counted per HTTP attempt (`@kindgi/capabilities/attempts`);
 *   - typed errors (`ModelProviderError`, `../errors.ts`);
 *   - the provider's opaque reasoning state, carried across a pause in the first tool call's
 *     `signature` (`aisdk1.`) and sent back on the next call to the same model;
 *   - usage onto our counters, sampling a model refuses dropped with a warning, `traceparent`
 *     sent only when the call has one.
 */
import { APICallError } from '@ai-sdk/provider';
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  SharedV4ProviderMetadata,
  SharedV4ProviderOptions,
} from '@ai-sdk/provider';

import { samplingFor } from '@kindgi/capabilities';
import type {
  ModelCallInput,
  ModelCallResult,
  ModelCallWarning,
  ModelInfo,
  ModelMessage,
  ModelProvider,
  ModelToolCall,
  ProviderMetadata,
  UsageCounters,
} from '@kindgi/capabilities';
import { createAttemptCounter } from '@kindgi/capabilities/attempts';
import { nameToolsAsSent } from '@kindgi/capabilities/tool-names';

import { ModelProviderError, modelProviderError } from '../errors.js';
import { type RetryableFailure, withRetries } from '../retries.js';

export interface AiSdkModelProviderOptions {
  readonly metadata: ProviderMetadata;
  /** The provider's model for a name, sending with `fetch` (it counts each HTTP attempt). */
  readonly languageModel: (name: string, fetch: typeof globalThis.fetch) => LanguageModelV4;
  /** Provider options on every call (OpenAI: `store: false`). */
  readonly providerOptions?: (model: ModelInfo) => SharedV4ProviderOptions | undefined;
  /** Our cost formula for this vendor, from its usage. */
  readonly cost: (model: ModelInfo, usage: UsageCounters) => number;
  /** HTTP attempts in all on a retryable failure (408, 409, 429, 5xx, network). Default 3. */
  readonly attempts?: number;
  /**
   * Run before each HTTP attempt, inside the retries: where an adapter checks its sign-in (the
   * runtime's identity) itself, when its library would report a failure as a plain error. A
   * `ModelProviderError` thrown here (or anywhere in the adapter's own code) ends the call as it
   * is, never retried.
   */
  readonly beforeAttempt?: () => Promise<void>;
  /**
   * A sentence for a failed call's message, where the vendor's own words don't say what to
   * check (Bedrock's 403: the IAM policy, or the account's access to the model). Undefined:
   * the message as it is.
   */
  readonly explain?: (error: ModelProviderError) => string | undefined;
}

const wireName = (name: string) => name.replace(/\./g, '__');
const ourName = (name: string) => name.replace(/__/g, '.');

export function createAiSdkModelProvider(options: AiSdkModelProviderOptions): ModelProvider {
  const { metadata } = options;
  const models = new Map(metadata.models.map((m) => [m.name, m] as const));
  const counter = createAttemptCounter();
  const built = new Map<string, LanguageModelV4>();
  const lm = (name: string) => {
    let model = built.get(name);
    if (model === undefined) {
      model = options.languageModel(name, counter.fetch);
      built.set(name, model);
    }
    return model;
  };

  return {
    metadata,
    async invoke(input: ModelCallInput): Promise<ModelCallResult> {
      const model = models.get(input.model);
      if (model === undefined) {
        throw new ModelProviderError(
          'invalid-request',
          undefined,
          `provider "${metadata.id}" has no model "${input.model}"`,
        );
      }
      const startedAt = Date.now();
      const toolIds = input.tools?.map((t) => t.name) ?? [];
      const sampling = samplingFor(model, input);
      const maxOutputTokens = input.maxOutputTokens ?? model.maxOutputTokens;
      const extra = options.providerOptions?.(model);
      const call: LanguageModelV4CallOptions = {
        prompt: toPrompt(input.messages, input.model, toolIds),
        ...(maxOutputTokens !== undefined && { maxOutputTokens }),
        ...(sampling.temperature !== undefined && { temperature: sampling.temperature }),
        ...(input.tools !== undefined &&
          input.tools.length > 0 && {
            tools: input.tools.map((t) => ({
              type: 'function' as const,
              name: wireName(t.name),
              description: t.description,
              inputSchema: t.inputSchema as never,
            })),
            toolChoice: { type: 'auto' as const },
          }),
        ...(input.structuredOutput !== undefined && {
          responseFormat: {
            type: 'json' as const,
            schema: input.structuredOutput.schema as never,
            name: input.structuredOutput.name,
          },
        }),
        ...(input.thinking === 'lowest' &&
          model.thinking !== undefined && { reasoning: portableReasoning(model.thinking.lowest) }),
        ...(input.abortSignal !== undefined && { abortSignal: input.abortSignal }),
        ...(input.traceparent !== undefined && { headers: { traceparent: input.traceparent } }),
        ...(extra !== undefined && { providerOptions: extra }),
      };
      const counted = await counter.count(() =>
        withRetries(
          async () => {
            await options.beforeAttempt?.();
            return lm(input.model).doGenerate(call);
          },
          {
            attempts: options.attempts ?? 3,
            ...(input.abortSignal !== undefined && { signal: input.abortSignal }),
            describe: describeFailure,
            // An adapter's own typed error (its sign-in failed) is the answer as it is.
            toError: (failure, error) =>
              explained(
                error instanceof ModelProviderError ? error : modelProviderError(failure, error),
                options.explain,
              ),
          },
        ),
      );
      const result = counted.value;

      const toolCalls: ModelToolCall[] = [];
      for (const part of result.content) {
        if (part.type === 'tool-call' && part.providerExecuted !== true) {
          toolCalls.push({
            id: part.toolCallId,
            name: ourName(part.toolName),
            arguments: parseJson(part.input),
          });
        }
      }
      if (toolCalls.length > 0) {
        const first = toolCalls[0] as ModelToolCall;
        toolCalls[0] = { ...first, signature: encodeCarry(input.model, result.content) };
      }
      const text = result.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
      const usage = toUsage(result.usage);
      const warnings: ModelCallWarning[] = [
        ...sampling.warnings,
        ...result.warnings.map((w) => ({
          code: `sdk-${w.type}`,
          message:
            'feature' in w
              ? `${w.feature}${w.details ? `: ${w.details}` : ''}`
              : 'message' in w
                ? String(w.message)
                : JSON.stringify(w),
        })),
      ];
      const headers = result.response?.headers ?? {};
      const requestId =
        headers['x-request-id'] ??
        headers['request-id'] ??
        headers['x-amzn-requestid'] ??
        headers['apim-request-id'] ??
        result.response?.id;
      return {
        message: { role: 'assistant', content: text, ...(toolCalls.length > 0 && { toolCalls }) },
        finishReason: toolCalls.length > 0 ? 'tool-use' : finishReason(result.finishReason),
        usage,
        costUsd: options.cost(model, usage),
        durationMs: Date.now() - startedAt,
        provider: { id: metadata.id, model: input.model },
        ...(result.response?.modelId !== undefined && { servedModel: result.response.modelId }),
        ...(requestId !== undefined && { providerRequestId: requestId }),
        ...(counted.attempts > 0 && { attempts: counted.attempts }),
        ...(result.usage.raw !== undefined && { rawUsage: result.usage.raw }),
        ...(warnings.length > 0 && { warnings }),
      };
    },
  };
}

/** Our lowest-thinking values onto the SDK's portable `reasoning` levels. */
function portableReasoning(lowest: string): NonNullable<LanguageModelV4CallOptions['reasoning']> {
  if (lowest === 'disabled') return 'none';
  if (lowest === 'between_tools') return 'low';
  return lowest as NonNullable<LanguageModelV4CallOptions['reasoning']>;
}

/** The model's own reason when the library has no unified one for it: out of context is `length`. */
const CONTEXT_WINDOW_STOP = /context_window|context_length/i;

function finishReason(reason: {
  readonly unified: string;
  readonly raw?: string | undefined;
}): ModelCallResult['finishReason'] {
  switch (reason.unified) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content-filter':
      return 'content-filter';
    case 'tool-calls':
      return 'tool-use';
    default:
      return reason.raw !== undefined && CONTEXT_WINDOW_STOP.test(reason.raw) ? 'length' : 'error';
  }
}

function toUsage(u: {
  inputTokens: Record<string, number | undefined>;
  outputTokens: Record<string, number | undefined>;
}): UsageCounters {
  const read = u.inputTokens.cacheRead;
  const write = u.inputTokens.cacheWrite;
  const reasoning = u.outputTokens.reasoning;
  return {
    promptTokens: u.inputTokens.total ?? (u.inputTokens.noCache ?? 0) + (read ?? 0) + (write ?? 0),
    completionTokens: u.outputTokens.total ?? 0,
    ...(read !== undefined && { cacheReadTokens: read }),
    ...(write !== undefined && { cacheWriteTokens: write }),
    ...(reasoning !== undefined && { reasoningTokens: reasoning }),
  };
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * The opaque state a provider returns with an answer (reasoning parts with their signatures or
 * encrypted content, tool calls' thought signatures), in order, carried in the first tool call's
 * `signature` and sent back as `providerOptions` on the next call to the same model.
 */
interface Carry {
  readonly model: string;
  readonly parts: readonly (
    | {
        readonly type: 'reasoning';
        readonly text: string;
        readonly meta?: SharedV4ProviderMetadata;
      }
    | { readonly type: 'text'; readonly meta?: SharedV4ProviderMetadata }
    | { readonly type: 'tool-call'; readonly id: string; readonly meta?: SharedV4ProviderMetadata }
  )[];
}

function encodeCarry(model: string, content: readonly LanguageModelV4Content[]): string {
  const parts: Carry['parts'][number][] = [];
  for (const p of content) {
    if (p.type === 'reasoning')
      parts.push({
        type: 'reasoning',
        text: p.text,
        ...(p.providerMetadata && { meta: p.providerMetadata }),
      });
    else if (p.type === 'text')
      parts.push({ type: 'text', ...(p.providerMetadata && { meta: p.providerMetadata }) });
    else if (p.type === 'tool-call' && p.providerExecuted !== true)
      parts.push({
        type: 'tool-call',
        id: p.toolCallId,
        ...(p.providerMetadata && { meta: p.providerMetadata }),
      });
  }
  const carry: Carry = { model, parts };
  return `aisdk1.${Buffer.from(JSON.stringify(carry)).toString('base64url')}`;
}

function decodeCarry(signature: string | undefined, model: string): Carry | undefined {
  if (signature === undefined || !signature.startsWith('aisdk1.')) return undefined;
  try {
    const carry = JSON.parse(
      Buffer.from(signature.slice(7), 'base64url').toString('utf8'),
    ) as Carry;
    return carry.model === model ? carry : undefined;
  } catch {
    return undefined;
  }
}

/** Our message trail as the spec's prompt; a carried answer is rebuilt part by part. */
function toPrompt(
  messages: readonly ModelMessage[],
  model: string,
  toolIds: readonly string[],
): LanguageModelV4Prompt {
  const prompt: LanguageModelV4Message[] = [];
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'system') {
      prompt.push({ role: 'system', content: nameToolsAsSent(m.content, toolIds, wireName) });
    } else if (m.role === 'user') {
      prompt.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
    } else if (m.role === 'assistant') {
      const calls = m.toolCalls ?? [];
      for (const c of calls) toolNames.set(c.id, wireName(c.name));
      const carry = decodeCarry(calls[0]?.signature, model);
      const content: Extract<LanguageModelV4Message, { role: 'assistant' }>['content'] = [];
      if (carry !== undefined) {
        const byId = new Map(calls.map((c) => [c.id, c] as const));
        for (const p of carry.parts) {
          if (p.type === 'reasoning')
            content.push({
              type: 'reasoning',
              text: p.text,
              ...(p.meta && { providerOptions: p.meta }),
            });
          else if (p.type === 'text' && m.content.length > 0)
            content.push({
              type: 'text',
              text: m.content,
              ...(p.meta && { providerOptions: p.meta }),
            });
          else if (p.type === 'tool-call') {
            const c = byId.get(p.id);
            if (c !== undefined)
              content.push({
                type: 'tool-call',
                toolCallId: c.id,
                toolName: wireName(c.name),
                input: c.arguments,
                ...(p.meta && { providerOptions: p.meta }),
              });
          }
        }
      } else {
        if (m.content.length > 0) content.push({ type: 'text', text: m.content });
        for (const c of calls)
          content.push({
            type: 'tool-call',
            toolCallId: c.id,
            toolName: wireName(c.name),
            input: c.arguments,
          });
      }
      if (content.length > 0) prompt.push({ role: 'assistant', content });
    } else {
      const id = m.toolCallId ?? '';
      const part = {
        type: 'tool-result' as const,
        toolCallId: id,
        toolName: toolNames.get(id) ?? 'unknown',
        output: { type: 'text' as const, value: m.content },
      };
      const last = prompt[prompt.length - 1];
      if (last?.role === 'tool') last.content.push(part);
      else prompt.push({ role: 'tool', content: [part] });
    }
  }
  return prompt;
}

/** The error with the adapter's sentence after its message, when it has one. */
function explained(
  error: ModelProviderError,
  explain: AiSdkModelProviderOptions['explain'],
): ModelProviderError {
  const sentence = explain?.(error);
  if (sentence === undefined || sentence === '') return error;
  return new ModelProviderError(error.kind, error.status, `${error.message} ${sentence}`, {
    cause: error.cause,
  });
}

/** An AI SDK failure as the retry policy and the typed error need it. */
function describeFailure(error: unknown): RetryableFailure {
  if (error instanceof ModelProviderError) {
    return {
      ...(error.status !== undefined && { status: error.status }),
      words: error.message,
      retryable: false,
    };
  }
  if (!APICallError.isInstance(error)) {
    // No response at all: a dropped connection, DNS, TLS.
    return { words: (error as Error)?.message ?? String(error), retryable: true };
  }
  return {
    ...(error.statusCode !== undefined && { status: error.statusCode }),
    words: error.responseBody?.trim() || error.message,
    retryable: error.isRetryable,
    ...(error.responseHeaders !== undefined && { headers: error.responseHeaders }),
  };
}
