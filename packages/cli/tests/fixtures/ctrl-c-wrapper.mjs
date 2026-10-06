// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// A package-manager wrapper around a command, as it treats the terminal's
// Ctrl+C (which reaches it and its child both):
//   forward  `npx`, `pnpm run`, `npm run`: forwards SIGINT, waits for the child
//   exec     `pnpm exec` (pnpm 12): SIGTERMs the child, exits 130 at once
//
//   node ctrl-c-wrapper.mjs <forward|exec> <command...>

import { spawn } from 'node:child_process';

const [mode, command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: 'inherit' });
if (mode === 'exec') {
  process.on('SIGINT', () => {
    child.kill('SIGTERM');
    process.exit(130);
  });
} else {
  process.on('SIGINT', () => child.kill('SIGINT'));
  child.on('exit', (code) => process.exit(code ?? 1));
}
