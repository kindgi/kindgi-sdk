// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `ctx.progress` when the CLI streams it (`write`): the first line goes
 * after what `runCli` says first, the dev runtime's line (`hint`, said once a
 * command reads its key) and the pin's. `unsaid` is what's left of those
 * for the outcome, before `later` (the pin's line, when the outcome says
 * it): all of it when nothing was streamed, else the hint when it came
 * after the first line.
 */
export function progressAfterHead(
  write: ((text: string) => void) | undefined,
  hint: () => string,
  pin: () => string,
): {
  readonly progress: ((text: string) => void) | undefined;
  readonly unsaid: (later: string) => string;
} {
  let opened: { readonly hint: string } | undefined;
  const unsaid = (later: string): string => {
    if (opened === undefined) return `${hint()}${later}`;
    return opened.hint === '' ? hint() : '';
  };
  if (write === undefined) return { progress: undefined, unsaid };
  const progress = (text: string): void => {
    if (opened !== undefined) {
      write(text);
      return;
    }
    opened = { hint: hint() };
    write(`${opened.hint}${pin()}${text}`);
  };
  return { progress, unsaid };
}
