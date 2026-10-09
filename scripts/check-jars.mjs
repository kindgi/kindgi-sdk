#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What the JVM SDKs put on Maven Central, checked before it goes: the npm
 * packages' `check:publish`, for jars. Its input is what the builds stage, a
 * Maven repository on disk: `sdks/java/target/central-staging`
 * (`./mvnw -P release deploy`) and `sdks/scala/target/sona-staging`
 * (`sbt +publish` or `+publishSigned`). Those exact files are what
 * `scripts/central-bundle.mjs` uploads.
 *
 * Per artifact (`ARTIFACTS` lists every one we publish; anything else is refused):
 *   - **Files:** the pom, and for a jar its `-sources.jar` and `-javadoc.jar`,
 *     none empty, nothing else; with `--signed`, an `.asc` beside each.
 *   - **Version:** `@kindgi/sdk`'s (packages/sdk/package.json), in the path
 *     and the pom.
 *   - **Pom:** the metadata Central requires (name, description, url,
 *     licenses, developers, scm; a module's may come from the staged parent);
 *     no `<repositories>`; its runtime dependencies exactly `ARTIFACTS`' list,
 *     each at a fixed version (no SNAPSHOT, no range), and no `system` scope.
 *   - **Jar:** classes only under `com/kindgi/` (the client's shaded Jackson
 *     under `com/kindgi/client/internal/shaded/`), no test code, every
 *     `META-INF/services` entry naming a class the jar has, Apache-2.0
 *     `META-INF/LICENSE` and a NOTICE naming Kindgi Inc. (the sources jar
 *     too), and no other project's `META-INF/maven` metadata but the shaded
 *     code's (kept, so scanners see the Jackson inside).
 *   - **Names:** no forbidden name (scripts/text-scan.mjs) in any text entry
 *     of the three jars, in a class's constant pool, or in a TASTy file.
 *
 * Usage:
 *   node scripts/check-jars.mjs [--signed] [--complete] <staging dir>…
 *     --signed    every file has its signature (the release job)
 *     --complete  every artifact in ARTIFACTS is there (the release job)
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { XmlError, childText, childrenNamed, xmlRoot } from './lib/pom-xml.mjs';
import { ZipError, readZip } from './lib/zip.mjs';
import { NAME_HIT, nameHits } from './text-scan.mjs';

const NAME = 'check-jars';
const GROUP = 'com.kindgi';
const GROUP_PATH = GROUP.replaceAll('.', '/');

const JACKSON2 = [
  'com.fasterxml.jackson.core:jackson-databind',
  'com.fasterxml.jackson.core:jackson-core',
  'com.fasterxml.jackson.core:jackson-annotations',
  'com.fasterxml.jackson.datatype:jackson-datatype-jsr310',
  'com.fasterxml.jackson.datatype:jackson-datatype-jdk8',
];

/**
 * Every artifact we publish: its packaging, its runtime dependencies (compile
 * or runtime scope) and its optional ones, exactly. A new module is published
 * only once it's listed here.
 */
export const ARTIFACTS = {
  'kindgi-java-parent': { packaging: 'pom', dependencies: [], optional: [] },
  'kindgi-models': {
    packaging: 'jar',
    dependencies: ['org.jspecify:jspecify'],
    optional: ['com.fasterxml.jackson.core:jackson-annotations'],
  },
  'kindgi-client': {
    packaging: 'jar',
    // Jackson 3 is shaded in, relocated.
    dependencies: ['com.kindgi:kindgi-models', 'org.jspecify:jspecify'],
    optional: [],
    shaded: {
      classes: 'com/kindgi/client/internal/shaded/',
      metadata: ['tools.jackson.core', 'com.fasterxml.jackson.core'],
    },
  },
  'kindgi-pack': {
    packaging: 'jar',
    // The app's own Jackson 2, unshaded.
    dependencies: [...JACKSON2, 'org.jspecify:jspecify'],
    optional: ['jakarta.validation:jakarta.validation-api'],
  },
  'kindgi-pack-scala_2.13': {
    packaging: 'jar',
    dependencies: [
      'org.scala-lang:scala-library',
      'com.kindgi:kindgi-pack',
      'com.fasterxml.jackson.module:jackson-module-scala_2.13',
    ],
    optional: [],
  },
  'kindgi-pack-scala_3': {
    packaging: 'jar',
    dependencies: [
      'org.scala-lang:scala3-library_3',
      'com.kindgi:kindgi-pack',
      'com.fasterxml.jackson.module:jackson-module-scala_3',
    ],
    optional: [],
  },
};

/** Central's required pom metadata: each must be there, in the pom or its parent. */
const REQUIRED_METADATA = ['name', 'description', 'url', 'licenses', 'developers', 'scm'];

/**
 * Test code, which a published jar never holds: the test packages kindgi-pack
 * and the Scala layer use, and anything that uses a test framework (a class
 * whose constant pool, or a source whose text, names JUnit, AssertJ or MUnit).
 * Names alone don't tell: `EvalSuite` is one of the API's models.
 */
const TEST_PACKAGE = /(?:^|\/)(?:testpacks|testmodule|testfixtures)\//;
const TEST_FRAMEWORK = /\b(?:org[/.]junit|org[/.]assertj|munit)[/.]/;

/** A file a staging directory may hold beside the artifacts: Maven's own bookkeeping. */
const BOOKKEEPING = /(?:^|\/)maven-metadata\.xml(?:\.(?:md5|sha1|sha256|sha512))?$/;
const CHECKSUM = /\.(?:md5|sha1|sha256|sha512)$/;

/** The version every artifact carries: `@kindgi/sdk`'s, as npm and Maven both spell it. */
export function lockstepVersion(root) {
  return JSON.parse(readFileSync(join(root, 'packages/sdk/package.json'), 'utf8')).version;
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/**
 * The artifacts of staging directories: `{ artifact, version, dir, files }`
 * per `<group>/<artifact>/<version>/`, and the problems with anything else there.
 */
export function stagedArtifacts(stagingDirs) {
  const problems = [];
  const found = new Map();
  for (const staging of stagingDirs) {
    for (const path of walk(staging)) {
      const rel = relative(staging, path).split(sep).join('/');
      if (BOOKKEEPING.test(rel)) continue;
      const parts = rel.split('/');
      const group = parts.slice(0, -3).join('/');
      if (group !== GROUP_PATH) {
        problems.push(`${rel}: not under ${GROUP_PATH}/<artifact>/<version>/`);
        continue;
      }
      const [artifact, version, file] = parts.slice(-3);
      const key = `${artifact}/${version}`;
      if (!found.has(key)) {
        found.set(key, {
          artifact,
          version,
          dir: join(staging, GROUP_PATH, artifact, version),
          files: [],
        });
      } else if (found.get(key).dir !== join(staging, GROUP_PATH, artifact, version)) {
        problems.push(`${artifact} ${version} is staged twice`);
        continue;
      }
      found.get(key).files.push(file);
    }
  }
  return { artifacts: [...found.values()], problems };
}

/** The files an artifact must have, by its packaging. */
export function expectedFiles(artifact, version, packaging) {
  const base = `${artifact}-${version}`;
  return packaging === 'pom'
    ? [`${base}.pom`]
    : [`${base}.pom`, `${base}.jar`, `${base}-sources.jar`, `${base}-javadoc.jar`];
}

function checkFiles(staged, spec, signed, problems) {
  const expected = expectedFiles(staged.artifact, staged.version, spec.packaging);
  const files = new Set(staged.files);
  for (const file of expected) {
    if (!files.has(file)) problems.push(`${staged.artifact}: no ${file}`);
    else if (statSync(join(staged.dir, file)).size === 0)
      problems.push(`${staged.artifact}: ${file} is empty`);
    if (signed && !files.has(`${file}.asc`))
      problems.push(`${staged.artifact}: ${file} isn't signed (no .asc)`);
  }
  const allowed = new Set(expected.flatMap((file) => [file, `${file}.asc`]));
  for (const file of staged.files) {
    const subject = file.replace(CHECKSUM, '');
    if (!allowed.has(subject))
      problems.push(`${staged.artifact}: ${file} isn't something we publish`);
  }
}

// ---- the pom ------------------------------------------------------------------

/** `${name}` references resolved against the pom's properties and its parent's. */
function resolver(pom, parent) {
  const properties = new Map();
  for (const source of [parent, pom]) {
    if (source === undefined) continue;
    for (const block of childrenNamed(source.root, 'properties')) {
      for (const property of block.children) properties.set(property.name, property.text.trim());
    }
  }
  properties.set('project.version', pom.version);
  return (value) =>
    value?.replace(/\$\{([^}]+)\}/g, (whole, name) => properties.get(name) ?? whole);
}

/** A staged pom, read: its root element, coordinates (inherited where absent) and parent. */
function readPom(staged, version) {
  const file = join(staged.dir, `${staged.artifact}-${version}.pom`);
  const root = xmlRoot(readFileSync(file, 'utf8'), relative(process.cwd(), file));
  const parentElement = childrenNamed(root, 'parent')[0];
  return {
    root,
    groupId: childText(root, 'groupId') ?? childText(parentElement, 'groupId'),
    artifactId: childText(root, 'artifactId'),
    version: childText(root, 'version') ?? childText(parentElement, 'version'),
    parent:
      parentElement === undefined
        ? undefined
        : {
            groupId: childText(parentElement, 'groupId'),
            artifactId: childText(parentElement, 'artifactId'),
          },
  };
}

const coordinates = (dependency) =>
  `${childText(dependency, 'groupId')}:${childText(dependency, 'artifactId')}`;

function checkCoordinates(where, staged, pom, parent, version, problems) {
  if (pom.groupId !== GROUP) problems.push(`${where}: groupId ${pom.groupId}, not ${GROUP}`);
  if (pom.artifactId !== staged.artifact) problems.push(`${where}: artifactId ${pom.artifactId}`);
  if (pom.version !== version) problems.push(`${where}: version ${pom.version}, not ${version}`);
  if (pom.parent !== undefined && (pom.parent.groupId !== GROUP || parent === undefined)) {
    problems.push(
      `${where}: its parent ${pom.parent.groupId}:${pom.parent.artifactId} isn't staged with it`,
    );
  }
}

/** Central's required metadata, the license, and no repositories: in the pom or its parent. */
function checkMetadata(where, pom, parent, problems) {
  const field = (name) => childrenNamed(pom.root, name)[0] ?? childrenNamed(parent?.root, name)[0];
  for (const name of REQUIRED_METADATA) {
    const element = field(name);
    if (element === undefined || (element.children.length === 0 && element.text.trim() === '')) {
      problems.push(`${where}: no <${name}> (Central requires it)`);
    }
  }
  const apache = (license) =>
    /^Apache-2\.0$|Apache License, Version 2\.0/.test(childText(license, 'name') ?? '');
  if (!childrenNamed(field('licenses'), 'license').some(apache)) {
    problems.push(`${where}: its license isn't Apache-2.0`);
  }
  for (const [source, label] of [
    [pom, 'the pom'],
    [parent, 'its parent'],
  ]) {
    for (const name of ['repositories', 'pluginRepositories']) {
      if (childrenNamed(source?.root, name).length > 0) {
        problems.push(`${where}: <${name}> in ${label}; a published pom names none`);
      }
    }
  }
}

/** The pom's runtime and optional dependencies, each checked for its scope and version. */
function dependenciesOf(where, pom, parent, problems) {
  const resolve = resolver(pom, parent);
  const runtime = [];
  const optional = [];
  for (const dependency of childrenNamed(
    childrenNamed(pom.root, 'dependencies')[0],
    'dependency',
  )) {
    const id = coordinates(dependency);
    const scope = childText(dependency, 'scope') ?? 'compile';
    if (scope === 'test') continue;
    if (scope === 'system') {
      problems.push(`${where}: ${id} has system scope`);
      continue;
    }
    const version = resolve(childText(dependency, 'version'));
    if (version === undefined || version === '') {
      problems.push(`${where}: ${id} has no version`);
    } else if (/\$\{|SNAPSHOT|^[[(]|[\])]$|,/.test(version)) {
      problems.push(`${where}: ${id} isn't at a fixed version (${version})`);
    }
    const isOptional = childText(dependency, 'optional') === 'true' || scope === 'provided';
    (isOptional ? optional : runtime).push(id);
  }
  return { runtime, optional };
}

function checkPom(staged, spec, pom, parent, version, problems) {
  const where = `${staged.artifact}'s pom`;
  checkCoordinates(where, staged, pom, parent, version, problems);
  checkMetadata(where, pom, parent, problems);
  const { runtime, optional } = dependenciesOf(where, pom, parent, problems);
  for (const [kind, actual, wanted] of [
    ['runtime dependencies', runtime, spec.dependencies],
    ['optional dependencies', optional, spec.optional],
  ]) {
    const extra = actual.filter((id) => !wanted.includes(id));
    const missing = wanted.filter((id) => !actual.includes(id));
    if (extra.length > 0) problems.push(`${where}: ${kind} not on its list: ${extra.join(', ')}`);
    if (missing.length > 0) problems.push(`${where}: ${kind} missing: ${missing.join(', ')}`);
  }
}

// ---- the jars -----------------------------------------------------------------

/** A class file's constant pool strings (CONSTANT_Utf8), as text. */
export function classStrings(bytes, name) {
  if (bytes.length < 10 || bytes.readUInt32BE(0) !== 0xcafebabe) {
    throw new Error(`${name} isn't a class file`);
  }
  const strings = [];
  const count = bytes.readUInt16BE(8);
  let at = 10;
  for (let i = 1; i < count; i++) {
    const tag = bytes[at];
    at += 1;
    switch (tag) {
      case 1: {
        const length = bytes.readUInt16BE(at);
        strings.push(bytes.toString('utf8', at + 2, at + 2 + length));
        at += 2 + length;
        break;
      }
      case 3: // Integer
      case 4: // Float
      case 9: // Fieldref
      case 10: // Methodref
      case 11: // InterfaceMethodref
      case 12: // NameAndType
      case 17: // Dynamic
      case 18: // InvokeDynamic
        at += 4;
        break;
      case 5: // Long
      case 6: // Double: two slots
        at += 8;
        i++;
        break;
      case 7: // Class
      case 8: // String
      case 16: // MethodType
      case 19: // Module
      case 20: // Package
        at += 2;
        break;
      case 15: // MethodHandle
        at += 3;
        break;
      default:
        throw new Error(`${name}: constant ${i} has an unknown tag ${tag}`);
    }
  }
  return strings;
}

/** Text, unless the bytes hold a NUL in their first 8 KiB. */
const isText = (bytes) => !bytes.subarray(0, 8192).includes(0);

/** The strings a jar entry holds, for the name scan. */
function entryStrings(name, bytes) {
  if (name.endsWith('.class')) return classStrings(bytes, name);
  if (name.endsWith('.tasty')) return [bytes.toString('latin1')];
  return isText(bytes) ? bytes.toString('utf8').split('\n') : [];
}

function checkNames(jarName, entries, names, problems) {
  const hits = new Set();
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    const seen = new Set();
    for (const text of entryStrings(entry.name, entry.data())) {
      if (seen.has(text)) continue;
      seen.add(text);
      if (nameHits(text, names) > 0) {
        hits.add(entry.name);
        break;
      }
    }
  }
  for (const name of hits) problems.push(`${jarName}: ${name}: ${NAME_HIT}`);
}

function checkLicense(jarName, byName, problems) {
  const license = byName.get('META-INF/LICENSE')?.data().toString('utf8');
  if (license === undefined) problems.push(`${jarName}: no META-INF/LICENSE`);
  else if (!/Apache License\s+Version 2\.0/.test(license)) {
    problems.push(`${jarName}: META-INF/LICENSE isn't the Apache License 2.0`);
  }
  const notice = byName.get('META-INF/NOTICE')?.data().toString('utf8');
  if (notice === undefined) problems.push(`${jarName}: no META-INF/NOTICE`);
  else if (!notice.includes('Kindgi Inc.'))
    problems.push(`${jarName}: META-INF/NOTICE doesn't name Kindgi Inc.`);
}

function checkClasses(staged, spec, jarName, entries, byName, problems) {
  const classes = entries
    .filter((entry) => entry.name.endsWith('.class'))
    .map((entry) => entry.name);
  if (classes.length === 0) problems.push(`${jarName}: no classes`);
  const isTestCode = (name) =>
    TEST_PACKAGE.test(name) ||
    classStrings(byName.get(name).data(), name).some((text) => TEST_FRAMEWORK.test(text));
  for (const name of classes) {
    if (!name.startsWith(`${GROUP_PATH}/`)) {
      problems.push(`${jarName}: ${name} is outside ${GROUP_PATH}/`);
    } else if (isTestCode(name)) {
      problems.push(`${jarName}: ${name} is test code`);
    }
  }
  const shadedLike = classes.find((name) => name.includes('/shaded/'));
  if (spec.shaded === undefined && shadedLike !== undefined) {
    problems.push(`${jarName}: ${shadedLike} looks shaded, and ${staged.artifact} shades nothing`);
  }
}

/** Each `META-INF/services` entry names classes the jar holds. */
function checkServices(jarName, entries, byName, problems) {
  for (const entry of entries) {
    const service = entry.name.match(/^META-INF\/services\/([^/]+)$/)?.[1];
    if (service === undefined) continue;
    const implementations = entry
      .data()
      .toString('utf8')
      .split('\n')
      .map((line) => line.replace(/#.*/, '').trim())
      .filter(Boolean);
    for (const implementation of implementations) {
      if (!byName.has(`${implementation.replaceAll('.', '/')}.class`)) {
        problems.push(
          `${jarName}: META-INF/services/${service} names ${implementation}, which it doesn't hold`,
        );
      }
    }
  }
}

/** `META-INF/maven` holds the artifact's own metadata, and the shaded code's. */
function checkMavenMetadata(staged, spec, jarName, entries, problems) {
  for (const entry of entries) {
    const metadata = entry.name.match(/^META-INF\/maven\/([^/]+)\/([^/]+)\//);
    if (metadata === null) continue;
    const own = metadata[1] === GROUP && metadata[2] === staged.artifact;
    if (!own && !(spec.shaded?.metadata ?? []).includes(metadata[1])) {
      problems.push(`${jarName}: ${entry.name} is another project's metadata`);
    }
  }
}

function checkMainJar(staged, spec, jarName, entries, problems) {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  checkClasses(staged, spec, jarName, entries, byName, problems);
  checkServices(jarName, entries, byName, problems);
  checkMavenMetadata(staged, spec, jarName, entries, problems);
  checkLicense(jarName, byName, problems);
}

function checkSourcesJar(jarName, entries, problems) {
  const sources = entries.filter((entry) => /\.(?:java|scala)$/.test(entry.name));
  if (sources.length === 0) problems.push(`${jarName}: no sources`);
  for (const { name, data } of sources) {
    if (!name.startsWith(`${GROUP_PATH}/`)) {
      problems.push(`${jarName}: ${name} is outside ${GROUP_PATH}/`);
    } else if (TEST_PACKAGE.test(name) || TEST_FRAMEWORK.test(data().toString('utf8'))) {
      problems.push(`${jarName}: ${name} is test code`);
    }
  }
  checkLicense(jarName, new Map(entries.map((entry) => [entry.name, entry])), problems);
}

function checkJavadocJar(jarName, entries, problems) {
  if (!entries.some((entry) => entry.name === 'index.html'))
    problems.push(`${jarName}: no index.html`);
}

function checkJars(staged, spec, version, names, problems) {
  const base = `${staged.artifact}-${version}`;
  const kinds = [
    [`${base}.jar`, (name, entries) => checkMainJar(staged, spec, name, entries, problems)],
    [`${base}-sources.jar`, (name, entries) => checkSourcesJar(name, entries, problems)],
    [`${base}-javadoc.jar`, (name, entries) => checkJavadocJar(name, entries, problems)],
  ];
  for (const [jarName, check] of kinds) {
    if (!staged.files.includes(jarName)) continue;
    let entries;
    try {
      entries = readZip(readFileSync(join(staged.dir, jarName)), jarName);
    } catch (err) {
      if (!(err instanceof ZipError)) throw err;
      problems.push(err.message);
      continue;
    }
    check(jarName, entries);
    checkNames(jarName, entries, names, problems);
  }
}

// ---- all together -----------------------------------------------------------------

/**
 * The problems with staged artifacts, one line each; none when they may go to Central.
 *
 * @param {string[]} stagingDirs Maven repositories on disk
 * @param {{ version: string, signed?: boolean, complete?: boolean, names?: object }} options
 *   `names`: the forbidden names (text-scan.mjs's `loadNames`), the repository's by default
 */
export function checkStaged(stagingDirs, { version, signed = false, complete = false, names }) {
  const { artifacts, problems } = stagedArtifacts(stagingDirs);
  if (artifacts.length === 0) problems.push(`nothing staged in ${stagingDirs.join(', ')}`);
  const ours = artifacts.filter((staged) => isOurs(staged, version, problems));
  const poms = new Map();
  for (const staged of ours) {
    checkFiles(staged, ARTIFACTS[staged.artifact], signed, problems);
    const pom = readStagedPom(staged, version, problems);
    if (pom !== undefined) poms.set(staged.artifact, pom);
  }
  for (const staged of ours) {
    const spec = ARTIFACTS[staged.artifact];
    const pom = poms.get(staged.artifact);
    if (pom !== undefined) {
      const parent = pom.parent === undefined ? undefined : poms.get(pom.parent.artifactId);
      checkPom(staged, spec, pom, parent, version, problems);
    }
    if (spec.packaging === 'jar') checkJars(staged, spec, version, names, problems);
  }
  if (complete) problems.push(...unstaged(artifacts));
  return { artifacts, problems };
}

/** The artifacts a release publishes that aren't staged. */
function unstaged(artifacts) {
  const staged = new Set(artifacts.map((artifact) => artifact.artifact));
  return Object.keys(ARTIFACTS)
    .filter((artifact) => !staged.has(artifact))
    .map((artifact) => `${artifact}: not staged (a release publishes every one)`);
}

/** An artifact we publish, at the release's version; a problem otherwise. */
function isOurs(staged, version, problems) {
  if (ARTIFACTS[staged.artifact] === undefined) {
    problems.push(
      `${staged.artifact}: not an artifact we publish (scripts/check-jars.mjs, ARTIFACTS)`,
    );
    return false;
  }
  if (staged.version !== version) {
    problems.push(
      `${staged.artifact}: staged at ${staged.version}, not ${version} (@kindgi/sdk's)`,
    );
    return false;
  }
  return true;
}

function readStagedPom(staged, version, problems) {
  if (!staged.files.includes(`${staged.artifact}-${version}.pom`)) return undefined;
  try {
    return readPom(staged, version);
  } catch (err) {
    if (!(err instanceof XmlError)) throw err;
    problems.push(err.message);
    return undefined;
  }
}

function main(args) {
  const flags = new Set(args.filter((arg) => arg.startsWith('--')));
  const dirs = args.filter((arg) => !arg.startsWith('--'));
  const unknown = [...flags].filter((flag) => flag !== '--signed' && flag !== '--complete');
  if (unknown.length > 0 || dirs.length === 0) {
    console.error(
      `${NAME}: usage: node scripts/check-jars.mjs [--signed] [--complete] <staging dir>…`,
    );
    process.exit(2);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const version = lockstepVersion(root);
  const { artifacts, problems } = checkStaged(dirs, {
    version,
    signed: flags.has('--signed'),
    complete: flags.has('--complete'),
  });
  if (problems.length > 0) {
    console.error(`${NAME}: ${problems.length} problem(s) in what would go to Maven Central:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `${NAME}: ${artifacts.length} artifact(s) at ${version} may go to Maven Central: ${artifacts.map((a) => a.artifact).join(', ')}`,
  );
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
