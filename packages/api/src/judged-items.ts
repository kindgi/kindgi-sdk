// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The items of a run's output that people judge, and how a new output is
 * scored against the judgments of an old one. Pure, with no dependencies,
 * so a console can derive items the same way.
 *
 * Items:
 *   - an agent turn's answer (its last agent message) is `answer`;
 *   - a flow run's whole output is `output`;
 *   - each element of a list in the output (an agent's typed result sits
 *     under `output`) is an item, keyed by its own `id` or `key` when it
 *     has one, else by where it sits (a JSON Pointer), with its rank.
 *
 * A judgment carries over to a new output's item when it's the same item:
 * an item keyed by its own id is the same item when the key matches; any
 * other (the answer, an element keyed by its place) only when its content
 * is the same too. So a changed answer is a new item, with no judgments.
 */

export interface OutputItem {
  /** The key judgments use for this item. */
  readonly key: string;
  /** Where it sits in the output (JSON Pointer). */
  readonly pointer: string;
  /** Its place in its list (0 = first). */
  readonly rank?: number;
  /** `true` when the key is the item's own id, so it identifies the item by itself. */
  readonly ownKey: boolean;
  readonly value: unknown;
}

const MAX_DEPTH = 3;
const MAX_LIST = 100;

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** An element's own id, if it has a usable one. */
function ownId(element: unknown): string | undefined {
  const o = obj(element);
  for (const field of ['id', 'key']) {
    const v = o?.[field];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

function listItems(value: unknown, pointer: string, depth: number): OutputItem[] {
  if (depth > MAX_DEPTH) return [];
  if (Array.isArray(value)) {
    if (value.length === 0 || value.length > MAX_LIST) return [];
    const seen = new Set<string>();
    return value.map((element, i) => {
      const id = ownId(element);
      // Duplicate ids within one list fall back to the element's place.
      const own = id !== undefined && !seen.has(id);
      const key = own ? id : `${pointer}/${i}`;
      seen.add(key);
      return { key, pointer: `${pointer}/${i}`, rank: i, ownKey: own, value: element };
    });
  }
  const o = obj(value);
  if (o === undefined) return [];
  return Object.entries(o).flatMap(([field, child]) =>
    listItems(child, `${pointer}/${escapeToken(field)}`, depth + 1),
  );
}

function turnAnswer(output: Record<string, unknown>): OutputItem | undefined {
  const appended = Array.isArray(output.appended) ? output.appended : [];
  for (let i = appended.length - 1; i >= 0; i--) {
    const m = obj(appended[i]);
    if (m?.role === 'agent' && m.content !== undefined && !hasToolCalls(m.content)) {
      return { key: 'answer', pointer: `/appended/${i}/content`, ownKey: false, value: m.content };
    }
  }
  return undefined;
}

function hasToolCalls(content: unknown): boolean {
  return Array.isArray(obj(content)?.toolCalls);
}

/** The items of a run's output (`agentTurn`: an agent turn's result). */
export function outputItems(output: unknown, agentTurn: boolean): readonly OutputItem[] {
  const o = obj(output);
  if (agentTurn) {
    if (o === undefined) return [];
    const answer = turnAnswer(o);
    return [
      ...(answer !== undefined ? [answer] : []),
      ...(o.output !== undefined ? listItems(o.output, '/output', 0) : []),
    ];
  }
  if (output === undefined || output === null) return [];
  return [
    { key: 'output', pointer: '', ownKey: false, value: output },
    ...listItems(output, '', 0),
  ];
}

/** The value at a JSON Pointer in `doc`, or `undefined` when there's none. */
export function valueAt(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  if (!pointer.startsWith('/')) return undefined;
  let current: unknown = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const token = unescapeToken(raw);
    if (Array.isArray(current)) {
      const i = Number(token);
      current = Number.isInteger(i) ? current[i] : undefined;
    } else {
      current = obj(current)?.[token];
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/** JSON with sorted keys, so equal values compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const o = obj(value);
  if (o !== undefined) {
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** What people said about one judged item (as a judged test-set case keeps it). */
export interface ItemJudgments {
  readonly key: string;
  readonly pointer?: string;
  readonly rank?: number;
  readonly yesWeight: number;
  readonly totalWeight: number;
}

/** A new output's item and the judged item it is the same as, if any. */
export interface MatchedItem {
  readonly item: OutputItem;
  readonly judged?: ItemJudgments;
  /**
   * Judgments of this output itself (a comparison's replay, judged after it
   * ran), for an item the past output's judgments don't cover.
   */
  readonly fresh?: ItemJudgments;
}

/**
 * Match a new output's items to the items judged in a past output
 * (`judgedOutput`, where the judged items' pointers point).
 */
export function matchJudged(
  items: readonly OutputItem[],
  judged: readonly ItemJudgments[],
  judgedOutput: unknown,
): readonly MatchedItem[] {
  const byKey = new Map(judged.map((j) => [j.key, j]));
  return items.map((item) => {
    const j = byKey.get(item.key);
    if (j === undefined) return { item };
    if (item.ownKey) return { item, judged: j };
    const before = j.pointer === undefined ? undefined : valueAt(judgedOutput, j.pointer);
    return before !== undefined && canonical(before) === canonical(item.value)
      ? { item, judged: j }
      : { item };
  });
}

/**
 * Judgments made on the new output itself, by item key, onto the items the
 * past output's judgments don't cover: a replay's answer that changed is a
 * new item, and people (or later a calibrated judge) can judge it there.
 */
export function withFresh(
  matched: readonly MatchedItem[],
  fresh: readonly ItemJudgments[],
): readonly MatchedItem[] {
  if (fresh.length === 0) return matched;
  const byKey = new Map(fresh.map((j) => [j.key, j]));
  return matched.map((m) => {
    if (m.judged !== undefined) return m;
    const j = byKey.get(m.item.key);
    return j === undefined ? m : { ...m, fresh: j };
  });
}

/** An output scored against judgments: the sums the metrics are made of. */
export interface OutputScore {
  /** Σ yesWeight and Σ totalWeight over the output's judged items. */
  readonly yesWeight: number;
  readonly totalWeight: number;
  readonly items: number;
  readonly judgedItems: number;
  /** The same sums over the judged items among the first `k` ranked items. */
  readonly topK: { readonly yesWeight: number; readonly totalWeight: number };
  /**
   * The part of these sums judged on this output itself (`withFresh`).
   * Absent when none was.
   */
  readonly fresh?: {
    readonly yesWeight: number;
    readonly totalWeight: number;
    readonly items: number;
  };
}

export function scoreItems(matched: readonly MatchedItem[], k: number): OutputScore {
  let yesWeight = 0;
  let totalWeight = 0;
  let judgedItems = 0;
  const fresh = { yesWeight: 0, totalWeight: 0, items: 0 };
  for (const m of matched) {
    const j = m.judged ?? m.fresh;
    if (j === undefined) continue;
    judgedItems += 1;
    yesWeight += j.yesWeight;
    totalWeight += j.totalWeight;
    if (m.judged === undefined) {
      fresh.items += 1;
      fresh.yesWeight += j.yesWeight;
      fresh.totalWeight += j.totalWeight;
    }
  }
  const top = matched
    .filter((m) => m.item.rank !== undefined)
    .sort((a, b) => (a.item.rank ?? 0) - (b.item.rank ?? 0))
    .slice(0, k);
  const topK = { yesWeight: 0, totalWeight: 0 };
  for (const m of top) {
    const j = m.judged ?? m.fresh;
    if (j === undefined) continue;
    topK.yesWeight += j.yesWeight;
    topK.totalWeight += j.totalWeight;
  }
  return {
    yesWeight,
    totalWeight,
    items: matched.length,
    judgedItems,
    topK,
    ...(fresh.items > 0 && { fresh }),
  };
}

/** How a new output's items moved against the judged ones. */
export interface ItemChanges {
  /** Judged items the new output still has, with their rank before and now. */
  readonly kept: readonly {
    readonly key: string;
    readonly rankBefore?: number;
    readonly rank?: number;
  }[];
  /** Judged items the new output no longer has. */
  readonly dropped: readonly { readonly key: string; readonly rankBefore?: number }[];
  /**
   * The new output's items the past output's judgments don't cover: for
   * people to judge on the replay itself. `judged` sums what they said
   * there, once they have.
   */
  readonly new: readonly {
    readonly key: string;
    readonly pointer: string;
    readonly rank?: number;
    readonly judged?: { readonly yesWeight: number; readonly totalWeight: number };
  }[];
}

export function itemChanges(
  matched: readonly MatchedItem[],
  judged: readonly ItemJudgments[],
): ItemChanges {
  const keptKeys = new Set<string>();
  const kept: ItemChanges['kept'][number][] = [];
  const fresh: ItemChanges['new'][number][] = [];
  for (const m of matched) {
    if (m.judged !== undefined) {
      keptKeys.add(m.judged.key);
      kept.push({
        key: m.judged.key,
        ...(m.judged.rank !== undefined && { rankBefore: m.judged.rank }),
        ...(m.item.rank !== undefined && { rank: m.item.rank }),
      });
    } else {
      fresh.push({
        key: m.item.key,
        pointer: m.item.pointer,
        ...(m.item.rank !== undefined && { rank: m.item.rank }),
        ...(m.fresh !== undefined && {
          judged: { yesWeight: m.fresh.yesWeight, totalWeight: m.fresh.totalWeight },
        }),
      });
    }
  }
  const dropped = judged
    .filter((j) => !keptKeys.has(j.key))
    .map((j) => ({ key: j.key, ...(j.rank !== undefined && { rankBefore: j.rank }) }));
  return { kept, dropped, new: fresh };
}
