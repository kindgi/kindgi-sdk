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
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  AISDKError,
  APICallError,
  EmptyResponseBodyError,
  InvalidResponseDataError,
  JSONParseError,
  TypeValidationError,
} from '@ai-sdk/provider';
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
   * The fetch each HTTP attempt goes through, counted. For an endpoint the registration
   * chose, the runtime's (`AdapterFactoryInput.fetch`, which refuses the hosts its deployment
   * forbids). Default: the global `fetch`.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Run before each HTTP attempt, inside the retries, with the call's abort signal: where an
   * adapter signs in (the runtime's identity, a key) itself, so a failure is typed by the adapter
   * rather than by its library. What it returns is this attempt's own (`attemptPrepared()`), for
   * the adapter's code the library calls during the attempt. A `ModelProviderError` thrown here
   * (or anywhere in the adapter's own code) ends the call as it is, never retried.
   */
  readonly beforeAttempt?: (signal: AbortSignal | undefined) => Promise<unknown>;
  /**
   * A sentence for a failed call's message, where the vendor's own words don't say what to
   * check (Bedrock's 403: the IAM policy, or the account's access to the model). Undefined:
   * the message as it is.
   */
  readonly explain?: (error: ModelProviderError) => string | undefined;
}

/** Each attempt's `beforeAttempt` result, for the code the library calls during that attempt. */
const attemptScope = new AsyncLocalStorage<{ readonly prepared: unknown }>();

/**
 * What this attempt's `beforeAttempt` returned, read from code the library calls during the
 * attempt (a credential provider, a fetch wrapper); undefined outside one. Per attempt, so calls
 * running at once never see each other's.
 */
export function attemptPrepared<T>(): T | undefined {
  return attemptScope.getStore()?.prepared as T | undefined;
}

const wireName = (name: string) => name.replace(/\./g, '__');
const ourName = (name: string) => name.replace(/__/g, '.');

export function createAiSdkModelProvider(options: AiSdkModelProviderOptions): ModelProvider {
  const { metadata } = options;
  const models = new Map(metadata.models.map((m) => [m.name, m] as const));
  const counter = createAttemptCounter(options.fetch);
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
        prompt: toPrompt(input.messages, { provider: metadata.id, model: input.model }, toolIds),
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
            const prepared = await options.beforeAttempt?.(input.abortSignal);
            return attemptScope.run({ prepared }, () => lm(input.model).doGenerate(call));
          },
          {
            attempts: options.attempts ?? 3,
            ...(input.abortSignal !== undefined && { signal: input.abortSignal }),
            describe: describeFailure,
            // An adapter's own typed error (its sign-in failed) is the answer as it is; an error
            // that's neither the vendor's answer nor the network (a bug) propagates as it is.
            toError: (failure, error) => {
              const own = adapterError(error);
              if (own === undefined && failure.unrecognized === true) {
                return error instanceof Error ? error : new Error(String(error));
              }
              return explained(own ?? modelProviderError(failure, error), options.explain);
            },
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
        toolCalls[0] = {
          ...first,
          signature: encodeCarry({ provider: metadata.id, model: input.model }, result.content),
        };
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
 * encrypted content, text parts' ids, tool calls' thought signatures), in order, carried in the
 * first tool call's `signature` and sent back as `providerOptions` on the next call to the same
 * provider's same model. Only there: two providers can serve a model of the same name.
 */
interface Carry {
  readonly provider: string;
  readonly model: string;
  readonly parts: readonly (
    | {
        readonly type: 'reasoning';
        readonly text: string;
        readonly meta?: SharedV4ProviderMetadata;
      }
    | { readonly type: 'text'; readonly text: string; readonly meta?: SharedV4ProviderMetadata }
    | { readonly type: 'tool-call'; readonly id: string; readonly meta?: SharedV4ProviderMetadata }
  )[];
}

/** Whose answer a carry is: the provider's id and the model's name. */
interface CarryOwner {
  readonly provider: string;
  readonly model: string;
}

function encodeCarry(owner: CarryOwner, content: readonly LanguageModelV4Content[]): string {
  const parts: Carry['parts'][number][] = [];
  for (const p of content) {
    if (p.type === 'reasoning')
      parts.push({
        type: 'reasoning',
        text: p.text,
        ...(p.providerMetadata && { meta: p.providerMetadata }),
      });
    else if (p.type === 'text')
      parts.push({
        type: 'text',
        text: p.text,
        ...(p.providerMetadata && { meta: p.providerMetadata }),
      });
    else if (p.type === 'tool-call' && p.providerExecuted !== true)
      parts.push({
        type: 'tool-call',
        id: p.toolCallId,
        ...(p.providerMetadata && { meta: p.providerMetadata }),
      });
  }
  const carry: Carry = { provider: owner.provider, model: owner.model, parts };
  return `aisdk1.${Buffer.from(JSON.stringify(carry)).toString('base64url')}`;
}

function decodeCarry(signature: string | undefined, owner: CarryOwner): Carry | undefined {
  if (signature === undefined || !signature.startsWith('aisdk1.')) return undefined;
  try {
    const carry = JSON.parse(
      Buffer.from(signature.slice(7), 'base64url').toString('utf8'),
    ) as Carry;
    return carry.provider === owner.provider && carry.model === owner.model ? carry : undefined;
  } catch {
    return undefined;
  }
}

/** Our message trail as the spec's prompt; a carried answer is rebuilt part by part. */
function toPrompt(
  messages: readonly ModelMessage[],
  owner: CarryOwner,
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
      const carry = decodeCarry(calls[0]?.signature, owner);
      const content: Extract<LanguageModelV4Message, { role: 'assistant' }>['content'] = [];
      if (carry !== undefined) {
        const byId = new Map(calls.map((c) => [c.id, c] as const));
        // The answer's text as the model gave it, part by part with each part's own state, while
        // the trail still says the same; once it doesn't (a caller trimmed or redacted it), the
        // trail's text alone, where the first part was, without state that was about other words.
        const texts = carry.parts.flatMap((p) => (p.type === 'text' ? [p.text] : []));
        const faithful = texts.join('') === m.content;
        let textPlaced = false;
        const placeText = () => {
          if (!textPlaced && m.content.length > 0) content.push({ type: 'text', text: m.content });
          textPlaced = true;
        };
        for (const p of carry.parts) {
          if (p.type === 'reasoning')
            content.push({
              type: 'reasoning',
              text: p.text,
              ...(p.meta && { providerOptions: p.meta }),
            });
          else if (p.type === 'text' && faithful) {
            if (p.text.length > 0 || p.meta !== undefined)
              content.push({
                type: 'text',
                text: p.text,
                ...(p.meta && { providerOptions: p.meta }),
              });
          } else if (p.type === 'text') placeText();
          else if (p.type === 'tool-call') {
            if (!faithful) placeText();
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

/**
 * The adapter's own typed error, as thrown, or as the library re-wrapped it: the AI SDK turns an
 * error from a fetch wrapper whose cause carries a network code (`ECONNREFUSED` while a key is
 * read, say) into a retryable "Cannot connect to API", with the adapter's error as its cause.
 */
function adapterError(error: unknown): ModelProviderError | undefined {
  if (error instanceof ModelProviderError) return error;
  if (APICallError.isInstance(error) && error.cause instanceof ModelProviderError) {
    return error.cause;
  }
  return undefined;
}

/**
 * The codes of a failed connection, as Node (`ECONNRESET`), undici (`UND_ERR_SOCKET`) and Bun
 * (`ConnectionRefused`) set them on an error or its causes: the AI SDK's list, plus DNS.
 */
const TRANSPORT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'ConnectionRefused',
  'ConnectionClosed',
  'FailedToOpenSocket',
]);

/** A failed connection: `fetch failed`, or a transport code on the error or one of its causes. */
function isTransport(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e = error; e instanceof Error && !seen.has(e); e = e.cause) {
    seen.add(e);
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSPORT_CODES.has(code)) return true;
    if (e instanceof TypeError && /^(fetch failed|failed to fetch)$/i.test(e.message)) return true;
  }
  return false;
}

/**
 * A connection refused by policy, the same every time it's tried: a redirect the request won't
 * follow (its credential goes to the endpoint only), or a host refused before any connection, by
 * a system-style code that isn't a dropped connection's (the runtime's egress rules:
 * `EKINDGIEGRESS`). Its kind and words, when it's one.
 */
function refusedConnection(
  error: unknown,
): { readonly kind: 'unavailable' | 'network'; readonly words: string } | undefined {
  const seen = new Set<unknown>();
  for (let e = error; e instanceof Error && !seen.has(e); e = e.cause) {
    seen.add(e);
    if (/^unexpected redirect$/i.test(e.message)) {
      return {
        kind: 'unavailable',
        words:
          "the endpoint answered with a redirect, which isn't followed: a request's credential goes to its endpoint only. Check the endpoint.",
      };
    }
    const code = (e as { code?: unknown }).code;
    if (
      typeof code === 'string' &&
      /^E[A-Z0-9_]+$/.test(code) &&
      !code.startsWith('ERR_') &&
      !TRANSPORT_CODES.has(code)
    ) {
      return { kind: 'network', words: e.message };
    }
  }
  return undefined;
}

/** An answer the library couldn't read: a malformed 200, an empty body, a shape it doesn't know. */
function isUnreadableAnswer(error: unknown): boolean {
  return (
    InvalidResponseDataError.isInstance(error) ||
    JSONParseError.isInstance(error) ||
    TypeValidationError.isInstance(error) ||
    EmptyResponseBodyError.isInstance(error)
  );
}

/** A failure as the retry policy needs it, and whether it's one we know (a bug isn't). */
interface DescribedFailure extends RetryableFailure {
  readonly unrecognized?: true;
}

/** An AI SDK failure as the retry policy and the typed error need it. */
function describeFailure(error: unknown): DescribedFailure {
  const words = error instanceof Error ? error.message : String(error);
  const own = adapterError(error);
  if (own !== undefined) {
    return {
      ...(own.status !== undefined && { status: own.status }),
      words: own.message,
      retryable: false,
    };
  }
  // Refused, not dropped: before the library's own verdict, which retries any failed connection.
  const refused = refusedConnection(error);
  if (refused !== undefined) return { ...refused, retryable: false };
  if (APICallError.isInstance(error)) {
    return {
      ...(error.statusCode !== undefined && { status: error.statusCode }),
      words: error.responseBody?.trim() || error.message,
      retryable: error.isRetryable,
      ...(error.responseHeaders !== undefined && { headers: error.responseHeaders }),
    };
  }
  // No response at all: a dropped connection, DNS, TLS.
  if (isTransport(error)) return { words, retryable: true };
  // The vendor answered, and we couldn't read it. Once more, in case it was a bad gateway's
  // page; not again, since each answer may be billed.
  if (isUnreadableAnswer(error)) {
    return { kind: 'unavailable', words, retryable: true, maxAttempts: 2 };
  }
  // The request couldn't be built or sent as asked (a prompt or setting the provider refuses
  // before any HTTP): the caller's request, not retried.
  if (AISDKError.isInstance(error)) return { kind: 'invalid-request', words, retryable: false };
  return { words, retryable: false, unrecognized: true };
}
