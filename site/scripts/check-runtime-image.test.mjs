// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OLDER_RELEASES, check, pinnedImage } from './check-runtime-image.mjs';

const DIGEST = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const PIN = {
  image: `registry.kindgi.com/kindgi/runtime:0.4.0@sha256:${DIGEST}`,
  registry: 'registry.kindgi.com',
  tag: '0.4.0',
  digest: DIGEST,
};

const problems = (source, older) =>
  check(source, PIN, older).problems.map(
    ({ line, reference, problem }) => `${line}: ${reference}: ${problem}`,
  );

test('the image the CLI pins passes, by tag and by digest', () => {
  const source = [
    'docker pull registry.kindgi.com/kindgi/runtime:0.4.0',
    `  registry.kindgi.com/kindgi/runtime:0.4.0@sha256:${DIGEST}`,
    'The image is `registry.kindgi.com/kindgi/runtime:0.4.0`.',
    'It runs registry.kindgi.com/kindgi/runtime:0.4.0.',
  ].join('\n');
  assert.deepEqual(problems(source), []);
  assert.equal(check(source, PIN).counted, 4);
});

test('another tag fails, in code and in prose', () => {
  assert.deepEqual(
    problems(
      [
        '```sh',
        'docker pull registry.kindgi.com/kindgi/runtime:0.3.0',
        '```',
        'Pull `registry.kindgi.com/kindgi/runtime:0.4` first.',
        'Or registry.kindgi.com/kindgi/runtime:latest.',
      ].join('\n'),
    ),
    [
      '2: registry.kindgi.com/kindgi/runtime:0.3.0: tag 0.3.0, not 0.4.0',
      '4: registry.kindgi.com/kindgi/runtime:0.4: tag 0.4, not 0.4.0',
      '5: registry.kindgi.com/kindgi/runtime:latest: tag latest, not 0.4.0',
    ],
  );
});

test("another digest fails, with the pin's tag too", () => {
  assert.deepEqual(problems(`  registry.kindgi.com/kindgi/runtime:0.4.0@sha256:${OTHER}`), [
    `1: registry.kindgi.com/kindgi/runtime:0.4.0@sha256:${OTHER}: digest bbbbbbbbbbbb…, not the pin's aaaaaaaaaaaa…`,
  ]);
  assert.deepEqual(problems(`registry.kindgi.com/kindgi/runtime:0.3.0@sha256:${OTHER}`), [
    `1: registry.kindgi.com/kindgi/runtime:0.3.0@sha256:${OTHER}: tag 0.3.0, not 0.4.0`,
    `1: registry.kindgi.com/kindgi/runtime:0.3.0@sha256:${OTHER}: digest bbbbbbbbbbbb…, not the pin's aaaaaaaaaaaa…`,
  ]);
});

test('another registry fails, and so does none, which Docker reads as Docker Hub', () => {
  assert.deepEqual(
    problems(
      [
        'docker pull ghcr.io/kindgi/runtime:0.4.0',
        `  localhost:5000/kindgi/runtime:0.4.0@sha256:${DIGEST}`,
        'docker pull kindgi/runtime:0.4.0',
        'The `kindgi/runtime` image.',
        'docker pull docker.io/kindgi/runtime:0.3.0',
      ].join('\n'),
    ),
    [
      '1: ghcr.io/kindgi/runtime:0.4.0: registry ghcr.io, not registry.kindgi.com',
      `2: localhost:5000/kindgi/runtime:0.4.0@sha256:${DIGEST}: registry localhost:5000, not registry.kindgi.com`,
      '3: kindgi/runtime:0.4.0: no registry (Docker Hub), not registry.kindgi.com',
      '4: kindgi/runtime: no registry (Docker Hub), not registry.kindgi.com',
      '5: docker.io/kindgi/runtime:0.3.0: registry docker.io, not registry.kindgi.com',
      '5: docker.io/kindgi/runtime:0.3.0: tag 0.3.0, not 0.4.0',
    ],
  );
});

test('a reference with no tag, or a placeholder, names no release', () => {
  const source = [
    'The runtime is a container image at `registry.kindgi.com/kindgi/runtime`,',
    'docker pull registry.kindgi.com/kindgi/runtime:<version>',
    '     registry.kindgi.com/kindgi/runtime:<version>@sha256:<digest>',
    '✓ You can pull registry.kindgi.com/kindgi/runtime:…@sha256:…, the image this CLI runs.',
    'registry.kindgi.com/kindgi/runtime:{{kindgi.version}}',
  ].join('\n');
  assert.deepEqual(problems(source), []);
  assert.equal(check(source, PIN).counted, 5);
});

test('emphasis or a tag right after a reference is not part of it', () => {
  const source = [
    '**registry.kindgi.com/kindgi/runtime:0.4.0**',
    '_registry.kindgi.com/kindgi/runtime:0.4.0_',
    'registry.kindgi.com/kindgi/runtime:0.4.0<br/>',
    `*registry.kindgi.com/kindgi/runtime:0.4.0@sha256:${DIGEST}*`,
    '**registry.kindgi.com/kindgi/runtime:0.3.0**',
  ].join('\n');
  assert.deepEqual(problems(source), [
    '5: registry.kindgi.com/kindgi/runtime:0.3.0: tag 0.3.0, not 0.4.0',
  ]);
  assert.equal(check(source, PIN).counted, 5);
});

