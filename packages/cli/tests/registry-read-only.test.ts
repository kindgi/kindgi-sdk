// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { KindgiApiError } from '@kindgi/client';

import { runCli } from '../src/main.js';

let home: string;
let cwd: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const REASON =
  "Under kindgi dev, the pack is the source of agents: edit the pack's file and kindgi dev reloads it.";

describe('a write to a read-only registry', () => {
  test('kindgi agents publish says why, plainly, tagged with the reason code', async () => {
    const out = await runCli({
      argv: [
        'agents',
        'publish',
        '--spec={"id":"acme.intake","version":"1.0.0"}',
        '--project=p-1',
        '--url=https://x',
        '--token=t',
      ],
      env: {},
      cwd,
      home,
      clientFactory: () =>
        ({
          agents: {
            define: async () => {
              throw new KindgiApiError({
                code: 'conflict',
                message: REASON,
                reason: 'registry-read-only',
              } as never);
            },
          },
        }) as never,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(`Error [registry-read-only]: ${REASON}`);
    expect(out.stderr).not.toContain('already registered');
  });
});
