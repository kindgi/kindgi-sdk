// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * central-bundle: the bundle's files and checksums, and the Central Portal
 * calls a dry run and a release make, against a stand-in Portal and Maven
 * repository served here.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bundleArtifacts, bundleEntries } from './central-bundle.mjs';
import { writeZip } from './lib/zip.mjs';

const SCRIPT = fileURLToPath(new URL('./central-bundle.mjs', import.meta.url));
const VERSION = '1.2.3';
const work = mkdtempSync(join(tmpdir(), 'central-bundle-'));
after(() => rmSync(work, { recursive: true, force: true }));

function stage(name, files) {
  const dir = join(work, name);
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), data);
  }
  return dir;
}

const PARENT = `com/kindgi/kindgi-java-parent/${VERSION}/kindgi-java-parent-${VERSION}.pom`;
const PACK = `com/kindgi/kindgi-pack/${VERSION}/kindgi-pack-${VERSION}`;

describe('the bundle', () => {
  test('each file with its checksums; the build bookkeeping and its signature checksums left out', () => {
    const java = stage('java', {
      [PARENT]: '<project/>',
      [`${PARENT}.md5`]: createHash('md5').update('<project/>').digest('hex'),
      'com/kindgi/kindgi-java-parent/maven-metadata.xml': '<metadata/>',
    });
    const entries = bundleEntries([java], { signed: false, version: VERSION });
    assert.deepEqual(
      entries.map((entry) => entry.name),
      [PARENT, `${PARENT}.md5`, `${PARENT}.sha1`],
    );
    assert.equal(entries[2].data.toString(), createHash('sha1').update('<project/>').digest('hex'));
    assert.deepEqual(bundleArtifacts(entries), [
      { artifact: 'kindgi-java-parent', version: VERSION },
    ]);
  });

  test("a checksum the build wrote that doesn't match its file stops it", () => {
    const java = stage('bad-checksum', { [PARENT]: '<project/>', [`${PARENT}.sha1`]: 'ffff' });
    assert.throws(
      () => bundleEntries([java], { signed: false, version: VERSION }),
      /kindgi-java-parent-1\.2\.3\.pom\.sha1 doesn't match/,
    );
  });

  test("a signed bundle needs every signature, and the release key's fingerprint", () => {
    const java = stage('unsigned', { [PARENT]: '<project/>' });
    const fingerprint = '0123456789ABCDEF0123456789ABCDEF01234567';
    assert.throws(
      () => bundleEntries([java], { signed: true, version: VERSION, fingerprint }),
      /isn't signed/,
    );
    assert.throws(
      () => bundleEntries([java], { signed: true, version: VERSION }),
      /needs the release key's fingerprint/,
    );
  });

  test('a jar artifact without its sources is refused', () => {
    const java = stage('no-sources', {
      [`${PACK}.pom`]: 'x',
      [`${PACK}.jar`]: 'x',
      [`${PACK}-javadoc.jar`]: 'x',
    });
    assert.throws(
      () => bundleEntries([java], { signed: false, version: VERSION }),
      /no kindgi-pack-1\.2\.3-sources\.jar/,
    );
  });
});

// ---- the Portal, stood in for -------------------------------------------------------

/** What the stand-in Portal and repository were asked, and how they answer. */
const portal = { calls: [], states: [], onCentral: new Set(), uploads: [] };
let server;
let url;

const TOKEN = `Bearer ${Buffer.from('token-user:token-pass').toString('base64')}`;
const DEPLOYMENT = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

/** The stand-in's answer: the repository's HEADs, then the Portal's three calls, with the token. */
function answer(request, response, body) {
  const { pathname, searchParams } = new URL(request.url, 'http://x');
  const call = `${request.method} ${pathname}`;
  portal.calls.push(call);
  if (request.method === 'HEAD' && pathname.startsWith('/maven2/')) {
    response.writeHead(portal.onCentral.has(pathname.split('/')[4]) ? 200 : 404).end();
  } else if (request.headers.authorization !== TOKEN) {
    response.writeHead(401).end('unauthorized');
  } else if (call === 'POST /api/v1/publisher/upload') {
    portal.uploads.push({
      publishingType: searchParams.get('publishingType'),
      name: searchParams.get('name'),
      field: /name="bundle"; filename="bundle\.zip"/.test(body),
    });
    response.writeHead(201).end(DEPLOYMENT);
  } else if (call === 'POST /api/v1/publisher/status') {
    const state = portal.states.length > 1 ? portal.states.shift() : portal.states[0];
    const status = { deploymentId: searchParams.get('id'), deploymentState: state };
    if (state === 'FAILED') {
      status.errors = { 'pkg:maven/com.kindgi/kindgi-pack@1.2.3': ['Missing signature'] };
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(status));
  } else if (call === `DELETE /api/v1/publisher/deployment/${DEPLOYMENT}`) {
    response.writeHead(204).end();
  } else {
    response.writeHead(404).end();
  }
}

