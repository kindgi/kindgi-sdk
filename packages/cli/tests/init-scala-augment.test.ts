// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi init` in an existing sbt app: `kindgi.config.json` with discovery
 * under `kindgi` packages, the dependency to add printed, the wrappers and
 * `.gitignore` — through the real CLI.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { defaultTemplatesRoot } from '../src/commands/init.js';
import { JVM_PREVIEW, type KindgiJavaSource } from '../src/init/dependency-specs.js';
import {
  kindgiPackScalaDependency,
  readSbtIdentity,
  runInitScalaAugment,
} from '../src/init/scala-augment.js';
import { runCli } from '../src/main.js';
import { CLI_VERSION } from '../src/version-info.js';

let app: string;
beforeEach(async () => {
  app = await mkdtemp(join(tmpdir(), 'kindgi-sbt-app-'));
});
afterEach(async () => {
  await rm(app, { recursive: true, force: true });
});

const BUILD = `ThisBuild / scalaVersion := "3.3.8"
ThisBuild / version := "2.4.0"

lazy val root = (project in file("."))
  .settings(
    name := "Acme_Ledger",
    libraryDependencies += "org.typelevel" %% "cats-core" % "2.13.0"
  )
`;

function init(...flags: string[]) {
  return runCli({ argv: ['init', ...flags], env: {}, cwd: app, home: app });
}

describe('kindgi init in an sbt app', () => {
  beforeEach(async () => {
    await writeFile(join(app, 'build.sbt'), BUILD);
  });

  test("writes kindgi.config.json (the build's name and version; discovery under kindgi packages), prints the dependency", async () => {
    const out = await init();
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(app, 'kindgi.config.json'), 'utf8'))).toEqual({
      language: 'scala',
      cli: CLI_VERSION,
      pack: { id: 'acme-ledger', version: '2.4.0' },
      discovery: {
        tools: 'src/main/scala/**/kindgi/tools/**/*.scala',
        guardrails: 'src/main/scala/**/kindgi/guardrails/**/*.scala',
        agents: 'src/main/scala/**/kindgi/agents/**/*.scala',
        flows: 'src/main/scala/**/kindgi/flows/**/*.scala',
      },
    });
    // build.sbt isn't edited: the dependency is printed.
    expect(await readFile(join(app, 'build.sbt'), 'utf8')).toBe(BUILD);
    expect(out.stderr).toContain(kindgiPackScalaDependency(CLI_VERSION));
    expect(out.stderr).toContain('resolvers += Resolver.mavenLocal');
    expect(out.stderr).toContain('com.acme.app.kindgi.tools');
    expect(await readFile(join(app, 'kindgiw'), 'utf8')).toMatch(/^#!\/bin\/sh/);
    expect(out.stderr).toContain('./kindgiw dev');
    expect(await readFile(join(app, '.gitignore'), 'utf8')).toContain('.kindgirc.json');
    expect(JSON.parse(out.stdout)).toMatchObject({ language: 'scala', dependencyInBuild: false });
    // The skills written for Scala packs.
    expect(
      await readFile(
        join(app, '.claude', 'skills', 'kindgi-scala-authoring-tools', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('name: kindgi-scala-authoring-tools');
    expect(JSON.parse(out.stdout).created).toContain(
      join(app, '.claude', 'skills', 'kindgi-scala-getting-started', 'SKILL.md'),
    );
  });

  test('a second run refuses; --force writes it again; another template is refused', async () => {
    expect((await init()).exitCode).toBe(0);
    const again = await init();
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain('already exists — this app is a Kindgi pack');
    expect((await init('--force', '--pack-id=acme.ledger')).exitCode).toBe(0);
    expect(JSON.parse(await readFile(join(app, 'kindgi.config.json'), 'utf8')).pack.id).toBe(
      'acme.ledger',
    );
    const java = await init('--template=java', '--force');
    expect(java.exitCode).toBe(1);
    expect(java.stderr).toContain('An sbt app gets a Scala pack');
  });

  test('a build that declares kindgi-pack-scala (here in project/*.scala): no dependency to print', async () => {
    await mkdir(join(app, 'project'), { recursive: true });
    await writeFile(
      join(app, 'project', 'Dependencies.scala'),
      'object Dependencies { val kindgi = "com.kindgi" %% "kindgi-pack-scala" % "0.1.6" }\n',
    );
    const out = await init();
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain('Add to build.sbt');
  });

  async function augment(javaSource: KindgiJavaSource) {
    const out = await runInitScalaAugment({
      targetDir: app,
      templatesRoot: defaultTemplatesRoot(),
      force: true,
      javaSource,
    });
    if (out.kind !== 'ok') throw new Error(JSON.stringify(out));
    return out.rendered;
  }

  test('from Maven Central: only the dependency to add; it says the pack is a preview', async () => {
    const { stderr, stdout } = await augment({ kind: 'published', version: '0.1.5' });
    expect(stderr).toContain(`Add to build.sbt:\n      ${kindgiPackScalaDependency('0.1.5')}\n`);
    expect(stderr).not.toContain('Resolver.mavenLocal');
    expect(stderr).not.toContain('sbt +publishLocal');
    expect(stderr).toContain('(a Scala pack in the app; preview)');
    expect(stderr).toContain(JVM_PREVIEW);
    expect(JSON.parse(stdout)).toMatchObject({ preview: true });
  });

  test('from a Kindgi checkout: its SDK published locally first, and the local Maven repository', async () => {
    const { stderr } = await augment({
      kind: 'local-checkout',
      path: '/k/sdks/java',
      version: '0.1.5',
    });
    expect(stderr).toContain(
      '(cd /k/sdks/java && ./mvnw -q -pl kindgi-pack -am install -DskipTests)',
    );
    expect(stderr).toContain('(cd /k/sdks/scala && sbt +publishLocal)');
    expect(stderr).toContain(
      `${kindgiPackScalaDependency('0.1.5')}\n      resolvers += Resolver.mavenLocal`,
    );
  });
});

describe("a build's identity", () => {
  test('its name and version, plain or ThisBuild-scoped', () => {
    expect(readSbtIdentity(BUILD)).toEqual({ name: 'Acme_Ledger', version: '2.4.0' });
    expect(readSbtIdentity('scalaVersion := "3.3.8"\n')).toEqual({});
  });
});
