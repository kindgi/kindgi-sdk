// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { manifestLayers, migrationStage, pullProgress } from '../src/dev/runtime-container.js';
import {
  type StartPhases,
  createStartPhases,
  formatDuration,
  formatSize,
} from '../src/dev/start-phases.js';

describe("the runtime start's phases", () => {
  let lines: string[];
  let phases: StartPhases;

  beforeEach(() => {
    vi.useFakeTimers();
    lines = [];
    phases = createStartPhases({ emit: (line) => lines.push(line) });
  });

  afterEach(() => {
    phases.close();
    vi.useRealTimers();
  });

  test('a pull says its size at once, its progress every 3s, and its time at the end', () => {
    phases.begin('pull', 'quay.io/acme/runtime:1.0, 269 MB in 8 layers (first run only)');
    phases.progress('96.0 MB of 269 MB, 3 of 8 layers');
    vi.advanceTimersByTime(3000);
    phases.progress('180 MB of 269 MB, 6 of 8 layers');
    vi.advanceTimersByTime(3000);
    vi.advanceTimersByTime(1500);
    phases.end('269 MB');
    expect(lines).toEqual([
      '  ⋯ pulling the runtime image: quay.io/acme/runtime:1.0, 269 MB in 8 layers (first run only)',
      '  ⋯ pulling the runtime image: 96.0 MB of 269 MB, 3 of 8 layers (3s)',
      '  ⋯ pulling the runtime image: 180 MB of 269 MB, 6 of 8 layers (6s)',
      '  ✓ pulled the runtime image: 269 MB in 7.5s',
    ]);
  });

  test('container, migrating, waiting: waiting gives way to migrating without a line', () => {
    phases.begin('container');
    vi.advanceTimersByTime(400);
    phases.end();
    phases.begin('serve');
    vi.advanceTimersByTime(800);
    phases.begin('migrate');
    vi.advanceTimersByTime(6100);
    phases.end();
    phases.begin('serve');
    vi.advanceTimersByTime(1000);
    expect(lines).toEqual([
      '  ✓ started its container in 0.4s',
      '  ⋯ migrating the database (3s)',
      '  ⋯ migrating the database (6s)',
      '  ✓ migrated the database in 6.1s',
    ]);
    expect(phases.elapsedMs()).toBe(8300);
  });

  test('a runtime without migration records: the whole wait is waiting', () => {
    phases.begin('container');
    phases.end();
    phases.begin('serve');
    vi.advanceTimersByTime(6000);
    expect(lines.slice(1)).toEqual([
      '  ⋯ waiting for it to serve (3s)',
      '  ⋯ waiting for it to serve (6s)',
    ]);
  });

  test('once closed (served, failed or stopped), nothing more is said', () => {
    phases.begin('serve');
    phases.close();
    vi.advanceTimersByTime(9000);
    phases.begin('migrate');
    phases.end();
    expect(lines).toEqual([]);
  });
});

describe('formatDuration and formatSize', () => {
  test('durations as people say them', () => {
    expect(formatDuration(400)).toBe('0.4s');
    expect(formatDuration(9_949)).toBe('9.9s');
    expect(formatDuration(12_400)).toBe('12s');
    expect(formatDuration(65_000)).toBe('1m 05s');
  });

  test('sizes as docker states them (decimal units)', () => {
    expect(formatSize(812_000)).toBe('812 kB');
    expect(formatSize(48_210_000)).toBe('48.2 MB');
    expect(formatSize(269_277_995)).toBe('269 MB');
    expect(formatSize(1_240_000_000)).toBe('1.24 GB');
  });
});

/** `docker manifest inspect --verbose` for a two-platform image with attestations, trimmed. */
const VERBOSE_INDEX = JSON.stringify([
  {
    Ref: 'quay.io/acme/runtime:1.0@sha256:aaa',
    Descriptor: { platform: { architecture: 'amd64', os: 'linux' } },
    OCIManifest: {
      layers: [
        { digest: 'sha256:1111111111111111aaaa', size: 30_000_000 },
        { digest: 'sha256:2222222222222222aaaa', size: 200_000_000 },
      ],
    },
  },
  {
    Ref: 'quay.io/acme/runtime:1.0@sha256:bbb',
    Descriptor: { platform: { architecture: 'unknown', os: 'unknown' } },
    OCIManifest: { layers: [{ digest: 'sha256:attest', size: 1_000 }] },
  },
  {
    Ref: 'quay.io/acme/runtime:1.0@sha256:ccc',
    Descriptor: { platform: { architecture: 'arm64', os: 'linux' } },
    OCIManifest: {
      layers: [
        { digest: 'sha256:e3649207a629aaaa', size: 29_000_000 },
        { digest: 'sha256:5f2c8e7d1b0aaaaa', size: 210_000_000 },
        { digest: 'sha256:0b9d4a6c3e21aaaa', size: 30_000_000 },
      ],
    },
  },
]);

