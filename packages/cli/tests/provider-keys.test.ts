// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The names model providers resolve their keys from (`env/provider-keys.ts`):
 * what `kindgi dev` keeps out of the pack service and `kindgi secrets copy`
 * copies. Names only, never a value.
 */

import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { DeclaredProvider } from '../src/dev/providers.js';
import {
  declaredProviderKeyNames,
  providerKeysRecordPath,
  readProviderKeysRecord,
  runtimeProviderKeyNames,
  writeProviderKeysRecord,
} from '../src/env/provider-keys.js';
import { loadProviderPresets } from '../src/providers/preset-loader.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-provider-keys-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const declared = (id: string, ref?: { envName: string; name: string }): DeclaredProvider =>
  ({
    id,
    input: {
      adapter_id: 'x',
      metadata: { id, region: 'unspecified', models: [] },
      ...(ref !== undefined && { secret_ref: ref }),
    },
  }) as unknown as DeclaredProvider;

describe('declaredProviderKeyNames', () => {
  test('the local secret_ref names only', () => {
    expect(
      declaredProviderKeyNames([
        declared('anthropic', { envName: 'local', name: 'ANTHROPIC_API_KEY' }),
        declared('openai', { envName: 'staging', name: 'OPENAI_API_KEY' }),
        declared('gemini'),
      ]),
    ).toEqual(new Set(['ANTHROPIC_API_KEY']));
  });
});

describe('runtimeProviderKeyNames', () => {
  test("a check's secretRef names the key; a preset's name is the fallback for one without", async () => {
    const presets = await loadProviderPresets();
    const checks: Record<string, { secretRef?: { envName: string; name: string } }> = {
      'my-anthropic': { secretRef: { envName: 'local', name: 'ACME_CLAUDE_KEY' } },
      'other-env': { secretRef: { envName: 'staging', name: 'STAGING_KEY' } },
      // An older runtime's check: no secretRef; the id is a preset's.
      openai: {},
      // No secretRef and no preset with this id: nothing.
      'dev-echo': {},
    };
    const names = await runtimeProviderKeyNames({
      providers: [
        { id: 'my-anthropic' },
        { id: 'other-env' },
        { id: 'openai' },
        { id: 'dev-echo' },
        { id: 'groq' },
      ],
      check: async (id) => {
        const c = checks[id];
        if (c === undefined) throw new Error('404');
        return c;
      },
      presets,
    });
    // `groq`'s check failed (a runtime before the check route): its preset's name.
    expect(names).toEqual(new Set(['ACME_CLAUDE_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY']));
  });
});

describe('the record', () => {
  test('names only, sorted, 0600; read back as a set', async () => {
    await mkdir(join(dir, '.kindgi', 'dev'), { recursive: true });
    await writeProviderKeysRecord(dir, new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']));

    expect(JSON.parse(await readFile(providerKeysRecordPath(dir), 'utf8'))).toEqual({
      names: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    });
    expect((await stat(providerKeysRecordPath(dir))).mode & 0o777).toBe(0o600);
    expect(await readProviderKeysRecord(dir)).toEqual(
      new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']),
    );
  });

  test('no record: an empty set', async () => {
    expect(await readProviderKeysRecord(dir)).toEqual(new Set());
  });
});
