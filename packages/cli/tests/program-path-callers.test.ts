// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Every place the CLI starts a program by name runs the one on `PATH`'s
 * absolute folders, never a copy in the folder it runs in, and a program
 * that isn't there fails as it always did.
 *
 * Each program here is a stand-in that writes a line to `marks`: one on
 * `PATH` (`found`), and a copy in the pack's folder (`planted`). `PATH`
 * starts with an empty entry, `.` and the pack's folder as a relative
 * path, so a bare name would run the copy, whether the child runs in the
 * pack's folder or in the CLI's own, as a bare name does on Windows. These
 * run on Linux and macOS; the Windows search order is program-path.test.ts's.
 */

import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { dockerBuildReal, pullImageIndexReal } from '../src/build/defaults.js';
import { runTool } from '../src/commands/doctor.js';
import { runInteractiveEditor } from '../src/commands/feedback.js';
import { createPackServiceReal, runPythonIndexer } from '../src/dev/defaults.js';
import { osProcesses } from '../src/dev/dev-lock.js';
import { runProcess } from '../src/dev/jvm-run-files.js';
import { type PackCode, checkPackPython } from '../src/dev/pack-code.js';
import { createPythonPackBuilder } from '../src/dev/python-builder.js';
import { type DockerRunner, docker, startRuntimeContainer } from '../src/dev/runtime-container.js';
import { probeReal } from '../src/dev/sandbox/detect.js';
import { queryPythonReal } from '../src/dev/sandbox/policy.js';
import { runCloudCli } from '../src/license/stores.js';
import { runLauncher } from '../src/mcp/launcher.js';
import { openUrlInBrowser } from '../src/open-url.js';
import { defaultDetectIo, readPnpmVersion } from '../src/package-manager.js';
import { REAL_TEST_RUNNERS } from '../src/test/defaults.js';

let pack: string;
let bin: string;
let marksFile: string;
/** `PATH` with the program on it, after the entries that would find the copy. */
let withProgram: string;
/** `PATH` without it: only the entries that would find the copy. */
let withoutProgram: string;

beforeEach(async () => {
  // realpath: macOS's tmpdir is a symlink.
  pack = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-pack-')));
  bin = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-bin-')));
  marksFile = join(bin, 'marks');
  const copies = ['', '.', relative(process.cwd(), pack)];
  withProgram = [...copies, bin].join(':');
  withoutProgram = copies.join(':');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(pack, { recursive: true, force: true });
  await rm(bin, { recursive: true, force: true });
});

/**
 * `name` on `PATH` and its copy in the pack's folder: each writes its kind,
 * its name and its arguments to `marks` (a record each, as an argument may
 * hold a newline), then runs `body` (sh: builtins only, nothing else is on
 * these PATHs).
 */
async function stand(name: string, body = ''): Promise<void> {
  for (const [dir, kind] of [
    [bin, 'found'],
    [pack, 'planted'],
  ] as const) {
    const file = join(dir, name);
    await writeFile(
      file,
      `#!/bin/sh\nprintf '%s\\036' "${kind} ${name} $*" >> '${marksFile}'\n${body}\n`,
    );
    await chmod(file, 0o755);
  }
}

/** What ran, one each. */
async function marks(): Promise<string[]> {
  const text = await readFile(marksFile, 'utf8').catch(() => '');
  return text.split('\x1e').filter((mark) => mark !== '');
}