describe('manifestLayers', () => {
  test("an index: this machine's platform, not another's or an attestation", () => {
    expect(manifestLayers(VERBOSE_INDEX, 'linux/arm64')?.map((l) => l.size)).toEqual([
      29_000_000, 210_000_000, 30_000_000,
    ]);
    expect(manifestLayers(VERBOSE_INDEX, 'linux/amd64')).toHaveLength(2);
    expect(manifestLayers(VERBOSE_INDEX, 'linux/riscv64')).toBeUndefined();
  });

  test('one manifest (a single-platform image), Docker v2 or OCI', () => {
    const single = JSON.stringify({
      Ref: 'acme/runtime:1.0',
      Descriptor: { platform: { architecture: 'amd64', os: 'linux' } },
      SchemaV2Manifest: { layers: [{ digest: 'sha256:abc', size: 7 }] },
    });
    expect(manifestLayers(single, 'linux/arm64')).toEqual([{ digest: 'sha256:abc', size: 7 }]);
  });

  test("what isn't a manifest with sizes: undefined", () => {
    expect(manifestLayers('no such manifest', 'linux/arm64')).toBeUndefined();
    expect(manifestLayers('[]', 'linux/arm64')).toBeUndefined();
    expect(
      manifestLayers(JSON.stringify({ OCIManifest: { layers: [{ digest: 'x' }] } }), 'linux/arm64'),
    ).toBeUndefined();
  });
});

describe('pullProgress', () => {
  // `docker pull` without a terminal: a line per layer status, no byte counts.
  const PULL = [
    '1.0: Pulling from acme/runtime',
    'e3649207a629: Pulling fs layer',
    '5f2c8e7d1b0a: Pulling fs layer',
    '0b9d4a6c3e21: Already exists',
    'e3649207a629: Verifying Checksum',
    'e3649207a629: Download complete',
    'e3649207a629: Pull complete',
    '5f2c8e7d1b0a: Waiting',
    '5f2c8e7d1b0a: Download complete',
    '5f2c8e7d1b0a: Pull complete',
    'Digest: sha256:aaaa',
    'Status: Downloaded newer image for quay.io/acme/runtime:1.0',
  ];

  test('the bytes in are the sizes of the layers in, each counted once', () => {
    const progress = pullProgress(manifestLayers(VERBOSE_INDEX, 'linux/arm64'));
    expect(progress.totalBytes).toBe(269_000_000);
    expect(PULL.map((line) => progress.take(line)).filter((n) => n !== undefined)).toEqual([
      '30.0 MB of 269 MB, 1 of 3 layers',
      '59.0 MB of 269 MB, 2 of 3 layers',
      '269 MB of 269 MB, 3 of 3 layers',
    ]);
  });

  test("without the manifest's sizes, layers are counted", () => {
    const progress = pullProgress(undefined);
    expect(progress.totalBytes).toBe(0);
    expect(PULL.map((line) => progress.take(line)).filter((n) => n !== undefined)).toEqual([
      '1 layer in',
      '2 layers in',
      '3 layers in',
    ]);
  });
});

describe('migrationStage', () => {
  const record = (fields: Record<string, unknown>) =>
    JSON.stringify({
      time: '2026-10-10T22:00:00.000Z',
      level: 'info',
      severity: 'INFO',
      subsystem: 'migrations',
      message: 'm',
      ...fields,
    });

  test("the runtime's two records: start and done", () => {
    expect(migrationStage(record({ stage: 'start', steps: 17 }))).toBe('start');
    expect(migrationStage(record({ stage: 'done', durationMs: 2100 }))).toBe('done');
  });

  test('anything else is not', () => {
    expect(migrationStage(record({}))).toBeUndefined();
    expect(migrationStage(record({ level: 'error', stage: 'hook' }))).toBeUndefined();
    expect(migrationStage(record({ subsystem: 'boot', stage: 'start' }))).toBeUndefined();
    expect(migrationStage('migrating the database')).toBeUndefined();
  });
});
