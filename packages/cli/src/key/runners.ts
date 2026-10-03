// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Injectable seams for `kindgi key`. Every filesystem side-effect
 * and every crypto op flows through this shape so tests substitute
 * fixtures — no real key files touch disk under `~/.kindgi/keys/` during
 * unit tests.
 *
 * Production wiring lives at `packages/cli/src/key/defaults.ts`; tests
 * pass `RunCliInputs.keyRunners` with in-memory stubs.
 */

/**
 * Byte-oriented view of an Ed25519 key pair — the raw 32-byte
 * representation `@kindgi/crypto` operates on. Both public and
 * private are handed to the runner so the caller can serialize each
 * independently (public → PEM + raw hex + base64; private → PEM only).
 */
export interface GeneratedKeyPair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
}

export interface WriteFileOptions {
  readonly path: string;
  readonly contents: string | Uint8Array;
  readonly mode: number;
}

export interface KeyDirEntry {
  readonly name: string;
  readonly isFile: boolean;
}

/**
 * Runners shape. All ops asynchronous — matches the `BuildRunners` /
 * `DeployRunners` / `DevRunners` conventions.
 */
export interface KeyRunners {
  /** Generate a fresh Ed25519 key pair (raw bytes + PEM serialization). */
  readonly generateKeyPair: () => Promise<GeneratedKeyPair>;
  /** `mkdir -p` with a specific mode (0o700 for the keys dir). */
  readonly mkdir: (path: string, mode: number) => Promise<void>;
  /** Write `contents` to `path` with the given mode. Never overwrites — the caller pre-checks. */
  readonly writeFile: (opts: WriteFileOptions) => Promise<void>;
  /**
   * Read `path` as UTF-8. Returns `null` if the file does not exist;
   * throws for any other IO error. Used by `export` (reads the pub PEM)
   * + `list` (existence probe).
   */
  readonly readFile: (path: string) => Promise<string | null>;
  /**
   * Directory listing. Returns an empty array when the directory does
   * not exist. Anything else throws.
   */
  readonly readdir: (path: string) => Promise<readonly KeyDirEntry[]>;
  /**
   * `stat`-style existence probe. Returns `true` if a file exists at
   * `path`, `false` otherwise. Used to enforce the refuse-to-overwrite
   * contract on `key create`.
   */
  readonly exists: (path: string) => Promise<boolean>;
}
