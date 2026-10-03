#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { runCli } from './main.js';
import { createStopSignal } from './stop-signal.js';
import { writeFully } from './write-fully.js';

async function main(): Promise<void> {
  // SIGINT/SIGTERM → an AbortSignal so long-lived commands (currently
  // only `kindgi dev` — the watch loop) can shut down cleanly; a second
  // signal forces the exit. Short-lived commands never observe it.
  const stopSignal = createStopSignal(process, (code) => process.exit(code));

  const outcome = await runCli({
    argv: process.argv.slice(2),
    env: process.env,
    stopSignal,
  });
  // Exit once the output is out: piped output would be cut otherwise.
  await writeFully(process.stdout, outcome.stdout);
  await writeFully(process.stderr, outcome.stderr);
  process.exit(outcome.exitCode);
}

main().catch(async (err: unknown) => {
  await writeFully(
    process.stderr,
    `Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
