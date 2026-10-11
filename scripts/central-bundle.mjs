#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The JVM SDKs' release to Maven Central, through the Central Portal's
 * Publisher API: every artifact the builds staged (scripts/check-jars.mjs
 * checked those same files), in one bundle, uploaded as one deployment, so a
 * version's Java and Scala artifacts publish together or not at all.
 *
 *   bundle    Writes the bundle: each artifact file with its `.asc` and its
 *             `.md5` and `.sha1` (written here, and compared with the build's
 *             where it wrote them). Every signature is verified with gpg, and
 *             must be the release key's (`--fingerprint`, the key's public
 *             fingerprint). `--unsigned` leaves signatures out, for a check.
 *   validate  Uploads the bundle for the Portal to validate, never to
 *             publish, waits until it's validated (or failed, with the
 *             Portal's errors), then drops the deployment: the dry run.
 *   publish   Uploads the bundle to publish, and waits until it's published.
 *             A version Central already has is skipped (versions are
 *             permanent), and a version it has part of is refused.
 *   on-central  Waits until every JVM artifact at a version resolves from
 *             Central. The npm job runs it before it publishes: a CLI
 *             scaffolds Java and Scala packs on kindgi-pack at its own
 *             version, so npm never gets a CLI whose kindgi-pack isn't there.
 *
 * The Portal user token comes from MAVEN_CENTRAL_USERNAME and
 * MAVEN_CENTRAL_PASSWORD, by name, and is never printed.
 *
 * Usage:
 *   node scripts/central-bundle.mjs bundle --out <zip> (--fingerprint <fpr> | --unsigned) <staging dir>…
 *   node scripts/central-bundle.mjs validate --bundle <zip> [--wait-minutes <n>]
 *   node scripts/central-bundle.mjs publish --bundle <zip> [--wait-minutes <n>]
 *   node scripts/central-bundle.mjs on-central --version <v> [--wait-minutes <n>]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ARTIFACTS, expectedFiles, lockstepVersion, stagedArtifacts } from './check-jars.mjs';
import { readZip, writeZip } from './lib/zip.mjs';

const NAME = 'central-bundle';
const PORTAL = process.env.KINDGI_CENTRAL_PORTAL_URL ?? 'https://central.sonatype.com';
const REPOSITORY = process.env.KINDGI_CENTRAL_REPOSITORY_URL ?? 'https://repo1.maven.org/maven2';
/** Seconds between status polls. The URLs and this are overridden only by its tests. */
const POLL_SECONDS = Number(process.env.KINDGI_CENTRAL_POLL_SECONDS ?? 10);
const GROUP_PATH = 'com/kindgi';
const CHECKSUMS = { md5: 'md5', sha1: 'sha1' };

class BundleError extends Error {}

const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');

/**
 * Does `signature` verify `file`, made by the key with `fingerprint` (its
 * primary key's or the signing subkey's)? gpg's machine-readable status says.
 */
