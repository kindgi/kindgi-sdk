// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for the writable dev-mode dotenv `SecretBinding`. Uses a real
 * tmp pack directory per test so filesystem semantics (perms, atomicity,
 * ENOENT handling) are exercised end-to-end.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Scope } from '@kindgi/platform';
import type { EnvName, TenantId } from '@kindgi/types';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createDotenvSecretBinding } from '../src/index.js';

let packDir: string;

const TENANT: TenantId = 'tenant-test' as TenantId;
const SCOPE: Scope = { kind: 'tenant', tenantId: TENANT };
const ENV: EnvName = 'local' as EnvName;

const NULL_HOOK = () => [] as const;

const RESOLVE_CTX = { caller: 'dispatch' as const };

beforeEach(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-secrets-dotenv-'));
});

afterEach(async () => {
  await rm(packDir, { recursive: true, force: true });
});

describe('SecretBinding.set — create-new', () => {
  test('writes to a fresh .env.<envName> file', async () => {
    const binding = createDotenvSecretBinding({ packDir });
    const outcome = await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'ANTHROPIC_API_KEY',
      value: 'sk-ant-xxxxxxxx',
      writeMode: 'create-new',
      enqueueTuples: NULL_HOOK,
    });

    expect(outcome.kind).toBe('ok');
    const contents = await readFile(join(packDir, '.env.local'), 'utf8');
    expect(contents).toBe('ANTHROPIC_API_KEY=sk-ant-xxxxxxxx\n');
  });

  test('appends to an existing file, preserving unrelated entries + comments', async () => {
    await writeFile(join(packDir, '.env.local'), '# header\nAAA=1\n\n# for bbb\nBBB=2\n', 'utf8');
    const binding = createDotenvSecretBinding({ packDir });
    await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'CCC',
      value: 'newval',
      writeMode: 'create-new',
      enqueueTuples: NULL_HOOK,
    });

    const contents = await readFile(join(packDir, '.env.local'), 'utf8');
    expect(contents).toBe('# header\nAAA=1\n\n# for bbb\nBBB=2\nCCC=newval\n');
  });

  test('returns already-exists when the key is present', async () => {
    await writeFile(join(packDir, '.env.local'), 'ANTHROPIC_API_KEY=sk-old\n', 'utf8');
    const binding = createDotenvSecretBinding({ packDir });
    const outcome = await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'ANTHROPIC_API_KEY',
      value: 'sk-new',
      writeMode: 'create-new',
      enqueueTuples: NULL_HOOK,
    });

    expect(outcome.kind).toBe('already-exists');
    // Original value untouched.
    const contents = await readFile(join(packDir, '.env.local'), 'utf8');
    expect(contents).toBe('ANTHROPIC_API_KEY=sk-old\n');
  });

  test('invokes enqueueTuples exactly once on fresh insert', async () => {
    const calls: string[] = [];
    const binding = createDotenvSecretBinding({ packDir });
    await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'FRESH',
      value: 'v',
      writeMode: 'create-new',
      enqueueTuples: (id) => {
        calls.push(id);
        return [];
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('SecretBinding.set — add-version', () => {
  test('overwrites an existing key in place', async () => {
    await writeFile(
      join(packDir, '.env.local'),
      'AAA=1\nANTHROPIC_API_KEY=sk-old\nBBB=2\n',
      'utf8',
    );
    const binding = createDotenvSecretBinding({ packDir });
    const outcome = await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'ANTHROPIC_API_KEY',
      value: 'sk-new',
      writeMode: 'add-version',
      enqueueTuples: NULL_HOOK,
    });

    expect(outcome.kind).toBe('ok');
    const contents = await readFile(join(packDir, '.env.local'), 'utf8');
    expect(contents).toBe('AAA=1\nANTHROPIC_API_KEY=sk-new\nBBB=2\n');
  });

  test('creates the key when absent even under add-version (upsert-like)', async () => {
    await writeFile(join(packDir, '.env.local'), 'AAA=1\n', 'utf8');
    const binding = createDotenvSecretBinding({ packDir });
    const outcome = await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'BBB',
      value: '2',
      writeMode: 'add-version',
      enqueueTuples: NULL_HOOK,
    });

    expect(outcome.kind).toBe('ok');
    const contents = await readFile(join(packDir, '.env.local'), 'utf8');
    expect(contents).toBe('AAA=1\nBBB=2\n');
  });

  test('does NOT invoke enqueueTuples when the key already exists', async () => {
    await writeFile(join(packDir, '.env.local'), 'FOO=old\n', 'utf8');
    const calls: string[] = [];
    const binding = createDotenvSecretBinding({ packDir });
    await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'FOO',
      value: 'new',
      writeMode: 'add-version',
      enqueueTuples: (id) => {
        calls.push(id);
        return [];
      },
    });

    expect(calls).toHaveLength(0);
  });
});

