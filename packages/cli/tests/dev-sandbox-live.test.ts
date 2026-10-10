// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi dev`'s pack service in its sandbox, for real: the supervisor
 * starts the Node pack service through the sandbox this machine has
 * (Seatbelt on macOS, bubblewrap on Linux), and a probe tool says what it
 * reaches (`fixtures/dev-sandbox-probe.mjs`, on the built CLI). Skipped
 * where neither runs. The home folder it closes is a stand-in under the
 * test's temp folder, with a canary; nothing outside the test's folders
 * is read.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runIndexer } from '@kindgi/handler-runtime';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { REAL_DEV_RUNNERS } from '../src/dev/defaults.js';
import { devIndexPath } from '../src/dev/paths.js';
import { sandboxTmpDir } from '../src/dev/sandbox/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/dev-sandbox-probe.mjs', import.meta.url));

const PROBE = `import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const outcome = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code ?? String(e.status ?? e); } };
export default {
  id: 'acme.probe',
  description: 'Says what this process can reach: ok or an error code, never contents.',
  version: '1.0.0',
  input: { type: 'object' },
  output: { type: 'object' },
  effects: [],
  handler: async (input) => ({
    read: Object.fromEntries((input.read ?? []).map((p) => [p, outcome(() => readFileSync(p))])),
    write: Object.fromEntries((input.write ?? []).map((p) => [p, outcome(() => writeFileSync(p, 'x'))])),
    exec: Object.fromEntries((input.exec ?? []).map((p) => [p, outcome(() => execFileSync('/bin/cat', [p], { stdio: 'ignore' }))])),
    tmpdir: process.env.TMPDIR ?? '',
  }),
};
`;

interface ProbeOutput {
  readonly read: Record<string, string>;
  readonly write: Record<string, string>;
  readonly exec: Record<string, string>;
  readonly tmpdir: string;
}

const availability = await REAL_DEV_RUNNERS.detectSandbox();
const engine = availability.kind === 'available' ? availability.engine : undefined;
// CI installs bubblewrap and sets this: there the test fails rather than skips.
if (availability.kind === 'unavailable' && process.env.KINDGI_DEV_SANDBOX_LIVE === 'required') {
  throw new Error(
    `kindgi dev's sandbox can't run here, and KINDGI_DEV_SANDBOX_LIVE=required: ${availability.reason}. ${availability.fix}`,
  );
}

describe.skipIf(engine === undefined)(
  `kindgi dev's pack service in its sandbox (${engine ?? 'none here'})`,
  () => {
    let root: string;
    let app: string;
    let home: string;
    let tmp: string;
    let out: ProbeOutput;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-dev-sandbox-')));
      app = join(root, 'app');
      home = join(root, 'home');
      await mkdir(join(app, 'tools'), { recursive: true });
      await mkdir(join(app, '.kindgi', 'dev'), { recursive: true });
      await mkdir(join(root, 'other'), { recursive: true });
      await mkdir(home, { recursive: true });
      await writeFile(join(app, 'tools', 'probe.mjs'), PROBE);
      await writeFile(join(app, 'package.json'), '{ "name": "acme-probe", "type": "module" }\n');
      await writeFile(
        join(app, 'kindgi.config.ts'),
        "export default { pack: { id: 'acme', version: '1.0.0' }, discovery: { tools: 'tools/**/*.mjs' } };\n",
      );
      await writeFile(join(app, '.env.local'), 'CANARY=fake-canary\n');
      await writeFile(join(app, '.kindgi', 'secrets.env'), 'CANARY=fake-canary\n');
      await writeFile(join(home, 'canary'), 'fake-canary\n');
      await writeFile(join(root, 'other', 'canary'), 'fake-canary\n');
      const indexed = await runIndexer({
        packDir: app,
        outputPath: devIndexPath(app),
        artifactVersion: '20261010.1',
        publishedAt: '2026-10-10T00:00:00.000Z',
      });
      expect(indexed.kind, JSON.stringify(indexed)).toBe('ok');
      tmp = engine === 'seatbelt' ? sandboxTmpDir(app) : '/tmp';
      const inputs = [
        {
          read: [
            join(app, 'package.json'),
            join(app, '.env.local'),
            join(app, '.kindgi', 'secrets.env'),
            join(home, 'canary'),
            join(root, 'other', 'canary'),
          ],
          write: [
            join(app, 'out.txt'),
            join(app, '.env.local'),
            join(home, 'written'),
            join(tmp, 'scratch.txt'),
          ],
          exec: [join(app, '.env.local'), join(home, 'canary')],
        },
      ];
      const inputsPath = join(root, 'inputs.json');
      await writeFile(inputsPath, JSON.stringify(inputs));
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          process.execPath,
          [FIXTURE, app, home, engine ?? 'seatbelt', inputsPath],
          { timeout: 60_000 },
          (err, so, se) => (err ? reject(new Error(`${err.message}\n${so}\n${se}`)) : resolve(so)),
        );
      });
      const report = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as {
        outputs?: { kind: string; output: ProbeOutput }[];
        error?: unknown;
      };
      expect(report.error, JSON.stringify(report.error)).toBeUndefined();
      const first = report.outputs?.[0];
      expect(first?.kind, JSON.stringify(first)).toBe('result');
      out = first?.output as ProbeOutput;
    }, 90_000);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    test("the app's code and its own files: read and written", () => {
      expect(out.read[join(app, 'package.json')]).toBe('ok');
      expect(out.write[join(app, 'out.txt')]).toBe('ok');
    });

    test('secrets in the app, the home folder, other folders: closed', () => {
      for (const path of [
        join(app, '.env.local'),
        join(app, '.kindgi', 'secrets.env'),
        join(home, 'canary'),
        join(root, 'other', 'canary'),
      ]) {
        expect(out.read[path], path).not.toBe('ok');
      }
      expect(out.write[join(app, '.env.local')]).not.toBe('ok');
      // Under bwrap the home folder is an empty tmpfs: a write lands there, and is gone.
      if (engine === 'seatbelt') expect(out.write[join(home, 'written')]).not.toBe('ok');
    });

    test('a process the code starts is inside it too', () => {
      expect(Object.values(out.exec)).toEqual(['1', '1']);
    });

    test('it has its own temp folder, and can write there', () => {
      expect(out.tmpdir).toBe(tmp);
      expect(out.write[join(tmp, 'scratch.txt')]).toBe('ok');
    });
  },
);
