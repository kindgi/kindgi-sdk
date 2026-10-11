// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A model's own tools, named in its text by the names it's sent them
 * under.
 *
 * Tool ids are dotted (`acme.lookup_order`), and providers that forbid
 * dots in tool names (Anthropic, OpenAI-compatible) are sent an encoded
 * name (`acme__lookup_order`). An agent's instructions that name a tool
 * by its id then point the model at a name it wasn't given. It writes
 * the call as text, or the server drops it. Measured on local models,
 * that's a quarter of such turns (T311).
 *
 * `nameToolsAsSent` rewrites each declared tool id in `text` to its sent
 * name:
 *   - only the ids passed (the call's own tools), as whole tokens: not
 *     preceded by a word character, `.` or `-`, and not followed by a word
 *     character, `-` or `.<word>`. So `acme.lookup_orders`,
 *     `xacme.lookup_order` and `acme.lookup_order.v2` are left alone, and
 *     a sentence's final `.` isn't part of the id;
 *   - deterministically: one pass, longest id first, so the same text and
 *     tools always give the same bytes (prompt-cache prefixes stay stable).
 *
 * An adapter applies it to the text it sends (the system prompt), at the
 * wire boundary: the agent's own messages, the journal and provenance
 * keep the author's dotted ids.
 */
export function nameToolsAsSent(
  text: string,
  toolIds: readonly string[],
  sentName: (id: string) => string,
): string {
  const renamed = new Map<string, string>();
  for (const id of toolIds) {
    const name = sentName(id);
    if (name !== id) renamed.set(id, name);
  }
  if (renamed.size === 0) return text;
  const ids = [...renamed.keys()].sort(
    (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  const pattern = new RegExp(
    `(?<![\\w.-])(?:${ids.map(escapeRegExp).join('|')})(?![\\w-]|\\.\\w)`,
    'g',
  );
  return text.replace(pattern, (id) => renamed.get(id) ?? id);
}

/**
 * Two of a call's tools sent under one name: the model's call to it can't
 * be told apart, so the call isn't sent.
 */
export class ToolNameCollisionError extends Error {
  constructor(
    readonly first: string,
    readonly second: string,
    readonly sent: string,
  ) {
    super(
      `tools "${first}" and "${second}" have the same name for the model ("${sent}"): rename one of them`,
    );
    this.name = 'ToolNameCollisionError';
  }
}

/**
 * The tool id a provider's call names, given the name the call's tools were
 * sent under: looked up among the call's own tools, never worked out by
 * undoing the encoding. An id can hold what the encoding writes (an MCP
 * server names its tools as it likes: Drupal's `tool_api__list_content`,
 * as `drupal.tool_api__list_content`, is sent as
 * `drupal__tool_api__list_content`, and undoing `.` → `__` would give
 * `drupal.tool_api.list_content`, a tool nobody has).
 *
 * Throws `ToolNameCollisionError` when two of the tools are sent under one
 * name. A name the call didn't send (a model inventing one) is passed to
 * `fallback`, so the caller still reports what the model asked for.
 */
export function toolIdsBySentName(
  toolIds: readonly string[],
  sentName: (id: string) => string,
  fallback: (name: string) => string,
): (name: string) => string {
  const byName = new Map<string, string>();
  for (const id of toolIds) {
    const name = sentName(id);
    const other = byName.get(name);
    if (other !== undefined && other !== id) throw new ToolNameCollisionError(other, id, name);
    byName.set(name, id);
  }
  return (name) => byName.get(name) ?? fallback(name);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
