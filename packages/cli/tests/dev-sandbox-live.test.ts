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
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { type Server, connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readFile } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { REAL_DEV_RUNNERS } from '../src/dev/defaults.js';
import { sandboxTmpDir } from '../src/dev/sandbox/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/dev-sandbox-probe.mjs', import.meta.url));

const PROBE = `import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';
const outcome = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code ?? String(e.status ?? e); } };
const reach = (path) => new Promise((resolve) => {
  const socket = connect(path);
  socket.setTimeout(5000, () => { socket.destroy(); resolve('timeout'); });
  socket.once('connect', () => { socket.destroy(); resolve('ok'); });
  socket.once('error', (e) => resolve(e.code ?? String(e)));
});
// Linux: its PID, the session it's in and the processes it sees (/proc). None on macOS.
const proc = () => {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid: process.pid, session: Number(fields[3]), pids: readdirSync('/proc').filter((n) => /^\\d+$/.test(n)) };
  } catch { return undefined; }
};
// Top-level code: the indexer runs it when it imports this module. It
// records what it reached then, in the app (which it may write).
if (process.argv.some((a) => a.includes('index-child'))) {
  const at = JSON.parse(process.env.KINDGI_PROBE_AT_INDEX ?? '[]');
  writeFileSync(new URL('../index-time.json', import.meta.url), JSON.stringify(
    Object.fromEntries(at.map((p) => [p, outcome(() => readFileSync(p))])),
  ));
}
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
    connect: Object.fromEntries(await Promise.all((input.connect ?? []).map(async (p) => [p, await reach(p)]))),
    proc: proc(),
    tmpdir: process.env.TMPDIR ?? '',
  }),
};
`;

interface ProbeOutput {
  readonly read: Record<string, string>;
  readonly write: Record<string, string>;
  readonly exec: Record<string, string>;
  readonly connect: Record<string, string>;
  readonly proc?: { readonly pid: number; readonly session: number; readonly pids: string[] };
  readonly tmpdir: string;
}

/** Connects to a UNIX socket: `ok`, or the error's code. */
function reach(path: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.setTimeout(5000, () => {
      socket.destroy();
      resolve('timeout');
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve('ok');
    });
    socket.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? String(e)));
  });
}

/** Where the Docker CLI looks for Docker's socket (on Linux `/var/run` is `/run`). */
const DOCKER_SOCKET = '/var/run/docker.sock';
/** Written from inside on Linux: the root is bound read-only. */
const SYSTEM_FILE = '/usr/kindgi-dev-sandbox-probe';

const availability = await REAL_DEV_RUNNERS.detectSandbox();
const engine = availability.kind === 'available' ? availability.engine : undefined;
// CI installs bubblewrap and sets this: there the test fails rather than skips.
const required = process.env.KINDGI_DEV_SANDBOX_LIVE === 'required';
/** Whether the test itself reaches Docker (CI's runner does): the control for the sandbox's answer. */
const dockerHere = await reach(DOCKER_SOCKET);
if (availability.kind === 'unavailable' && required) {
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
    let atIndex: Record<string, string>;
    /** A socket outside the app, as an agent's or a local database's; the test listens on it. */
    let agentSocket: string;
    let agent: Server | undefined;
    let agentHere: string;
    /** Outside the home folder, and writable by the user (macOS). */
    const shared = join('/Users/Shared', `kindgi-dev-sandbox-${process.pid}`);

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
      tmp = engine === 'seatbelt' ? sandboxTmpDir(app) : '/tmp';
      agentSocket = join(root, 'agent.sock');
      agent = createServer().listen(agentSocket);
      await once(agent, 'listening');
      agentHere = await reach(agentSocket);
      const canaries = [
        join(home, 'canary'),
        join(app, '.env.local'),
        join(root, 'other', 'canary'),
      ];
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
            join(app, 'kindgi.config.ts'),
            ...(engine === 'seatbelt' ? [shared] : [SYSTEM_FILE]),
          ],
          exec: [join(app, '.env.local'), join(home, 'canary')],
          connect: [agentSocket, DOCKER_SOCKET],
        },
      ];
      const inputsPath = join(root, 'inputs.json');
      await writeFile(inputsPath, JSON.stringify(inputs));
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          process.execPath,
          [FIXTURE, app, home, engine ?? 'seatbelt', inputsPath],
          {
            timeout: 60_000,
            env: { ...process.env, KINDGI_PROBE_AT_INDEX: JSON.stringify(canaries) },
          },
          (err, so, se) => (err ? reject(new Error(`${err.message}\n${so}\n${se}`)) : resolve(so)),
        );
      });
      const report = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as {
        indexed?: string;
        outputs?: { kind: string; output: ProbeOutput }[];
        error?: unknown;
      };
      expect(report.error, JSON.stringify(report.error)).toBeUndefined();
      expect(report.indexed).toBe('ok');
      atIndex = JSON.parse(await readFile(join(app, 'index-time.json'), 'utf8'));
      const first = report.outputs?.[0];
      expect(first?.kind, JSON.stringify(first)).toBe('result');
      out = first?.output as ProbeOutput;
    }, 90_000);

    afterAll(async () => {
      agent?.close();
      if (root !== undefined) await rm(root, { recursive: true, force: true });
      await rm(shared, { force: true });
    });

    test("the indexer runs the pack's code in the sandbox too: its top-level code reached none of the canaries", () => {
      expect(Object.keys(atIndex)).toHaveLength(3);
      for (const [path, outcome] of Object.entries(atIndex)) expect(outcome, path).not.toBe('ok');
    });

    test("Kindgi's configuration can't be written from inside (kindgi dev loads it)", () => {
      expect(out.write[join(app, 'kindgi.config.ts')]).not.toBe('ok');
    });

    test.skipIf(engine !== 'seatbelt')(
      'macOS: nothing is written outside the app, home or not',
      () => {
        expect(out.write[shared]).not.toBe('ok');
      },
    );

    test("a UNIX socket outside the app (an agent's, a local database's): closed", () => {
      expect(agentHere, 'the test itself reaches it').toBe('ok');
      expect(out.connect[agentSocket]).not.toBe('ok');
    });

    test.skipIf(dockerHere !== 'ok' && !required)("Docker's socket: closed", () => {
      expect(dockerHere, 'the test itself reaches Docker').toBe('ok');
      expect(out.connect[DOCKER_SOCKET]).not.toBe('ok');
    });

    test.skipIf(engine !== 'bwrap')(
      'Linux: the system is read-only (EROFS under /usr, not only a permission error)',
      () => {
        expect(out.write[SYSTEM_FILE]).toBe('EROFS');
      },
    );

    test.skipIf(engine !== 'bwrap')(
      'Linux: other processes are hidden; it sees one, itself, as PID 1 of its own namespace',
      () => {
        const here = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
        expect(here, 'the test itself sees other processes').toContain(String(process.pid));
        expect(here.length).toBeGreaterThan(1);
        expect(out.proc?.pid).toBe(1);
        expect(out.proc?.pids).toEqual(['1']);
      },
    );

    test.skipIf(engine !== 'bwrap')(
      'Linux: it leads its own session, apart from the terminal kindgi dev runs in',
      () => {
        // Without --new-session the session's leader is outside its PID namespace: this reads 0.
        expect(out.proc?.session).toBe(1);
      },
    );

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
