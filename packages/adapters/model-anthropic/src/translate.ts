// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type Anthropic from '@anthropic-ai/sdk';

import type {
  ModelCallResult,
  ModelMessage,
  ModelToolCall,
  ModelToolDefinition,
} from '@kindgi/capabilities';

/**
 * The framework's tool id convention is `<pack>.<tool>` — e.g.
 * `acme.orders.lookup`. Anthropic's Messages API rejects tool
 * names that don't match `^[a-zA-Z0-9_-]{1,128}$` (in particular,
 * dots are forbidden), so this adapter transparently encodes tool
 * names on the way out and decodes them on the way in.
 *
 * Encoding is a simple `.` → `__` substitution. It isn't undone by
 * substitution: a tool id can hold `__` itself (an MCP server names its
 * tools as it likes), so the provider looks each call's name up among the
 * request's own tools (`toolIdsBySentName`), and `decodeToolName` is only
 * the fallback for a name the request didn't send. The substitution is
 * contained to the wire boundary; the message trail, runtime registry,
 * and provenance records all continue to see the canonical
 * `<pack>.<tool>` form.
 */
export function encodeToolName(name: string): string {
  return name.replace(/\./g, '__');
}

export function decodeToolName(name: string): string {
  return name.replace(/__/g, '.');
}

/**
 * Translate a framework message trail to the Anthropic Messages API
 * shape. Two structural mappings matter:
 *
 *   - `role: 'system'` messages lift out of the message array into
 *     Anthropic's top-level `system` parameter. Multiple system
 *     messages concatenate with a blank-line separator, preserving
 *     order — the framework's message-trail contract lets any handler
 *     push a system message, so we don't assume there's only one.
 *   - `role: 'tool'` messages fold into `role: 'user'` messages
 *     carrying `tool_result` content blocks. Anthropic requires tool
 *     results to arrive as user turns; consecutive tool results
 *     merge into a single user message (matching the framework's
 *     dispatch-tools handler which appends one tool message per call
 *     after an assistant `tool_use` turn).
 *
 * `systemParts` keeps the system messages apart, in order, so each can be
 * its own block: the first (the agent's prompt) is the stable one a cache
 * breakpoint goes on (`withPromptCache`).
 *
 * With `model`, an assistant turn that `model` answered with thinking goes
 * back with its thinking (`fromAnthropicResponse`'s carry); without it, or
 * for any other turn, as its text and then its tool calls.
 */
export function toAnthropicMessages(
  messages: readonly ModelMessage[],
  model?: string,
): {
  readonly system: string | undefined;
  readonly systemParts: readonly string[];
  readonly messages: readonly Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (msg.content.length > 0) systemParts.push(msg.content);
      continue;
    }
    if (msg.role === 'user') {
      appendToUserTurn(out, [{ type: 'text', text: msg.content }]);
      continue;
    }
    if (msg.role === 'assistant') {
      const blocks = assistantBlocks(msg, model);
      // Anthropic rejects assistant turns with empty content — skip
      // rather than emit an invalid message. The framework's
      // dispatch-tools handler ensures either text or tool_use is
      // present, so this only triggers on malformed input.
      if (blocks.length > 0) {
        out.push({ role: 'assistant', content: blocks });
      }
      continue;
    }
    // role === 'tool'
    const toolResult: Anthropic.ToolResultBlockParam = {
      type: 'tool_result',
      tool_use_id: msg.toolCallId ?? '',
      content: msg.content,
    };
    appendToUserTurn(out, [toolResult]);
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    systemParts,
    messages: out,
  };
}

/**
 * An assistant turn's blocks. One that `model` answered with thinking, still
 * as it answered (`readCarried`), goes back as the answer was: its thinking
 * unchanged and in place, its text as it was split, and each tool call where
 * it was. Any other goes back as its text and then its tool calls.
 */
function assistantBlocks(
  msg: ModelMessage,
  model: string | undefined,
): Anthropic.ContentBlockParam[] {
  const calls = msg.toolCalls ?? [];
  const carried = model === undefined ? undefined : readCarried(msg, model);
  if (carried === undefined) {
    return [
      ...(msg.content.length > 0 ? [{ type: 'text' as const, text: msg.content }] : []),
      ...calls.map(toolUse),
    ];
  }
  const byId = new Map(calls.map((c) => [c.id, c] as const));
  return carried.flatMap((block): Anthropic.ContentBlockParam[] => {
    switch (block.type) {
      case 'thinking':
        return [{ type: 'thinking', thinking: block.thinking, signature: block.signature }];
      case 'redacted_thinking':
        return [{ type: 'redacted_thinking', data: block.data }];
      // Anthropic rejects an empty text block; the text joins the same without it.
      case 'text':
        return block.text.length > 0 ? [{ type: 'text', text: block.text }] : [];
      case 'tool_use': {
        // `readCarried` matched every id to a call.
        const call = byId.get(block.id);
        return call === undefined ? [] : [toolUse(call)];
      }
    }
  });
}

function toolUse(tc: ModelToolCall): Anthropic.ToolUseBlockParam {
  return {
    type: 'tool_use',
    id: tc.id,
    // Encode when replaying prior assistant turns — the
    // message trail stores canonical framework names, but
    // Anthropic on the wire wants the encoded form.
    name: encodeToolName(tc.name),
    input: tc.arguments,
  };
}

function appendToUserTurn(
  out: Anthropic.MessageParam[],
  blocks: readonly Anthropic.ContentBlockParam[],
): void {
  const last = out[out.length - 1];
  if (last !== undefined && last.role === 'user') {
    const existing = normalizeContent(last.content);
    last.content = [...existing, ...blocks];
    return;
  }
  out.push({ role: 'user', content: [...blocks] });
}

