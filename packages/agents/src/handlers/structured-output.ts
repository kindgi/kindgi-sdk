// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Typed agent output: reading the model's final answer as JSON and
 * checking it against the agent's `output.schema`, and the repair
 * message sent back when it doesn't fit.
 *
 * The model is told the output from the turn's start: the system message
 * carries `outputSection` (`build-initial-messages`), so a first answer
 * can fit. The repair loop, the fallback, lives in `budget-check`: an
 * invalid answer with repairs left keeps the turn going, with the answer
 * and a repair message (the same words, and what didn't fit) appended to
 * the conversation sent to the model. Repairs are counted from those
 * messages, so a replayed turn counts the same.
 */

import type { ModelMessage } from '@kindgi/capabilities';
import { type CompiledInlineSchema, compileInlineSchema } from '@kindgi/schema';

import type { AgentOutputSpec } from '../types.js';

/** Default number of repair attempts. */
export const DEFAULT_MAX_REPAIRS = 1;

/** Marks the messages this module adds, so they can be counted. */
const REPAIR_MARKER = '[kindgi:output-repair]';

export type OutputCheck =
  | { readonly kind: 'ok'; readonly value: unknown }
  | { readonly kind: 'invalid'; readonly errors: readonly string[] };

/**
 * The answer's text as JSON. Accepts a bare JSON value or one fenced
 * as ```json … ``` (models often fence it).
 */
export function parseJsonAnswer(content: unknown): OutputCheck {
  if (typeof content !== 'string') {
    return { kind: 'invalid', errors: ['the answer is not text'] };
  }
  const text = unfence(content.trim());
  if (text.length === 0) return { kind: 'invalid', errors: ['the answer is empty'] };
  try {
    return { kind: 'ok', value: JSON.parse(text) };
  } catch (cause) {
    return {
      kind: 'invalid',
      errors: [
        `the answer is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
      ],
    };
  }
}

function unfence(text: string): string {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(text);
  return fenced?.[1]?.trim() ?? text;
}

/** Compiled once per turn — see `outputChecker`. */
export interface OutputChecker {
  check(content: unknown): OutputCheck;
}

export function outputChecker(spec: AgentOutputSpec): OutputChecker {
  const compiled = compileInlineSchema(spec.schema);
  if (compiled.kind === 'err') {
    // `defineAgent` compiles the schema, so this is an agent built by hand.
    const reason = compiled.error.message;
    return {
      check: () => ({ kind: 'invalid', errors: [`the output schema is invalid: ${reason}`] }),
    };
  }
  const validator: CompiledInlineSchema = compiled.value;
  return {
    check(content) {
      const parsed = parseJsonAnswer(content);
      if (parsed.kind === 'invalid') return parsed;
      const validated = validator.validate(parsed.value);
      if (validated.kind === 'ok') return parsed;
      return { kind: 'invalid', errors: describeErrors(validated.error.errors) };
    },
  };
}

/** Ajv errors as `path message` lines the model can act on. */
function describeErrors(errors: readonly unknown[]): string[] {
  const list = errors.map((raw) => {
    const e = raw as { readonly instancePath?: string; readonly message?: string };
    const where = e.instancePath === undefined || e.instancePath === '' ? '(root)' : e.instancePath;
    return `${where} ${e.message ?? 'is invalid'}`;
  });
  return list.length > 0 ? list : ['the answer does not match the schema'];
}

/** Whether a message is one of this module's repair requests. */
export function isRepairMessage(m: ModelMessage): boolean {
  return m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(REPAIR_MARKER);
}

/** How many repairs this turn has asked for so far. */
export function repairsSoFar(messages: readonly ModelMessage[]): number {
  return messages.filter(isRepairMessage).length;
}

/**
 * What the model is told about a typed answer: the output's name, its JSON
 * Schema (descriptions included), and that the answer is that JSON and
 * nothing else. The system message and a repair say it in the same words.
 */
export function outputInstructions(spec: AgentOutputSpec): string {
  const name = spec.name ?? 'output';
  return [
    `Your answer must be the ${name} as JSON matching this JSON Schema, and nothing else:`,
    JSON.stringify(spec.schema),
  ].join('\n');
}

/**
 * The system message's part for a typed agent: the output, and that the
 * tools it needs come first, so a typed answer never stands in for a tool
 * call it still has to make.
 */
export function outputSection(spec: AgentOutputSpec): string {
  return [
    outputInstructions(spec),
    'Call the tools you need first; then give your final answer as that JSON alone.',
  ].join('\n');
}

/** The message asking the model to fix its answer. */
export function repairMessage(spec: AgentOutputSpec, errors: readonly string[]): ModelMessage {
  const name = spec.name ?? 'output';
  return {
    role: 'user',
    content: [
      REPAIR_MARKER,
      outputInstructions(spec),
      'It did not fit:',
      ...errors.map((e) => `- ${e}`),
      `Reply again with only the corrected ${name} JSON.`,
    ].join('\n'),
  };
}