test('another image whose name starts or ends the same is not the runtime', () => {
  const source =
    'docker pull registry.kindgi.com/kindgi/runtime-tools:0.1.0 kindgi/runtimes:1 notkindgi/runtime:1';
  assert.deepEqual(problems(source), []);
  assert.equal(check(source, PIN).counted, 0);
});

test('the old registry fails anywhere, with what its reference names', () => {
  assert.deepEqual(
    problems(
      [
        `docker pull quay.io/kindgi/runtime:0.4.0@sha256:${DIGEST}`,
        'Images were at `quay.io/kindgi`.',
      ].join('\n'),
    ),
    [
      `1: quay.io/kindgi/runtime:0.4.0@sha256:${DIGEST}: the old registry, quay.io`,
      '2: quay.io/kindgi: the old registry, quay.io',
    ],
  );
});

test("an older release's section is skipped, up to the next heading of its level or above", () => {
  const source = [
    '## Upgrade the runtime',
    '### Runtime 0.1.5.1',
    'docker pull quay.io/kindgi/runtime:0.1.5.1',
    '#### What to check',
    'docker pull registry.kindgi.com/kindgi/runtime:0.1.5.1',
    '### From 0.1.4 to 0.1.5',
    'docker pull registry.kindgi.com/kindgi/runtime:0.1.5',
    '### Runtime 0.1.4.2',
    'docker pull registry.kindgi.com/kindgi/runtime:0.1.4.2',
    '## Back up',
    'docker pull registry.kindgi.com/kindgi/runtime:0.1.4',
  ].join('\n');
  const older = ['### Runtime 0.1.5.1', '### Runtime 0.1.4.2', '### Runtime 0.1.4.1'];
  assert.deepEqual(problems(source, older), [
    '7: registry.kindgi.com/kindgi/runtime:0.1.5: tag 0.1.5, not 0.4.0',
    '11: registry.kindgi.com/kindgi/runtime:0.1.4: tag 0.1.4, not 0.4.0',
  ]);
  const { counted, skipped, seen } = check(source, PIN, older);
  assert.equal(counted, 2);
  assert.equal(skipped, 3);
  assert.deepEqual([...seen], ['### Runtime 0.1.5.1', '### Runtime 0.1.4.2']);
});

test("a # line in a code block or the front matter is not a heading, and doesn't end a section", () => {
  const source = [
    '---',
    '### Runtime 0.1.5.1',
    'description: Pull registry.kindgi.com/kindgi/runtime:0.3.0.',
    '---',
    '### Runtime 0.1.5.1',
    '```sh',
    '# Pull it',
    'docker pull registry.kindgi.com/kindgi/runtime:0.1.5.1',
    '```',
    '  ```sh',
    '  ## Runtime 0.1.5.1',
    '  ```',
    '### Next',
    '```sh',
    '### Runtime 0.1.5.1',
    'docker pull registry.kindgi.com/kindgi/runtime:0.1.5.1',
    '```',
  ].join('\n');
  assert.deepEqual(problems(source, ['### Runtime 0.1.5.1']), [
    '3: registry.kindgi.com/kindgi/runtime:0.3.0: tag 0.3.0, not 0.4.0',
    '16: registry.kindgi.com/kindgi/runtime:0.1.5.1: tag 0.1.5.1, not 0.4.0',
  ]);
});

test("the pin is read from this checkout's runtime-image.ts", () => {
  const pin = pinnedImage();
  assert.match(pin.registry, /^[a-z0-9.-]+(?::\d+)?$/);
  assert.match(pin.tag, /^\d+\.\d+\.\d+/);
  assert.match(pin.digest, /^[0-9a-f]{64}$/);
  assert.equal(pin.image, `${pin.registry}/kindgi/runtime:${pin.tag}@sha256:${pin.digest}`);
});

test('a pin it cannot read stops the check', () => {
  assert.deepEqual(
    pinnedImage(
      `export const DEFAULT_RUNTIME_IMAGE =\n  'registry.kindgi.com/kindgi/runtime:0.4.0@sha256:${DIGEST}';`,
    ),
    {
      image: `registry.kindgi.com/kindgi/runtime:0.4.0@sha256:${DIGEST}`,
      registry: 'registry.kindgi.com',
      tag: '0.4.0',
      digest: DIGEST,
    },
  );
  for (const source of [
    "export const DEFAULT_RUNTIME_IMAGE = 'registry.kindgi.com/kindgi/runtime:0.4.0';",
    `export const DEFAULT_RUNTIME_IMAGE = 'registry.kindgi.com/kindgi/runtime@sha256:${DIGEST}';`,
    `export const DEFAULT_RUNTIME_IMAGE = 'kindgi/runtime:0.4.0@sha256:${DIGEST}';`,
    `export const DEFAULT_RUNTIME_IMAGE = 'registry.kindgi.com/mirror/kindgi/runtime:0.4.0@sha256:${DIGEST}';`,
    `export const OTHER_IMAGE = 'registry.kindgi.com/kindgi/runtime:0.4.0@sha256:${DIGEST}';`,
  ]) {
    assert.throws(() => pinnedImage(source), /runtime-image\.ts has no DEFAULT_RUNTIME_IMAGE/);
  }
});

test('each older-release section names a page and a heading', () => {
  for (const { page, heading } of OLDER_RELEASES) {
    assert.match(page, /^[\w/-]+$/);
    assert.match(heading, /^#{2,6} \S/);
  }
});
