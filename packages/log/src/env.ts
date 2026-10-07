// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { LOG_LEVELS, type LogLevel, parseLogLevel, parseLogLevels } from './levels.js';
import { createLogger } from './logger.js';
import type { LogFormat, Logger } from './types.js';

/**
 * `KINDGI_LOG_FORMAT`'s value as a format: `json` or `pretty` as given;
 * `auto` (the default) is pretty on a terminal and JSON otherwise. So the
 * CLI, the runtime and a pack service agree. `undefined` for any other
 * value.
 */
export function resolveLogFormat(
  raw: string | undefined,
  context: { readonly isTTY: boolean },
): LogFormat | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'auto') return context.isTTY ? 'pretty' : 'json';
  if (value === 'json' || value === 'pretty') return value;
  return undefined;
}

/** `KINDGI_LOG_LEVEL`'s level (`info` when unset), or the error that names a bad one. */
function levelFromEnv(
  raw: string | undefined,
): LogLevel | { readonly kind: 'err'; readonly message: string } {
  if (raw === undefined || raw.trim() === '') return 'info';
  const parsed = parseLogLevel(raw);
  if (parsed !== undefined) return parsed;
  return {
    kind: 'err',
    message: `KINDGI_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${raw}".`,
  };
}

/** `KINDGI_LOG_LEVELS` entries no subsystem logs under (nor its dotted root). */
function unknownSubsystems(
  levels: Readonly<Record<string, LogLevel>>,
  subsystems: readonly string[],
): string[] {
  const known = new Set(subsystems);
  return Object.keys(levels)
    .filter((name) => !known.has(name) && !known.has(name.split('.')[0] ?? name))
    .map(
      (name) =>
        `KINDGI_LOG_LEVELS names "${name}", which no subsystem logs under; it has no effect.`,
    );
}

export type LoggerFromEnv =
  | {
      readonly kind: 'ok';
      readonly logger: Logger;
      /** Settings that are wrong but harmless: log them at boot (an unknown subsystem, say). */
      readonly problems: readonly string[];
    }
  | {
      /** A setting that can't be honoured: refuse to start, naming it (exit code 2). */
      readonly kind: 'err';
      readonly message: string;
    };

/**
 * The root logger from `KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and
 * `KINDGI_LOG_FORMAT`. An unknown level or format, or a malformed
 * `KINDGI_LOG_LEVELS`, is an error; a subsystem not in `subsystems` (when
 * given) is a problem to report, not a refusal, so a typo doesn't stop a
 * server. Default sink: stdout.
 */
export function loggerFromEnv(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly write?: (line: string) => void;
  readonly isTTY?: boolean;
  /** The subsystems the caller logs under, to flag an unknown one. */
  readonly subsystems?: readonly string[];
  /** Extra field keys to redact. */
  readonly redact?: readonly string[];
}): LoggerFromEnv {
  const { env } = input;
  const level = levelFromEnv(env.KINDGI_LOG_LEVEL);
  if (typeof level === 'object') return level;
  const levels = parseLogLevels(env.KINDGI_LOG_LEVELS ?? '');
  if (levels.kind === 'err') {
    return { kind: 'err', message: `KINDGI_LOG_LEVELS: ${levels.message}.` };
  }
  const isTTY = input.isTTY ?? false;
  const format = resolveLogFormat(env.KINDGI_LOG_FORMAT, { isTTY });
  if (format === undefined) {
    return {
      kind: 'err',
      message: `KINDGI_LOG_FORMAT must be auto, json or pretty, got "${env.KINDGI_LOG_FORMAT}".`,
    };
  }
  const problems =
    input.subsystems === undefined ? [] : unknownSubsystems(levels.levels, input.subsystems);
  const write =
    input.write ??
    ((line: string) => {
      if (typeof process !== 'undefined') process.stdout.write(`${line}\n`);
    });
  const logger = createLogger({
    level,
    levels: levels.levels,
    format,
    color: format === 'pretty' && isTTY && (env.NO_COLOR ?? '') === '',
    write,
    ...(input.redact !== undefined && { redact: input.redact }),
  });
  return { kind: 'ok', logger, problems };
}
