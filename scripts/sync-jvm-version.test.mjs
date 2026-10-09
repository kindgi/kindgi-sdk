// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for `scripts/sync-jvm-version.mjs`: the Maven spelling, the pom
 * reader, and the command itself in a scratch workspace (`--check`,
 * writing, `--release`). Maven's own ordering of the spelling is
 * sdks/java/codegen's `VersionOrderTest`. Run: `pnpm run test:scripts`.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { NO_CHANGES, SyncError, pomLeaves, sbtLine, toMaven } from './sync-jvm-version.mjs';

const SCRIPT = fileURLToPath(new URL('./sync-jvm-version.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'kindgi-sync-jvm-version-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe('toMaven', () => {
  test('takes a release or an alpha, beta or rc prerelease as npm spells it', () => {
    for (const version of ['1.2.3', '0.1.6-alpha.0', '0.1.6-beta.2', '0.1.6-rc.10']) {
      assert.equal(toMaven(version), version);
    }
  });

  test("refuses what Maven wouldn't order as npm does", () => {
    for (const version of [
      '1.2.3-next.1',
      '1.2.3-rc1',
      '1.2.3-rc.01',
      '01.2.3',
      '1.2',
      '1.2.3+build.4',
    ]) {
      assert.throws(() => toMaven(version), SyncError, version);
    }
  });
});

describe('pomLeaves', () => {
  test('finds elements by path; comments and CDATA hold none', () => {
    const leaves = pomLeaves(
      `<?xml version="1.0"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <!-- <version>9.9.9</version> -->
  <version> 1.2.0 </version>
  <description><![CDATA[<version>8.8.8</version>]]></description>
  <build/>
</project>
`,
      'pom.xml',
    );
    assert.deepEqual(
      leaves.map(({ path, value }) => [path, value]),
      [
        ['project/version', ' 1.2.0 '],
        ['project/description', '<![CDATA[<version>8.8.8</version>]]>'],
      ],
    );
  });

  test('refuses XML that is not well-formed', () => {
    assert.throws(
      () => pomLeaves('<project><version>1</parent></project>', 'p.xml'),
      /p\.xml: <\/parent> closes <version>/,
    );
    assert.throws(
      () => pomLeaves('<project><version>1</version>', 'p.xml'),
      /<project> is never closed/,
    );
    assert.throws(() => pomLeaves('<project>a < b</project>', 'p.xml'), /not well-formed/);
  });
});

// ---- the command, in a scratch workspace ----------------------------------------

/** The root pom. Every other `1.2.0` in it (a property, a managed dependency, a plugin, a comment) isn't the project's version and must stay. */
const ROOT = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.acme</groupId>
  <artifactId>acme-parent</artifactId>
  <!-- The version follows the npm packages; not this one: <version>1.2.0</version> -->
  <version>1.2.0</version>
  <packaging>pom</packaging>
  <properties>
    <other.version>1.2.0</other.version>
  </properties>
  <modules>
    <module>a</module>
  </modules>
  <profiles>
    <profile>
      <id>compat</id>
      <modules>
        <module>compat/b</module>
      </modules>
    </profile>
  </profiles>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>com.other</groupId>
        <artifactId>other</artifactId>
        <version>1.2.0</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <build>
    <plugins>
      <plugin>
        <artifactId>maven-acme-plugin</artifactId>
        <version>1.2.0</version>
      </plugin>
    </plugins>
  </build>
</project>
`;

/** A module, its parent the root, with a dependency at the same version string. */
const module = (artifactId) => `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>com.acme</groupId>
    <artifactId>acme-parent</artifactId>
    <version>1.2.0</version>
    <relativePath>${artifactId === 'b' ? '../../pom.xml' : '../pom.xml'}</relativePath>
  </parent>
  <artifactId>${artifactId}</artifactId>
  <dependencies>
    <dependency>
      <groupId>com.other</groupId>
      <artifactId>other</artifactId>
      <version>1.2.0</version>
    </dependency>
  </dependencies>
</project>
`;

const CHANGELOG = `# Acme JVM SDKs

## Unreleased

- a change

## 1.2.0

- the first release
`;

const POMS = {
  'sdks/java/pom.xml': ROOT,
  'sdks/java/a/pom.xml': module('a'),
  'sdks/java/compat/b/pom.xml': module('b'),
};

let fixtures = 0;

/** A workspace with two fixed-group packages at `sdk`, and the JVM SDKs at 1.2.0. */
function workspace({ sdk, files = {} }) {
  const root = join(scratch, `ws-${++fixtures}`);
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  write('package.json', JSON.stringify({ name: 'acme-root', private: true }));
  write('pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n');
  write('.changeset/config.json', JSON.stringify({ fixed: [['@kindgi/*']] }));
  write('packages/sdk/package.json', JSON.stringify({ name: '@kindgi/sdk', version: sdk }));
  write('packages/cli/package.json', JSON.stringify({ name: '@kindgi/cli', version: sdk }));
  for (const [file, text] of Object.entries({
    ...POMS,
    'sdks/java/CHANGELOG.md': CHANGELOG,
    ...files,
  })) {
    if (text !== undefined) write(file, text);
  }
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: root });
  return root;
}

const run = (root, args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8' });
const read = (root, file) => readFileSync(join(root, file), 'utf8');

/** `text` with the first `<version>1.2.0</version>` after `anchor` (not in it) moved to `version`. */
function moved(text, anchor, version) {
  const at = text.indexOf(anchor);
  assert.ok(at >= 0 && text.indexOf(anchor, at + 1) === -1, `one ${anchor}`);
  const from = text.indexOf('<version>1.2.0</version>', at + anchor.length);
  return `${text.slice(0, from)}<version>${version}</version>${text.slice(from + '<version>1.2.0</version>'.length)}`;
}

const ROOT_ANCHOR =
  '<!-- The version follows the npm packages; not this one: <version>1.2.0</version> -->';
const PARENT_ANCHOR = '<artifactId>acme-parent</artifactId>';

describe('sync-jvm-version --check', () => {
  test('passes when every module has the npm version', () => {
    const result = run(workspace({ sdk: '1.2.0' }), ['--check']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /3 Maven module\(s\) at 1\.2\.0, in step with the 2 packages/);
  });

  test('fails on modules behind npm, naming each element and the fix', () => {
    const result = run(workspace({ sdk: '1.3.0-rc.1' }), ['--check']);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /sdks\/java\/pom\.xml: <project><version> 1\.2\.0, expected 1\.3\.0-rc\.1/,
    );
    assert.match(
      result.stderr,
      /sdks\/java\/a\/pom\.xml: <parent><version> 1\.2\.0, expected 1\.3\.0-rc\.1/,
    );
    assert.match(result.stderr, /sdks\/java\/compat\/b\/pom\.xml: <parent><version> 1\.2\.0/);
    assert.match(result.stderr, /Run `node scripts\/sync-jvm-version\.mjs`/);
  });

  test("checks version.sbt's one version line, when it exists", () => {
    const sbt = { 'sdks/scala/version.sbt': `${sbtLine('1.2.0')}\n` };
    const ok = run(workspace({ sdk: '1.2.0', files: sbt }), ['--check']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /3 Maven module\(s\) and version\.sbt at 1\.2\.0/);
    const behind = run(workspace({ sdk: '1.3.0', files: sbt }), ['--check']);
    assert.equal(behind.status, 1);
    assert.match(behind.stderr, /version\.sbt: ThisBuild \/ version 1\.2\.0, expected 1\.3\.0/);
    for (const text of ['version := "1.2.0"\n', `${sbtLine('1.2.0')}\n${sbtLine('1.2.0')}\n`]) {
      const result = run(workspace({ sdk: '1.2.0', files: { 'sdks/scala/version.sbt': text } }), [
        '--check',
      ]);
      assert.equal(result.status, 1, text);
      assert.match(
        result.stderr,
        /version\.sbt needs one line `ThisBuild \/ version := "…"`; it has [02]/,
      );
    }
  });

  test("fails on a changelog that can't be stamped", () => {
    const result = run(
      workspace({ sdk: '1.2.0', files: { 'sdks/java/CHANGELOG.md': '# Acme\n\n## 1.2.0\n' } }),
      ['--check'],
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CHANGELOG\.md needs one "## Unreleased" heading; it has 0/);
  });

  test('refuses a module whose parent is not the pom that lists it, or that sets its own version', () => {
    const stranger = module('a').replace(PARENT_ANCHOR, '<artifactId>someone-else</artifactId>');
    const other = run(workspace({ sdk: '1.2.0', files: { 'sdks/java/a/pom.xml': stranger } }), [
      '--check',
    ]);
    assert.equal(other.status, 1);
    assert.match(
      other.stderr,
      /a\/pom\.xml: its <parent> must be com\.acme:acme-parent \(sdks\/java\/pom\.xml\), the pom that lists it; it is com\.acme:someone-else/,
    );
    const own = module('a').replace(
      '<artifactId>a</artifactId>',
      '<artifactId>a</artifactId>\n  <version>1.2.0</version>',
    );
    const versioned = run(workspace({ sdk: '1.2.0', files: { 'sdks/java/a/pom.xml': own } }), [
      '--check',
    ]);
    assert.equal(versioned.status, 1);
    assert.match(versioned.stderr, /a\/pom\.xml declares its own <project><version>: drop it/);
  });

  test('reads a module its parent lists twice (in <modules> and a profile) once', () => {
    const twice = ROOT.replace(
      '<module>compat/b</module>',
      '<module>compat/b</module>\n        <module>a</module>',
    );
    const root = workspace({ sdk: '1.3.0-rc.10', files: { 'sdks/java/pom.xml': twice } });
    // A longer version: offsets applied twice would corrupt the file.
    const result = run(root, []);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      read(root, 'sdks/java/a/pom.xml'),
      moved(module('a'), PARENT_ANCHOR, '1.3.0-rc.10'),
    );
    assert.equal(result.stdout.match(/a\/pom\.xml <parent><version>/g)?.length, 1);
  });

  test('refuses a module two poms list, and the root listed as a module', () => {
    const lister = module('a').replace(
      '<dependencies>',
      '<modules>\n    <module>../compat/b</module>\n  </modules>\n  <dependencies>',
    );
    const shared = run(workspace({ sdk: '1.2.0', files: { 'sdks/java/a/pom.xml': lister } }), [
      '--check',
    ]);
    assert.equal(shared.status, 1);
    assert.match(
      shared.stderr,
      /sdks\/java\/compat\/b\/pom\.xml is listed as a module by both sdks\/java\/pom\.xml and sdks\/java\/a\/pom\.xml/,
    );
    const loop = module('a').replace(
      '<dependencies>',
      '<modules>\n    <module>..</module>\n  </modules>\n  <dependencies>',
    );
    const cycle = run(workspace({ sdk: '1.2.0', files: { 'sdks/java/a/pom.xml': loop } }), [
      '--check',
    ]);
    assert.equal(cycle.status, 1);
    assert.match(cycle.stderr, /sdks\/java\/a\/pom\.xml lists sdks\/java\/pom\.xml, the root pom/);
  });

  test('a <module> may name a pom file', () => {
    const bom = ROOT.replace(
      '<module>a</module>',
      '<module>a</module>\n    <module>bom/pom-bom.xml</module>',
    );
    const root = workspace({
      sdk: '1.3.0',
      files: { 'sdks/java/pom.xml': bom, 'sdks/java/bom/pom-bom.xml': module('bom') },
    });
    assert.equal(run(root, []).status, 0);
    assert.equal(
      read(root, 'sdks/java/bom/pom-bom.xml'),
      moved(module('bom'), PARENT_ANCHOR, '1.3.0'),
    );
  });

  test('refuses a listed module that is missing', () => {
    const result = run(
      workspace({ sdk: '1.2.0', files: { 'sdks/java/compat/b/pom.xml': undefined } }),
      ['--check'],
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /sdks\/java\/compat\/b\/pom\.xml is missing, but sdks\/java\/pom\.xml lists it as a module/,
    );
  });

  test('refuses --check with --release, and an unknown argument', () => {
    const root = workspace({ sdk: '1.2.0' });
    assert.match(
      run(root, ['--check', '--release']).stderr,
      /--check only reads; --release writes/,
    );
    assert.match(run(root, ['--chek']).stderr, /unknown argument --chek; usage:/);
  });
});

describe('sync-jvm-version (writing)', () => {
  test("moves the root's own version and each module's parent version, and nothing else", () => {
    const root = workspace({ sdk: '1.3.0-rc.1' });
    const result = run(root, []);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sdks\/java\/pom\.xml <project><version> 1\.2\.0 → 1\.3\.0-rc\.1/);
    assert.equal(read(root, 'sdks/java/pom.xml'), moved(ROOT, ROOT_ANCHOR, '1.3.0-rc.1'));
    assert.equal(
      read(root, 'sdks/java/a/pom.xml'),
      moved(module('a'), PARENT_ANCHOR, '1.3.0-rc.1'),
    );
    assert.equal(
      read(root, 'sdks/java/compat/b/pom.xml'),
      moved(module('b'), PARENT_ANCHOR, '1.3.0-rc.1'),
    );
    // A plain run is a branch catching up: no release, so no stamp.
    assert.equal(read(root, 'sdks/java/CHANGELOG.md'), CHANGELOG);
    assert.equal(run(root, ['--check']).status, 0);
  });

  test("moves version.sbt's version line when it exists, keeps its other lines, and creates none", () => {
    const comment = '// The version follows the npm packages (scripts/sync-jvm-version.mjs).\n';
    const root = workspace({
      sdk: '1.3.0',
      files: { 'sdks/scala/version.sbt': `${comment}${sbtLine('1.2.0')}\n` },
    });
    assert.equal(run(root, []).status, 0);
    assert.equal(read(root, 'sdks/scala/version.sbt'), `${comment}${sbtLine('1.3.0')}\n`);
    const without = workspace({ sdk: '1.3.0' });
    assert.equal(run(without, []).status, 0);
    assert.throws(() => read(without, 'sdks/scala/version.sbt'), /ENOENT/);
  });

  test('--release stamps the changelog too, and a second run changes nothing', () => {
    const root = workspace({ sdk: '1.3.0-rc.0' });
    const first = run(root, ['--release']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /CHANGELOG\.md: "## Unreleased" → "## 1\.3\.0-rc\.0"/);
    const stamped = CHANGELOG.replace('## Unreleased\n', '## Unreleased\n\n## 1.3.0-rc.0\n');
    assert.equal(read(root, 'sdks/java/CHANGELOG.md'), stamped);
    const second = run(root, ['--release']);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, '');
    assert.equal(read(root, 'sdks/java/CHANGELOG.md'), stamped);
  });

  test('--release with no new entries stamps a section that says so', () => {
    const empty = '# Acme JVM SDKs\n\n## Unreleased\n\n## 1.2.0\n\n- the first release\n';
    const root = workspace({ sdk: '1.2.1', files: { 'sdks/java/CHANGELOG.md': empty } });
    assert.equal(run(root, ['--release']).status, 0);
    assert.equal(
      read(root, 'sdks/java/CHANGELOG.md'),
      `# Acme JVM SDKs\n\n## Unreleased\n\n## 1.2.1\n\n${NO_CHANGES}\n\n## 1.2.0\n\n- the first release\n`,
    );
  });

  test("--release with a changelog that can't be stamped writes nothing", () => {
    const root = workspace({ sdk: '1.3.0', files: { 'sdks/java/CHANGELOG.md': '# Acme\n' } });
    const result = run(root, ['--release']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs one "## Unreleased" heading/);
    assert.equal(read(root, 'sdks/java/pom.xml'), ROOT);
  });

  test('refuses an npm version Maven would order differently, before writing', () => {
    const root = workspace({ sdk: '1.3.0-next.1' });
    const result = run(root, []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /has no Maven spelling that orders the same way/);
    assert.equal(read(root, 'sdks/java/pom.xml'), ROOT);
  });
});
