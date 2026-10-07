// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi init` in an existing Maven app: `kindgi.config.json` with
 * discovery under `kindgi` packages, the dependency to add printed, the
 * skills and `.gitignore` — through the real CLI.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { packIdOf, readPomIdentity } from '../src/init/java-augment.js';
import { runCli } from '../src/main.js';
import { CLI_VERSION } from '../src/version-info.js';

let app: string;
beforeEach(async () => {
  app = await mkdtemp(join(tmpdir(), 'kindgi-maven-app-'));
});
afterEach(async () => {
  await rm(app, { recursive: true, force: true });
});

const POM = `<?xml version="1.0"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.5.6</version>
  </parent>
  <groupId>com.acme</groupId>
  <artifactId>Acme_Ledger</artifactId>
  <version>2.4.0</version>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
</project>
`;

function init(...flags: string[]) {
  return runCli({ argv: ['init', ...flags], env: {}, cwd: app, home: app });
}

describe('kindgi init in a Maven app', () => {
  beforeEach(async () => {
    await writeFile(join(app, 'pom.xml'), POM);
  });

  test("writes kindgi.config.json (the app's artifactId and version; discovery under kindgi packages), prints the dependency", async () => {
    const out = await init();
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(app, 'kindgi.config.json'), 'utf8'))).toEqual({
      language: 'java',
      pack: { id: 'acme-ledger', version: '2.4.0' },
      discovery: {
        tools: 'src/main/java/**/kindgi/tools/**/*.java',
        guardrails: 'src/main/java/**/kindgi/guardrails/**/*.java',
        agents: 'src/main/java/**/kindgi/agents/**/*.java',
        flows: 'src/main/java/**/kindgi/flows/**/*.java',
      },
    });
    // pom.xml isn't edited: the dependency is printed.
    expect(await readFile(join(app, 'pom.xml'), 'utf8')).toBe(POM);
    expect(out.stderr).toContain('<artifactId>kindgi-pack</artifactId>');
    expect(out.stderr).toContain(`<version>${CLI_VERSION}</version>`);
    expect(out.stderr).toContain('com.acme.app.kindgi.tools');
    const gitignore = await readFile(join(app, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.kindgirc.json');
    const summary = JSON.parse(out.stdout) as { language: string; dependencyInPom: boolean };
    expect(summary).toMatchObject({ language: 'java', dependencyInPom: false });
  });

  test('a second run refuses; --force writes it again', async () => {
    expect((await init()).exitCode).toBe(0);
    const again = await init();
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain('already exists — this app is a Kindgi pack');
    expect((await init('--force')).exitCode).toBe(0);
  });

  test('--pack-id names the pack; another template is refused', async () => {
    expect((await init('--pack-id=acme.ledger')).exitCode).toBe(0);
    expect(JSON.parse(await readFile(join(app, 'kindgi.config.json'), 'utf8')).pack.id).toBe(
      'acme.ledger',
    );
    const sample = await init('--template=sample', '--force');
    expect(sample.exitCode).toBe(1);
    expect(sample.stderr).toContain('A Maven app gets a Java pack');
  });

  test('a pom that already has kindgi-pack: no dependency to print', async () => {
    await writeFile(
      join(app, 'pom.xml'),
      POM.replace(
        '</dependencies>',
        '<dependency><groupId>com.kindgi</groupId><artifactId>kindgi-pack</artifactId><version>0.1.6</version></dependency></dependencies>',
      ),
    );
    const out = await init();
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain("Add to pom.xml's <dependencies>");
  });
});

describe("a pom's identity", () => {
  test("its own artifactId and version, not its parent's; a property version isn't one", () => {
    expect(readPomIdentity(POM)).toEqual({ artifactId: 'Acme_Ledger', version: '2.4.0' });
    expect(
      readPomIdentity(
        '<project><artifactId>x</artifactId><version>${revision}</version></project>',
      ),
    ).toEqual({ artifactId: 'x' });
    expect(packIdOf('Acme_Ledger')).toBe('acme-ledger');
    expect(packIdOf('2fa-service')).toBe('fa-service');
  });
});
