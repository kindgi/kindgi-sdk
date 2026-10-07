// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { LogLevel } from './levels.js';

/** A record's fields: values, never text pasted into the message. */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * One log record, the JSON format's line. `time` (RFC 3339), `level`,
 * `severity` (Cloud Logging's name for the level), `subsystem` and
 * `message` are always there; the correlation fields come next when
 * known, then the event's own fields. An error is `err`.
 */
export interface LogRecord {
  readonly time: string;
  readonly level: LogLevel;
  readonly severity: string;
  readonly subsystem: string;
  readonly message: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly requestId?: string;
  readonly tenantId?: string;
  readonly projectId?: string;
  readonly runId?: string;
  readonly err?: SerializedError;
  readonly [field: string]: unknown;
}

/** An error, as a record carries it. `stack` at `error`, or when the logger is at `debug` or below. */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
  readonly cause?: SerializedError | string;
}

/**
 * A logger. `child` returns one whose records all carry `bindings`
 * (`log.child({ subsystem: 'leases' })`, `log.child({ runId })`); a
 * child's `subsystem` replaces its parent's, so name it in full
 * (`kernel.sweeper`). Pass an error as `{ err: error }`.
 */
export interface Logger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  trace(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
  /** Whether a record at `level` would be written: skip building costly fields when it wouldn't. */
  isLevelEnabled(level: LogLevel): boolean;
}

export type LogFormat = 'json' | 'pretty';
