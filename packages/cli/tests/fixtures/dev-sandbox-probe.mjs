// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// `kindgi dev`'s pack service in its sandbox, as `commands/dev.ts` starts
// it: `createPackServiceReal` with a sandbox, then the app's `acme.probe`
// tool asked each input in turn. Prints one JSON object on stdout:
// `{ outputs: [...] }`, or `{ error }`. It runs the built CLI (`pnpm run
// build` first): the pack service's entrypoint is found with
// `import.meta.resolve`, which vitest's transform lacks.
//
//   node dev-sandbox-probe.mjs <app> <home> <seatbelt|bwrap> <inputs.json>

import { readFileSync } from 'node:fs';

import { createPackServiceReal } from '../../dist/dev/defaults.js';
import { NODE_PACK_CODE } from '../../dist/dev/pack-code.js';
import { devIndexPath } from '../../dist/dev/paths.js';

const [app, home, engine, inputsPath] = process.argv.slice(2);
const inputs = JSON.parse(readFileSync(inputsPath, 'utf8'));

const service = createPackServiceReal({
  packDir: app,
  code: NODE_PACK_CODE,
  env: async () => ({ PATH: process.env.PATH ?? '' }),
  sandbox: {
    engine,
    settings: { mode: 'on', source: 'default', allowRead: [], allowUnixSockets: [] },
    home,
  },
  onLog: () => undefined,
  onEvent: () => undefined,
});
try {
  const { url } = await service.listen();
  const started = await service.start(devIndexPath(app));
  if (started.kind !== 'ok') {
    console.log(JSON.stringify({ error: started.error }));
    process.exitCode = 1;
  } else {
    const outputs = [];
    for (const input of inputs) {
      const res = await fetch(`${url}/v1/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'kindgi-pack-token': service.token },
        body: JSON.stringify({
          v: 2,
          kind: 'invoke',
          tool: { id: 'acme.probe' },
          input,
          ctx: { tenantId: 't', runId: 'r' },
        }),
      });
      outputs.push(await res.json());
    }
    console.log(JSON.stringify({ outputs }));
  }
} finally {
  await service.close();
}
