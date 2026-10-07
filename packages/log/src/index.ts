// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/log` — Kindgi's structured logger: levels (per subsystem, with
 * dotted inheritance), JSON and pretty formats, redaction, and the W3C
 * trace-context helpers. Zero dependencies. The runtime, `@kindgi/api`
 * (`createApp({ logger })`) and pack services write the same records.
 */

export type { LogFields, LogFormat, LogRecord, Logger, SerializedError } from './types.js';
export {
  LOG_LEVELS,
  type LogLevel,
  type ParsedLogLevels,
  SEVERITY,
  levelEnabled,
  levelFor,
  parseLogLevel,
  parseLogLevels,
} from './levels.js';
export { type CreateLoggerOptions, createLogger, noopLogger } from './logger.js';
export { formatJson, formatPretty } from './format.js';
export { REDACTED, isSecretKey, redactValue, scrubText } from './redact.js';
export {
  type TraceContext,
  childSpan,
  formatTraceparent,
  newTraceContext,
  parseTraceparent,
  traceFromHeader,
} from './trace.js';
export { type LoggerFromEnv, loggerFromEnv, resolveLogFormat } from './env.js';
