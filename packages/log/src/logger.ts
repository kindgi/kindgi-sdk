// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { formatJson, formatPretty } from './format.js';
import { type LogLevel, SEVERITY, levelEnabled, levelFor } from './levels.js';
import { redactValue, scrubText } from './redact.js';
import type {
  LogFields,
  LogFormat,
  LogOptions,
  LogRecord,
  Logger,
  SerializedError,
} from './types.js';

export interface CreateLoggerOptions {
  /** Records below this level aren't written (`KINDGI_LOG_LEVEL`). Default `info`. */
  readonly level?: LogLevel;
  /** Per-subsystem levels; a dotted name inherits its parent's (`KINDGI_LOG_LEVELS`). */
  readonly levels?: Readonly<Record<string, LogLevel>>;
  /** `json` (one record per line) or `pretty` (for a terminal). Default `json`. */
  readonly format?: LogFormat;
  /** Colours in the pretty format (a terminal, `NO_COLOR` unset). Default off. */
  readonly color?: boolean;
  /** Where each line goes: one complete line, no trailing newline. */
  readonly write: (line: string) => void;
  /** More field keys to redact, on top of the built-in ones. */
  readonly redact?: readonly string[];
  /** The records' subsystem until a child names one. Default `root`. */
  readonly subsystem?: string;
  /** The clock (tests). */
  readonly now?: () => Date;
}

/** Correlation fields, in the order a record carries them, after the fixed five. */
const CORRELATION = [
  'traceId',
  'spanId',
  'runTraceId',
  'requestId',
  'tenantId',
  'projectId',
  'orgId',
  'runId',
  'parentRunId',
  'agentId',
  'agentVersion',
  'flowId',
  'flowVersion',
  'toolId',
  'conversationId',
  'approvalId',
] as const;

const FIXED: ReadonlySet<string> = new Set(['time', 'level', 'severity', 'subsystem', 'message']);

function serializeError(err: unknown, withStack: boolean, depth = 0): SerializedError | string {
  if (!(err instanceof Error)) return scrubText(String(err));
  const code = (err as { readonly code?: unknown }).code;
  const cause = (err as { readonly cause?: unknown }).cause;
  return {
    name: err.name,
    message: scrubText(err.message),
    ...(typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {}),
    ...(withStack && err.stack !== undefined && { stack: scrubText(err.stack) }),
    ...(cause !== undefined && depth < 3 && { cause: serializeError(cause, withStack, depth + 1) }),
  };
}

/**
 * Copy a record's own fields into `out`, after the fixed five and the
 * correlation ones; an `Error` among them is serialized. A field named
 * like one of the fixed five can't replace it: it comes back to be kept
 * under `fields`.
 */
function copyFields(
  out: Record<string, unknown>,
  merged: Readonly<Record<string, unknown>>,
  level: LogLevel,
): Record<string, unknown> {
  const reserved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || key === 'subsystem' || key === 'err') continue;
    if ((CORRELATION as readonly string[]).includes(key)) continue;
    if (FIXED.has(key)) reserved[key] = value;
    else out[key] = value instanceof Error ? serializeError(value, level === 'error') : value;
  }
  return reserved;
}

interface Shared {
  readonly options: CreateLoggerOptions;
  readonly threshold: LogLevel;
  readonly levels: Readonly<Record<string, LogLevel>>;
  readonly format: LogFormat;
  readonly now: () => Date;
}

function build(shared: Shared, bindings: LogFields): Logger {
  const subsystem =
    typeof bindings.subsystem === 'string' && bindings.subsystem !== ''
      ? bindings.subsystem
      : (shared.options.subsystem ?? 'root');
  const threshold = levelFor(subsystem, shared.levels, shared.threshold);
  const extra = shared.options.redact ?? [];

  function record(level: LogLevel, message: string, fields: LogFields | undefined): LogRecord {
    const merged: Record<string, unknown> = { ...bindings, ...fields };
    const out: Record<string, unknown> = {
      time: shared.now().toISOString(),
      level,
      severity: SEVERITY[level],
      subsystem,
      message: scrubText(message),
    };
    for (const key of CORRELATION) {
      if (merged[key] !== undefined) out[key] = redactValue(merged[key], extra);
    }
    const reserved = copyFields(out, merged, level);
    const redacted = redactValue(out, extra) as Record<string, unknown>;
    // The fixed five are the record's own, never redacted as fields.
    for (const key of FIXED) redacted[key] = out[key];
    if (Object.keys(reserved).length > 0) redacted.fields = redactValue(reserved, extra);
    if (merged.err !== undefined) {
      const withStack = level === 'error' || levelEnabled('debug', threshold);
      redacted.err = serializeError(merged.err, withStack);
    }
    return redacted as LogRecord;
  }

  function write(level: LogLevel, message: string, fields?: LogFields, how?: LogOptions): void {
    if (!levelEnabled(level, threshold)) return;
    const rec = record(level, message, fields);
    const line =
      shared.format === 'pretty'
        ? formatPretty(rec, {
            color: shared.options.color === true,
            ...(how?.inMessage !== undefined && { omit: how.inMessage }),
          })
        : formatJson(rec);
    try {
      shared.options.write(line);
    } catch {
      // A sink that fails must never fail the code that logged.
    }
  }

  return {
    error: (message, fields, how) => write('error', message, fields, how),
    warn: (message, fields, how) => write('warn', message, fields, how),
    info: (message, fields, how) => write('info', message, fields, how),
    debug: (message, fields, how) => write('debug', message, fields, how),
    trace: (message, fields, how) => write('trace', message, fields, how),
    child: (more) => build(shared, { ...bindings, ...more }),
    isLevelEnabled: (level) => levelEnabled(level, threshold),
  };
}

/**
 * A logger: records at or above its level (per subsystem, `levels`) are
 * redacted and written to `write` as JSON or pretty lines. Logging never
 * throws, and a failing sink is ignored.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  return build(
    {
      options,
      threshold: options.level ?? 'info',
      levels: options.levels ?? {},
      format: options.format ?? 'json',
      now: options.now ?? (() => new Date()),
    },
    {},
  );
}

/** A logger that writes nothing: the default where one isn't given (`createApp`). */
const noop = (): void => undefined;

export const noopLogger: Logger = {
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  trace: noop,
  child: () => noopLogger,
  isLevelEnabled: () => false,
};
