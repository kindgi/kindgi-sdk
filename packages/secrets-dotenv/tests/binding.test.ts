// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for the writable dev-mode dotenv `SecretBinding`. Uses a real
 * tmp pack directory per test so filesystem semantics (perms, atomicity,
 * ENOENT handling) are exercised end-to-end.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

/** Kindgi's own secrets file and the app's highest-precedence file, in the tmp pack. */
const kindgiFile = (): string => join(packDir, '.kindgi', 'secrets.env');
const appFile = (): string => join(packDir, '.env.local');

async function writeKindgiFile(contents: string, mode = 0o600): Promise<void> {
  await mkdir(join(packDir, '.kindgi'), { recursive: true });
  await writeFile(kindgiFile(), contents, { mode });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("SecretBinding.set — create-new writes Kindgi's own file", () => {
  test(".kindgi/secrets.env, created; the app's .env.local isn't", async () => {
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
    expect(await readFile(kindgiFile(), 'utf8')).toBe('ANTHROPIC_API_KEY=sk-ant-xxxxxxxx\n');
    expect(await exists(appFile())).toBe(false);
  });

  test("leaves the app's .env and .env.local byte-identical, their modes too", async () => {
    await writeFile(join(packDir, '.env'), 'BASE=1\n', { mode: 0o644 });
    await writeFile(appFile(), '# mine\nAPP_ONLY=2\n', { mode: 0o644 });
    const binding = createDotenvSecretBinding({ packDir });
    await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'NEW_KEY',
      value: 'v',
      writeMode: 'create-new',
      enqueueTuples: NULL_HOOK,
    });

    expect(await readFile(join(packDir, '.env'), 'utf8')).toBe('BASE=1\n');
    expect(await readFile(appFile(), 'utf8')).toBe('# mine\nAPP_ONLY=2\n');
    expect((await stat(appFile())).mode & 0o777).toBe(0o644);
    expect(await readFile(kindgiFile(), 'utf8')).toBe('NEW_KEY=v\n');
  });

  test("appends to Kindgi's existing file, preserving unrelated entries + comments", async () => {
    await writeKindgiFile('# header\nAAA=1\n\n# for bbb\nBBB=2\n');
    const binding = createDotenvSecretBinding({ packDir });
    await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'CCC',
      value: 'newval',
      writeMode: 'create-new',
      enqueueTuples: NULL_HOOK,
    });

    expect(await readFile(kindgiFile(), 'utf8')).toBe(
      '# header\nAAA=1\n\n# for bbb\nBBB=2\nCCC=newval\n',
    );
  });

  test("returns already-exists when the key is in any file, the app's included", async () => {
    await writeFile(appFile(), 'ANTHROPIC_API_KEY=sk-old\n', 'utf8');
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
    expect(await readFile(appFile(), 'utf8')).toBe('ANTHROPIC_API_KEY=sk-old\n');
    expect(await exists(kindgiFile())).toBe(false);
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

describe("SecretBinding.set — appEnvFile writes the app's file", () => {
  test('advertises it', () => {
    expect(createDotenvSecretBinding({ packDir }).writesAppEnvFiles).toBe(true);
  });

  test(".env.local, its other lines and its mode kept; Kindgi's file untouched", async () => {
    await writeFile(appFile(), '# mine\nAPP_ONLY=2\n', { mode: 0o644 });
    const binding = createDotenvSecretBinding({ packDir });
    const outcome = await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'ACME_WEBHOOK_SECRET',
      value: 'whsec_x',
      writeMode: 'create-new',
      appEnvFile: true,
      enqueueTuples: NULL_HOOK,
    });

    expect(outcome.kind).toBe('ok');
    expect(await readFile(appFile(), 'utf8')).toBe(
      '# mine\nAPP_ONLY=2\nACME_WEBHOOK_SECRET=whsec_x\n',
    );
    expect((await stat(appFile())).mode & 0o777).toBe(0o644);
    expect(await exists(kindgiFile())).toBe(false);
  });

  test('with dev.envFiles, the last of them', async () => {
    const binding = createDotenvSecretBinding({ packDir, localEnvFiles: ['.env', '.env.dev'] });
    await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'SHARED',
      value: 'v',
      writeMode: 'create-new',
      appEnvFile: true,
      enqueueTuples: NULL_HOOK,
    });

    expect(await readFile(join(packDir, '.env.dev'), 'utf8')).toBe('SHARED=v\n');
  });

  test('a new app file is created 0600', async () => {
    const binding = createDotenvSecretBinding({ packDir });
    await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'SHARED',
      value: 'v',
      writeMode: 'create-new',
      appEnvFile: true,
      enqueueTuples: NULL_HOOK,
    });

    expect((await stat(appFile())).mode & 0o777).toBe(0o600);
  });
});

describe('SecretBinding.set — add-version', () => {
  test("overwrites an existing key in place in Kindgi's file", async () => {
    await writeKindgiFile('AAA=1\nANTHROPIC_API_KEY=sk-old\nBBB=2\n');
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
    expect(await readFile(kindgiFile(), 'utf8')).toBe('AAA=1\nANTHROPIC_API_KEY=sk-new\nBBB=2\n');
  });

  test("a key only in the app's file: the new value goes to Kindgi's, which wins; the app's line stays", async () => {
    await writeFile(appFile(), 'AAA=1\nANTHROPIC_API_KEY=sk-old\n', 'utf8');
    const binding = createDotenvSecretBinding({ packDir });
    await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'ANTHROPIC_API_KEY',
      value: 'sk-new',
      writeMode: 'add-version',
      enqueueTuples: NULL_HOOK,
    });

    expect(await readFile(appFile(), 'utf8')).toBe('AAA=1\nANTHROPIC_API_KEY=sk-old\n');
    expect(await readFile(kindgiFile(), 'utf8')).toBe('ANTHROPIC_API_KEY=sk-new\n');
    const resolved = await binding.resolve({
      scope: SCOPE,
      envName: ENV,
      name: 'ANTHROPIC_API_KEY',
      resolveContext: RESOLVE_CTX,
    });
    expect(resolved).toEqual({
      kind: 'ok',
      value: { name: 'ANTHROPIC_API_KEY', versionId: 1, value: 'sk-new' },
    });
  });

  test('creates the key when absent even under add-version (upsert-like)', async () => {
    await writeKindgiFile('AAA=1\n');
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
    expect(await readFile(kindgiFile(), 'utf8')).toBe('AAA=1\nBBB=2\n');
  });

  test('does NOT invoke enqueueTuples when the key already exists', async () => {
    await writeFile(appFile(), 'FOO=old\n', 'utf8');
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
    await writeFile(appFile(), 'FOO=old\n', 'utf8');
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
    await writeFile(appFile(), 'FOO=old\n', 'utf8');
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

describe("SecretBinding.set — Kindgi's file is owner-only", () => {
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

    expect((await stat(kindgiFile())).mode & 0o777).toBe(0o600);
  });

  test('subsequent writes enforce 0600 even if the file was loose beforehand', async () => {
    await writeKindgiFile('FOO=old\n', 0o644);
    const binding = createDotenvSecretBinding({ packDir });
    await binding.set({
      scope: SCOPE,
      envName: ENV,
      name: 'FOO',
      value: 'new',
      writeMode: 'add-version',
      enqueueTuples: NULL_HOOK,
    });

    expect((await stat(kindgiFile())).mode & 0o777).toBe(0o600);
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
