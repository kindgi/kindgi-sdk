// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** How `kindgi dev` shows the runtime's and the pack service's log lines. */

import { describe, expect, test } from 'vitest';

import { createLogger } from '@kindgi/log';

import { lineReader } from '../src/dev/lines.js';
import {
  DEFAULT_DEV_LOG_VIEW,
  type DevLogFlags,
  type DevLogView,
  parseDevLogFlags,
  resolveDevLogView,
  runtimeLogLevels,
  showIndexerLine,
  showLine,
  sourceLogEnv,
  sourceLogLevels,
  textLines,
} from '../src/dev/log-view.js';

const AT = new Date('2026-10-07T14:02:11.123Z');

function recordLine(write: (log: ReturnType<typeof createLogger>) => void): string {
  const lines: string[] = [];
  write(createLogger({ level: 'trace', write: (l) => lines.push(l), now: () => AT }));
  return lines[0] ?? '';
}

const ACCESS = recordLine((log) =>
  log
    .child({ subsystem: 'http' })
    .info(
      'GET /v1/runs 200 12ms',
      { method: 'GET', route: '/v1/runs', status: 200, durationMs: 12, requestId: 'req-1' },
      { inMessage: ['method', 'route', 'status', 'durationMs'] },
    ),
);

/** The runtime's boot record, as it writes its banner in JSON. */
const BOOT = recordLine((log) =>
  log.child({ subsystem: 'boot' }).info('Kindgi runtime ready', {
    url: 'http://127.0.0.1:4000',
    lines: ['Kindgi API server listening on http://127.0.0.1:4000', '  Pack: /pack (development)'],
  }),
);

const PRETTY = DEFAULT_DEV_LOG_VIEW;
const flags = (over: Partial<DevLogFlags> = {}): DevLogFlags => ({
  levels: {},
  format: 'pretty',
  quiet: false,
  ...over,
});

describe('the flags', () => {
  test('--log-level, --log (each, or a comma list) and --log-format', () => {
    const parsed = parseDevLogFlags({
      level: 'DEBUG',
      log: ['http=warn', 'pack=trace,kernel=error'],
      format: 'json',
      quiet: false,
    });
    expect(parsed).toEqual({
      kind: 'ok',
      value: {
        level: 'debug',
        levels: { http: 'warn', pack: 'trace', kernel: 'error' },
        format: 'json',
        quiet: false,
      },
    });
  });

  test('a bad value is refused, naming the flag', () => {
    const bad = (options: Partial<Parameters<typeof parseDevLogFlags>[0]>) =>
      parseDevLogFlags({
        level: undefined,
        log: undefined,
        format: undefined,
        quiet: false,
        ...options,
      });
    expect(bad({ level: 'loud' })).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/^--log-level must be one of error, warn, info, debug, trace/),
    });
    expect(bad({ log: ['http'] })).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/^--log: "http" isn't subsystem=level/),
    });
    expect(bad({ format: 'xml' })).toMatchObject({
      kind: 'error',
      message: '--log-format must be pretty or json, got "xml".',
    });
  });
});

describe('the view', () => {
  const env = (over: Record<string, string> = {}) => ({ env: over, files: {}, isTTY: false });

  test('the level: the flag, else the shell, else the env files, else info', () => {
    const level = (f: DevLogFlags, input: Parameters<typeof resolveDevLogView>[1]) => {
      const view = resolveDevLogView(f, input);
      return view.kind === 'ok' ? view.value.level : view.message;
    };
    expect(level(flags(), env())).toBe('info');
    expect(level(flags(), { ...env(), files: { KINDGI_LOG_LEVEL: 'warn' } })).toBe('warn');
    expect(
      level(flags(), {
        ...env({ KINDGI_LOG_LEVEL: 'debug' }),
        files: { KINDGI_LOG_LEVEL: 'warn' },
      }),
    ).toBe('debug');
    expect(level(flags({ level: 'trace' }), env({ KINDGI_LOG_LEVEL: 'debug' }))).toBe('trace');
    expect(level(flags(), env({ KINDGI_LOG_LEVEL: 'loud' }))).toMatch(/^KINDGI_LOG_LEVEL must be/);
  });

  test('--log adds to KINDGI_LOG_LEVELS and wins over it', () => {
    const view = resolveDevLogView(
      flags({ levels: { http: 'debug' } }),
      env({ KINDGI_LOG_LEVELS: 'http=warn,kernel=debug' }),
    );
    expect(view).toMatchObject({
      kind: 'ok',
      value: { levels: { http: 'debug', kernel: 'debug' } },
    });
  });

  test('--quiet: error, whatever the env says, unless --log-level says otherwise', () => {
    const quiet = (f: DevLogFlags) =>
      resolveDevLogView(f, env({ KINDGI_LOG_LEVEL: 'debug', KINDGI_LOG_LEVELS: 'http=trace' }));
    expect(quiet(flags({ quiet: true }))).toMatchObject({
      kind: 'ok',
      value: { level: 'error', levels: {}, quiet: true },
    });
    expect(quiet(flags({ quiet: true, level: 'warn' }))).toMatchObject({
      value: { level: 'warn' },
    });
  });

  test('colour on a terminal, unless NO_COLOR is set or the format is JSON', () => {
    const color = (f: DevLogFlags, shell: Record<string, string>, isTTY: boolean) => {
      const view = resolveDevLogView(f, { env: shell, files: {}, isTTY });
      return view.kind === 'ok' && view.value.color;
    };
    expect(color(flags(), {}, true)).toBe(true);
    expect(color(flags(), {}, false)).toBe(false);
    expect(color(flags(), { NO_COLOR: '1' }, true)).toBe(false);
    expect(color(flags({ format: 'json' }), {}, true)).toBe(false);
  });

  test('what the sources get: the levels; JSON for the ones kindgi dev reads', () => {
    const view: DevLogView = { ...PRETTY, level: 'debug', levels: { http: 'warn', pack: 'trace' } };
    expect(sourceLogLevels(view)).toEqual({
      KINDGI_LOG_LEVEL: 'debug',
      KINDGI_LOG_LEVELS: 'http=warn,pack=trace',
    });
    expect(sourceLogEnv(PRETTY)).toEqual({ KINDGI_LOG_FORMAT: 'json', KINDGI_LOG_LEVEL: 'info' });
  });

  test('the runtime keeps its boot record (its banner, which kindgi dev waits for) at info', () => {
    expect(runtimeLogLevels(PRETTY)).toEqual({ KINDGI_LOG_LEVEL: 'info' });
    expect(runtimeLogLevels({ ...PRETTY, level: 'debug' })).toEqual({ KINDGI_LOG_LEVEL: 'debug' });
    expect(runtimeLogLevels({ ...PRETTY, quiet: true, level: 'error' })).toEqual({
      KINDGI_LOG_LEVEL: 'error',
      KINDGI_LOG_LEVELS: 'boot=info',
    });
    expect(runtimeLogLevels({ ...PRETTY, levels: { boot: 'warn', http: 'debug' } })).toEqual({
      KINDGI_LOG_LEVEL: 'info',
      KINDGI_LOG_LEVELS: 'boot=info,http=debug',
    });
    // Shown or not is still the view's: under --quiet the banner isn't.
    const quiet = { ...PRETTY, quiet: true, level: 'error' } as const;
    expect(showLine('runtime', BOOT, quiet)).toBeUndefined();
  });
});

