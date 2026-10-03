// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { databaseUrlFrom, googleCredentialsPath } from '../src/dev/defaults.js';
import {
  type RuntimeContainerOptions,
  runtimeContainerName,
  runtimeRunArgs,
} from '../src/dev/runtime-container.js';

const OPTIONS: RuntimeContainerOptions = {
  image: 'quay.io/kindgi/runtime:preview',
  packDir: '/home/dev/acme-pack',
  envFile: '/home/dev/acme-pack/.kindgi/dev/runtime.env',
  network: 'alias',
  hostPort: 4100,
  onLog: () => undefined,
};

describe('runtimeRunArgs', () => {
  test('Docker Desktop: the API on host loopback only, the pack at /pack, the host alias', () => {
    expect(runtimeRunArgs('kindgi-dev-runtime-x', OPTIONS)).toEqual([
      'run',
      '--detach',
      '--rm',
      '--name',
      'kindgi-dev-runtime-x',
      '--env-file',
      OPTIONS.envFile,
      '--volume',
      '/home/dev/acme-pack:/pack',
      '--publish',
      '127.0.0.1:4100:4000',
      '--add-host',
      'host.docker.internal:host-gateway',
      'quay.io/kindgi/runtime:preview',
      '--console-static-dir',
      '/app/console',
      '--dev-echo-provider',
    ]);
  });

  test('Linux: host networking as the developer, credentials mounted read-only', () => {
    const args = runtimeRunArgs('n', {
      ...OPTIONS,
      network: 'host-network',
      googleCredentials: '/home/dev/.config/gcloud/application_default_credentials.json',
      publicTokenKey: '/home/dev/keys/public-token.pem',
    });
    expect(args).toContain('--network');
    expect(args[args.indexOf('--network') + 1]).toBe('host');
    expect(args).not.toContain('--publish');
    if (typeof process.getuid === 'function') {
      expect(args[args.indexOf('--user') + 1]).toBe(`${process.getuid()}:${process.getgid?.()}`);
    }
    expect(args).toContain(
      '/home/dev/.config/gcloud/application_default_credentials.json:/run/kindgi/google-credentials.json:ro',
    );
    expect(args).toContain(
      '/home/dev/keys/public-token.pem:/run/kindgi/public-token-signing.pem:ro',
    );
  });

  test('one container per pack directory', () => {
    const a = runtimeContainerName('/home/dev/acme-pack');
    expect(a).toMatch(/^kindgi-dev-runtime-[0-9a-f]{12}$/);
    expect(runtimeContainerName('/home/dev/acme-pack')).toBe(a);
    expect(runtimeContainerName('/home/dev/other-pack')).not.toBe(a);
  });
});

describe('databaseUrlFrom', () => {
  test('through the alias, a loopback database host becomes host.docker.internal', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(databaseUrlFrom(`postgres://kindgi:pw@${host}:55432/kindgi`, 'alias')).toBe(
        'postgres://kindgi:pw@host.docker.internal:55432/kindgi',
      );
    }
    expect(databaseUrlFrom('postgres://kindgi:pw@db.internal:5432/kindgi', 'alias')).toBe(
      'postgres://kindgi:pw@db.internal:5432/kindgi',
    );
  });

  test('with host networking, unchanged', () => {
    expect(databaseUrlFrom('postgres://kindgi:pw@127.0.0.1:55432/kindgi', 'host-network')).toBe(
      'postgres://kindgi:pw@127.0.0.1:55432/kindgi',
    );
  });
});

describe('googleCredentialsPath', () => {
  test('GOOGLE_APPLICATION_CREDENTIALS when it exists, else the gcloud ADC file, else none', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kindgi-home-'));
    try {
      expect(googleCredentialsPath({ HOME: home })).toBeUndefined();
      const adcDir = join(home, '.config', 'gcloud');
      await import('node:fs/promises').then((fs) => fs.mkdir(adcDir, { recursive: true }));
      const adc = join(adcDir, 'application_default_credentials.json');
      await writeFile(adc, '{}');
      expect(googleCredentialsPath({ HOME: home })).toBe(adc);
      const explicit = join(home, 'sa.json');
      await writeFile(explicit, '{}');
      expect(googleCredentialsPath({ HOME: home, GOOGLE_APPLICATION_CREDENTIALS: explicit })).toBe(
        explicit,
      );
      expect(
        googleCredentialsPath({
          HOME: home,
          GOOGLE_APPLICATION_CREDENTIALS: join(home, 'gone.json'),
        }),
      ).toBe(adc);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
