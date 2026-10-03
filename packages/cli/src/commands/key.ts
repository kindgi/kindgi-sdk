// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi key` — local Ed25519 signing-key lifecycle.
 *
 * FULLY LOCAL. Reads + writes files under `<home>/.kindgi/keys/`.
 * `SigningKeyBinding` is a runtime primitive with no HTTP admin
 * surface yet, so there is no `push` / `pull` / `rotate` / `delete`.
 *
 * Subcommands:
 *   - `create <keyId> [--env <name>] [--home <dir>]`
 *   - `export <keyId> [--format=pem|base64|raw-hex] [--home <dir>]`
 *   - `list [--home <dir>]`
 *
 * Every filesystem side-effect flows through `KeyRunners` so tests
 * substitute stubs — no real key files touch disk during unit tests.
 * Production wiring lives at `packages/cli/src/key/defaults.ts`.
 */

import { parsePublicKeyPem, serializePublicKeyBase64 } from '@kindgi/crypto';

import type { CommandContext } from '../context.js';
import { shortFingerprint } from '../key/fingerprint.js';
import {
  KEYS_DIR_MODE,
  KEY_ID_REGEX,
  PRIVATE_KEY_FILE_MODE,
  PUBLIC_KEY_FILE_MODE,
  pickHome,
  resolveKeyPaths,
} from '../key/paths.js';
import type { KeyRunners } from '../key/runners.js';
import { renderJson } from '../output.js';
import type { Command, CommandResult, LeafCommand } from './types.js';

// ---------------------------------------------------------------------
// Common: runner + home resolution
// ---------------------------------------------------------------------

function pickRunners(
  ctx: CommandContext,
):
  | { readonly kind: 'ok'; readonly runners: KeyRunners }
  | (CommandResult & { readonly kind: 'error' }) {
  if (ctx.keyRunners !== undefined) return { kind: 'ok', runners: ctx.keyRunners };
  return {
    kind: 'error',
    stderr:
      'Internal error: kindgi key requires key runners to be wired. ' +
      'Rebuild the CLI (`pnpm --filter @kindgi/cli build`).\n',
    exitCode: 1,
  };
}

function pickHomeFromCtx(ctx: CommandContext): string {
  const flag = ctx.options.home;
  return pickHome({
    ...(typeof flag === 'string' && flag !== '' ? { flag } : {}),
    ...(ctx.home !== undefined ? { ctxHome: ctx.home } : {}),
    ...(typeof ctx.env.HOME === 'string' && ctx.env.HOME !== '' ? { envHome: ctx.env.HOME } : {}),
  });
}

function validateKeyId(
  id: string | undefined,
): { ok: true; id: string } | { ok: false; error: string } {
  if (id === undefined || id === '') {
    return { ok: false, error: 'Missing required argument: <keyId>.' };
  }
  if (!KEY_ID_REGEX.test(id)) {
    return {
      ok: false,
      error: `Invalid keyId: "${id}". Must match ${KEY_ID_REGEX.source} — lowercase alphanumerics + [-._], starting with an alphanumeric.`,
    };
  }
  return { ok: true, id };
}

// ---------------------------------------------------------------------
// `kindgi key create <keyId> [--env <name>] [--home <dir>]`
// ---------------------------------------------------------------------