export function verifySignature(file, signature, fingerprint) {
  const result = spawnSync('gpg', ['--batch', '--status-fd', '1', '--verify', signature, file], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return false;
  const valid = result.stdout.match(/^\[GNUPG:\] VALIDSIG (.*)$/m)?.[1].split(' ') ?? [];
  const wanted = fingerprint.replace(/\s+/g, '').toUpperCase();
  return valid.length > 0 && (valid[0] === wanted || valid.at(-1) === wanted);
}

/**
 * The bundle's entries, from staging directories: `{ name, data }[]`, sorted.
 *
 * @param {string[]} stagingDirs
 * @param {{ signed: boolean, version: string, fingerprint?: string }} options
 *   `fingerprint`: the release key's, which every signature must verify with
 */
export function bundleEntries(stagingDirs, { signed, version, fingerprint }) {
  if (signed && !/^[0-9A-F]{40}$/i.test(fingerprint?.replace(/\s+/g, '') ?? '')) {
    throw new BundleError("a signed bundle needs the release key's fingerprint (40 hex digits)");
  }
  const { artifacts, problems } = stagedArtifacts(stagingDirs);
  if (problems.length > 0) throw new BundleError(problems.join('\n'));
  if (artifacts.length === 0) throw new BundleError(`nothing staged in ${stagingDirs.join(', ')}`);
  const entries = [];
  for (const staged of artifacts) {
    const spec = ARTIFACTS[staged.artifact];
    if (spec === undefined || staged.version !== version) {
      throw new BundleError(
        `${staged.artifact} ${staged.version}: run scripts/check-jars.mjs first`,
      );
    }
    for (const file of expectedFiles(staged.artifact, version, spec.packaging)) {
      entries.push(...fileEntries(staged, file, signed ? fingerprint : undefined));
    }
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * One artifact file's entries: the file, its checksums, and its signature when
 * `fingerprint` names the key that must have made it.
 */
function fileEntries(staged, file, fingerprint) {
  const prefix = `${GROUP_PATH}/${staged.artifact}/${staged.version}`;
  const path = join(staged.dir, file);
  if (!existsSync(path)) throw new BundleError(`${staged.artifact}: no ${file}`);
  const data = readFileSync(path);
  const entries = [{ name: `${prefix}/${file}`, data }];
  for (const [extension, algorithm] of Object.entries(CHECKSUMS)) {
    const sum = digest(algorithm, data);
    const built = join(staged.dir, `${file}.${extension}`);
    if (existsSync(built) && readFileSync(built, 'utf8').trim().split(/\s+/)[0] !== sum) {
      throw new BundleError(`${staged.artifact}: ${file}.${extension} doesn't match ${file}`);
    }
    entries.push({ name: `${prefix}/${file}.${extension}`, data: Buffer.from(sum) });
  }
  if (fingerprint !== undefined) {
    const signature = `${path}.asc`;
    if (!existsSync(signature)) throw new BundleError(`${staged.artifact}: ${file} isn't signed`);
    if (!verifySignature(path, signature, fingerprint)) {
      throw new BundleError(
        `${staged.artifact}: ${file}.asc isn't a valid signature by ${fingerprint}`,
      );
    }
    entries.push({ name: `${prefix}/${file}.asc`, data: readFileSync(signature) });
  }
  return entries;
}

/** The artifacts a bundle holds, by its poms: `{ artifact, version }[]`. */
export function bundleArtifacts(entries) {
  return entries
    .map((entry) => entry.name.match(/^com\/kindgi\/([^/]+)\/([^/]+)\/[^/]+\.pom$/))
    .filter(Boolean)
    .map(([, artifact, version]) => ({ artifact, version }));
}

// ---- the Portal ---------------------------------------------------------------

function authorization() {
  const username = process.env.MAVEN_CENTRAL_USERNAME;
  const password = process.env.MAVEN_CENTRAL_PASSWORD;
  if (!username || !password) {
    throw new BundleError(
      'MAVEN_CENTRAL_USERNAME and MAVEN_CENTRAL_PASSWORD (a Central Portal user token) must be set',
    );
  }
  return `Bearer ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function portal(method, path, { body, expect }) {
  const response = await fetch(`${PORTAL}${path}`, {
    method,
    headers: { authorization: authorization() },
    body,
  });
  const text = await response.text();
  if (!expect.includes(response.status)) {
    throw new BundleError(`${method} ${path}: HTTP ${response.status}: ${text.slice(0, 2000)}`);
  }
  return text;
}

async function upload(bundlePath, publishingType, name) {
  const form = new FormData();
  form.append('bundle', new Blob([readFileSync(bundlePath)]), basename(bundlePath));
  const query = new URLSearchParams({ publishingType, name });
  const id = (
    await portal('POST', `/api/v1/publisher/upload?${query}`, { body: form, expect: [200, 201] })
  ).trim();
  if (!/^[0-9a-f-]{36}$/i.test(id))
    throw new BundleError(`the upload answered "${id.slice(0, 200)}", not a deployment id`);
  return id;
}

/** Polls the deployment until it reaches one of `states`, or FAILED; its last status. */
async function waitFor(id, states, minutes) {
  const deadline = Date.now() + minutes * 60_000;
  let last;
  for (;;) {
    const status = JSON.parse(
      await portal('POST', `/api/v1/publisher/status?id=${encodeURIComponent(id)}`, {
        expect: [200],
      }),
    );
    if (status.deploymentState !== last)
      console.log(`${NAME}: deployment ${id}: ${status.deploymentState}`);
    last = status.deploymentState;
    if (states.includes(last) || last === 'FAILED') return status;
    if (Date.now() > deadline) {
      throw new BundleError(
        `deployment ${id} is still ${last} after ${minutes} minutes: see it on ${PORTAL}/publishing/deployments`,
      );
    }
    await sleep(POLL_SECONDS * 1000);
  }
}

const failure = (status) =>
  `the Portal failed the deployment:\n${JSON.stringify(status.errors ?? status, null, 2)}`;

/** Which of the bundle's artifacts Central already has. */
async function alreadyOnCentral(artifacts) {
  const found = [];
  for (const { artifact, version } of artifacts) {
    const url = `${REPOSITORY}/${GROUP_PATH}/${artifact}/${version}/${artifact}-${version}.pom`;
    const response = await fetch(url, { method: 'HEAD' });
    if (response.status === 200) found.push(artifact);
    else if (response.status !== 404) throw new BundleError(`HEAD ${url}: HTTP ${response.status}`);
  }
  return found;
}

async function validate(bundlePath, minutes) {
  const artifacts = bundleArtifacts(readZip(readFileSync(bundlePath), bundlePath));
  const version = artifacts[0]?.version;
  const id = await upload(bundlePath, 'USER_MANAGED', `kindgi-jvm ${version} (dry run)`);
  let status;
  try {
    status = await waitFor(id, ['VALIDATED'], minutes);
  } finally {
    // Dropped whatever happened: a dry run leaves no deployment behind.
    try {
      await portal('DELETE', `/api/v1/publisher/deployment/${encodeURIComponent(id)}`, {
        expect: [204],
      });
      console.log(`${NAME}: deployment ${id} dropped`);
    } catch (err) {
      console.error(
        `${NAME}: couldn't drop deployment ${id}; drop it on ${PORTAL}/publishing/deployments before the release: ${err.message}`,
      );
      process.exitCode = 1;
    }
  }
  if (status.deploymentState === 'FAILED') throw new BundleError(failure(status));
  console.log(
    `${NAME}: the Portal validated ${artifacts.length} artifact(s) at ${version}; nothing was published`,
  );
}

