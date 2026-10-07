// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * How `kindgi dev` shows logs. The runtime container and the pack service
 * write `@kindgi/log` records as JSON; `kindgi dev` reads them and prints
 * them for a person, each tagged with where it came from:
 *
 *   [runtime] 14:02:11.123 INFO  [http] GET /v1/runs 200 12ms requestId=…
 *   [pack] 14:02:11.130 INFO  [pack] tool acme.lookup ok 12ms runId=…
 *
 * Levels are set where the records are written (`KINDGI_LOG_LEVEL` and
 * `KINDGI_LOG_LEVELS` for the runtime, the pack service and the indexer),
 * and checked again here for a source that ignores them.
 * `--log-format=json` writes the records as they came, one per line on
 * stdout, for `| jq`; everything else stays on stderr. `--quiet` keeps
 * errors only. A line that isn't a record (pack code's own output, an
 * older runtime's) is shown as it is.
 */

import {
  LOG_LEVELS,
  type LogLevel,
  type LogRecord,
  SEVERITY,
  formatPretty,
  levelEnabled,
  levelFor,
  parseLogLevel,
  parseLogLevels,
} from '@kindgi/log';

import type { OptionValue } from '../parse.js';

/** Where a line came from: its tag. */
export type DevLogSource = 'runtime' | 'pack';

/** What `kindgi dev` writes for one line: lines of text for a stream. */
export interface DevOutput {
  readonly stream: 'stdout' | 'stderr';
  readonly lines: readonly string[];
}

/** The log flags, checked: `--log-level`, `--log` (each), `--log-format`, `--quiet`. */
export interface DevLogFlags {
  readonly level?: LogLevel;
  readonly levels: Readonly<Record<string, LogLevel>>;
  readonly format: 'pretty' | 'json';
  readonly quiet: boolean;
}

/** How `kindgi dev` shows logs this session. */
export interface DevLogView {
  /** The level for subsystems `levels` doesn't name. */
  readonly level: LogLevel;
  /** Per-subsystem levels, dotted children included (`pack` covers `pack.tool`). */
  readonly levels: Readonly<Record<string, LogLevel>>;
  readonly format: 'pretty' | 'json';
  /** Colours in pretty lines: stderr is a terminal and `NO_COLOR` is unset. */
  readonly color: boolean;
  /** `--quiet`: errors only. */
  readonly quiet: boolean;
}

/** Before the flags are read: everything shown, plain. */
export const DEFAULT_DEV_LOG_VIEW: DevLogView = {
  level: 'info',
  levels: {},
  format: 'pretty',
  color: false,
  quiet: false,
};

type Checked<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'error'; readonly message: string };

/** The log flags from the command line, or what's wrong with one. */
export function parseDevLogFlags(options: {
  readonly level: OptionValue;
  readonly log: OptionValue;
  readonly format: OptionValue;
  readonly quiet: boolean;
}): Checked<DevLogFlags> {
  let level: LogLevel | undefined;
  if (typeof options.level === 'string') {
    level = parseLogLevel(options.level);
    if (level === undefined) {
      return {
        kind: 'error',
        message: `--log-level must be one of ${LOG_LEVELS.join(', ')}, got "${options.level}".`,
      };
    }
  }
  const levels: Record<string, LogLevel> = {};
  const entries =
    typeof options.log === 'string' ? [options.log] : Array.isArray(options.log) ? options.log : [];
  for (const entry of entries) {
    const parsed = parseLogLevels(entry);
    if (parsed.kind === 'err') return { kind: 'error', message: `--log: ${parsed.message}.` };
    Object.assign(levels, parsed.levels);
  }
  const format =
    typeof options.format === 'string' ? options.format.trim().toLowerCase() : 'pretty';
  if (format !== 'pretty' && format !== 'json') {
    return {
      kind: 'error',
      message: `--log-format must be pretty or json, got "${String(options.format)}".`,
    };
  }
  return {
    kind: 'ok',
    value: { ...(level !== undefined && { level }), levels, format, quiet: options.quiet },
  };
}

/**
 * The session's view: the flags first, then `KINDGI_LOG_LEVEL` and
 * `KINDGI_LOG_LEVELS` (the shell's, then the env files'), then `info`.
 * `--quiet` is `error` unless `--log-level` says otherwise.
 */
export function resolveDevLogView(
  flags: DevLogFlags,
  input: {
    /** The shell's environment. */
    readonly env: Readonly<Record<string, string | undefined>>;
    /** The env files' `KINDGI_*` values. */
    readonly files: Readonly<Record<string, string>>;
    /** Whether stderr is a terminal. */
    readonly isTTY: boolean;
  },
): Checked<DevLogView> {
  const setting = (name: string): string | undefined => {
    const value = input.env[name] ?? input.files[name];
    return value === undefined || value.trim() === '' ? undefined : value;
  };
  let level = flags.level;
  let levels: Readonly<Record<string, LogLevel>> = {};
  if (flags.quiet) {
    level ??= 'error';
  } else {
    const rawLevel = setting('KINDGI_LOG_LEVEL');
    if (level === undefined && rawLevel !== undefined) {
      level = parseLogLevel(rawLevel);
      if (level === undefined) {
        return {
          kind: 'error',
          message: `KINDGI_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${rawLevel}".`,
        };
      }
    }
    const rawLevels = setting('KINDGI_LOG_LEVELS');
    if (rawLevels !== undefined) {
      const parsed = parseLogLevels(rawLevels);
      if (parsed.kind === 'err') {
        return { kind: 'error', message: `KINDGI_LOG_LEVELS: ${parsed.message}.` };
      }
      levels = parsed.levels;
    }
  }
  const color = flags.format === 'pretty' && input.isTTY && (input.env.NO_COLOR ?? '') === '';
  return {
    kind: 'ok',
    value: {
      level: level ?? 'info',
      levels: { ...levels, ...flags.levels },
      format: flags.format,
      color,
      quiet: flags.quiet,
    },
  };
}

