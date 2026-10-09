// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * check-jars: a staged release that may go to Maven Central passes, and each
 * thing that must not go there is named (staging directories built here).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';

import { checkStaged, classStrings } from './check-jars.mjs';
import { writeZip } from './lib/zip.mjs';
import { NAME_HIT, loadNames } from './text-scan.mjs';

const VERSION = '1.2.3';
const SALT = 'check-jars-test';
const hash = (text) => createHash('sha256').update(`${SALT}:${text}`).digest('hex');
const names = loadNames({ v: 1, salt: SALT, maxPhrase: 2, tokens: [hash('zorblax')], allowed: [] });

const LICENSE = 'Apache License\n                           Version 2.0, January 2004\n';
const NOTICE = 'Kindgi SDK\nCopyright (C) 2026 Kindgi Inc.\n';

const work = mkdtempSync(join(tmpdir(), 'check-jars-'));
after(() => rmSync(work, { recursive: true, force: true }));

/** A class file whose constant pool holds `strings` (nothing past the pool is read). */
function classFile(...strings) {
  const parts = [Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 61])];
  const count = Buffer.alloc(2);
  count.writeUInt16BE(strings.length + 2);
  parts.push(count);
  for (const text of strings) {
    const bytes = Buffer.from(text);
    const header = Buffer.from([1, 0, 0]);
    header.writeUInt16BE(bytes.length, 1);
    parts.push(header, bytes);
  }
  parts.push(Buffer.from([5, 0, 0, 0, 0, 0, 0, 0, 1])); // a Long: two slots
  parts.push(Buffer.alloc(8));
  return Buffer.concat(parts);
}

const METADATA = `
  <name>x</name><description>x</description><url>https://example.com</url>
  <licenses><license><name>Apache-2.0</name></license></licenses>
  <developers><developer><name>Kindgi Inc.</name></developer></developers>
  <scm><url>https://example.com</url></scm>`;

const SCALA3_DEPENDENCIES = [
  ['org.scala-lang', 'scala3-library_3', '3.3.8'],
  ['com.kindgi', 'kindgi-pack', VERSION],
  ['com.fasterxml.jackson.module', 'jackson-module-scala_3', '2.15.4'],
];

function pom({
  artifact,
  version = VERSION,
  dependencies = [],
  metadata = METADATA,
  extra = '',
  parent,
}) {
  const deps = dependencies
    .map(
      ([g, a, v, more = '']) =>
        `<dependency><groupId>${g}</groupId><artifactId>${a}</artifactId>${v === undefined ? '' : `<version>${v}</version>`}${more}</dependency>`,
    )
    .join('');
  const own =
    parent === undefined ? `<groupId>com.kindgi</groupId><version>${version}</version>` : '';
  const parentElement =
    parent === undefined
      ? ''
      : `<parent><groupId>com.kindgi</groupId><artifactId>${parent}</artifactId><version>${version}</version></parent>`;
  return `<?xml version="1.0"?>\n<project>${parentElement}${own}<artifactId>${artifact}</artifactId>${metadata}${extra}<dependencies>${deps}<dependency><groupId>org.scalameta</groupId><artifactId>munit_3</artifactId><scope>test</scope></dependency></dependencies></project>\n`;
}

/** A jar of `entries`; an `undefined` one is left out. */
function jar(entries) {
  return writeZip(
    Object.entries(entries)
      .filter(([, data]) => data !== undefined)
      .map(([name, data]) => ({ name, data: Buffer.from(data) })),
  );
}

const MAIN = {
  'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\n',
  'META-INF/LICENSE': LICENSE,
  'META-INF/NOTICE': NOTICE,
  'META-INF/services/com.kindgi.pack.spi.SchemaTypeAdapter':
    '# the adapter\ncom.kindgi.pack.scaladsl.ScalaTypeAdapter\n',
  'com/kindgi/pack/scaladsl/ScalaTypeAdapter.class': classFile(
    'com/kindgi/pack/scaladsl/ScalaTypeAdapter',
    'schema',
  ),
  'com/kindgi/pack/scaladsl/Tool.tasty': Buffer.from([
    0x5c,
    0xa1,
    0xab,
    0x1f,
    0x84,
    ...Buffer.from('Tool'),
  ]),
};
const SOURCES = {
  'META-INF/LICENSE': LICENSE,
  'META-INF/NOTICE': NOTICE,
  'com/kindgi/pack/scaladsl/Tool.scala': 'package com.kindgi.pack.scaladsl\n',
};
const JAVADOC = { 'index.html': '<html></html>' };