function normalizeContent(
  content: Anthropic.MessageParam['content'],
): Anthropic.ContentBlockParam[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [...content];
}

/**
 * Translate framework tool definitions to Anthropic's `tools` shape.
 * `input_schema` is JSON-Schema-shaped on both sides — direct passthrough.
 */
export function toAnthropicTools(tools: readonly ModelToolDefinition[]): readonly Anthropic.Tool[] {
  return tools.map((t) => ({
    name: encodeToolName(t.name),
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

/**
 * Translate an Anthropic response message back into a framework
 * `ModelMessage`. Text blocks concatenate into `content`; tool_use
 * blocks become `toolCalls`.
 *
 * Thinking (`thinking` and `redacted_thinking` blocks) has no field on
 * `ModelMessage`, and the Messages API wants it back, unchanged and in
 * place, on the call that sends the tool results. So, given the `model`
 * that answered, an answer with thinking and tool calls keeps its content
 * in order in its first tool call's `signature` (`anth1.`), as the other
 * adapters keep their own state there, and `toAnthropicMessages` sends it
 * back to that model. The thinking is kept as Claude wrote it (only
 * `redacted_thinking` is encrypted): replay needs it unchanged. An answer
 * without tool calls keeps none: no call in its turn follows it.
 */
export function fromAnthropicResponse(
  response: Anthropic.Message,
  toolIdOf: (name: string) => string = decodeToolName,
  model?: string,
): ModelMessage {
  const textParts: string[] = [];
  const toolCalls: ModelToolCall[] = [];
  const blocks: CarriedBlock[] = [];
  let thought = false;

  for (const block of response.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
      blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        // Anthropic returns the name it was sent (`weather__forecast`);
        // the rest of the framework expects the tool's id.
        name: toolIdOf(block.name),
        arguments: (block.input ?? {}) as Readonly<Record<string, unknown>>,
      });
      blocks.push({ type: 'tool_use', id: block.id });
    } else if (block.type === 'thinking') {
      thought = true;
      blocks.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
    } else if (block.type === 'redacted_thinking') {
      thought = true;
      blocks.push({ type: 'redacted_thinking', data: block.data });
    }
  }

  const carry =
    model !== undefined && thought && toolCalls.length > 0
      ? writeSignature({ model, blocks })
      : undefined;
  const message: ModelMessage = {
    role: 'assistant',
    content: textParts.join(''),
    ...(toolCalls.length > 0 && {
      toolCalls: toolCalls.map((c, i) =>
        i === 0 && carry !== undefined ? { ...c, signature: carry } : c,
      ),
    }),
  };
  return message;
}

/** An answer's block as carried: a tool call's name and arguments stay on the call. */
type CarriedBlock =
  | { readonly type: 'thinking'; readonly thinking: string; readonly signature: string }
  | { readonly type: 'redacted_thinking'; readonly data: string }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string };

interface Carried {
  /** The model that answered: only that model gets it back. */
  readonly model: string;
  /** The answer's content, in order. */
  readonly blocks: readonly CarriedBlock[];
}

/** Versioned, so a later shape can tell this one apart. */
const SIGNATURE_PREFIX = 'anth1.';

function writeSignature(carried: Carried): string {
  return SIGNATURE_PREFIX + Buffer.from(JSON.stringify(carried), 'utf8').toString('base64url');
}

/**
 * The answer carried on an assistant turn's first call, when it's this
 * adapter's, for `model`, and the turn still says what the answer said: its
 * text blocks join to the turn's text, and its tool calls are the turn's, in
 * order. Anything else (another adapter's signature, another model's, a turn
 * edited since, one that doesn't parse) is ignored: the turn goes back
 * without it.
 */
function readCarried(msg: ModelMessage, model: string): readonly CarriedBlock[] | undefined {
  const calls = msg.toolCalls ?? [];
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
  if (!isRecord(parsed) || parsed.model !== model || !Array.isArray(parsed.blocks)) {
    return undefined;
  }
  const blocks = parsed.blocks as unknown[];
  if (!blocks.every(isCarriedBlock)) return undefined;
  const text = blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  if (text !== msg.content) return undefined;
  const ids = blocks.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []));
  if (ids.length !== calls.length || ids.some((id, i) => id !== calls[i]?.id)) return undefined;
  return blocks;
}

function isCarriedBlock(value: unknown): value is CarriedBlock {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'thinking':
      return typeof value.thinking === 'string' && typeof value.signature === 'string';
    case 'redacted_thinking':
      return typeof value.data === 'string';
    case 'text':
      return typeof value.text === 'string';
    case 'tool_use':
      return typeof value.id === 'string';
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Map Anthropic's `stop_reason` to the framework's `finishReason`.
 *
 * Mapping choices:
 *   - `end_turn`, `stop_sequence`, `pause_turn` → `stop`
 *     (`pause_turn` is a server-side agentic pause — non-streaming
 *     invokers don't resume, so treat as terminal for this call.)
 *   - `max_tokens` → `length`
 *   - `tool_use` → `tool-use`
 *   - `refusal` → `content-filter`
 *   - `null` (streaming edge) / unknown → `stop`
 */
export function mapStopReason(
  reason: Anthropic.Message['stop_reason'],
): ModelCallResult['finishReason'] {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool-use';
    case 'refusal':
      return 'content-filter';
    default:
      return 'stop';
  }
}