async function publish(bundlePath, minutes) {
  const artifacts = bundleArtifacts(readZip(readFileSync(bundlePath), bundlePath));
  const version = artifacts[0]?.version;
  const present = await alreadyOnCentral(artifacts);
  if (present.length === artifacts.length) {
    console.log(`${NAME}: Central already has every artifact at ${version}; nothing to publish`);
    return;
  }
  if (present.length > 0) {
    throw new BundleError(
      `Central has ${present.join(', ')} at ${version} but not the rest: a version is published whole, so this needs a person`,
    );
  }
  const id = await upload(bundlePath, 'AUTOMATIC', `kindgi-jvm ${version}`);
  const status = await waitFor(id, ['PUBLISHED'], minutes);
  if (status.deploymentState === 'FAILED') throw new BundleError(failure(status));
  console.log(`${NAME}: published ${artifacts.map((a) => a.artifact).join(', ')} at ${version}`);
}

/** Waits until Central serves every artifact we publish at `version`. */
async function onCentral(version, minutes) {
  const artifacts = Object.keys(ARTIFACTS).map((artifact) => ({ artifact, version }));
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const present = new Set(await alreadyOnCentral(artifacts));
    const missing = artifacts.filter(({ artifact }) => !present.has(artifact));
    if (missing.length === 0) {
      console.log(`${NAME}: Central has every JVM artifact at ${version}`);
      return;
    }
    if (Date.now() > deadline) {
      throw new BundleError(
        `Central doesn't have ${missing.map((a) => a.artifact).join(', ')} at ${version} after ${minutes} minutes: a CLI at ${version} would scaffold packs on artifacts that don't resolve`,
      );
    }
    await sleep(POLL_SECONDS * 1000);
  }
}

// ---- the command ---------------------------------------------------------------

function option(args, name) {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  args.splice(at, 2);
  if (value === undefined || value.startsWith('--')) throw new BundleError(`${name} needs a value`);
  return value;
}

const USAGE = `usage:
  node scripts/central-bundle.mjs bundle --out <zip> (--fingerprint <fpr> | --unsigned) <staging dir>…
  node scripts/central-bundle.mjs validate --bundle <zip> [--wait-minutes <n>]
  node scripts/central-bundle.mjs publish --bundle <zip> [--wait-minutes <n>]
  node scripts/central-bundle.mjs on-central --version <v> [--wait-minutes <n>]`;

/** `bundle`: the staged files, checked and signed-verified, into one zip. */
function bundleCommand(args) {
  const out = option(args, '--out');
  const fingerprint = option(args, '--fingerprint');
  const unsigned = args.includes('--unsigned');
  const dirs = args.filter((arg) => arg !== '--unsigned');
  const usable = out !== undefined && dirs.length > 0 && !dirs.some((dir) => dir.startsWith('--'));
  if (!usable || unsigned === (fingerprint !== undefined)) throw new BundleError(USAGE);
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const entries = bundleEntries(dirs, {
    signed: !unsigned,
    version: lockstepVersion(root),
    fingerprint,
  });
  writeFileSync(out, writeZip(entries));
  const signatures = unsigned ? 'unsigned' : `every signature verified as ${fingerprint}'s`;
  console.log(
    `${NAME}: ${out}: ${bundleArtifacts(entries).length} artifact(s), ${entries.length} files, ${signatures}`,
  );
}

/** `validate`, `publish`: a bundle to the Portal. */
async function portalCommand(command, args) {
  const bundle = option(args, '--bundle');
  const minutes = Number(option(args, '--wait-minutes') ?? (command === 'publish' ? 60 : 30));
  if (bundle === undefined || args.length > 0 || !(minutes > 0)) throw new BundleError(USAGE);
  await (command === 'validate' ? validate(bundle, minutes) : publish(bundle, minutes));
}

/** `on-central`: wait until Central serves a version. */
async function onCentralCommand(args) {
  const version = option(args, '--version');
  const minutes = Number(option(args, '--wait-minutes') ?? 30);
  if (version === undefined || args.length > 0 || !(minutes >= 0)) throw new BundleError(USAGE);
  await onCentral(version, minutes);
}

const COMMANDS = {
  bundle: (args) => bundleCommand(args),
  validate: (args) => portalCommand('validate', args),
  publish: (args) => portalCommand('publish', args),
  'on-central': (args) => onCentralCommand(args),
};

async function main(argv) {
  const [command, ...args] = argv;
  const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (run === undefined) throw new BundleError(USAGE);
  await run(args);
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((err) => {
    if (!(err instanceof BundleError)) throw err;
    console.error(`${NAME}: ${err.message}`);
    process.exit(1);
  });
}
