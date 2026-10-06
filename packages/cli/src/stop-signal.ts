// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * SIGINT / SIGTERM → an AbortSignal long-lived commands (`kindgi dev`)
 * watch to shut down cleanly: close watchers, stop the api-server, tear
 * down the bundled containers.
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
 * never forces the exit; it asks for the stop already under way. Forcing
 * it left the runtime container running.
 */

export interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
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
  const onSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
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
  return controller.signal;
}
