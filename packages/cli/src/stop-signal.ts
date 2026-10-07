// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * SIGINT / SIGTERM / SIGHUP → an AbortSignal long-lived commands
 * (`kindgi dev`) watch to shut down cleanly: close watchers, stop the
 * api-server, tear down the bundled containers. SIGHUP is the terminal
 * closing: without a listener it ended `kindgi dev` at once, leaving its
 * runtime container running.
 *
 * The listener stays registered (`on`, never `once`), so a dependency
 * that re-raises a signal when it finds itself the only listener left
 * (`signal-exit` v3 does) can't cut the graceful shutdown short.
 *
 * A second Ctrl+C forces the exit, the usual Ctrl+C-twice contract, but
 * not one that comes with the first. One Ctrl+C can arrive more than once:
 * the terminal signals the whole foreground process group, and a wrapper
 * in it signals its child too (`npx` and `pnpm run` forward SIGINT;
 * `pnpm exec` sends SIGTERM and exits at once). A signal is the same
 * Ctrl+C when it's handled within `REPEAT_SIGNAL_WINDOW_MS` of the first,
 * or before the event loop has turned twice since: a stop step can hold
 * the loop (closing a recursive file watcher takes over a second on
 * macOS), so a signal that came at once can be handled late. A SIGTERM
 * or SIGHUP never forces the exit; it asks for the stop already under
 * way. Forcing it left the runtime container running.
 */

type StopSignalName = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

export interface SignalSource {
  on(event: StopSignalName, listener: () => void): unknown;
}

/** Where the stop signal reads the time and the event loop's turns (tests fake it). */
export interface StopSignalClock {
  now(): number;
  /** Run `fn` on the event loop's next turn. */
  nextTurn(fn: () => void): void;
}

/** How long after the first signal another is still the same Ctrl+C. */
export const REPEAT_SIGNAL_WINDOW_MS = 500;

const systemClock: StopSignalClock = {
  now: () => Date.now(),
  nextTurn: (fn) => {
    setImmediate(fn);
  },
};

export function createStopSignal(
  source: SignalSource,
  forceExit: (code: number) => void,
  clock: StopSignalClock = systemClock,
): AbortSignal {
  const controller = new AbortController();
  let firstAt = 0;
  let settled = false;
  const onSignal = (signal: StopSignalName): void => {
    if (!controller.signal.aborted) {
      firstAt = clock.now();
      clock.nextTurn(() =>
        clock.nextTurn(() => {
          settled = true;
        }),
      );
      controller.abort();
      return;
    }
    if (signal !== 'SIGINT') return;
    if (!settled || clock.now() - firstAt < REPEAT_SIGNAL_WINDOW_MS) return;
    forceExit(130);
  };
  source.on('SIGINT', () => onSignal('SIGINT'));
  source.on('SIGTERM', () => onSignal('SIGTERM'));
  source.on('SIGHUP', () => onSignal('SIGHUP'));
  return controller.signal;
}

/** Where the command's output goes (`process.stdout`, `process.stderr`). */
export interface OutputStream {
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * After a hangup (SIGHUP: the terminal closed), writing to the terminal
 * fails (EIO). Unheard, that error would end the process mid-stop, the
 * runtime container left behind, so from then on the outputs' errors are
 * ignored: nobody is left to read them.
 */
export function ignoreOutputAfterHangup(
  source: SignalSource,
  outputs: readonly OutputStream[],
): void {
  let hungUp = false;
  source.on('SIGHUP', () => {
    if (hungUp) return;
    hungUp = true;
    for (const output of outputs) output.on('error', () => undefined);
  });
}
