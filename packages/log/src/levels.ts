// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Log levels, most severe first. A level says how much attention a line
 * needs: `error` (an operator should look), `warn` (unexpected but
 * handled), `info` (what happened, at the operator's grain), `debug` (the
 * decisions behind it), `trace` (internals, briefly).
 */
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Readonly<Record<LogLevel, number>> = {
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
};

/** Cloud Logging's severity names: Cloud Run and GKE show levels with no agent configuration. */
export const SEVERITY: Readonly<Record<LogLevel, string>> = {
  error: 'ERROR',
  warn: 'WARNING',
  info: 'INFO',
  debug: 'DEBUG',
  trace: 'DEBUG',
};

/** Whether a record at `level` is written by a logger at `threshold`. */
export function levelEnabled(level: LogLevel, threshold: LogLevel): boolean {
  return RANK[level] >= RANK[threshold];
}

/** A level's name, case and spaces aside; `undefined` when it isn't one. */
export function parseLogLevel(raw: string): LogLevel | undefined {
  const value = raw.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(value) ? (value as LogLevel) : undefined;
}

export type ParsedLogLevels =
  | { readonly kind: 'ok'; readonly levels: Readonly<Record<string, LogLevel>> }
  | { readonly kind: 'err'; readonly message: string };

/**
 * Per-subsystem levels, `KINDGI_LOG_LEVELS`'s form: a comma list of
 * `subsystem=level`, such as `kernel=debug,http=warn`. Empty is none. An
 * entry that isn't `name=level`, or names no known level, is an error that
 * quotes it. Whether a subsystem exists is the caller's question.
 */
export function parseLogLevels(raw: string): ParsedLogLevels {
  const levels: Record<string, LogLevel> = {};
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    const subsystem = eq === -1 ? '' : trimmed.slice(0, eq).trim();
    const level = eq === -1 ? undefined : parseLogLevel(trimmed.slice(eq + 1));
    if (subsystem === '' || level === undefined) {
      return {
        kind: 'err',
        message: `"${trimmed}" isn't subsystem=level (levels: ${LOG_LEVELS.join(', ')})`,
      };
    }
    levels[subsystem] = level;
  }
  return { kind: 'ok', levels };
}

/**
 * The level for `subsystem`: its own entry, else its nearest dotted
 * parent's (`kernel=debug` covers `kernel.sweeper`), else `fallback`.
 */
export function levelFor(
  subsystem: string,
  levels: Readonly<Record<string, LogLevel>>,
  fallback: LogLevel,
): LogLevel {
  let name = subsystem;
  for (;;) {
    const own = levels[name];
    if (own !== undefined) return own;
    const dot = name.lastIndexOf('.');
    if (dot === -1) return fallback;
    name = name.slice(0, dot);
  }
}
