// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `parseEvent`: the typed event in a verified webhook request's body. The TypeScript counterpart
 * of Python's `kindgi.webhooks.parse_event`, with no runtime dependency. Each event's shape is
 * generated from the API's own schema (`WebhookEvent` in `@kindgi/api`'s OpenAPI document,
 * `scripts/gen-webhook-event-shapes.mjs`), so it checks what Python's generated models check:
 * every field's type, the required ones, enums and consts, `uuid` and `date-time` formats,
 * bounds, patterns, array items and the discriminated unions, at every depth. As in Python, a
 * field the schema doesn't name is kept, so a newer runtime's additions don't break a receiver.
 */

import type { WebhookEvent } from '@kindgi/client';

import { WEBHOOK_EVENT_SHAPES } from './webhook-event-shapes.generated.js';

/** Why a body isn't an event: not JSON, a `type` this version doesn't know, or a field wrong. */
export type ParseWebhookEventFailure = 'not-json' | 'unknown-type' | 'invalid-event';

export type ParseWebhookEventResult =
  | { readonly kind: 'ok'; readonly event: WebhookEvent }
  | {
      readonly kind: 'err';
      readonly reason: ParseWebhookEventFailure;
      /** What's wrong, naming the field (`data.run.status`); no field's value but the `type`. */
      readonly message: string;
    };

type Fields = Readonly<Record<string, EventShape>>;

/** A field's shape, as the API's schema has it (generated: `webhook-event-shapes.generated.ts`). */
export type EventShape =
  | {
      readonly kind: 'string';
      readonly nullable?: boolean;
      readonly enum?: readonly string[];
      readonly format?: 'uuid' | 'date-time';
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly pattern?: string;
    }
  | {
      readonly kind: 'number' | 'integer';
      readonly nullable?: boolean;
      readonly minimum?: number;
      readonly maximum?: number;
      readonly exclusiveMinimum?: number;
      readonly exclusiveMaximum?: number;
    }
  | { readonly kind: 'boolean'; readonly nullable?: boolean }
  | {
      readonly kind: 'array';
      readonly nullable?: boolean;
      readonly items?: EventShape;
      readonly minItems?: number;
      readonly maxItems?: number;
    }
  | {
      readonly kind: 'object';
      readonly nullable?: boolean;
      readonly required?: Fields;
      readonly optional?: Fields;
    }
  | { readonly kind: 'union'; readonly discriminator: string; readonly variants: Fields };

/**
 * The typed event in a webhook request's body, one of `WebhookEvent`'s by its `type`. Call it
 * after `verifyWebhook` says `ok`, on the same raw body.
 *
 * - `not-json`: the body isn't JSON;
 * - `unknown-type`: an event this version of the SDK doesn't know, as a newer runtime may send.
 *   Answer it with a 2xx and leave it, or Kindgi retries it;
 * - `invalid-event`: a known `type` with a field missing or wrong; the message names it.
 */
export function parseEvent(body: string | Uint8Array): ParseWebhookEventResult {
  let value: unknown;
  try {
    value = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body));
  } catch {
    return { kind: 'err', reason: 'not-json', message: 'The body is not JSON.' };
  }
  const type = isRecord(value) ? value.type : undefined;
  if (typeof type !== 'string') {
    return { kind: 'err', reason: 'invalid-event', message: '`type` is missing or not a string.' };
  }
  if (!Object.hasOwn(WEBHOOK_EVENT_SHAPES, type)) {
    return {
      kind: 'err',
      reason: 'unknown-type',
      message: `"${type.slice(0, 64)}" is an event type this version of the SDK doesn't know.`,
    };
  }
  const shape = (WEBHOOK_EVENT_SHAPES as Fields)[type] as EventShape;
  const problem = check(shape, value, '');
  return problem === undefined
    ? { kind: 'ok', event: value as WebhookEvent }
    : { kind: 'err', reason: 'invalid-event', message: `A "${type}" event: ${problem}` };
}

/** The first way `value` doesn't fit `shape`, naming the field; undefined when it fits. */
function check(shape: EventShape, value: unknown, path: string): string | undefined {
  const at = path === '' ? 'the body' : `\`${path}\``;
  if (value === null && shape.kind !== 'union' && shape.nullable === true) return undefined;
  switch (shape.kind) {
    case 'string':
      return checkString(shape, value, at);
    case 'number':
    case 'integer':
      return checkNumber(shape, value, at);
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `${at} is not true or false.`;
    case 'array':
      return checkArray(shape, value, path, at);
    case 'object':
      return checkObject(shape, value, path, at);
    case 'union':
      return checkUnion(shape, value, path, at);
  }
}

type Of<K extends EventShape['kind']> = Extract<EventShape, { kind: K }>;

