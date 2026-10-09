// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runJavaIndexer } from '../src/dev/defaults.js';
import {
  type ScalaPackCode,
  checkPackJvm,
  javaMajor,
  resolvePackCode,
  resolvePackScala,
} from '../src/dev/pack-code.js';
import {
  createScalaPackBuilder,
  exportedClasspath,
  isSbtBuildChange,
  isScalaSourceChange,
  sbtErrors,
  sbtServerRunning,
} from '../src/dev/scala-builder.js';

let packDir: string;

beforeEach(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-scala-pack-'));
});

afterEach(async () => {
  await rm(packDir, { recursive: true, force: true });
});

describe("the pack's JDK and sbt", () => {
  test('JAVA_HOME, else java on PATH; dev.sbt, else sbt; SBT_OPTS for sbt only', async () => {
    expect(
      await resolvePackScala(
        packDir,
        undefined,
        { JAVA_HOME: '/opt/jdk-17', SBT_OPTS: '-Xmx2g' },
        'linux',
      ),
    ).toEqual({
      kind: 'ok',
      value: {
        language: 'scala',
        java: '/opt/jdk-17/bin/java',
        javaHome: '/opt/jdk-17',
        sbt: ['sbt'],
        workDir: join(packDir, '.kindgi', 'dev', 'scala'),
        sbtEnv: { SBT_OPTS: '-Xmx2g' },
      },
    });
    const configured = await resolvePackScala(
      packDir,
      { dev: { javaHome: '/opt/jdk-21', sbt: ['sbt', '-mem', '2048'] } },
      {},
      'linux',
    );
    expect(configured.kind === 'ok' && configured.value).toMatchObject({
      java: '/opt/jdk-21/bin/java',
      sbt: ['sbt', '-mem', '2048'],
    });
    expect(await resolvePackScala(packDir, { dev: { sbt: [] } }, {}, 'linux')).toMatchObject({
      kind: 'err',
      message: expect.stringContaining('`dev.sbt` must be a command'),
    });
  });

  test('on Windows, a Scala pack runs under WSL', async () => {
    expect(await resolvePackScala(packDir, undefined, {}, 'win32')).toMatchObject({
      kind: 'err',
      message: expect.stringContaining(
        "a Scala pack's service starts through a POSIX shell script",
      ),
    });
  });

  test('resolvePackCode picks sbt for a Scala pack', async () => {
    const resolved = await resolvePackCode('scala', packDir, undefined, { JAVA_HOME: '/opt/jdk' });
    if (process.platform !== 'win32') {
      expect(resolved.kind === 'ok' && resolved.value.language).toBe('scala');
    }
  });

  /** A fake `java` or `sbt`: prints `text` on a stream, exits `code`. */
  async function fake(name: string, text: string, stream: 1 | 2, code = 0): Promise<string> {
    const file = join(packDir, name);
    await writeFile(file, `#!/bin/sh\nprintf '%s\\n' '${text}' >&${stream}\nexit ${code}\n`);
    await chmod(file, 0o755);
    return file;
  }

  test.skipIf(process.platform === 'win32')(
    'the check: the JDK 17 or later, and an sbt that runs',
    async () => {
      const java17 = await fake('java17', 'openjdk version "17.0.6" 2023-01-17', 2);
      const sbt = await fake('sbt', 'sbt runner version: 1.12.15', 1);
      const brokenSbt = await fake('sbt-broken', 'no java', 1, 1);
      const code = (java: string, sbtPath: string): ScalaPackCode => ({
        language: 'scala',
        java,
        sbt: [sbtPath],
        workDir: join(packDir, '.kindgi', 'dev', 'scala'),
      });
      const env = { PATH: process.env.PATH ?? '' };
      expect(await checkPackJvm(code(java17, sbt), env)).toEqual({
        kind: 'ok',
        value: `Java 17.0.6 · sbt 1.12.15 (${java17}; ${sbt})`,
      });
      expect(await checkPackJvm(code(java17, brokenSbt), env)).toMatchObject({
        kind: 'err',
        message: expect.stringContaining(`the pack's sbt (${brokenSbt}) did not run: no java`),
      });
      const java11 = await fake('java11', 'openjdk version "11.0.22" 2024-01-16', 2);
      expect(await checkPackJvm(code(java11, sbt), env)).toMatchObject({
        kind: 'err',
        message: expect.stringContaining('a Scala pack needs 17 or later'),
      });
    },
  );
});

