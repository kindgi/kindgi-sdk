// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `parseEvent`: the typed event in a verified webhook request's body. The TypeScript counterpart
 * of Python's `kindgi.webhooks.parse_event`, with no runtime dependency: each event's fields are
 * checked against its shape below, which a test holds to the API's own schemas
 * (`WebhookEvent` in `@kindgi/api`'s OpenAPI document). As in Python, a field this version
 * doesn't know is kept, so a newer runtime's additions don't break an older receiver.
 */

import type { WebhookEvent } from '@kindgi/client';

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

/** A field's shape, as the API's schema has it. */
export type EventFieldShape =
  | { readonly kind: 'string' }
  | { readonly kind: 'string-or-null' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'number' }
  | { readonly kind: 'integer' }
  | { readonly kind: 'date-time' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'array' }
  | { readonly kind: 'object'; readonly required: ShapeFields; readonly optional?: ShapeFields };

type ShapeFields = Readonly<Record<string, EventFieldShape>>;

const string = { kind: 'string' } as const;
const dateTime = { kind: 'date-time' } as const;
const integer = { kind: 'integer' } as const;
/** An object whose own fields aren't checked here (the client's type says them). */
const object = { kind: 'object', required: {} } as const;

const envelope = (type: string, data: EventFieldShape): EventFieldShape => ({
  kind: 'object',
  required: { id: string, type: { kind: 'enum', values: [type] }, createdAt: dateTime, data },
});

/** Each event `type` this version knows, and its shape. */
export const WEBHOOK_EVENT_SHAPES: Readonly<Record<WebhookEvent['type'], EventFieldShape>> = {
  'run.finished': envelope('run.finished', {
    kind: 'object',
    required: {
      run: {
        kind: 'object',
        required: {
          id: string,
          projectId: string,
          flowId: string,
          flowVersion: string,
          status: { kind: 'enum', values: ['completed', 'failed', 'cancelled'] },
          dryRun: { kind: 'boolean' },
          failureMessage: { kind: 'string-or-null' },
          createdAt: dateTime,
          completedAt: dateTime,
        },
        optional: {
          usage: {
            kind: 'object',
            required: { calls: integer, costUsd: { kind: 'number' }, tokens: object },
          },
          agent: {
            kind: 'object',
            required: { id: string, version: string, conversationId: string },
          },
        },
      },
    },
  }),
  'improvement-pass.finished': envelope('improvement-pass.finished', {
    kind: 'object',
    required: {
      pass: {
        kind: 'object',
        required: {
          id: string,
          agentId: string,
          fromVersion: string,
          scope: object,
          suiteId: string,
          tiers: { kind: 'array' },
          objective: string,
          budget: object,
          requestedBy: string,
          status: string,
          candidatesEvaluated: integer,
          costUsd: string,
          createdAt: dateTime,
          updatedAt: dateTime,
        },
      },
    },
  }),
  'approval.requested': envelope('approval.requested', {
    kind: 'object',
    required: {
      approval: {
        kind: 'object',
        required: {
          approvalId: string,
          requiredRole: { kind: 'enum', values: ['standard', 'senior', 'admin'] },
          createdAt: dateTime,
        },
        optional: {
          projectId: string,
          title: string,
          assignedTo: string,
          expiresAt: dateTime,
          url: string,
        },
      },
    },
  }),
  'webhook.test': envelope('webhook.test', {
    kind: 'object',
    required: { endpointId: string },
  }),
};

/**
 * The typed event in a webhook request's body, one of `WebhookEvent`'s by its `type`. Call it
 * after `verifyWebhook` says `ok`, on the same raw body.
 *
 * - `not-json`: the body isn't JSON;
 * - `unknown-type`: an event this version of the SDK doesn't know, as a newer runtime may send.
 *   Answer it with a 2xx and leave it, or Kindgi retries it;
 * - `invalid-event`: a known `type` with a field missing or of the wrong type; the message names it.
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
  const shape = (WEBHOOK_EVENT_SHAPES as Readonly<Record<string, EventFieldShape>>)[
    type
  ] as EventFieldShape;
  const problem = check(shape, value, '');
  return problem === undefined
    ? { kind: 'ok', event: value as WebhookEvent }
    : { kind: 'err', reason: 'invalid-event', message: `A "${type}" event: ${problem}` };
}

/** The first way `value` doesn't fit `shape`, naming the field; undefined when it fits. */
function check(shape: EventFieldShape, value: unknown, path: string): string | undefined {
  const at = path === '' ? 'the body' : `\`${path}\``;
  if (shape.kind === 'object') return checkObject(shape, value, path, at);
  if (shape.kind === 'enum') {
    return typeof value === 'string' && shape.values.includes(value)
      ? undefined
      : `${at} is not one of ${shape.values.map((v) => `"${v}"`).join(', ')}.`;
  }
  const [fits, problem] = PLAIN[shape.kind];
  return fits(value) ? undefined : `${at} ${problem}`;
}

type PlainKind = Exclude<EventFieldShape['kind'], 'object' | 'enum'>;

/** Each plain kind: whether a value fits it, and what's said when it doesn't. */
const PLAIN: Readonly<Record<PlainKind, readonly [(value: unknown) => boolean, string]>> = {
  string: [(v) => typeof v === 'string', 'is not a string.'],
  'string-or-null': [(v) => typeof v === 'string' || v === null, 'is not a string or null.'],
  boolean: [(v) => typeof v === 'boolean', 'is not true or false.'],
  number: [(v) => typeof v === 'number' && Number.isFinite(v), 'is not a number.'],
  integer: [(v) => Number.isInteger(v), 'is not a whole number.'],
  'date-time': [
    (v) => typeof v === 'string' && DATE_TIME.test(v) && !Number.isNaN(Date.parse(v)),
    'is not a date-time with a time zone.',
  ],
  array: [(v) => Array.isArray(v), 'is not an array.'],
};

/** An object: each required field there and fitting, each optional one fitting when it's there. */
function checkObject(
  shape: Extract<EventFieldShape, { kind: 'object' }>,
  value: unknown,
  path: string,
  at: string,
): string | undefined {
  if (!isRecord(value)) return `${at} is not an object.`;
  const fields: [string, EventFieldShape, boolean][] = [
    ...Object.entries(shape.required).map(([k, f]): [string, EventFieldShape, boolean] => [
      k,
      f,
      true,
    ]),
    ...Object.entries(shape.optional ?? {}).map(([k, f]): [string, EventFieldShape, boolean] => [
      k,
      f,
      false,
    ]),
  ];
  for (const [key, field, required] of fields) {
    const where = path === '' ? key : `${path}.${key}`;
    const present = Object.hasOwn(value, key) && value[key] !== undefined;
    if (!present) {
      if (required) return `\`${where}\` is missing.`;
      continue;
    }
    const problem = check(field, value[key], where);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** RFC 3339: a date, a time and a zone (`Z` or an offset), as the API writes them. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
