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
 * Encoding is a simple `.` → `__` substitution. Reversible as long
 * as authors don't put literal `__` in their tool ids — which the
 * framework's kebab-case convention already discourages. The
 * substitution is contained to the wire boundary; the message trail,
 * runtime registry, and provenance records all continue to see the
 * canonical `<pack>.<tool>` form.
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
 */
export function toAnthropicMessages(messages: readonly ModelMessage[]): {
  readonly system: string | undefined;
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
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (msg.content.length > 0) blocks.push({ type: 'text', text: msg.content });
      if (msg.toolCalls !== undefined) {
        for (const tc of msg.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            // Encode when replaying prior assistant turns — the
            // message trail stores canonical framework names, but
            // Anthropic on the wire wants the encoded form.
            name: encodeToolName(tc.name),
            input: tc.arguments,
          });
        }
      }
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
    messages: out,
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
 * blocks become `toolCalls`. Thinking blocks are ignored (the
 * framework has no thinking field on `ModelMessage`).
 */
export function fromAnthropicResponse(response: Anthropic.Message): ModelMessage {
  const textParts: string[] = [];
  const toolCalls: ModelToolCall[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        // Decode: Anthropic returns the encoded name (`weather__forecast`);
        // the rest of the framework expects the canonical dotted form.
        name: decodeToolName(block.name),
        arguments: (block.input ?? {}) as Readonly<Record<string, unknown>>,
      });
    }
    // 'thinking' / 'redacted_thinking' blocks are ignored (see above).
  }

  const message: ModelMessage = {
    role: 'assistant',
    content: textParts.join(''),
    ...(toolCalls.length > 0 && { toolCalls }),
  };
  return message;
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
