#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Only modules that import nothing load before the Node check, and this file
// and they keep to syntax older Nodes parse (no nullish coalescing or optional
// chaining, which Node 12 can't): the rest of the CLI (`main.js`) is imported
// after the check, so on an older Node its one line is all the CLI prints.
import { unsupportedNode } from './node-version.js';
import { createStopSignal, ignoreOutputAfterHangup } from './stop-signal.js';
import { writeFully } from './write-fully.js';

async function main(): Promise<void> {
  const tooOld = unsupportedNode(process.versions.node);
  if (tooOld !== undefined) {
    await writeFully(process.stderr, `${tooOld}\n`);
    process.exit(1);
  }

  const { runCli } = await import('./main.js');

  // SIGINT/SIGTERM/SIGHUP → an AbortSignal so long-lived commands
  // (currently only `kindgi dev` — the watch loop) can shut down cleanly;
  // a second Ctrl+C forces the exit. Short-lived commands never observe it.
  const stopSignal = createStopSignal(process, (code) => process.exit(code));
  ignoreOutputAfterHangup(process, [process.stdout, process.stderr]);

  const outcome = await runCli({
    argv: process.argv.slice(2),
    env: process.env,
    stopSignal,
    // A command's progress (`kindgi build`'s lines): out as it comes.
    progress: (text: string) => {
      process.stderr.write(text);
    },
  });
  // Exit once the output is out: piped output would be cut otherwise.
  await writeFully(process.stdout, outcome.stdout);
  await writeFully(process.stderr, outcome.stderr);
  process.exit(outcome.exitCode);
}

main().catch(async (err: unknown) => {
  await writeFully(
    process.stderr,
    `Fatal: ${err instanceof Error ? err.stack || err.message : String(err)}\n`,
  );
  process.exit(1);
});