before(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.setEncoding('latin1');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => answer(request, response, body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const bundle = join(work, 'bundle.zip');
writeFileSync(
  bundle,
  writeZip([
    { name: PARENT, data: Buffer.from('<project/>') },
    { name: `${PACK}.pom`, data: Buffer.from('<project/>') },
  ]),
);

function run(...args) {
  portal.calls = [];
  portal.uploads = [];
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    env: {
      PATH: process.env.PATH,
      MAVEN_CENTRAL_USERNAME: 'token-user',
      MAVEN_CENTRAL_PASSWORD: 'token-pass',
      KINDGI_CENTRAL_PORTAL_URL: url,
      KINDGI_CENTRAL_REPOSITORY_URL: `${url}/maven2`,
      KINDGI_CENTRAL_POLL_SECONDS: '0',
    },
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  return new Promise((resolve) => child.on('close', (status) => resolve({ status, output })));
}

describe('the Portal', () => {
  test('a dry run uploads for validation only, waits, and drops the deployment', async () => {
    portal.states = ['PENDING', 'VALIDATING', 'VALIDATED'];
    const { status, output } = await run('validate', '--bundle', bundle);
    assert.equal(status, 0, output);
    assert.deepEqual(portal.uploads, [
      { publishingType: 'USER_MANAGED', name: 'kindgi-jvm 1.2.3 (dry run)', field: true },
    ]);
    assert.equal(portal.calls.at(-1), `DELETE /api/v1/publisher/deployment/${DEPLOYMENT}`);
    assert.match(output, /validated 2 artifact\(s\) at 1\.2\.3; nothing was published/);
    assert.ok(!output.includes('token-pass') && !output.includes('token-user'));
  });

  test("a failed validation shows the Portal's errors, and the deployment is still dropped", async () => {
    portal.states = ['VALIDATING', 'FAILED'];
    const { status, output } = await run('validate', '--bundle', bundle);
    assert.equal(status, 1);
    assert.match(output, /Missing signature/);
    assert.equal(portal.calls.at(-1), `DELETE /api/v1/publisher/deployment/${DEPLOYMENT}`);
  });

  test('a release uploads to publish and waits until it is published', async () => {
    portal.onCentral = new Set();
    portal.states = ['VALIDATED', 'PUBLISHING', 'PUBLISHED'];
    const { status, output } = await run('publish', '--bundle', bundle);
    assert.equal(status, 0, output);
    assert.deepEqual(portal.uploads, [
      { publishingType: 'AUTOMATIC', name: 'kindgi-jvm 1.2.3', field: true },
    ]);
    assert.ok(!portal.calls.some((call) => call.startsWith('DELETE')));
    assert.match(output, /published kindgi-java-parent, kindgi-pack at 1\.2\.3/);
  });

  test('a version Central has is skipped; a version it has part of is refused', async () => {
    portal.onCentral = new Set(['kindgi-java-parent', 'kindgi-pack']);
    let { status, output } = await run('publish', '--bundle', bundle);
    assert.equal(status, 0, output);
    assert.equal(portal.uploads.length, 0);
    assert.match(output, /already has every artifact at 1\.2\.3/);

    portal.onCentral = new Set(['kindgi-pack']);
    ({ status, output } = await run('publish', '--bundle', bundle));
    assert.equal(status, 1);
    assert.equal(portal.uploads.length, 0);
    assert.match(output, /Central has kindgi-pack at 1\.2\.3 but not the rest/);
  });

  test('a deployment that never gets there fails, saying where to look', async () => {
    portal.onCentral = new Set();
    portal.states = ['PUBLISHING'];
    const { status, output } = await run('publish', '--bundle', bundle, '--wait-minutes', '0.0001');
    assert.equal(status, 1);
    assert.match(output, /is still PUBLISHING after 0\.0001 minutes: see it on/);
  });

  test('without the token, nothing is sent', async () => {
    const child = spawn(process.execPath, [SCRIPT, 'validate', '--bundle', bundle], {
      env: { PATH: process.env.PATH, KINDGI_CENTRAL_PORTAL_URL: url },
    });
    let output = '';
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    portal.calls = [];
    const status = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(status, 1);
    assert.match(output, /MAVEN_CENTRAL_USERNAME and MAVEN_CENTRAL_PASSWORD/);
    assert.deepEqual(portal.calls, []);
  });
});
