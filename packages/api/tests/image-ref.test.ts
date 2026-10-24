// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { imageRefWithin, parseImagePrefix, parseImageRef } from '../src/index.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const HOST = 'us-central1-docker.pkg.dev';

function ref(s: string) {
  const r = parseImageRef(s);
  if (r.kind === 'err') throw new Error(`expected ${s} to parse: ${r.error.reason}`);
  return r.value;
}

function prefix(s: string) {
  const r = parseImagePrefix(s);
  if (r.kind === 'err') throw new Error(`expected ${s} to parse: ${r.error.reason}`);
  return r.value;
}

describe('parseImageRef', () => {
  test('splits a digest-pinned reference into host, path and digest', () => {
    expect(ref(`${HOST}/acme-cell/s-1/agent@${DIGEST}`)).toEqual({
      host: HOST,
      path: 'acme-cell/s-1/agent',
      digest: DIGEST,
    });
  });

  test('lowercases the host and the digest', () => {
    expect(ref(`US-Central1-Docker.PKG.dev/p/r@sha256:${'A'.repeat(64)}`)).toEqual({
      host: HOST,
      path: 'p/r',
      digest: DIGEST,
    });
  });

  test('takes a port and localhost', () => {
    expect(ref(`localhost:5000/p/r@${DIGEST}`).host).toBe('localhost:5000');
    expect(ref(`localhost/r@${DIGEST}`).host).toBe('localhost');
  });

  test.each([
    ['no digest', `${HOST}/p/r`],
    ['a tag only', `${HOST}/p/r:latest`],
    ['a tag and a digest', `${HOST}/p/r:latest@${DIGEST}`],
    ['user info', `user:secret@${HOST}/p/r@${DIGEST}`],
    ['user info, no digest', `user@${HOST}/p/r`],
    ['a .. segment', `${HOST}/p/../q/r@${DIGEST}`],
    ['a leading dot segment', `${HOST}/./r@${DIGEST}`],
    ['an uppercase path', `${HOST}/p/Agent@${DIGEST}`],
    ['no registry host', `library/ubuntu@${DIGEST}`],
    ['no path', `${HOST}@${DIGEST}`],
    ['an empty path segment', `${HOST}/p//r@${DIGEST}`],
    ['a trailing slash', `${HOST}/p/@${DIGEST}`],
    ['whitespace', ` ${HOST}/p/r@${DIGEST}`],
    ['a short digest', `${HOST}/p/r@sha256:abc`],
    ['another algorithm', `${HOST}/p/r@sha512:${'a'.repeat(128)}`],
    ['two digests', `${HOST}/p/r@${DIGEST}@${DIGEST}`],
    ['a scheme', `https://${HOST}/p/r@${DIGEST}`],
    ['a repository over 255 characters', `${HOST}/${'a'.repeat(260)}@${DIGEST}`],
  ])('refuses %s', (_why, input) => {
    const r = parseImageRef(input);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('image-ref-invalid');
  });
});

describe('parseImagePrefix', () => {
  test('takes <host>/<path>', () => {
    expect(prefix(`${HOST}/acme-cell/s-1`)).toEqual({ host: HOST, path: 'acme-cell/s-1' });
  });

  test.each([
    ['a digest', `${HOST}/p/r@${DIGEST}`],
    ['a tag', `${HOST}/p/r:v1`],
    ['no registry host', 'acme-cell/s-1'],
    ['a trailing slash', `${HOST}/p/`],
  ])('refuses %s', (_why, input) => {
    expect(parseImagePrefix(input).kind).toBe('err');
  });
});

describe('imageRefWithin', () => {
  const slot = prefix(`${HOST}/acme-cell/s-1`);

  test('admits the prefix itself and anything under it', () => {
    expect(imageRefWithin(ref(`${HOST}/acme-cell/s-1@${DIGEST}`), slot)).toBe(true);
    expect(imageRefWithin(ref(`${HOST}/acme-cell/s-1/agent@${DIGEST}`), slot)).toBe(true);
    expect(imageRefWithin(ref(`${HOST}/acme-cell/s-1/a/b@${DIGEST}`), slot)).toBe(true);
  });

  test('stops at a path boundary: s-1 never admits s-10 or s-1-x', () => {
    expect(imageRefWithin(ref(`${HOST}/acme-cell/s-10/agent@${DIGEST}`), slot)).toBe(false);
    expect(imageRefWithin(ref(`${HOST}/acme-cell/s-1-x@${DIGEST}`), slot)).toBe(false);
  });

  test("refuses another tenant's slot and its parent", () => {
    expect(imageRefWithin(ref(`${HOST}/acme-cell/s-2/agent@${DIGEST}`), slot)).toBe(false);
    expect(imageRefWithin(ref(`${HOST}/acme-cell@${DIGEST}`), slot)).toBe(false);
  });

  test('compares hosts case-insensitively, and refuses another host', () => {
    expect(
      imageRefWithin(ref(`US-CENTRAL1-DOCKER.PKG.DEV/acme-cell/s-1/agent@${DIGEST}`), slot),
    ).toBe(true);
    expect(imageRefWithin(ref(`europe-docker.pkg.dev/acme-cell/s-1/agent@${DIGEST}`), slot)).toBe(
      false,
    );
    expect(imageRefWithin(ref(`${HOST}:443/acme-cell/s-1/agent@${DIGEST}`), slot)).toBe(false);
  });
});