describe('SecretBinding.set — ifVersion', () => {
  test('accepts ifVersion=1 (the only version dotenv exposes)', async () => {
    await writeFile(join(packDir, '.env.local'), 'FOO=old\n', 'utf8');
    const binding = createDotenvSecretBinding({ packDir });
    const outcome = await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'FOO',
      value: 'new',
      writeMode: 'add-version',
      ifVersion: 1,
      enqueueTuples: NULL_HOOK,
    });

    expect(outcome.kind).toBe('ok');
  });

  test('returns version-conflict when ifVersion !== 1', async () => {
    await writeFile(join(packDir, '.env.local'), 'FOO=old\n', 'utf8');
    const binding = createDotenvSecretBinding({ packDir });
    const outcome = await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'FOO',
      value: 'new',
      writeMode: 'add-version',
      ifVersion: 7,
      enqueueTuples: NULL_HOOK,
    });

    expect(outcome).toEqual({ kind: 'version-conflict', currentVersion: 1 });
  });
});

describe('SecretBinding.set — file permissions', () => {
  test('newly created file has mode 0600', async () => {
    const binding = createDotenvSecretBinding({ packDir });
    await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'FOO',
      value: 'bar',
      writeMode: 'create-new',
      enqueueTuples: NULL_HOOK,
    });

    const info = await stat(join(packDir, '.env.local'));
    expect(info.mode & 0o777).toBe(0o600);
  });

  test('subsequent writes enforce 0600 even if the file was loose beforehand', async () => {
    const target = join(packDir, '.env.local');
    await writeFile(target, 'FOO=old\n', { mode: 0o644 });
    const binding = createDotenvSecretBinding({ packDir });
    await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'FOO',
      value: 'new',
      writeMode: 'add-version',
      enqueueTuples: NULL_HOOK,
    });

    const info = await stat(target);
    expect(info.mode & 0o777).toBe(0o600);
  });
});

describe('SecretBinding.resolve — round-trips values written by set', () => {
  test('resolve returns the value just written', async () => {
    const binding = createDotenvSecretBinding({ packDir });
    await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'ANTHROPIC_API_KEY',
      value: 'sk-ant-xxxxxxxx',
      writeMode: 'create-new',
      enqueueTuples: NULL_HOOK,
    });

    const outcome = await binding.resolve({
      scope: SCOPE,
      envName: ENV,
      name: 'ANTHROPIC_API_KEY',
      resolveContext: RESOLVE_CTX,
    });

    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.value.value).toBe('sk-ant-xxxxxxxx');
      expect(outcome.value.versionId).toBe(1);
    }
  });

  test('resolve reflects add-version overwrites', async () => {
    const binding = createDotenvSecretBinding({ packDir });
    await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'FOO',
      value: 'v1',
      writeMode: 'create-new',
      enqueueTuples: NULL_HOOK,
    });
    await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'FOO',
      value: 'v2',
      writeMode: 'add-version',
      enqueueTuples: NULL_HOOK,
    });

    const outcome = await binding.resolve({
      scope: SCOPE,
      envName: ENV,
      name: 'FOO',
      resolveContext: RESOLVE_CTX,
    });
    expect(outcome.kind === 'ok' && outcome.value.value).toBe('v2');
  });
});

describe('SecretBinding — rotate/revoke stay unsupported', () => {
  test('rotate is unsupported by design (501), with a message pointing at add-version', async () => {
    const binding = createDotenvSecretBinding({ packDir });
    const outcome = await binding.rotate({
      scope: SCOPE,
      envName: ENV,
      name: 'FOO',
    });

    expect(outcome.kind).toBe('err');
    if (outcome.kind === 'err') {
      expect(outcome.error.code).toBe('secret-operation-unsupported');
      expect(outcome.error.message).toContain('add-version');
    }
  });

  test('revoke is unsupported by design (501), naming the env files to edit', async () => {
    const binding = createDotenvSecretBinding({ packDir });
    const outcome = await binding.revoke({
      scope: SCOPE,
      envName: ENV,
      name: 'FOO',
    });

    expect(outcome.kind).toBe('err');
    if (outcome.kind === 'err') {
      expect(outcome.error.code).toBe('secret-operation-unsupported');
      expect(outcome.error.message).toContain('.env, .env.local');
    }
  });
});
