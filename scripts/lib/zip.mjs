// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Zip archives (jars, the Central Portal's bundle), with Node's zlib only.
 *
 * Reading takes the central directory's entries, stored or deflated, and
 * checks each one's CRC. Writing deflates every entry, with a fixed time
 * (1980-01-01), so the same files make the same bytes. No ZIP64, no
 * encryption: an archive that needs either is refused, never misread.
 */

import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/** An archive these functions can't read. */
export class ZipError extends Error {}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const STORED = 0;
const DEFLATED = 8;
/** 1980-01-01 00:00, the earliest DOS date. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/**
 * The archive's entries, in central directory order; directories included
 * (their names end with `/`).
 *
 * @param {Buffer} buffer the archive
 * @param {string} file its path, for the messages
 * @returns {{ name: string, data: () => Buffer }[]}
 */
export function readZip(buffer, file) {
  const end = findEnd(buffer, file);
  const count = buffer.readUInt16LE(end + 10);
  const size = buffer.readUInt32LE(end + 12);
  let at = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || at === 0xffffffff) {
    throw new ZipError(`${file}: a ZIP64 archive, not read here`);
  }
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL) {
      throw new ZipError(`${file}: central directory entry ${i} is damaged`);
    }
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const compressed = buffer.readUInt32LE(at + 20);
    const uncompressed = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw new ZipError(`${file}: ${name} is encrypted`);
    if (method !== STORED && method !== DEFLATED) {
      throw new ZipError(`${file}: ${name} uses compression method ${method}`);
    }
    entries.push({
      name,
      data: () => {
        if (buffer.readUInt32LE(local) !== LOCAL) {
          throw new ZipError(`${file}: ${name}'s local header is damaged`);
        }
        const start =
          local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
        const raw = buffer.subarray(start, start + compressed);
        let data;
        try {
          data = method === STORED ? Buffer.from(raw) : inflateRawSync(raw);
        } catch (err) {
          throw new ZipError(`${file}: ${name} doesn't inflate: ${err.message}`);
        }
        if (data.length !== uncompressed || crc32(data) !== crc) {
          throw new ZipError(`${file}: ${name} doesn't match its checksum`);
        }
        return data;
      },
    });
  }
  return entries;
}

function findEnd(buffer, file) {
  // The end record is 22 bytes, after which only a comment (up to 64 KiB) may follow.
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 0xffff); at--) {
    if (buffer.readUInt32LE(at) === END) return at;
  }
  throw new ZipError(`${file}: not a zip archive`);
}

/**
 * An archive of `entries`, in the order given, each deflated.
 *
 * @param {{ name: string, data: Buffer }[]} entries
 * @returns {Buffer}
 */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // the name is UTF-8
    local.writeUInt16LE(DEFLATED, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4); // made by: 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(DEFLATED, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  if (entries.length > 0xfffe || offset > 0xfffffffe) {
    throw new ZipError('too many entries or bytes for an archive without ZIP64');
  }
  return Buffer.concat([...locals, directory, end]);
}
