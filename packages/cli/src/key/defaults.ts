// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Production wiring for `kindgi key`. Composes `@kindgi/crypto`
 * primitives + `node:fs/promises` into the `KeyRunners` shape. Loaded
 * lazily by `main.ts` on `key` dispatch so unrelated commands don't
 * pay the crypto load.
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';

import {
  generateEd25519KeyPair,
  serializePrivateKeyPem,
  serializePublicKeyPem,
} from '@kindgi/crypto';

import type { KeyDirEntry, KeyRunners } from './runners.js';

export const REAL_KEY_RUNNERS: KeyRunners = {
  generateKeyPair: async () => {
    const pair = generateEd25519KeyPair();
    return {
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
      privateKeyPem: serializePrivateKeyPem(pair.privateKey),
      publicKeyPem: serializePublicKeyPem(pair.publicKey),
    };
  },
  mkdir: async (path, mode) => {
    await mkdir(path, { recursive: true, mode });
  },
  writeFile: async ({ path, contents, mode }) => {
    await writeFile(path, contents, { mode });
  },
  readFile: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  readdir: async (path): Promise<readonly KeyDirEntry[]> => {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isFile: e.isFile() }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  },
  exists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  },
};
