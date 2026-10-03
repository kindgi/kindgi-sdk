// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * SIGINT / SIGTERM → an AbortSignal long-lived commands (`kindgi dev`)
 * watch to shut down cleanly: close watchers, stop the api-server, tear
 * down the bundled containers.
 *
 * The listener stays registered (`on`, never `once`), so a dependency
 * that re-raises a signal when it finds itself the only listener left
 * (`signal-exit` v3 does) can't cut the graceful shutdown short. A second
 * signal forces the exit, the usual Ctrl+C-twice contract.
 */

export interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export function createStopSignal(
  source: SignalSource,
  forceExit: (code: number) => void,
): AbortSignal {
  const controller = new AbortController();
  const onSignal = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
      return;
    }
    forceExit(130);
  };
  source.on('SIGINT', onSignal);
  source.on('SIGTERM', onSignal);
  return controller.signal;
}