describe.skipIf(process.platform === 'win32')(
  "the program on PATH runs, never a copy in the folder it runs in; without one, it's not found as before",
  () => {
    describe('docker for kindgi dev', () => {
      test('docker()', async () => {
        await stand('docker', 'echo docker-found');
        vi.stubEnv('PATH', withProgram);
        expect(await docker(['version'])).toMatchObject({ code: 0, stdout: 'docker-found\n' });
        expect(await marks()).toEqual(['found docker version']);

        vi.stubEnv('PATH', withoutProgram);
        expect(await docker(['version'])).toEqual({
          code: null,
          stdout: '',
          stderr: 'spawn docker ENOENT',
          errorCode: 'ENOENT',
        });
        expect(await marks()).toEqual(['found docker version']);
      });

      // The start follows the container's logs, and a container that stopped
      // has them read: both by a `docker logs` of its own.
      test.each([
        ['on PATH', true],
        ['not on PATH', false],
      ])("the runtime container's logs, docker %s", async (_case, onPath) => {
        await stand('docker', 'echo runtime-line');
        vi.stubEnv('PATH', onPath ? withProgram : withoutProgram);
        const id = 'c'.repeat(64);
        const run: DockerRunner = async (args) => {
          if (args[0] === 'run') return { code: 0, stdout: `${id}\n`, stderr: '' };
          if (args.includes('{{.State.Running}}')) {
            if (onPath) {
              await vi.waitFor(async () =>
                expect(await marks()).toContain(`found docker logs --follow ${id}`),
              );
            }
            return { code: 0, stdout: 'false\n', stderr: '' };
          }
          return { code: 1, stdout: '', stderr: 'no such container' };
        };
        await expect(
          startRuntimeContainer(
            {
              image: 'img',
              packDir: pack,
              envFile: join(pack, 'runtime.env'),
              network: 'alias',
              hostPort: 4999,
              onLog: () => undefined,
              docker: run,
            },
            { fetch: async () => new Response(null, { status: 503 }), timeoutMs: 10_000 },
          ),
        ).rejects.toThrow();
        expect(await marks()).toEqual(
          onPath ? [`found docker logs --follow ${id}`, `found docker logs ${id}`] : [],
        );
      });
    });

    describe('docker for kindgi build', () => {
      test('the image build, in its context folder', async () => {
        await stand('docker', 'if [ "$1" = image ]; then echo sha256:found; fi');
        vi.stubEnv('PATH', withProgram);
        const options = { contextDir: pack, tag: 'pack:dev', buildTarget: 'server', secrets: [] };
        expect(await dockerBuildReal(options)).toEqual({ kind: 'ok', imageId: 'sha256:found' });
        expect((await marks()).map((line) => line.split(' ').slice(0, 4).join(' '))).toEqual([
          'found docker buildx build',
          'found docker image inspect',
        ]);

        vi.stubEnv('PATH', withoutProgram);
        expect(await dockerBuildReal(options)).toEqual({
          kind: 'err',
          message: 'docker buildx build exited 127:\n',
        });
        expect(await marks()).toHaveLength(2);
      });

      test("the server image's index", async () => {
        await stand(
          'docker',
          'case "$1" in create) echo cid ;; cp) printf \'{"index":1}\' > "$3" ;; esac',
        );
        vi.stubEnv('PATH', withProgram);
        const workDir = join(pack, 'work');
        const { bytes } = await pullImageIndexReal({ imageRef: 'img', workDir });
        expect(Buffer.from(bytes).toString('utf8')).toBe('{"index":1}');
        expect((await marks()).map((line) => line.split(' ').slice(0, 3).join(' '))).toEqual([
          'found docker pull',
          'found docker create',
          'found docker cp',
          'found docker rm',
        ]);

        vi.stubEnv('PATH', withoutProgram);
        await expect(pullImageIndexReal({ imageRef: 'img', workDir })).rejects.toMatchObject({
          code: 'ENOENT',
          message: 'spawn docker ENOENT',
        });
        expect(await marks()).toHaveLength(4);
      });
    });

    test('the package manager', async () => {
      await stand('pnpm', 'echo 10.99.0');
      await stand('yarn');
      vi.stubEnv('PATH', withProgram);
      expect(await readPnpmVersion(pack)).toBe('10.99.0');
      expect(await defaultDetectIo.runs?.('yarn')).toBe(true);
      expect(await marks()).toEqual(['found pnpm --version', 'found yarn --version']);

      vi.stubEnv('PATH', withoutProgram);
      await expect(readPnpmVersion(pack)).rejects.toMatchObject({ code: 'ENOENT' });
      // Each manager is asked once a process: one not asked yet.
      await stand('bun');
      expect(await defaultDetectIo.runs?.('bun')).toBe(false);
      expect(await marks()).toHaveLength(2);
    });

    test("kindgi test's runner", async () => {
      await stand('npx');
      const run = (path: string) =>
        REAL_TEST_RUNNERS.runTests({
          packDir: pack,
          runner: 'vitest',
          args: [],
          env: { PATH: path },
        });
      expect(await run(withProgram)).toEqual({ spawned: true, exitCode: 0, resolvedBinary: 'npx' });
      expect(await marks()).toEqual(['found npx --no-install vitest']);

      expect(await run(withoutProgram)).toEqual({
        spawned: false,
        exitCode: 1,
        reason: 'runner-binary-not-found',
        resolvedBinary: 'npx',
      });
      // One on PATH it may not run: the spawn's EACCES, as before. (A PATH
      // not asked about yet: a path found is kept for each PATH.)
      await chmod(join(bin, 'npx'), 0o644);
      expect(await run(bin)).toEqual({
        spawned: false,
        exitCode: 1,
        reason: 'runner-spawn-error',
        resolvedBinary: 'npx',
      });
      expect(await marks()).toHaveLength(1);
    });

    test("kindgi doctor's tools", async () => {
      await stand('uv', 'echo uv 0.9.0');
      vi.stubEnv('PATH', withProgram);
      expect(await runTool('uv', ['--version'])).toEqual({
        code: 0,
        stdout: 'uv 0.9.0\n',
        stderr: '',
      });
      expect(await marks()).toEqual(['found uv --version']);

      vi.stubEnv('PATH', withoutProgram);
      expect(await runTool('uv', ['--version'])).toEqual({
        code: null,
        stdout: '',
        stderr: 'spawn uv ENOENT',
      });
      expect(await marks()).toHaveLength(1);
    });

    test("a cloud's CLI, for a token", async () => {
      await stand('gcloud', 'echo token-found');
      vi.stubEnv('PATH', withProgram);
      expect(await runCloudCli('gcloud', ['auth', 'print-access-token'])).toBe('token-found\n');
      expect(await marks()).toEqual(['found gcloud auth print-access-token']);

      vi.stubEnv('PATH', withoutProgram);
      await expect(runCloudCli('gcloud', ['auth', 'print-access-token'])).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await marks()).toHaveLength(1);
    });

    test("the browser's opener", async () => {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      await stand(opener);
      vi.stubEnv('PATH', withProgram);
      expect(await openUrlInBrowser('https://example.com/')).toEqual({ ok: true });
      // Detached: it runs on its own.
      await vi.waitFor(async () =>
        expect(await marks()).toEqual([`found ${opener} https://example.com/`]),
      );

      vi.stubEnv('PATH', withoutProgram);
      expect(await openUrlInBrowser('https://example.com/')).toEqual({
        ok: false,
        reason: `${opener}: ENOENT`,
      });
      expect(await marks()).toHaveLength(1);
    });

    test("kindgi feedback's editor", async () => {
      await stand('kindgi-editor', 'printf edited > "$1"');
      // The draft's file goes in the pack's folder, removed with it.
      vi.stubEnv('TMPDIR', pack);
      vi.stubEnv('EDITOR', 'kindgi-editor');
      vi.stubEnv('PATH', withProgram);
      expect(await runInteractiveEditor('seed')).toBe('edited');
      expect(await marks()).toEqual([expect.stringMatching(/^found kindgi-editor \//)]);

      vi.stubEnv('PATH', withoutProgram);
      await expect(runInteractiveEditor('seed')).rejects.toMatchObject({
        code: 'ENOENT',
        message: 'spawn kindgi-editor ENOENT',
      });
      expect(await marks()).toHaveLength(1);
    });

    test("kindgi mcp-launch's runner", async () => {
      await stand('npx');
      const stderr: string[] = [];
      const launch = () =>
        runLauncher(['--runtime=npx', '--package=kindgi-fake-mcp', `--pack-dir=${pack}`], {
          stderr: (line) => stderr.push(line),
          onSignal: () => () => undefined,
        });
      vi.stubEnv('PATH', withProgram);
      expect(await launch()).toBe(0);
      expect(await marks()).toEqual(['found npx -y kindgi-fake-mcp']);

      vi.stubEnv('PATH', withoutProgram);
      expect(await launch()).toBe(4);
      expect(stderr).toEqual(['kindgi mcp-launch: child error: spawn npx ENOENT\n']);
      expect(await marks()).toHaveLength(1);
    });

    describe("the pack's Python", () => {
      const python: readonly [string, ...string[]] = ['kindgi-python'];
      const env = (path: string, out: string) => ({ PATH: path, KINDGI_FAKE_OUT: out });

      beforeEach(async () => {
        await stand('kindgi-python', 'printf \'%s\\n\' "$KINDGI_FAKE_OUT"');
      });

      test('the indexer', async () => {
        const index = (path: string) =>
          runPythonIndexer({
            packDir: pack,
            outputPath: join(pack, 'index.json'),
            python,
            env: env(path, '{"kind":"err","error":{"code":"fake","message":"found"}}'),
          });
        expect(await index(withProgram)).toEqual({ kind: 'err', code: 'fake', message: 'found' });
        expect((await marks()).map((line) => line.split(' ').slice(0, 5).join(' '))).toEqual([
          'found kindgi-python -m kindgi.pack index',
        ]);

        expect(await index(withoutProgram)).toEqual({
          kind: 'err',
          code: 'index-child-failed',
          message: 'The indexer process exited (null) without a result: spawn kindgi-python ENOENT',
        });
        expect(await marks()).toHaveLength(1);
      });

      test('the pack service', async () => {
        let path = withProgram;
        const service = createPackServiceReal({
          packDir: pack,
          code: { language: 'python', python } as PackCode,
          env: async () => env(path, 'not serving'),
          onLog: () => undefined,
          onEvent: () => undefined,
          blocks: { pattern: 'blocks/**', onWritten: () => undefined },
        });
        try {
          const index = join(pack, 'index.json');
          // The stand-in prints and exits: a boot that fails, after it ran.
          expect((await service.start(index)).kind).toBe('err');
          expect((await marks()).map((line) => line.split(' ').slice(0, 5).join(' '))).toEqual([
            'found kindgi-python -m kindgi.pack serve',
          ]);

          path = withoutProgram;
          expect(await service.start(index)).toEqual({
            kind: 'err',
            error: { problems: ['spawn kindgi-python ENOENT'] },
          });
          expect(await marks()).toHaveLength(1);
        } finally {
          await service.close();
        }
      });

      test("the sources' check, the version check, and the sandbox's question", async () => {
        const builder = (path: string) =>
          createPythonPackBuilder({
            packDir: pack,
            python,
            env: async () => env(path, '[]'),
            watchFs: () => ({ close: () => undefined }) as never,
          });
        expect(await builder(withProgram).build()).toEqual({ kind: 'ok', bundleMap: {} });
        expect(await checkPackPython(python, env(withProgram, '3.12.1 0.4.0'), pack)).toMatchObject(
          { kind: 'ok' },
        );
        const paths = '{"path":[],"prefix":"/p","base":"/b","exe":"/e"}';
        expect(await queryPythonReal(python, pack, env(withProgram, paths))).toEqual({
          path: [],
          prefix: '/p',
          basePrefix: '/b',
          executable: '/e',
        });
        expect((await marks()).map((line) => line.split(' ')[0])).toEqual([
          'found',
          'found',
          'found',
        ]);

        expect(await builder(withoutProgram).build()).toEqual({
          kind: 'err',
          errors: [
            "the pack's Python could not check the sources (null): spawn kindgi-python ENOENT",
          ],
        });
        expect(await checkPackPython(python, env(withoutProgram, ''), pack)).toEqual({
          kind: 'err',
          message: "the pack's Python (kindgi-python) did not start: spawn kindgi-python ENOENT",
        });
        await expect(queryPythonReal(python, pack, env(withoutProgram, paths))).rejects.toThrow(
          "could not ask the pack's Python where it reads from: spawn kindgi-python ENOENT",
        );
        expect(await marks()).toHaveLength(3);
      });
    });

    test("a JVM pack's build tools", async () => {
      await stand('mvn', 'echo built');
      const env = (path: string) => ({ PATH: path });
      expect(await runProcess('mvn', ['-q', 'package'], env(withProgram), pack)).toEqual({
        code: 0,
        stdout: 'built\n',
        stderr: '',
      });
      expect(await marks()).toEqual(['found mvn -q package']);

      expect(await runProcess('mvn', ['-q', 'package'], env(withoutProgram), pack)).toEqual({
        code: null,
        stdout: '',
        stderr: 'spawn mvn ENOENT',
      });
      expect(await marks()).toHaveLength(1);
    });

    test("kindgi dev's sandbox probe", async () => {
      await stand('bwrap');
      vi.stubEnv('PATH', withProgram);
      expect(await probeReal('bwrap', ['--version'])).toEqual({ code: 0, stderr: '' });
      expect(await marks()).toEqual(['found bwrap --version']);

      vi.stubEnv('PATH', withoutProgram);
      expect(await probeReal('bwrap', ['--version'])).toEqual({
        code: null,
        stderr: 'spawn bwrap ENOENT',
        errorCode: 'ENOENT',
      });
      expect(await marks()).toHaveLength(1);
    });

    test("kindgi dev's lock: a process's start time", async () => {
      await stand('ps', "echo 'Sun Nov  1 00:00:00 2026'");
      vi.stubEnv('PATH', withProgram);
      expect(await osProcesses().startTime(process.pid)).toBe('Sun Nov  1 00:00:00 2026');
      expect(await marks()).toEqual([`found ps -o lstart= -p ${process.pid}`]);

      vi.stubEnv('PATH', withoutProgram);
      expect(await osProcesses().startTime(process.pid)).toBe(undefined);
      expect(await marks()).toHaveLength(1);
    });
  },
);