describe('showing a line', () => {
  test('a record: pretty and tagged, without the fields its message states', () => {
    expect(showLine('runtime', ACCESS, PRETTY)).toEqual({
      stream: 'stderr',
      lines: ['[runtime] 14:02:11.123 INFO  [http] GET /v1/runs 200 12ms requestId=req-1'],
    });
  });

  test('a record below its level is left out', () => {
    expect(showLine('runtime', ACCESS, { ...PRETTY, levels: { http: 'warn' } })).toBeUndefined();
  });

  test('--log-format=json: the record as written, on stdout', () => {
    expect(showLine('runtime', ACCESS, { ...PRETTY, format: 'json' })).toEqual({
      stream: 'stdout',
      lines: [ACCESS],
    });
  });

  test("the runtime's boot record: its banner lines", () => {
    expect(showLine('runtime', BOOT, PRETTY)).toEqual({
      stream: 'stderr',
      lines: [
        '[runtime] Kindgi API server listening on http://127.0.0.1:4000',
        '[runtime]   Pack: /pack (development)',
      ],
    });
    expect(textLines(BOOT)).toEqual([
      'Kindgi API server listening on http://127.0.0.1:4000',
      '  Pack: /pack (development)',
    ]);
  });

  test('a line that is not a record: as it is, tagged, on stderr; --quiet keeps only stderr ones', () => {
    expect(showLine('pack', 'hello from a tool', PRETTY, 'stdout')).toEqual({
      stream: 'stderr',
      lines: ['[pack] hello from a tool'],
    });
    expect(showLine('pack', '{"not":"a record"}', PRETTY)).toEqual({
      stream: 'stderr',
      lines: ['[pack] {"not":"a record"}'],
    });
    const quiet = { ...PRETTY, quiet: true, level: 'error' } as const;
    expect(showLine('pack', 'printed', quiet, 'stdout')).toBeUndefined();
    expect(showLine('pack', 'Traceback (most recent call last):', quiet, 'stderr')).toBeDefined();
    expect(textLines('plain')).toEqual(['plain']);
  });

  test("what pack code prints while it's indexed: shown at debug (pack.index)", () => {
    expect(showIndexerLine('connecting to the cache', PRETTY)).toBeUndefined();
    const debug = { ...PRETTY, levels: { pack: 'debug' } } as const;
    expect(showIndexerLine('connecting to the cache', debug, () => AT)).toEqual({
      stream: 'stderr',
      lines: ['[pack] 14:02:11.123 DEBUG [pack.index] connecting to the cache'],
    });
    // A record it writes is shown as any record.
    const warn = recordLine((log) => log.child({ subsystem: 'acme' }).warn('no cache'));
    expect(showIndexerLine(warn, PRETTY)?.lines[0]).toContain('WARN  [acme] no cache');
  });
});

describe('lineReader', () => {
  test('a line split across chunks comes out whole; \\r\\n and empty lines handled', () => {
    const lines: string[] = [];
    const reader = lineReader((line) => lines.push(line));
    reader.push('{"a":');
    reader.push('1}\r\n\nsecond');
    expect(lines).toEqual(['{"a":1}']);
    reader.push(' line\nthird');
    reader.end();
    expect(lines).toEqual(['{"a":1}', 'second line', 'third']);
  });
});
