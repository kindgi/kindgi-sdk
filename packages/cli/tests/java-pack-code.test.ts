// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A Java pack under `kindgi dev`: its JDK and Maven, the builder's parsing,
 * and one real build (Maven, javac, the indexer, the launcher) when this
 * machine has a JDK 17+ and kindgi-pack in its local Maven repository
 * (`./mvnw -pl kindgi-pack -am install` in sdks/java; CI does).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { packServiceCommand, runJavaIndexer } from '../src/dev/defaults.js';
import {
  argsFileText,
  createJavaPackBuilder,
  isJavaSourceChange,
  mavenErrors,
} from '../src/dev/java-builder.js';
import {
  type JavaPackCode,
  checkPackJava,
  javaMajor,
  resolvePackCode,
  resolvePackJava,
} from '../src/dev/pack-code.js';

let packDir: string;
beforeEach(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-java-pack-'));
});
afterEach(async () => {
  await rm(packDir, { recursive: true, force: true });
});

describe("the pack's JDK and Maven", () => {
  test('JAVA_HOME, else java on PATH; the pack wrapper, else mvn', async () => {
    expect(
      await resolvePackJava(packDir, undefined, { JAVA_HOME: '/opt/jdk-17' }, 'linux'),
    ).toEqual({
      kind: 'ok',
      value: {
        language: 'java',
        java: '/opt/jdk-17/bin/java',
        javaHome: '/opt/jdk-17',
        maven: ['mvn'],
        workDir: join(packDir, '.kindgi', 'dev', 'java'),
      },
    });
    await writeFile(join(packDir, 'mvnw'), '#!/bin/sh\n');
    const resolved = await resolvePackJava(packDir, undefined, {}, 'linux');
    expect(resolved.kind === 'ok' && resolved.value).toMatchObject({
      java: 'java',
      maven: ['sh', join(packDir, 'mvnw')],
    });
    expect(resolved.kind === 'ok' && 'javaHome' in resolved.value).toBe(false);
  });

  test('dev.javaHome and dev.maven come first, and must be well formed', async () => {
    const config = { dev: { javaHome: '/opt/jdk-21', maven: 'mvn' } };
    const resolved = await resolvePackJava(packDir, config, { JAVA_HOME: '/opt/jdk-17' }, 'linux');
    expect(resolved.kind === 'ok' && resolved.value).toMatchObject({
      java: '/opt/jdk-21/bin/java',
      javaHome: '/opt/jdk-21',
      maven: ['mvn'],
    });
    expect(await resolvePackJava(packDir, { dev: { javaHome: 7 } }, {}, 'linux')).toMatchObject({
      kind: 'err',
      message: expect.stringContaining('`dev.javaHome` must be the path of a JDK'),
    });
    expect(
      await resolvePackJava(packDir, { dev: { maven: ['mvn', ''] } }, {}, 'linux'),
    ).toMatchObject({
      kind: 'err',
      message: expect.stringContaining('`dev.maven` must be a command'),
    });
  });

  test('on Windows, a Java pack runs under WSL', async () => {
    expect(await resolvePackJava(packDir, undefined, {}, 'win32')).toMatchObject({
      kind: 'err',
      message: expect.stringContaining('on Windows run kindgi dev under WSL'),
    });
  });

  test('resolvePackCode picks the JDK for a Java pack', async () => {
    const resolved = await resolvePackCode('java', packDir, undefined, { JAVA_HOME: '/opt/jdk' });
    if (process.platform === 'win32') {
      expect(resolved.kind).toBe('err');
    } else {
      expect(resolved.kind === 'ok' && resolved.value.language).toBe('java');
    }
  });

  test('versions: the major is what counts', () => {
    expect(javaMajor('17.0.6')).toBe(17);
    expect(javaMajor('21')).toBe(21);
    expect(javaMajor('25-ea')).toBe(25);
    expect(javaMajor('1.8.0_392')).toBe(8);
    expect(javaMajor('banana')).toBeUndefined();
  });

  /** A fake `java` or `mvn`: prints `text` on a stream, exits `code`. */
  async function fake(name: string, text: string, stream: 1 | 2, code = 0): Promise<string> {
    const file = join(packDir, name);
    await writeFile(file, `#!/bin/sh\nprintf '%s\\n' '${text}' >&${stream}\nexit ${code}\n`);
    await chmod(file, 0o755);
    return file;
  }

  const code = (java: string, maven: string): JavaPackCode => ({
    language: 'java',
    java,
    maven: [maven],
    workDir: join(packDir, '.kindgi', 'dev', 'java'),
  });
  const env = { PATH: process.env.PATH ?? '' };

  test.skipIf(process.platform === 'win32')(
    'the check: the JDK 17 or later, and a Maven that runs',
    async () => {
      const java17 = await fake('java17', 'openjdk version "17.0.6" 2023-01-17', 2);
      const java11 = await fake('java11', 'openjdk version "11.0.22" 2024-01-16', 2);
      const mvn = await fake('mvn', 'Apache Maven 3.9.16 (abc)', 1);
      const brokenMvn = await fake(
        'mvn-broken',
        'Error: JAVA_HOME is not defined correctly.',
        1,
        1,
      );

      expect(await checkPackJava(code(java17, mvn), env)).toEqual({
        kind: 'ok',
        value: `Java 17.0.6 · Maven 3.9.16 (${java17}; ${mvn})`,
      });
      expect(await checkPackJava(code(java11, mvn), env)).toMatchObject({
        kind: 'err',
        message: expect.stringContaining('is 11.0.22; a Java pack needs 17 or later'),
      });
      expect(await checkPackJava(code(java17, brokenMvn), env)).toMatchObject({
        kind: 'err',
        message: expect.stringContaining('JAVA_HOME is not defined correctly'),
      });
      expect(await checkPackJava(code(join(packDir, 'nope'), mvn), env)).toMatchObject({
        kind: 'err',
        message: expect.stringContaining('did not start'),
      });
    },
  );

  test('the service runs through the launcher, with the classpath @argfile', () => {
    const c = code('/opt/jdk/bin/java', 'mvn');
    expect(packServiceCommand(c)).toEqual([
      'sh',
      join(packDir, '.kindgi', 'dev', 'java', 'kindgi-pack-java'),
      `@${join(packDir, '.kindgi', 'dev', 'java', 'java.args')}`,
      'com.kindgi.pack.Main',
      'serve',
    ]);
  });
});