describe('the Scala pack builder', () => {
  test('which changes are code or build changes', () => {
    expect(isScalaSourceChange('src/main/scala/acme/tools/Greet.scala')).toBe(true);
    expect(isScalaSourceChange('src/main/resources/application.conf')).toBe(true);
    expect(isScalaSourceChange('build.sbt')).toBe(true);
    expect(isScalaSourceChange('project/plugins.sbt')).toBe(true);
    expect(isScalaSourceChange('project/Dependencies.scala')).toBe(true);
    expect(isScalaSourceChange('project/build.properties')).toBe(true);
    expect(isScalaSourceChange('src/test/scala/acme/GreetSuite.scala')).toBe(false);
    expect(isScalaSourceChange('target/scala-3.3.8/classes/acme/tools/Greet$.class')).toBe(false);
    expect(isScalaSourceChange('project/target/active.json')).toBe(false);
    expect(isScalaSourceChange('project/project/target/x')).toBe(false);
    expect(isScalaSourceChange('.bsp/sbt.json')).toBe(false);
    expect(isSbtBuildChange('build.sbt')).toBe(true);
    expect(isSbtBuildChange('src/main/scala/acme/tools/Greet.scala')).toBe(false);
  });

  // As sbt's thin client prints them (ANSI escapes included), the pack at /work/acme.
  const SCALA3 = [
    '\u001b[0J[info] compiling 1 Scala source to /work/acme/target/scala-3.3.8/classes ...',
    '[error] -- [E007] Type Mismatch Error: /work/acme/src/main/scala/acme/tools/Greet.scala:10:31 ',
    '[error] 10 |    .handler((in, _) => Output(42))',
    '[error]    |                               ^^',
    '[error]    |                               Found:    (42 : Int)',
    '[error]    |                               Required: String',
    '[error]    |',
    '[error]    | longer explanation available when compiling with `-explain`',
    '[error] one error found',
    '[error] (Compile / compileIncremental) Compilation failed',
    '[\u001b[31merror\u001b[0m] Total time: 2 s, completed Oct 8, 2026, 9:02:53 AM',
  ].join('\n');
  const SCALA2 = [
    '[error] /work/acme/src/main/scala/acme/tools/Greet.scala:10:32: type mismatch;',
    '[error]  found   : Int(42)',
    '[error]  required: String',
    '[error]     .handler((in, _) => Output(42))',
    '[error]                                ^',
    '[error] one error found',
    '[error] (Compile / compileIncremental) Compilation failed',
  ].join('\n');

  test("Scala 3's and Scala 2's errors, located from sbt's output", () => {
    expect(sbtErrors(SCALA3, '/work/acme', 1)).toEqual([
      'src/main/scala/acme/tools/Greet.scala:10:31: Type Mismatch Error: Found: (42 : Int); Required: String',
    ]);
    expect(sbtErrors(SCALA2, ['/elsewhere', '/work/acme'], 1)).toEqual([
      'src/main/scala/acme/tools/Greet.scala:10:32: type mismatch; found : Int(42) required: String',
    ]);
    expect(sbtErrors('[error] Not a valid key: comple\n[error] comple\n', '/work/acme', 1)).toEqual(
      [
        "the pack's sbt build failed (exit 1):",
        '    [error] Not a valid key: comple',
        '    [error] comple',
      ],
    );
  });

  test("the classpath sbt's export printed", () => {
    const out = [
      '[info] entering *experimental* thin client - BEEP WHIRR',
      '> compile; export Runtime/fullClasspath',
      '/work/acme/target/scala-3.3.8/classes:/cache/kindgi-pack-0.1.6.jar',
      '[\u001b[32msuccess\u001b[0m] Total time: 1 s',
    ].join('\n');
    expect(exportedClasspath(out)).toEqual([
      '/work/acme/target/scala-3.3.8/classes',
      '/cache/kindgi-pack-0.1.6.jar',
    ]);
    expect(exportedClasspath('[success] Total time: 1 s\n')).toBeUndefined();
  });

  test.skipIf(process.platform === 'win32')(
    'a server runs when its active.json names a socket that answers',
    async () => {
      expect(await sbtServerRunning(packDir)).toBe(false);
      await mkdir(join(packDir, 'project', 'target'), { recursive: true });
      const sock = join(packDir, 's.sock');
      const active = join(packDir, 'project', 'target', 'active.json');
      await writeFile(active, JSON.stringify({ uri: `local://${sock}` }));
      expect(await sbtServerRunning(packDir)).toBe(false);
      const server = createServer((socket) => socket.end());
      await new Promise<void>((resolve) => server.listen(sock, resolve));
      try {
        expect(await sbtServerRunning(packDir)).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  /**
   * A fake `sbt` that logs each `--client` command and prints a classpath,
   * and a fake `java` that writes a launcher: the builder's conversation
   * with the server, without one.
   */
  async function fakes(): Promise<{ code: ScalaPackCode; log: string }> {
    const log = join(packDir, 'sbt.log');
    const sbt = join(packDir, 'fake-sbt');
    await writeFile(
      sbt,
      // A shutdown stops the stand-in server (its marker file, `server`).
      `#!/bin/sh\nshift\nprintf '%s\\n' "$1" >> '${log}'\n[ "$1" = shutdown ] && rm -f '${join(packDir, 'server')}'\nprintf '%s\\n' '${join(packDir, 'classes')}:${join(packDir, 'kindgi-pack.jar')}'\n`,
    );
    const java = join(packDir, 'fake-java');
    await writeFile(java, "#!/bin/sh\nprintf '#!/bin/sh\\n'\n");
    await chmod(sbt, 0o755);
    await chmod(java, 0o755);
    return {
      code: {
        language: 'scala',
        java,
        sbt: [sbt],
        workDir: join(packDir, '.kindgi', 'dev', 'scala'),
      },
      log,
    };
  }

  test.skipIf(process.platform === 'win32')(
    'its own server: the idle timeout once, a reload after a build change, a shutdown at the end',
    async () => {
      const { code, log } = await fakes();
      const server = join(packDir, 'server');
      const builder = createScalaPackBuilder({
        packDir,
        code,
        env: async () => ({ PATH: process.env.PATH ?? '' }),
        serverRunning: async () => existsSync(server),
      });
      expect(await builder.build()).toEqual({ kind: 'ok', bundleMap: {} });
      // The first build started the server.
      await writeFile(server, '');
      expect(await builder.build()).toEqual({ kind: 'ok', bundleMap: {} });
      await builder.dispose();
      expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual([
        'set Global / serverIdleTimeout := Some(scala.concurrent.duration.FiniteDuration(1, "hour")); compile; export Runtime/fullClasspath',
        'compile; export Runtime/fullClasspath',
        'shutdown',
      ]);
      expect(await readFile(join(code.workDir, 'java.args'), 'utf8')).toBe(
        `-cp "${join(packDir, 'classes')}:${join(packDir, 'kindgi-pack.jar')}"\n`,
      );
    },
  );

  test.skipIf(process.platform === 'win32')(
    'a server that was already running: reloaded first, never shut down',
    async () => {
      const { code, log } = await fakes();
      const builder = createScalaPackBuilder({
        packDir,
        code,
        env: async () => ({ PATH: process.env.PATH ?? '' }),
        serverRunning: async () => true,
      });
      expect(await builder.build()).toEqual({ kind: 'ok', bundleMap: {} });
      expect(await builder.build()).toEqual({ kind: 'ok', bundleMap: {} });
      await builder.dispose();
      expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual([
        'reload; compile; export Runtime/fullClasspath',
        'compile; export Runtime/fullClasspath',
      ]);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// One real build, when this machine can: a JDK 17+, sbt, and kindgi-pack-scala at this checkout's
// version in the local Ivy repository (`sbt +publishLocal` in sdks/scala).
// ---------------------------------------------------------------------------------------------

const sdkScala = fileURLToPath(new URL('../../../sdks/scala', import.meta.url));
const layerVersion = /"([^"]+)"/.exec(readFileSync(join(sdkScala, 'version.sbt'), 'utf8'))?.[1];
const published =
  layerVersion !== undefined &&
  existsSync(join(homedir(), '.ivy2', 'local', 'com.kindgi', 'kindgi-pack-scala_3', layerVersion));
const sbtOnPath = spawnSync('sbt', ['--script-version'], { encoding: 'utf8' }).status === 0;
const jdkHome =
  process.env.JAVA_HOME !== undefined && process.env.JAVA_HOME !== ''
    ? process.env.JAVA_HOME
    : undefined;
const jdkOk =
  (javaMajor(
    /version "([^"]+)"/.exec(
      spawnSync(jdkHome !== undefined ? join(jdkHome, 'bin', 'java') : 'java', ['-version'], {
        encoding: 'utf8',
      }).stderr ?? '',
    )?.[1] ?? '',
  ) ?? 0) >= 17;

const GREET = `package acme.tools

import com.kindgi.pack.scaladsl._

object Greet {
  final case class Input(name: String)
  final case class Output(message: String)

  val tool: Tool[Input, Output] = Tool[Input, Output]("acme.greet")
    .handler((in, _) => Output(s"Hello, \${in.name}!"))
}
`;

describe.skipIf(!jdkOk || !sbtOnPath || !published || process.platform === 'win32')(
  'a real build: the sbt server, scalac, the indexer and the launcher',
  () => {
    test('builds, indexes, locates a compile error, recovers, and stops its server', async () => {
      await mkdir(join(packDir, 'project'), { recursive: true });
      await writeFile(join(packDir, 'project', 'build.properties'), 'sbt.version=1.12.15\n');
      await writeFile(
        join(packDir, 'build.sbt'),
        `scalaVersion := "3.3.8"\nresolvers += Resolver.mavenLocal\nlibraryDependencies += "com.kindgi" %% "kindgi-pack-scala" % "${layerVersion}"\n`,
      );
      await writeFile(
        join(packDir, 'kindgi.config.json'),
        JSON.stringify({ language: 'scala', pack: { id: 'acme', version: '1.0.0' } }),
      );
      const tools = join(packDir, 'src', 'main', 'scala', 'acme', 'tools');
      await mkdir(tools, { recursive: true });
      await writeFile(join(tools, 'Greet.scala'), GREET);
      const resolved = await resolvePackScala(
        packDir,
        undefined,
        jdkHome ? { JAVA_HOME: jdkHome } : {},
      );
      expect(resolved.kind).toBe('ok');
      const code = (resolved as { value: ScalaPackCode }).value;
      const env = async (): Promise<Record<string, string>> => ({
        PATH: process.env.PATH ?? '',
        HOME: homedir(),
      });
      const builder = createScalaPackBuilder({ packDir, code, env });
      try {
        expect(await builder.build()).toEqual({ kind: 'ok', bundleMap: {} });
        expect(await sbtServerRunning(packDir)).toBe(true);
        expect(await readFile(join(code.workDir, 'kindgi-pack-java'), 'utf8')).toMatch(
          /^#!\/bin\/sh/,
        );

        const indexed = await runJavaIndexer({
          packDir,
          outputPath: join(packDir, '.kindgi', 'dev', 'index.json'),
          code,
          env: await env(),
        });
        expect(indexed.kind === 'ok' && indexed.counts.tools).toBe(1);

        await writeFile(
          join(tools, 'Greet.scala'),
          GREET.replace('Output(s"Hello, ${in.name}!")', 'Output(42)'),
        );
        const broken = await builder.build();
        expect(broken.kind === 'err' && broken.errors).toEqual([
          expect.stringMatching(/^src\/main\/scala\/acme\/tools\/Greet\.scala:\d+:\d+: /),
        ]);

        await writeFile(join(tools, 'Greet.scala'), GREET);
        expect(await builder.build()).toEqual({ kind: 'ok', bundleMap: {} });
      } finally {
        await builder.dispose();
      }
      expect(await sbtServerRunning(packDir)).toBe(false);
    }, 600_000);
  },
);
