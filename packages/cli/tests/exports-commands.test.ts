// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi exports verify` and `kindgi approvals export`: a signed export
 * checks out against its own key (with a note that anyone could have
 * signed it), against --trust keys, or against the runtime's listed keys;
 * a changed byte or a stranger's key exits 1. `approvals export` names a
 * signing key only when asked.
 */

import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

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

const pemOf = (key: ReturnType<typeof generateKeyPairSync>['publicKey']) =>
  key.export({ type: 'spki', format: 'pem' }).toString();

/** A signed export file, as `kindgi provenance export > file` writes one; and its key. */
async function exportFile(tamper = false) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const exportedAt = '2026-10-08T00:00:00.000Z';
  const bytes = Buffer.from(
    JSON.stringify({ bundleSchemaVersion: '1.2.0', exportedAt, runId: 'run-1' }),
  );
  const shipped = tamper ? Buffer.from(bytes.toString().replace('run-1', 'run-2')) : bytes;
  const envelope = {
    runId: 'run-1',
    kind: 'provenance',
    bundle: shipped.toString('base64'),
    bundleSchemaVersion: '1.2.0',
    algorithm: 'ed25519',
    signingKeyId: 'ex_testkey0000000',
    signature: sign(null, bytes, privateKey).toString('base64'),
    publicKey: pemOf(publicKey),
    canonicalization: 'sorted-key-json',
    exportedAt,
  };
  const file = join(cwd, 'export.json');
  await writeFile(file, JSON.stringify(envelope));
  const keyFile = join(cwd, 'key.pem');
  await writeFile(keyFile, pemOf(publicKey));
  return { file, keyFile, pem: pemOf(publicKey) };
}

async function cli(argv: readonly string[], listed: readonly string[] = []) {
  const calls: unknown[][] = [];
  const out = await runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        exportSigningKeys: {
          list: async () => {
            calls.push(['exportSigningKeys.list']);
            return listed.map((publicKeyPem) => ({ keyId: 'ex_k', publicKeyPem }));
          },
        },
        approvals: {
          audit: {
            export: async (input: unknown) => {
              calls.push(['approvals.audit.export', input]);
              return { approvalId: 'a-1', bundle: '' };
            },
          },
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi exports verify', () => {
  test('its own key: exit 0, with a note that anyone could have signed it', async () => {
    const { file } = await exportFile();
    const { out } = await cli(['exports', 'verify', file]);
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({
      valid: true,
      kind: 'provenance',
      checkedAgainst: 'its-own-key',
    });
    expect(out.stderr).toContain('anyone could have signed it');
  });

  test('--trust with its key: exit 0, no note; a stranger key: exit 1, saying so', async () => {
    const { file, keyFile } = await exportFile();
    const trusted = await cli(['exports', 'verify', file, `--trust=${keyFile}`]);
    expect(trusted.out.exitCode).toBe(0);
    expect(trusted.out.stderr).toBe('');
    const stranger = join(cwd, 'stranger.pem');
    await writeFile(stranger, pemOf(generateKeyPairSync('ed25519').publicKey));
    const refused = await cli(['exports', 'verify', file, `--trust=${stranger}`]);
    expect(refused.out.exitCode).toBe(1);
    expect(JSON.parse(refused.out.stdout).issues.join(' ')).toContain("isn't one you trust");
  });

  test("--from-runtime pins the runtime's listed keys; none listed is an error", async () => {
    const { file, pem } = await exportFile();
    const pinned = await cli(['exports', 'verify', file, '--from-runtime'], [pem]);
    expect(pinned.out.exitCode).toBe(0);
    expect(pinned.calls).toEqual([['exportSigningKeys.list']]);
    const none = await cli(['exports', 'verify', file, '--from-runtime'], []);
    expect(none.out.exitCode).not.toBe(0);
    expect(none.out.stderr).toContain("doesn't sign exports");
  });

  test('a changed byte: exit 1; a file that is no export: an error naming what is missing', async () => {
    const { file } = await exportFile(true);
    const changed = await cli(['exports', 'verify', file]);
    expect(changed.out.exitCode).toBe(1);
    expect(JSON.parse(changed.out.stdout).issues.join(' ')).toContain("doesn't match");
    const other = join(cwd, 'other.json');
    await writeFile(other, '{"hello":"world"}');
    const notOne = await cli(['exports', 'verify', other]);
    expect(notOne.out.exitCode).not.toBe(0);
    expect(notOne.out.stderr).toContain("isn't a signed export");
  });
});

describe('kindgi approvals export', () => {
  test('signs with the active key unless --signing-key names one', async () => {
    const plain = await cli(['approvals', 'export', 'a-1']);
    expect(plain.out.exitCode).toBe(0);
    expect(plain.calls).toEqual([['approvals.audit.export', { approvalId: 'a-1' }]]);
    const named = await cli([
      'approvals',
      'export',
      'a-1',
      '--signing-key=ex_k',
      '--include-messages',
    ]);
    expect(named.calls).toEqual([
      [
        'approvals.audit.export',
        { approvalId: 'a-1', signingKeyId: 'ex_k', includeMessages: true },
      ],
    ]);
  });
});
