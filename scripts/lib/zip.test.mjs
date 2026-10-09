// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** Zip archives: what writeZip writes, readZip reads back, and a damaged archive is refused. */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ZipError, readZip, writeZip } from './zip.mjs';

const files = [
  { name: 'META-INF/', data: Buffer.alloc(0) },
  { name: 'com/acme/A.class', data: Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 1, 2, 3]) },
  { name: 'com/acme/notes.txt', data: Buffer.from('ü and ß, twice: ü and ß\n'.repeat(50)) },
];

describe('zip', () => {
  test('reads back what it writes, in order', () => {
    const entries = readZip(writeZip(files), 'a.zip');
    assert.deepEqual(
      entries.map((entry) => entry.name),
      files.map((file) => file.name),
    );
    entries.forEach((entry, i) => assert.deepEqual(entry.data(), files[i].data));
  });

  test('the same files make the same bytes', () => {
    assert.deepEqual(writeZip(files), writeZip(files));
  });

  test('a damaged entry is refused, never misread', () => {
    const bytes = writeZip(files);
    const at = bytes.indexOf(Buffer.from('com/acme/notes.txt')) + 'com/acme/notes.txt'.length + 2;
    bytes[at] ^= 0xff;
    const notes = readZip(bytes, 'a.zip').find((entry) => entry.name === 'com/acme/notes.txt');
    assert.throws(() => notes.data(), ZipError);
  });

  test('something else is not a zip archive', () => {
    assert.throws(
      () => readZip(Buffer.from('not a zip archive, just text'), 'a.zip'),
      /not a zip archive/,
    );
  });
});
