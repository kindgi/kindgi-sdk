// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// `kindgi dev` as a terminal's Ctrl+C finds it: the stop signal and the
// pack service wired as `cli.ts` and `commands/dev.ts` wire them, one pack
// child serving. It reports to <report>, a JSON object per line, written
// synchronously so nothing is lost at exit. It runs the built CLI
// (`pnpm run build` first).
//
//   node ctrl-c-dev.mjs <module-root> <index.json> <report>

import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createPackServiceSupervisor } from '@kindgi/handler-runtime/pack-service';
import { PACK_HEADERS, PACK_PROTOCOL_VERSION } from '@kindgi/handler-runtime/protocol';

import { createStopSignal } from '../../dist/stop-signal.js';

const [moduleRoot, indexPath, reportPath] = process.argv.slice(2);
const report = (line) => appendFileSync(reportPath, `${JSON.stringify(line)}\n`);
process.on('exit', (code) => report({ kind: 'exit', code }));

const stopSignal = createStopSignal(process, (code) => {
  report({ kind: 'forced-exit' });
  process.exit(code);
});
const pack = createPackServiceSupervisor({
  command: [
    process.execPath,
    fileURLToPath(import.meta.resolve('@kindgi/handler-runtime/pack-service-main')),
  ],
  moduleRoot,
  env: async () => ({ PATH: process.env.PATH ?? '' }),
  onEvent: (event) => {
    if (event.kind !== 'log') report({ kind: 'pack', event: event.kind });
  },
  restartDelayMs: 50,
});
const { url } = await pack.listen();
stopSignal.addEventListener('abort', () => pack.beginClose(), { once: true });
const started = await pack.start(indexPath);
if (started.kind !== 'ok') throw new Error(started.error.problems.join('; '));

const res = await fetch(`${url}/v1/invoke`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    [PACK_HEADERS.token]: pack.token,
    [PACK_HEADERS.runId]: 'run-1',
  },
  body: JSON.stringify({
    v: PACK_PROTOCOL_VERSION,
    kind: 'invoke',
    tool: { id: 'local.pid' },
    input: {},
    ctx: { tenantId: 't-1', runId: 'run-1' },
  }),
});
const { output } = await res.json();
report({ kind: 'ready', pid: process.pid, packPid: output.pid });

await new Promise((resolve) => stopSignal.addEventListener('abort', resolve, { once: true }));
report({ kind: 'stopping' });
// The stop's first step holds the event loop, as closing a recursive file
// watcher does on macOS (over a second): a signal that came with the first
// is handled only after it.
const holdUntil = Date.now() + 700;
while (Date.now() < holdUntil) {}
// The rest of the stop takes a while (the runtime's container): the pack
// child, signalled with the group, exits meanwhile.
await new Promise((resolve) => setTimeout(resolve, 300));
await pack.close();
report({ kind: 'stopped' });