let count = 0;
/** A staging directory with one artifact, kindgi-pack-scala_3 unless `artifact` says otherwise. */
function stage({ artifact = 'kindgi-pack-scala_3', version = VERSION, files } = {}) {
  const dir = join(work, `staging-${count++}`);
  const base = `${artifact}-${version}`;
  const all = files ?? {
    [`${base}.pom`]: pom({ artifact, version, dependencies: SCALA3_DEPENDENCIES }),
    [`${base}.jar`]: jar(MAIN),
    [`${base}-sources.jar`]: jar(SOURCES),
    [`${base}-javadoc.jar`]: jar(JAVADOC),
  };
  for (const [file, data] of Object.entries(all)) {
    if (data === undefined) continue;
    const path = join(dir, 'com/kindgi', artifact, version, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }
  return dir;
}

/** The default staging, with some files changed (`undefined` drops one). */
function stageWith(changes, artifact = 'kindgi-pack-scala_3') {
  const base = `${artifact}-${VERSION}`;
  return stage({
    artifact,
    files: {
      [`${base}.pom`]: pom({ artifact, dependencies: SCALA3_DEPENDENCIES }),
      [`${base}.jar`]: jar(MAIN),
      [`${base}-sources.jar`]: jar(SOURCES),
      [`${base}-javadoc.jar`]: jar(JAVADOC),
      ...changes,
    },
  });
}

const problemsOf = (dirs, options = {}) =>
  checkStaged(dirs, { version: VERSION, names, ...options }).problems;
const BASE = `kindgi-pack-scala_3-${VERSION}`;

describe('check-jars', () => {
  test('an artifact that may go to Central passes', () => {
    assert.deepEqual(problemsOf([stage()]), []);
  });

  test("a class's constant pool is read past every kind of constant", () => {
    assert.deepEqual(classStrings(classFile('a', 'b'), 'A.class'), ['a', 'b']);
  });

  describe('files', () => {
    test('each jar is there and not empty', () => {
      assert.deepEqual(
        problemsOf([
          stageWith({ [`${BASE}-sources.jar`]: undefined, [`${BASE}-javadoc.jar`]: '' }),
        ]),
        [
          `kindgi-pack-scala_3: no ${BASE}-sources.jar`,
          `kindgi-pack-scala_3: ${BASE}-javadoc.jar is empty`,
          `kindgi-pack-scala_3-${VERSION}-javadoc.jar: not a zip archive`,
        ],
      );
    });

    test('nothing else is published, and a release has every signature', () => {
      const dir = stageWith({ [`${BASE}-tests.jar`]: jar(JAVADOC), [`${BASE}.pom.asc`]: 'sig' });
      const problems = problemsOf([dir], { signed: true });
      assert.ok(
        problems.includes(`kindgi-pack-scala_3: ${BASE}-tests.jar isn't something we publish`),
      );
      assert.ok(problems.includes(`kindgi-pack-scala_3: ${BASE}.jar isn't signed (no .asc)`));
      assert.ok(!problems.some((p) => p.includes(`${BASE}.pom isn't signed`)));
    });

    test('an artifact we never publish is refused', () => {
      const dir = stage({ artifact: 'kindgi-internal-tools' });
      assert.deepEqual(problemsOf([dir]), [
        'kindgi-internal-tools: not an artifact we publish (scripts/check-jars.mjs, ARTIFACTS)',
      ]);
    });

    test("a version other than @kindgi/sdk's is refused", () => {
      assert.deepEqual(problemsOf([stage({ version: '1.2.4' })]), [
        `kindgi-pack-scala_3: staged at 1.2.4, not ${VERSION} (@kindgi/sdk's)`,
      ]);
    });

    test('a release stages every artifact', () => {
      const problems = problemsOf([stage()], { complete: true });
      assert.ok(problems.includes('kindgi-pack: not staged (a release publishes every one)'));
      assert.ok(!problems.some((p) => p.startsWith('kindgi-pack-scala_3:')));
    });
  });

  describe('the pom', () => {
    test("Central's metadata is required", () => {
      const problems = problemsOf([
        stageWith({
          [`${BASE}.pom`]: pom({
            artifact: 'kindgi-pack-scala_3',
            dependencies: SCALA3_DEPENDENCIES,
            metadata: METADATA.replace(/<scm>.*<\/scm>/, ''),
          }),
        }),
      ]);
      assert.deepEqual(problems, ["kindgi-pack-scala_3's pom: no <scm> (Central requires it)"]);
    });

    test("a module's metadata may come from its staged parent", () => {
      const version = VERSION;
      const parentDir = stage({
        artifact: 'kindgi-java-parent',
        files: {
          [`kindgi-java-parent-${version}.pom`]: pom({
            artifact: 'kindgi-java-parent',
            dependencies: [],
            extra: '<properties><jspecify.version>1.0.1</jspecify.version></properties>',
          }),
        },
      });
      const modelsDir = stage({
        artifact: 'kindgi-models',
        files: {
          [`kindgi-models-${version}.pom`]: pom({
            artifact: 'kindgi-models',
            parent: 'kindgi-java-parent',
            metadata: '<name>x</name><description>x</description>',
            dependencies: [
              ['org.jspecify', 'jspecify', '${jspecify.version}'],
              [
                'com.fasterxml.jackson.core',
                'jackson-annotations',
                '2.15.4',
                '<optional>true</optional>',
              ],
            ],
          }),
          [`kindgi-models-${version}.jar`]: jar({
            ...MAIN,
            'META-INF/services/com.kindgi.pack.spi.SchemaTypeAdapter': undefined,
          }),
          [`kindgi-models-${version}-sources.jar`]: jar(SOURCES),
          [`kindgi-models-${version}-javadoc.jar`]: jar(JAVADOC),
        },
      });
      assert.deepEqual(problemsOf([parentDir, modelsDir]), []);
      assert.deepEqual(problemsOf([modelsDir]), [
        "kindgi-models's pom: its parent com.kindgi:kindgi-java-parent isn't staged with it",
        "kindgi-models's pom: no <url> (Central requires it)",
        "kindgi-models's pom: no <licenses> (Central requires it)",
        "kindgi-models's pom: no <developers> (Central requires it)",
        "kindgi-models's pom: no <scm> (Central requires it)",
        "kindgi-models's pom: its license isn't Apache-2.0",
        "kindgi-models's pom: org.jspecify:jspecify isn't at a fixed version (${jspecify.version})",
      ]);
    });

    test('the runtime dependencies are exactly the listed ones, at fixed versions', () => {
      const dependencies = [
        ['org.scala-lang', 'scala3-library_3', '3.3.8'],
        ['com.kindgi', 'kindgi-pack', '1.2.3-SNAPSHOT'],
        ['com.example', 'extra', '[1.0,2.0)'],
        ['com.example', 'local', '1', '<scope>system</scope>'],
      ];
      const problems = problemsOf([
        stageWith({
          [`${BASE}.pom`]: pom({
            artifact: 'kindgi-pack-scala_3',
            dependencies,
            extra: '<repositories><repository><id>x</id></repository></repositories>',
          }),
        }),
      ]);
      assert.deepEqual(problems, [
        "kindgi-pack-scala_3's pom: <repositories> in the pom; a published pom names none",
        "kindgi-pack-scala_3's pom: com.kindgi:kindgi-pack isn't at a fixed version (1.2.3-SNAPSHOT)",
        "kindgi-pack-scala_3's pom: com.example:extra isn't at a fixed version ([1.0,2.0))",
        "kindgi-pack-scala_3's pom: com.example:local has system scope",
        "kindgi-pack-scala_3's pom: runtime dependencies not on its list: com.example:extra",
        "kindgi-pack-scala_3's pom: runtime dependencies missing: com.fasterxml.jackson.module:jackson-module-scala_3",
      ]);
    });
  });

  describe('the jars', () => {
    test('classes only under com/kindgi, and no test code', () => {
      const main = jar({
        ...MAIN,
        'org/example/Leak.class': classFile('org/example/Leak'),
        'com/kindgi/pack/scaladsl/ToolSpec.class': classFile(
          'com/kindgi/pack/scaladsl/ToolSpec',
          'munit/FunSuite',
        ),
        'com/kindgi/pack/testpacks/Echo.class': classFile('com/kindgi/pack/testpacks/Echo'),
        // A name alone doesn't make a test: one of the API's models is EvalSuite.
        'com/kindgi/pack/scaladsl/EvalSuite.class': classFile('com/kindgi/pack/scaladsl/EvalSuite'),
      });
      const sources = jar({
        ...SOURCES,
        'com/kindgi/pack/scaladsl/ToolSpec.scala': 'import org.junit.jupiter.api.Test\n',
      });
      assert.deepEqual(
        problemsOf([stageWith({ [`${BASE}.jar`]: main, [`${BASE}-sources.jar`]: sources })]),
        [
          `${BASE}.jar: org/example/Leak.class is outside com/kindgi/`,
          `${BASE}.jar: com/kindgi/pack/scaladsl/ToolSpec.class is test code`,
          `${BASE}.jar: com/kindgi/pack/testpacks/Echo.class is test code`,
          `${BASE}-sources.jar: com/kindgi/pack/scaladsl/ToolSpec.scala is test code`,
        ],
      );
    });

    test('a service names a class the jar holds', () => {
      const main = jar({
        ...MAIN,
        'META-INF/services/com.fasterxml.jackson.databind.Module':
          'com.kindgi.pack.scaladsl.Gone\n',
      });
      assert.deepEqual(problemsOf([stageWith({ [`${BASE}.jar`]: main })]), [
        `${BASE}.jar: META-INF/services/com.fasterxml.jackson.databind.Module names com.kindgi.pack.scaladsl.Gone, which it doesn't hold`,
      ]);
    });

    test('LICENSE and NOTICE, in the jar and the sources jar', () => {
      const main = jar({
        ...MAIN,
        'META-INF/LICENSE': 'MIT License\n',
        'META-INF/NOTICE': undefined,
      });
      const sources = jar({ ...SOURCES, 'META-INF/LICENSE': undefined });
      assert.deepEqual(
        problemsOf([stageWith({ [`${BASE}.jar`]: main, [`${BASE}-sources.jar`]: sources })]),
        [
          `${BASE}.jar: META-INF/LICENSE isn't the Apache License 2.0`,
          `${BASE}.jar: no META-INF/NOTICE`,
          `${BASE}-sources.jar: no META-INF/LICENSE`,
        ],
      );
    });

    test("only the shaded code's metadata, and only where something is shaded", () => {
      const main = jar({
        ...MAIN,
        'META-INF/maven/com.kindgi/kindgi-pack-scala_3/pom.xml': '<project/>',
        'META-INF/maven/com.example/other/pom.xml': '<project/>',
        'com/kindgi/pack/shaded/Thing.class': classFile('com/kindgi/pack/shaded/Thing'),
      });
      assert.deepEqual(problemsOf([stageWith({ [`${BASE}.jar`]: main })]), [
        `${BASE}.jar: com/kindgi/pack/shaded/Thing.class looks shaded, and kindgi-pack-scala_3 shades nothing`,
        `${BASE}.jar: META-INF/maven/com.example/other/pom.xml is another project's metadata`,
      ]);
    });

    test('a forbidden name is found in a class, a TASTy file, a source or the javadoc, never repeated', () => {
      const main = jar({
        ...MAIN,
        'com/kindgi/pack/scaladsl/Leak.class': classFile(
          'com/kindgi/pack/scaladsl/Leak',
          'built for Zorblax',
        ),
        'com/kindgi/pack/scaladsl/Leak.tasty': Buffer.concat([
          Buffer.from([0x5c, 0xa1, 0x87]),
          Buffer.from('zorblax'),
        ]),
      });
      const sources = jar({
        ...SOURCES,
        'com/kindgi/pack/scaladsl/Tool.scala': '// for zorblax\npackage x\n',
      });
      const javadoc = jar({ 'index.html': '<p>zorblax</p>' });
      const problems = problemsOf([
        stageWith({
          [`${BASE}.jar`]: main,
          [`${BASE}-sources.jar`]: sources,
          [`${BASE}-javadoc.jar`]: javadoc,
        }),
      ]);
      assert.deepEqual(problems, [
        `${BASE}.jar: com/kindgi/pack/scaladsl/Leak.class: ${NAME_HIT}`,
        `${BASE}.jar: com/kindgi/pack/scaladsl/Leak.tasty: ${NAME_HIT}`,
        `${BASE}-sources.jar: com/kindgi/pack/scaladsl/Tool.scala: ${NAME_HIT}`,
        `${BASE}-javadoc.jar: index.html: ${NAME_HIT}`,
      ]);
      assert.ok(!problems.join('\n').toLowerCase().includes('zorblax'));
    });
  });
});