function checkString(shape: Of<'string'>, value: unknown, at: string): string | undefined {
  if (typeof value !== 'string') return `${at} is not a string.`;
  if (shape.enum !== undefined && !shape.enum.includes(value)) {
    return `${at} is not one of ${shape.enum.map((v) => `"${v}"`).join(', ')}.`;
  }
  if (shape.format !== undefined && !FORMATS[shape.format](value)) {
    return `${at} is not ${shape.format === 'uuid' ? 'a UUID' : 'a date-time with a time zone'}.`;
  }
  const length = [...value].length;
  if (shape.minLength !== undefined && length < shape.minLength) {
    return `${at} is shorter than ${shape.minLength} characters.`;
  }
  if (shape.maxLength !== undefined && length > shape.maxLength) {
    return `${at} is longer than ${shape.maxLength} characters.`;
  }
  if (shape.pattern !== undefined && !patternOf(shape.pattern).test(value)) {
    return `${at} doesn't match ${shape.pattern}.`;
  }
  return undefined;
}

function checkNumber(
  shape: Of<'number' | 'integer'>,
  value: unknown,
  at: string,
): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${at} is not a number.`;
  if (shape.kind === 'integer' && !Number.isInteger(value)) return `${at} is not a whole number.`;
  const bounds: [number | undefined, (n: number) => boolean, string][] = [
    [shape.minimum, (m) => value >= m, 'is less than'],
    [shape.maximum, (m) => value <= m, 'is more than'],
    [shape.exclusiveMinimum, (m) => value > m, 'is not more than'],
    [shape.exclusiveMaximum, (m) => value < m, 'is not less than'],
  ];
  for (const [bound, holds, says] of bounds) {
    if (bound !== undefined && !holds(bound)) return `${at} ${says} ${bound}.`;
  }
  return undefined;
}

function checkArray(
  shape: Of<'array'>,
  value: unknown,
  path: string,
  at: string,
): string | undefined {
  if (!Array.isArray(value)) return `${at} is not an array.`;
  if (shape.minItems !== undefined && value.length < shape.minItems) {
    return `${at} has fewer than ${shape.minItems} items.`;
  }
  if (shape.maxItems !== undefined && value.length > shape.maxItems) {
    return `${at} has more than ${shape.maxItems} items.`;
  }
  if (shape.items === undefined) return undefined;
  for (const [i, item] of value.entries()) {
    const problem = check(shape.items, item, `${path}[${i}]`);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** An object: each required field there and fitting, each optional one fitting when it's there. */
function checkObject(
  shape: Of<'object'>,
  value: unknown,
  path: string,
  at: string,
): string | undefined {
  if (!isRecord(value)) return `${at} is not an object.`;
  const fields = [
    ...Object.entries(shape.required ?? {}).map(([k, f]) => [k, f, true] as const),
    ...Object.entries(shape.optional ?? {}).map(([k, f]) => [k, f, false] as const),
  ];
  for (const [key, field, required] of fields) {
    const where = path === '' ? key : `${path}.${key}`;
    if (!Object.hasOwn(value, key) || value[key] === undefined) {
      if (required) return `\`${where}\` is missing.`;
      continue;
    }
    const problem = check(field, value[key], where);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** A discriminated union: its tag names the variant, which is then checked. */
function checkUnion(
  shape: Of<'union'>,
  value: unknown,
  path: string,
  at: string,
): string | undefined {
  if (!isRecord(value)) return `${at} is not an object.`;
  const where = path === '' ? shape.discriminator : `${path}.${shape.discriminator}`;
  const tag = value[shape.discriminator];
  if (typeof tag !== 'string' || !Object.hasOwn(shape.variants, tag)) {
    const tags = Object.keys(shape.variants)
      .map((t) => `"${t}"`)
      .join(', ');
    return `\`${where}\` is not one of ${tags}.`;
  }
  return check(shape.variants[tag] as EventShape, value, path);
}

/** RFC 3339: a date, a time and a zone (`Z` or an offset), as the API writes them. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
/** A UUID in its usual form, any version (the API writes them so). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATS: Readonly<Record<'uuid' | 'date-time', (value: string) => boolean>> = {
  uuid: (v) => UUID.test(v),
  'date-time': (v) => DATE_TIME.test(v) && !Number.isNaN(Date.parse(v)),
};

/** Each pattern compiled once (Unicode, as the generator checked it compiles). */
const patterns = new Map<string, RegExp>();
function patternOf(source: string): RegExp {
  let compiled = patterns.get(source);
  if (compiled === undefined) {
    compiled = new RegExp(source, 'u');
    patterns.set(source, compiled);
  }
  return compiled;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