const createCmd: LeafCommand = {
  kind: 'leaf',
  name: 'create',
  description: 'Generate a new Ed25519 keypair under ~/.kindgi/keys/.',
  usage: 'kindgi key create <keyId> [--env <name>] [--home <dir>]',
  optionSpec: {
    env: {
      type: 'string',
      description:
        'Also print the `signingKey` and `signerKeyId` lines to add to this env block in `kindgi.config.ts`.',
    },
    home: {
      type: 'string',
      description: 'The home directory whose `.kindgi/keys/` holds the keys. Default: `$HOME`.',
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    const idCheck = validateKeyId(ctx.positionals[0]);
    if (!idCheck.ok) {
      return { kind: 'error', stderr: `${idCheck.error}\n`, exitCode: 1 };
    }
    const keyId = idCheck.id;

    const runnersOutcome = pickRunners(ctx);
    if (runnersOutcome.kind === 'error') return runnersOutcome;
    const runners = runnersOutcome.runners;

    const home = pickHomeFromCtx(ctx);
    const paths = resolveKeyPaths(home);
    const privPath = paths.privateKeyPath(keyId);
    const pubPath = paths.publicKeyPath(keyId);

    // Refuse to overwrite — regenerating a key silently would clobber
    // production signing material.
    if (await runners.exists(privPath)) {
      return {
        kind: 'error',
        stderr: `kindgi key create refuses to overwrite: ${privPath} already exists. Delete the existing pair (or pick a different --home) and re-run.\n`,
        exitCode: 1,
      };
    }
    if (await runners.exists(pubPath)) {
      return {
        kind: 'error',
        stderr: `kindgi key create refuses to overwrite: ${pubPath} already exists. Delete the existing pair (or pick a different --home) and re-run.\n`,
        exitCode: 1,
      };
    }

    const pair = await runners.generateKeyPair();
    await runners.mkdir(paths.keysDir, KEYS_DIR_MODE);
    await runners.writeFile({
      path: privPath,
      contents: pair.privateKeyPem,
      mode: PRIVATE_KEY_FILE_MODE,
    });
    await runners.writeFile({
      path: pubPath,
      contents: pair.publicKeyPem,
      mode: PUBLIC_KEY_FILE_MODE,
    });

    const fingerprint = shortFingerprint(pair.publicKey);

    const envFlag = ctx.options.env;
    const envName = typeof envFlag === 'string' && envFlag !== '' ? envFlag : undefined;

    const banner: string[] = [
      '',
      `  ✓ Ed25519 keypair created: ${keyId}`,
      `    private key:  ${privPath}  (mode 0600)`,
      `    public key:   ${pubPath}  (mode 0644)`,
      `    fingerprint:  ${fingerprint}`,
      '',
    ];
    if (envName !== undefined) {
      banner.push(
        `  Next step: add to environments.${envName} in kindgi.config.ts:`,
        '',
        `    ${envName}: {`,
        '      // …existing fields…',
        `      signingKey: '~/.kindgi/keys/${keyId}.pem',`,
        `      signerKeyId: '${keyId}',`,
        '    },',
        '',
        `  Then \`kindgi build --env=${envName}\` will pick up the key.`,
        '',
      );
    }

    const summary = {
      keyId,
      privateKeyPath: privPath,
      publicKeyPath: pubPath,
      fingerprint,
      home,
      ...(envName !== undefined && { env: envName }),
    };
    const rendered = renderJson(summary, ctx.globals.format);
    return {
      kind: 'ok',
      rendered: { stdout: rendered.stdout, stderr: `${banner.join('\n')}\n` },
    };
  },
};

// ---------------------------------------------------------------------
// `kindgi key export <keyId> [--format=pem|base64|raw-hex]`
// ---------------------------------------------------------------------

const AVAILABLE_FORMATS = ['pem', 'base64', 'raw-hex'] as const;
type PublicKeyFormat = (typeof AVAILABLE_FORMATS)[number];

const exportCmd: LeafCommand = {
  kind: 'leaf',
  name: 'export',
  description: 'Print the PUBLIC key material for a local key. Never exports the private key.',
  usage: 'kindgi key export <keyId> [--format=pem|base64|raw-hex] [--home <dir>]',
  optionSpec: {
    format: {
      type: 'string',
      description: "The public key's encoding: `pem` (default), `base64` or `raw-hex`.",
    },
    home: {
      type: 'string',
      description: 'The home directory whose `.kindgi/keys/` holds the keys. Default: `$HOME`.',
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    const idCheck = validateKeyId(ctx.positionals[0]);
    if (!idCheck.ok) {
      return { kind: 'error', stderr: `${idCheck.error}\n`, exitCode: 1 };
    }
    const keyId = idCheck.id;

    const formatFlag = ctx.options.format;
    const formatInput = typeof formatFlag === 'string' && formatFlag !== '' ? formatFlag : 'pem';
    if (!(AVAILABLE_FORMATS as readonly string[]).includes(formatInput)) {
      return {
        kind: 'error',
        stderr: `Unknown --format: ${formatInput}. Available: ${AVAILABLE_FORMATS.join(', ')}.\n`,
        exitCode: 1,
      };
    }
    const format = formatInput as PublicKeyFormat;

    const runnersOutcome = pickRunners(ctx);
    if (runnersOutcome.kind === 'error') return runnersOutcome;
    const runners = runnersOutcome.runners;

    const home = pickHomeFromCtx(ctx);
    const paths = resolveKeyPaths(home);
    const pubPath = paths.publicKeyPath(keyId);

    const pubPem = await runners.readFile(pubPath);
    if (pubPem === null) {
      return {
        kind: 'error',
        stderr:
          `kindgi key export: no public key at ${pubPath}. ` +
          `Run \`kindgi key create ${keyId}\` first, or pass --home <dir>.\n`,
        exitCode: 1,
      };
    }

    if (format === 'pem') {
      return {
        kind: 'ok',
        rendered: { stdout: ensureTrailingNewline(pubPem), stderr: '' },
      };
    }

    const parsed = parsePublicKeyPem(pubPem);
    if (parsed.kind === 'err') {
      return {
        kind: 'error',
        stderr:
          `kindgi key export: ${pubPath} is not a valid Ed25519 public key PEM: ` +
          `${parsed.error.message}\n`,
        exitCode: 1,
      };
    }
    if (format === 'base64') {
      return {
        kind: 'ok',
        rendered: {
          stdout: `${serializePublicKeyBase64(parsed.value)}\n`,
          stderr: '',
        },
      };
    }
    // raw-hex
    return {
      kind: 'ok',
      rendered: { stdout: `${bytesToHex(parsed.value)}\n`, stderr: '' },
    };
  },
};

// ---------------------------------------------------------------------
// `kindgi key list [--home <dir>]`
// ---------------------------------------------------------------------

const listCmd: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List local Ed25519 keys under ~/.kindgi/keys/.',
  usage: 'kindgi key list [--home <dir>]',
  optionSpec: {
    home: {
      type: 'string',
      description: 'The home directory whose `.kindgi/keys/` holds the keys. Default: `$HOME`.',
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    const runnersOutcome = pickRunners(ctx);
    if (runnersOutcome.kind === 'error') return runnersOutcome;
    const runners = runnersOutcome.runners;

    const home = pickHomeFromCtx(ctx);
    const paths = resolveKeyPaths(home);

    const entries = await runners.readdir(paths.keysDir);
    const fileNames = new Set(entries.filter((e) => e.isFile).map((e) => e.name));

    // Match `<keyId>.pem` iff `<keyId>.pub.pem` also present. Orphaned
    // halves (private only or public only) are silently skipped — the
    // pair contract is the whole point of the list.
    const keyIds: string[] = [];
    for (const name of fileNames) {
      if (!name.endsWith('.pem') || name.endsWith('.pub.pem')) continue;
      const stem = name.slice(0, -'.pem'.length);
      const pubName = `${stem}.pub.pem`;
      if (!fileNames.has(pubName)) continue;
      keyIds.push(stem);
    }
    keyIds.sort();

    const rows = await Promise.all(
      keyIds.map(async (keyId) => {
        const pubPath = paths.publicKeyPath(keyId);
        const pem = await runners.readFile(pubPath);
        const fingerprint = pem !== null ? shortFingerprint(pem) : 'sha256:(unreadable)';
        return {
          keyId,
          privateKeyPath: paths.privateKeyPath(keyId),
          publicKeyPath: pubPath,
          fingerprint,
        };
      }),
    );

    const summary = { keysDir: paths.keysDir, count: rows.length, keys: rows };

    if (rows.length === 0) {
      const rendered = renderJson(summary, ctx.globals.format);
      return {
        kind: 'ok',
        rendered: {
          stdout: rendered.stdout,
          stderr: `\n  (no keys under ${paths.keysDir})\n\n`,
        },
      };
    }

    const banner: string[] = ['', `  ${rows.length} key(s) under ${paths.keysDir}:`, ''];
    for (const row of rows) {
      banner.push(`    ${row.keyId}    ${row.fingerprint}`);
      banner.push(`      private:  ${row.privateKeyPath}`);
      banner.push(`      public:   ${row.publicKeyPath}`);
    }
    banner.push('');

    const rendered = renderJson(summary, ctx.globals.format);
    return {
      kind: 'ok',
      rendered: { stdout: rendered.stdout, stderr: `${banner.join('\n')}\n` },
    };
  },
};

// ---------------------------------------------------------------------
// Group registration
// ---------------------------------------------------------------------

export const keyCommand: Command = {
  kind: 'group',
  name: 'key',
  description: "Manage the tenant's local Ed25519 signing keys under ~/.kindgi/keys/.",
  subcommands: [createCmd, exportCmd, listCmd],
};

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    s += b.toString(16).padStart(2, '0');
  }
  return s;
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}
