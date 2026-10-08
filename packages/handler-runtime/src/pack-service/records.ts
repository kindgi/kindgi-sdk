// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The pack service's log: `@kindgi/log` records on stderr, subsystem
 * `pack` (the runtime writes the same schema). Two streams share the sink:
 *
 *   - **`log`**: calls, and `ctx.log` beneath them (`pack.tool`,
 *     `pack.check`). `KINDGI_LOG_LEVEL` / `KINDGI_LOG_LEVELS` apply.
 *   - **`event`**: the lifecycle (`listening`, `boot-failed`, …), written
 *     whatever the levels, because a supervisor reads it to know the
 *     service is up. Its records carry the event's name as `event`, and as
 *     `kind` too, so a supervisor from before records (which reads bare
 *     `{"kind": …}` lines) still sees `listening`. `kind` stays through
 *     0.1.x.
 *
 * The format is `KINDGI_LOG_FORMAT`'s, but `auto` is pretty only on a
 * terminal: a supervisor pipes stderr, and dev mode (`KINDGI_DEV`) doesn't
 * make it pretty, so a supervisor always gets JSON unless told otherwise.
 */

import {
  type LogFields,
  type Logger,
  createLogger,
  loggerFromEnv,
  resolveLogFormat,
} from '@kindgi/log';

/** Lifecycle events: always written, the supervisor's to read. */
export const PACK_SERVICE_EVENTS = [
  'listening',
  'boot-failed',
  'config-invalid',
  'draining',
  'stopped',
] as const;
export type PackServiceEventKind = (typeof PACK_SERVICE_EVENTS)[number];

const EVENT_LEVEL = {
  listening: 'info',
  'boot-failed': 'error',
  'config-invalid': 'error',
  draining: 'info',
  stopped: 'info',
} as const satisfies Record<PackServiceEventKind, 'info' | 'error'>;

export interface PackServiceLogs {
  /** Calls, and `ctx.log` beneath them; the levels apply. */
  readonly log: Logger;
  /** A lifecycle event, written whatever the levels. */
  event(kind: PackServiceEventKind, message: string, fields?: LogFields): void;
}

export type PackServiceLogsOutcome =
  | { readonly kind: 'ok'; readonly logs: PackServiceLogs; readonly problems: readonly string[] }
  | { readonly kind: 'err'; readonly message: string };

/** The pack service's logs from `KINDGI_LOG_*`; a bad setting is an error naming it. */
export function packServiceLogs(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** One line, no newline. Default stderr. */
  readonly write?: (line: string) => void;
  readonly isTTY?: boolean;
}): PackServiceLogsOutcome {
  // Dev mode doesn't make the service's records pretty: its supervisor reads them.
  const { KINDGI_DEV: _dev, ...env } = input.env;
  const write = input.write ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const isTTY = input.isTTY ?? false;
  const built = loggerFromEnv({ env, write, isTTY, subsystems: ['pack'] });
  if (built.kind === 'err') return built;
  const format = resolveLogFormat(env.KINDGI_LOG_FORMAT, { isTTY }) ?? 'json';
  const always = createLogger({
    level: 'trace',
    format,
    color: format === 'pretty' && isTTY && (env.NO_COLOR ?? '') === '',
    write,
    subsystem: 'pack',
  });
  return {
    kind: 'ok',
    problems: built.problems,
    logs: {
      log: built.logger.child({ subsystem: 'pack' }),
      event(kind, message, fields = {}) {
        always[EVENT_LEVEL[kind]](message, { ...fields, event: kind, kind });
      },
    },
  };
}

/** Logs for a caller that passes none: records on stderr, at the defaults. */
export function defaultPackServiceLogs(): PackServiceLogs {
  const built = packServiceLogs({ env: {}, isTTY: false });
  if (built.kind === 'err') throw new Error(built.message);
  return built.logs;
}
