// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { LogLevel } from './levels.js';
import type { LogRecord, SerializedError } from './types.js';

/** The JSON format: one record per line, the schema `LogRecord` describes. */
export function formatJson(record: LogRecord): string {
  return JSON.stringify(record, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

const LEVEL_LABEL: Readonly<Record<LogLevel, string>> = {
  error: 'ERROR',
  warn: 'WARN ',
  info: 'INFO ',
  debug: 'DEBUG',
  trace: 'TRACE',
};

const COLOR: Readonly<Record<LogLevel, string>> = {
  error: '\u001b[31m',
  warn: '\u001b[33m',
  info: '\u001b[36m',
  debug: '\u001b[90m',
  trace: '\u001b[90m',
};
const RESET = '\u001b[0m';
const DIM = '\u001b[2m';

const FIXED: ReadonlySet<string> = new Set([
  'time',
  'level',
  'severity',
  'subsystem',
  'message',
  'err',
]);

function pretty(value: unknown): string {
  if (typeof value === 'string')
    return /[\s"=]/.test(value) || value === '' ? JSON.stringify(value) : value;
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

function errorLines(err: SerializedError): string[] {
  const head = `${err.name}: ${err.message}${err.code !== undefined ? ` (${err.code})` : ''}`;
  const lines = [head];
  if (err.stack !== undefined) {
    const frames = err.stack.split('\n').filter((l) => /^\s*at /.test(l));
    lines.push(...frames.map((f) => `    ${f.trim()}`));
  }
  if (err.cause !== undefined) {
    lines.push(
      typeof err.cause === 'string'
        ? `  caused by: ${err.cause}`
        : `  caused by: ${errorLines(err.cause).join('\n  ')}`,
    );
  }
  return lines;
}

/**
 * The pretty format, for a person at a terminal:
 * `HH:MM:SS.mmm LEVEL [subsystem] message key=value …`, an error's
 * frames on the lines after. Colours only when `color` is set (a
 * terminal, and `NO_COLOR` unset). `omit`: fields the message already
 * states (`LogOptions.inMessage`), left out of the line.
 */
export function formatPretty(
  record: LogRecord,
  options: { readonly color?: boolean; readonly omit?: readonly string[] } = {},
): string {
  const color = options.color === true;
  const time = record.time.slice(11, 23);
  const label = LEVEL_LABEL[record.level];
  const omit = options.omit ?? [];
  const fields = Object.entries(record)
    .filter(([key, value]) => !FIXED.has(key) && value !== undefined && !omit.includes(key))
    .map(([key, value]) => `${key}=${pretty(value)}`);
  const head = [
    color ? `${DIM}${time}${RESET}` : time,
    color ? `${COLOR[record.level]}${label}${RESET}` : label,
    `[${record.subsystem}]`,
    record.message,
    ...fields,
  ].join(' ');
  if (record.err === undefined) return head;
  const [first, ...rest] = errorLines(record.err);
  return [`${head} err=${pretty(first)}`, ...rest].join('\n');
}