describe('the Java pack builder', () => {
  test('which changes are code changes', () => {
    expect(isJavaSourceChange('src/main/java/com/acme/tools/Greet.java')).toBe(true);
    expect(isJavaSourceChange('src/main/resources/application.properties')).toBe(true);
    expect(isJavaSourceChange('pom.xml')).toBe(true);
    expect(isJavaSourceChange('src/test/java/com/acme/GreetTest.java')).toBe(false);
    expect(isJavaSourceChange('target/classes/com/acme/tools/Greet.class')).toBe(false);
    expect(isJavaSourceChange('.kindgi/dev/java/java.args')).toBe(false);
    expect(isJavaSourceChange('src/main/java/.Greet.java.swp')).toBe(false);
    expect(isJavaSourceChange('README.md')).toBe(false);
    expect(isJavaSourceChange('sub/pom.xml')).toBe(false);
  });

  test("javac's errors, located from Maven's output", () => {
    const output = [
      '[ERROR] COMPILATION ERROR : ',
      `[ERROR] ${packDir}/src/main/java/com/acme/tools/Greet.java:[12,5] cannot find symbol`,
      `[ERROR] ${packDir}/src/main/java/com/acme/tools/Greet.java:[12,5] cannot find symbol`,
      `[ERROR] ${packDir}/src/main/java/com/acme/tools/Echo.java:[3,1] class, interface, enum, or record expected`,
      '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.16.0:compile',
    ].join('\n');
    expect(mavenErrors(output, packDir, 1)).toEqual([
      'src/main/java/com/acme/tools/Greet.java:12:5: cannot find symbol',
      'src/main/java/com/acme/tools/Echo.java:3:1: class, interface, enum, or record expected',
    ]);
    expect(mavenErrors('[INFO] x\n[ERROR] Non-resolvable parent POM\n', packDir, 1)).toEqual([
      "the pack's Maven build failed (exit 1):",
      '    [ERROR] Non-resolvable parent POM',
    ]);
  });

  test('the classpath @argfile quotes and escapes', () => {
    expect(argsFileText(['/a/classes', '/b c/x.jar', '/q"d/y.jar'])).toBe(
      `-cp "/a/classes${delimiter}/b c/x.jar${delimiter}/q\\"d/y.jar"\n`,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// One real build, when this machine can: a JDK 17+ (JAVA_HOME or the java on PATH) and
// kindgi-pack, at this checkout's version, in the local Maven repository.
// ---------------------------------------------------------------------------------------------

const sdkJava = fileURLToPath(new URL('../../../sdks/java', import.meta.url));
const kindgiPackVersion =
  /<artifactId>kindgi-java-parent<\/artifactId>[\s\S]*?<version>([^<]+)<\/version>/.exec(
    readFileSync(join(sdkJava, 'pom.xml'), 'utf8'),
  )?.[1];
const installed =
  kindgiPackVersion !== undefined &&
  existsSync(
    join(homedir(), '.m2', 'repository', 'com', 'kindgi', 'kindgi-pack', kindgiPackVersion),
  );
const jdk = ((): { readonly home?: string; readonly ok: boolean } => {
  const home =
    process.env.JAVA_HOME !== undefined && process.env.JAVA_HOME !== ''
      ? process.env.JAVA_HOME
      : undefined;
  const run = spawnSync(home !== undefined ? join(home, 'bin', 'java') : 'java', ['-version'], {
    encoding: 'utf8',
  });
  const major = javaMajor(
    /version "([^"]+)"/.exec(`${run.stderr ?? ''}${run.stdout ?? ''}`)?.[1] ?? '',
  );
  return { ...(home !== undefined && { home }), ok: major !== undefined && major >= 17 };
})();

const POM = (version: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.acme</groupId>
  <artifactId>acme-pack</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.release>17</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.kindgi</groupId>
      <artifactId>kindgi-pack</artifactId>
      <version>${version}</version>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-resources-plugin</artifactId><version>3.5.0</version></plugin>
      <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.16.0</version></plugin>
      <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-dependency-plugin</artifactId><version>3.11.0</version></plugin>
    </plugins>
  </build>
</project>
`;

const GREET = `package com.acme.tools;

import com.kindgi.pack.Tool;

public final class Greet {
  public record Input(String name) {}

  public record Output(String message) {}

  public static final Tool<Input, Output> TOOL = Tool.define("acme.greet")
      .input(Input.class)
      .output(Output.class)
      .handler((input, ctx) -> new Output("Hello, " + input.name() + "!"));
}
`;

describe.skipIf(!jdk.ok || !installed || process.platform === 'win32')(
  'a real build: Maven, javac, the indexer and the launcher',
  () => {
    test('builds, indexes, locates a compile error, and recovers', async () => {
      await writeFile(join(packDir, 'pom.xml'), POM(kindgiPackVersion as string));
      await writeFile(
        join(packDir, 'kindgi.config.json'),
        JSON.stringify({ language: 'java', pack: { id: 'acme', version: '1.0.0' } }),
      );
      const tools = join(packDir, 'src', 'main', 'java', 'com', 'acme', 'tools');
      await mkdir(tools, { recursive: true });
      await writeFile(join(tools, 'Greet.java'), GREET);
      const resolved = await resolvePackJava(
        packDir,
        { dev: { maven: ['sh', join(sdkJava, 'mvnw')] } },
        jdk.home ? { JAVA_HOME: jdk.home } : {},
      );
      expect(resolved.kind).toBe('ok');
      const code = (resolved as { value: JavaPackCode }).value;
      const env = async (): Promise<Record<string, string>> => ({
        PATH: process.env.PATH ?? '',
        HOME: homedir(),
        // Maven 3.9 reads extra arguments from MAVEN_ARGS (a machine's own `-s settings.xml`).
        ...(process.env.MAVEN_ARGS !== undefined && { MAVEN_ARGS: process.env.MAVEN_ARGS }),
      });
      const builder = createJavaPackBuilder({ packDir, code, env });

      expect(await builder.build()).toEqual({ kind: 'ok', bundleMap: {} });
      expect(await readFile(join(code.workDir, 'kindgi-pack-java'), 'utf8')).toMatch(
        /^#!\/bin\/sh/,
      );
      expect(await readFile(join(code.workDir, 'java.args'), 'utf8')).toContain('kindgi-pack');

      const indexed = await runJavaIndexer({
        packDir,
        outputPath: join(packDir, '.kindgi', 'dev', 'index.json'),
        code,
        env: await env(),
      });
      expect(indexed.kind).toBe('ok');
      expect(indexed.kind === 'ok' && indexed.counts.tools).toBe(1);

      await writeFile(join(tools, 'Greet.java'), GREET.replace('new Output(', 'new Outptu('));
      const broken = await builder.build();
      expect(broken.kind === 'err' && broken.errors).toEqual([
        expect.stringMatching(
          /^src\/main\/java\/com\/acme\/tools\/Greet\.java:\d+:\d+: cannot find symbol/,
        ),
      ]);

      await writeFile(join(tools, 'Greet.java'), GREET);
      expect(await builder.build()).toEqual({ kind: 'ok', bundleMap: {} });
      await builder.dispose();
    }, 300_000);
  },
);
