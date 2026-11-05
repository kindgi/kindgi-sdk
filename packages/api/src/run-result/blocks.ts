// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { clipText } from './clip-text.js';

/** The most of an answer the console's Result page draws. */
export const RESULT_LIMIT = 100_000;

/** A string on one line and at most this long is a value; else it's text. */
const VALUE_MAX = 280;
/** The most different keys a table's columns take; past it, the array is shown as JSON. */
const COLUMNS_MAX = 12;
/** Past any of these, a block is long, and a place draws it folded. */
export const LONG_CHARS = 1_200;
const LONG_FIELDS = 12;
const LONG_ROWS = 10;

export interface AnswerBlocks {
  readonly blocks: readonly AnswerBlock[];
  /** True when the answer was longer than `limit` and the rest was left out. */
  readonly truncated: boolean;
}

export type AnswerBlock =
  | { readonly kind: 'value'; readonly title?: string; readonly value: string }
  | {
      readonly kind: 'text';
      readonly title?: string;
      readonly text: string;
      readonly long: boolean;
    }
  | {
      readonly kind: 'fields';
      readonly title?: string;
      readonly fields: readonly { readonly name: string; readonly value: string }[];
      readonly long: boolean;
    }
  | {
      readonly kind: 'records';
      readonly title?: string;
      readonly columns: readonly string[];
      readonly rows: readonly (readonly string[])[];
      readonly long: boolean;
    };

type Field = { readonly name: string; readonly value: string };

/** A block before the limit and `long`. */
type Draft =
  | { readonly kind: 'value'; readonly title?: string; readonly value: string }
  | { readonly kind: 'text'; readonly title?: string; readonly text: string }
  | { readonly kind: 'fields'; readonly title?: string; readonly fields: Field[] }
  | {
      readonly kind: 'records';
      readonly title?: string;
      readonly columns: readonly string[];
      readonly rows: readonly (readonly string[])[];
    };

type JsonObject = Readonly<Record<string, unknown>>;

/**
 * The answer, split into blocks by its shape alone, within `limit`
 * characters:
 * - null, absent, `[]`, `{}`, or a string that's empty or only white space:
 *   no blocks.
 * - A string on one line, at most 280 characters, is a `value`; else `text`.
 *   A number or a boolean is a `value`, as its JSON.
 * - An array of objects with only scalar values, and at most 12 different
 *   keys between them, is `records`: its keys in the order they first
 *   appear, a missing key or null an empty cell.
 * - An object gives a block for each key, in key order. Its value-sized
 *   scalars (a value string, a number, a boolean, null) make one untitled
 *   `fields` block, at the place of the first. A text string, a `records`
 *   array or an object of value-sized scalars is its own block, titled with
 *   its key. Anything deeper is a `text` block of its JSON.
 * - Anything else is one `text` block of its JSON.
 *
 * Every string a block draws counts toward `limit`, as UTF-16 units: its
 * title, each field's name and value, each column name and cell, its text.
 * The block that crosses the limit is cut there, the blocks after it are
 * left out, and `truncated` is true. A cut never ends in half a character.
 */
export function answerBlocks(answer: unknown, limit: number): AnswerBlocks {
  const budget = new Budget(limit);
  const blocks: AnswerBlock[] = [];
  for (const draft of draftsOf(answer)) {
    if (budget.cut) break;
    const block = within(draft, budget);
    if (block !== undefined) blocks.push(block);
  }
  return { blocks, truncated: budget.cut };
}

/** What's left of the limit. Past it, nothing more is taken. */
class Budget {
  private left: number;
  cut = false;

  constructor(limit: number) {
    this.left = Math.max(0, limit);
  }

  /** The text, or as much of it as is left. */
  take(text: string): string {
    if (this.cut) return '';
    if (text.length <= this.left) {
      this.left -= text.length;
      return text;
    }
    this.cut = true;
    const kept = clipText(text, this.left);
    this.left = 0;
    return kept;
  }
}

function draftsOf(answer: unknown): Draft[] {
  if (answer === undefined || answer === null) return [];
  if (typeof answer === 'string') {
    if (answer.trim() === '') return [];
    return [
      isValueString(answer) ? { kind: 'value', value: answer } : { kind: 'text', text: answer },
    ];
  }
  if (typeof answer === 'number' || typeof answer === 'boolean') {
    return [{ kind: 'value', value: JSON.stringify(answer) }];
  }
  if (isEmpty(answer)) return [];
  if (Array.isArray(answer)) return [arrayDraft(answer)];
  if (isObject(answer)) return objectDrafts(answer);
  return [jsonDraft(answer)];
}

function objectDrafts(object: JsonObject): Draft[] {
  const drafts: Draft[] = [];
  let scalars: Field[] | undefined;
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || isEmpty(value)) continue;
    if (!isValueSized(value)) {
      drafts.push(keyDraft(key, value));
      continue;
    }
    if (scalars === undefined) {
      scalars = [];
      drafts.push({ kind: 'fields', fields: scalars });
    }
    scalars.push({ name: key, value: cellText(value) });
  }
  return drafts;
}