/** The levels a source gets, so it writes only what's shown. */
export function sourceLogLevels(view: DevLogView): Record<string, string> {
  const levels = Object.entries(view.levels)
    .map(([subsystem, level]) => `${subsystem}=${level}`)
    .join(',');
  return {
    KINDGI_LOG_LEVEL: view.level,
    ...(levels !== '' && { KINDGI_LOG_LEVELS: levels }),
  };
}

/**
 * The settings a source `kindgi dev` reads gets: the levels shown, as
 * records (the pack service and the indexer; the runtime container adds
 * the format itself, since a runtime you run writes to your terminal).
 */
export function sourceLogEnv(view: DevLogView): Record<string, string> {
  return { KINDGI_LOG_FORMAT: 'json', ...sourceLogLevels(view) };
}

/** A line as a record, when it is one (the five fixed fields, a known level). */
export function parseRecord(line: string): LogRecord | undefined {
  if (!line.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const r = parsed as Record<string, unknown>;
  return typeof r.time === 'string' &&
    typeof r.level === 'string' &&
    (LOG_LEVELS as readonly string[]).includes(r.level) &&
    typeof r.subsystem === 'string' &&
    typeof r.message === 'string'
    ? (r as LogRecord)
    : undefined;
}

/**
 * The runtime's banner, when the record carries it: in JSON the runtime
 * writes its boot lines as one `boot` record with them as `lines`.
 */
function bootLines(record: LogRecord): readonly string[] | undefined {
  const lines = record.lines;
  return record.subsystem === 'boot' &&
    Array.isArray(lines) &&
    lines.every((l) => typeof l === 'string')
    ? (lines as readonly string[])
    : undefined;
}

/**
 * A line as text a person reads, for checks on what a source said and
 * for a failure's last lines: a record pretty (the banner as its lines),
 * anything else as it is.
 */
export function textLines(line: string): readonly string[] {
  const record = parseRecord(line);
  if (record === undefined) return [line];
  return bootLines(record) ?? formatPretty(record).split('\n');
}

/** Whether the view shows a record at `level` from `subsystem`. */
export function shows(view: DevLogView, level: LogLevel, subsystem: string): boolean {
  return levelEnabled(level, levelFor(subsystem, view.levels, view.level));
}

/** A record, as `kindgi dev` shows it: `undefined` when its level is filtered out. */
export function showRecord(
  source: DevLogSource,
  record: LogRecord,
  raw: string,
  view: DevLogView,
): DevOutput | undefined {
  if (!shows(view, record.level, record.subsystem)) return undefined;
  if (view.format === 'json') return { stream: 'stdout', lines: [raw] };
  const text = bootLines(record) ?? formatPretty(record, { color: view.color }).split('\n');
  return { stream: 'stderr', lines: text.map((l) => `[${source}] ${l}`) };
}

/**
 * A line that isn't a record, as `kindgi dev` shows it: tagged, on
 * stderr. `--quiet` keeps only what a source wrote on stderr.
 */
export function showText(
  source: DevLogSource,
  line: string,
  view: DevLogView,
  stream: 'stdout' | 'stderr',
): DevOutput | undefined {
  if (view.quiet && stream !== 'stderr') return undefined;
  return { stream: 'stderr', lines: [`[${source}] ${line}`] };
}

/** A line a source wrote, as `kindgi dev` shows it, or `undefined` to leave it out. */
export function showLine(
  source: DevLogSource,
  line: string,
  view: DevLogView,
  stream: 'stdout' | 'stderr' = 'stdout',
): DevOutput | undefined {
  const record = parseRecord(line);
  return record === undefined
    ? showText(source, line, view, stream)
    : showRecord(source, record, line, view);
}

/**
 * What pack code printed while the indexer loaded it: shown at `debug`
 * (subsystem `pack.index`), where it used to be dropped. A record it
 * wrote is shown as any record.
 */
export function showIndexerLine(
  line: string,
  view: DevLogView,
  now: () => Date = () => new Date(),
): DevOutput | undefined {
  const record = parseRecord(line);
  if (record !== undefined) return showRecord('pack', record, line, view);
  if (!shows(view, 'debug', 'pack.index')) return undefined;
  if (view.format === 'json') return { stream: 'stderr', lines: [`[pack] ${line}`] };
  const shown: LogRecord = {
    time: now().toISOString(),
    level: 'debug',
    severity: SEVERITY.debug,
    subsystem: 'pack.index',
    message: line,
  };
  return { stream: 'stderr', lines: [`[pack] ${formatPretty(shown, { color: view.color })}`] };
}
