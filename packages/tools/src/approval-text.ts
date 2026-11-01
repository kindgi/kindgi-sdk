// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Result } from '@kindgi/types';
import type { InvalidToolDefinitionError } from './errors.js';
import type { ToolApproval, ToolManifest } from './types.js';

/**
 * A `{field}` placeholder: a top-level field of the tool's input, named
 * as an HTTP spec's `urlTemplate` names one.
 */
const PLACEHOLDER = /\{(\w+)\}/g;

/** Each text of an approval, with the path a problem in it is reported at. */
function textsOf(approval: ToolApproval): readonly (readonly [path: string, text: string])[] {
  return [
    ['/approval/title', approval.title],
    ...(approval.summary !== undefined ? [['/approval/summary', approval.summary] as const] : []),
    ...(approval.about !== undefined ? [['/approval/about/id', approval.about.id] as const] : []),
  ];
}

const SCALAR_TYPES: ReadonlySet<unknown> = new Set(['string', 'number', 'integer', 'boolean']);

function isScalarValue(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Whether a field's schema only lets a string, a number, an integer or a
 * boolean through (or an enum of those): a value that fills a line of
 * text. `null`, objects, arrays and unions don't.
 */
function isScalarSchema(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return false;
  const s = schema as {
    readonly type?: unknown;
    readonly enum?: unknown;
    readonly const?: unknown;
  };
  if (Array.isArray(s.enum)) return s.enum.length > 0 && s.enum.every(isScalarValue);
  if ('const' in s) return isScalarValue(s.const);
  const types = Array.isArray(s.type) ? s.type : [s.type];
  return types.length > 0 && types.every((t) => SCALAR_TYPES.has(t));
}

/**
 * Why a tool's `approval` can't be filled from its calls, if it can't.
 * Each `{field}` names a required top-level field of `input` whose
 * schema is a string, a number, an integer or a boolean (or an enum of
 * those), so every call has a value for it that reads as text. A brace
 * that isn't part of a placeholder is refused, so a text never reads
 * other than it's written, and `about.id` holds at least one placeholder.
 * Checked where the tool is defined, registered (`POST /v1/tools`) or
 * deployed, as `needsSpec` is.
 */
export function approvalProblem(manifest: ToolManifest): InvalidToolDefinitionError | undefined {
  const approval = manifest.approval;
  if (approval === undefined) return undefined;
  const fields = fieldsOf(manifest.input);
  for (const [path, text] of textsOf(approval)) {
    const message = textProblem(path, text, fields);
    if (message !== undefined) {
      const where = path.slice(1).replaceAll('/', '.');
      return {
        code: 'invalid-tool-definition',
        message: `Tool "${manifest.id as unknown as string}": ${where} ${message}`,
        issues: [{ path, message }],
      };
    }
  }
  return undefined;
}

interface InputFields {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: ReadonlySet<unknown>;
}

/** The top-level fields of an input schema, and which of them it requires. */
function fieldsOf(input: unknown): InputFields {
  const schema = (input ?? {}) as { readonly properties?: unknown; readonly required?: unknown };
  return {
    properties:
      schema.properties !== null && typeof schema.properties === 'object'
        ? (schema.properties as Readonly<Record<string, unknown>>)
        : {},
    required: new Set(Array.isArray(schema.required) ? schema.required : []),
  };
}

/** Why one text of an approval can't be filled from a call, if it can't. */
function textProblem(path: string, text: string, fields: InputFields): string | undefined {
  if (/[{}]/.test(text.replace(PLACEHOLDER, ''))) {
    return "has a brace that isn't part of a {field} placeholder";
  }
  const names = [...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
  if (path === '/approval/about/id' && names.length === 0) {
    return 'must hold at least one {field} placeholder';
  }
  for (const name of names) {
    const why = fieldProblem(name, fields.properties, fields.required);
    if (why !== undefined) return why;
  }
  return undefined;
}

/** Why the input's field `name` can't fill a placeholder, if it can't. */
function fieldProblem(
  name: string,
  properties: Readonly<Record<string, unknown>>,
  required: ReadonlySet<unknown>,
): string | undefined {
  if (!Object.hasOwn(properties, name)) return `names {${name}}, which isn't a field of the input`;
  if (!required.has(name)) {
    return `names {${name}}, an optional field of the input: a call may leave it out`;
  }
  if (!isScalarSchema(properties[name])) {
    return `names {${name}}, a field of the input that isn't a string, a number, an integer or a boolean`;
  }
  return undefined;
}

/** A call's approval in its tool's words: what dispatch puts in the approval's `context`. */
export interface RenderedApproval {
  readonly text: { readonly title: string; readonly summary?: string };
  readonly about?: { readonly kind: string; readonly id: string };
}

/** How long one value may run in each text, and each whole text. */
const VALUE_MAX = { title: 80, summary: 500, about: 200 } as const;
const TEXT_MAX = { title: 200, summary: 1000, about: 200 } as const;

/**
 * A value on one line, as it reads: each control character (C0 and C1,
 * line breaks included) and each line or paragraph separator becomes a
 * space, and each bidi control goes, so a value can't break the line or
 * reorder the words around it. Runs of white space close up.
 */
function oneLine(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it replaces.
      .replace(/[\x00-\x1f\x7f-\x9f\u{2028}\u{2029}]/gu, ' ')
      .replace(/[\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** `text` cut to `max` characters, ending in `…` when it's cut. */
function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * A call's approval in its tool's words: each `{field}` filled from the
 * call's arguments in one pass (a value holding `{x}` stays as it is),
 * each value on one line and cut when long, then each text cut. A call
 * whose arguments don't fill every placeholder (a pack read from disk
 * wasn't checked where it was defined) answers the path of the text that
 * didn't fill, and its approval reads the default.
 */
export function renderApproval(
  approval: ToolApproval,
  args: unknown,
): Result<RenderedApproval, { readonly path: string }> {
  const values =
    args !== null && typeof args === 'object' && !Array.isArray(args)
      ? (args as Readonly<Record<string, unknown>>)
      : {};
  const fill = (template: string, part: keyof typeof VALUE_MAX): string | undefined => {
    let filled = true;
    const text = template.replace(PLACEHOLDER, (_, name: string) => {
      const value = Object.hasOwn(values, name) ? values[name] : undefined;
      if (!isScalarValue(value)) {
        filled = false;
        return '';
      }
      return cut(oneLine(String(value)), VALUE_MAX[part]);
    });
    return filled ? cut(text, TEXT_MAX[part]) : undefined;
  };
  const title = fill(approval.title, 'title');
  if (title === undefined) return { kind: 'err', error: { path: '/approval/title' } };
  const summary = approval.summary !== undefined ? fill(approval.summary, 'summary') : undefined;
  if (approval.summary !== undefined && summary === undefined) {
    return { kind: 'err', error: { path: '/approval/summary' } };
  }
  const id = approval.about !== undefined ? fill(approval.about.id, 'about') : undefined;
  if (approval.about !== undefined && id === undefined) {
    return { kind: 'err', error: { path: '/approval/about/id' } };
  }
  return {
    kind: 'ok',
    value: {
      text: { title, ...(summary !== undefined && { summary }) },
      ...(approval.about !== undefined &&
        id !== undefined &&
        id !== '' && { about: { kind: approval.about.kind, id } }),
    },
  };
}