/** A key's own block, titled with the key: its value is more than a field holds. */
function keyDraft(key: string, value: unknown): Draft {
  if (typeof value === 'string') return { kind: 'text', title: key, text: value };
  if (Array.isArray(value)) return arrayDraft(value, key);
  if (isObject(value) && Object.values(value).every((v) => v === undefined || isValueSized(v))) {
    return { kind: 'fields', title: key, fields: fieldsOf(value) };
  }
  return jsonDraft(value, key);
}

function arrayDraft(items: readonly unknown[], title?: string): Draft {
  const columns = columnsOf(items);
  if (columns === undefined) return jsonDraft(items, title);
  return {
    kind: 'records',
    ...(title !== undefined && { title }),
    columns,
    rows: items.map((item) =>
      columns.map((column) =>
        cellText(Object.hasOwn(item as object, column) ? (item as JsonObject)[column] : undefined),
      ),
    ),
  };
}

/** A table's columns, or none when the items aren't all objects of scalars under the top. */
function columnsOf(items: readonly unknown[]): string[] | undefined {
  const columns = new Set<string>();
  for (const item of items) {
    if (!isObject(item)) return undefined;
    for (const [key, value] of Object.entries(item)) {
      if (value === undefined) continue;
      if (!isScalar(value)) return undefined;
      columns.add(key);
      if (columns.size > COLUMNS_MAX) return undefined;
    }
  }
  return columns.size === 0 ? undefined : [...columns];
}

function fieldsOf(object: JsonObject): Field[] {
  return Object.entries(object)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => ({ name, value: cellText(value) }));
}

function jsonDraft(value: unknown, title?: string): Draft {
  return { kind: 'text', ...(title !== undefined && { title }), text: jsonText(value) };
}

/** The draft within what's left of the limit, with `long`; none when nothing of it fits. */
function within(draft: Draft, budget: Budget): AnswerBlock | undefined {
  const title = draft.title === undefined ? undefined : budget.take(draft.title);
  const titled = title === undefined ? {} : { title };
  switch (draft.kind) {
    case 'value': {
      const value = budget.take(draft.value);
      return budget.cut && value === '' ? undefined : { kind: 'value', ...titled, value };
    }
    case 'text': {
      const text = budget.take(draft.text);
      return budget.cut && text === '' ? undefined : withLong({ kind: 'text', ...titled, text });
    }
    case 'fields': {
      const fields = fieldsWithin(draft.fields, budget);
      return fields.length === 0 ? undefined : withLong({ kind: 'fields', ...titled, fields });
    }
    case 'records': {
      const table = recordsWithin(draft.columns, draft.rows, budget);
      return table === undefined ? undefined : withLong({ kind: 'records', ...titled, ...table });
    }
  }
}

/** A block, `long` past 1,200 drawn characters, 12 fields or 10 rows. */
function withLong(block: Exclude<Draft, { readonly kind: 'value' }>): AnswerBlock {
  const chars = drawn([block.title ?? '', ...textsOf(block)]);
  const many =
    (block.kind === 'fields' && block.fields.length > LONG_FIELDS) ||
    (block.kind === 'records' && block.rows.length > LONG_ROWS);
  return { ...block, long: many || chars > LONG_CHARS };
}

/** Every string a block draws but its title. */
function textsOf(block: Exclude<Draft, { readonly kind: 'value' }>): string[] {
  switch (block.kind) {
    case 'text':
      return [block.text];
    case 'fields':
      return block.fields.flatMap((field) => [field.name, field.value]);
    case 'records':
      return [...block.columns, ...block.rows.flat()];
  }
}

/** The fields that fit, the one that crosses the limit cut; one whose value doesn't fit at all is left out. */
function fieldsWithin(fields: readonly Field[], budget: Budget): Field[] {
  const kept: Field[] = [];
  for (const field of fields) {
    const name = budget.take(field.name);
    if (budget.cut) break;
    const value = budget.take(field.value);
    if (budget.cut && value === '') break;
    kept.push({ name, value });
    if (budget.cut) break;
  }
  return kept;
}

/** The columns and the rows that fit, the one that crosses the limit cut; none when the columns don't fit. */
function recordsWithin(
  columns: readonly string[],
  rows: readonly (readonly string[])[],
  budget: Budget,
): { readonly columns: string[]; readonly rows: string[][] } | undefined {
  const kept = columns.map((column) => budget.take(column));
  if (budget.cut) return undefined;
  const keptRows: string[][] = [];
  for (const row of rows) {
    if (budget.cut) break;
    const cells = row.map((cell) => budget.take(cell));
    if (budget.cut && cells.every((cell) => cell === '')) break;
    keptRows.push(cells);
  }
  return keptRows.length === 0 ? undefined : { columns: kept, rows: keptRows };
}

function drawn(texts: readonly string[]): number {
  return texts.reduce((sum, text) => sum + text.length, 0);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return isObject(value) && Object.values(value).every((v) => v === undefined);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isValueString(text: string): boolean {
  return text.length <= VALUE_MAX && !/[\r\n]/.test(text);
}

/** A value string, a number, a boolean or null: what a field holds. */
function isValueSized(value: unknown): boolean {
  return typeof value === 'string' ? isValueString(value) : isScalar(value);
}

/** A scalar as a field or a cell shows it; null and a missing key are empty. */
function cellText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
