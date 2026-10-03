// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi secrets` — full lifecycle over the API's `/v1/secrets/*`
 * routes via the SDK's `SecretsClient`.
 *
 * Every verb requires `--env=<name>` + `--scope=<kind>[:id]`. Scope is
 * mandatory until the CLI resolves a global `--project`. Value input on `set` and `rotate` follows a strict
 * fail-loud contract:
 *
 *   - **Default:** interactive TTY prompt with echo disabled + one-time
 *     confirmation. Rejects if stdin is not a TTY.
 *   - `--from-stdin`: read from stdin (for pipelines / CI).
 *   - `--from-file <path>`: read from file; rejects if file mode includes
 *     group/world-read (fs.stat().mode & 0o077 !== 0).
 *
 * Never echoes values. Success messages carry NAME + scope + env only.
 */

import { readFile, stat } from 'node:fs/promises';
import { EOL } from 'node:os';
import * as readline from 'node:readline';
import type { ReadStream } from 'node:tty';

import type {
  RotationOutcome,
  SecretRecord,
  SecretVersionRecord,
  SecretsClient,
} from '@kindgi/client';
import type { Scope } from '@kindgi/platform';
import type { EnvName } from '@kindgi/types';

import type { CommandContext } from '../context.js';
import type { EnvRunners } from '../env/runners.js';
import { renderJson } from '../output.js';
import { commandResultFromThrown, integerFlag, requiredPositional, stringFlag } from './helpers.js';
import type { Command, CommandResult, LeafCommand } from './types.js';

// ---------------------------------------------------------------------
// Shared option spec — every leaf command carries these plus its own.
// ---------------------------------------------------------------------

const SCOPE_OPTION_SPEC = {
  env: { type: 'string' as const },
  scope: { type: 'string' as const },
};

// ---------------------------------------------------------------------
// Scope + env parsing
// ---------------------------------------------------------------------

interface ScopeAndEnv {
  readonly scope: Scope;
  readonly envName: EnvName;
}

type ScopeResult =
  | { readonly kind: 'ok'; readonly value: ScopeAndEnv }
  | { readonly kind: 'err'; readonly stderr: string };

/**
 * Parse `--scope=<kind>[:id]`. Every value the CLI accepts
 * maps to a `Scope` from `@kindgi/platform`. `tenantId` is
 * synthesized as a placeholder — the server derives the real tenantId
 * from the session bearer; the CLI just needs the discriminant + id.
 */
function parseScopeAndEnv(ctx: CommandContext): ScopeResult {
  const envName = stringFlag(ctx, 'env');
  if (envName === undefined) {
    return {
      kind: 'err',
      stderr:
        'Missing required flag: --env=<name>.\nEvery `kindgi secrets` command requires --env; secrets are per-environment.\n',
    };
  }
  const rawScope = stringFlag(ctx, 'scope');
  if (rawScope === undefined) {
    return {
      kind: 'err',
      stderr:
        'Missing required flag: --scope=<kind>[:id].\nAccepted forms:\n  --scope=tenant\n  --scope=org:<orgId>\n  --scope=project:<projectId>\n(--scope is required: there is no default scope yet.)\n',
    };
  }
  const [kind, id] = rawScope.split(':');
  const tenantId = 'session-tenant' as unknown as Scope extends { tenantId: infer T } ? T : never;
  if (kind === 'tenant') {
    if (id !== undefined && id !== '') {
      return {
        kind: 'err',
        stderr: `Malformed --scope: tenant scope carries no id, got "${rawScope}".\n`,
      };
    }
    return {
      kind: 'ok',
      value: { scope: { kind: 'tenant', tenantId }, envName: envName as unknown as EnvName },
    };
  }
  if (kind === 'org') {
    if (id === undefined || id === '') {
      return {
        kind: 'err',
        stderr: `Malformed --scope: expected --scope=org:<orgId>, got "${rawScope}".\n`,
      };
    }
    return {
      kind: 'ok',
      value: {
        scope: { kind: 'org', tenantId, orgId: id as never },
        envName: envName as unknown as EnvName,
      },
    };
  }
  if (kind === 'project') {
    if (id === undefined || id === '') {
      return {
        kind: 'err',
        stderr: `Malformed --scope: expected --scope=project:<projectId>, got "${rawScope}".\n`,
      };
    }
    return {
      kind: 'ok',
      value: {
        scope: { kind: 'project', tenantId, projectId: id as never },
        envName: envName as unknown as EnvName,
      },
    };
  }
  return {
    kind: 'err',
    stderr: `Unknown --scope kind "${String(kind)}".\nAccepted: tenant, org:<orgId>, project:<projectId>.\n`,
  };
}

// ---------------------------------------------------------------------
// Value input — TTY prompt / --from-stdin / --from-file
// ---------------------------------------------------------------------

interface ValueInputConfig {
  readonly fromStdin: boolean;
  readonly fromFile: string | undefined;
  /**
   * Injectable readline seam for tests. Production leaves undefined and
   * we spin up a real `readline.Interface` bound to
   * `process.stdin` / `process.stderr`.
   */
  readonly tty?: TtySeam;
  /**
   * Injectable stdin reader for `--from-stdin` (tests bypass
   * `process.stdin`).
   */
  readonly readStdin?: () => Promise<string>;
  /** Injectable file reader (tests bypass fs). */
  readonly readFileAt?: (path: string) => Promise<string>;
  /** Injectable file stat (tests inject a mode). */
  readonly statFile?: (path: string) => Promise<{ mode: number }>;
  /**
   * Injectable TTY-check for stdin. Tests can force TTY / non-TTY
   * without a real terminal.
   */
  readonly stdinIsTty?: () => boolean;
}

/**
 * Read a secret value from one of three sources per canonical
 * decision #2. Result carries the raw bytes only; callers must never
 * echo or log the return value.
 */
async function readValueInput(
  cfg: ValueInputConfig,
): Promise<{ kind: 'ok'; value: string } | { kind: 'err'; stderr: string }> {
  const chosen = [cfg.fromStdin, cfg.fromFile !== undefined].filter(Boolean).length;
  if (chosen > 1) {
    return {
      kind: 'err',
      stderr: 'Mutually exclusive flags: --from-stdin and --from-file cannot be combined.\n',
    };
  }

  if (cfg.fromFile !== undefined) {
    const path = cfg.fromFile;
    const statImpl = cfg.statFile ?? (async (p: string) => await stat(p));
    let info: { mode: number };
    try {
      info = await statImpl(path);
    } catch (err) {
      return {
        kind: 'err',
        stderr: `Cannot read --from-file "${path}": ${(err as Error).message}\n`,
      };
    }
    // Reject if group/world can read (mode bits 0o077 nonzero).
    if ((info.mode & 0o077) !== 0) {
      const octal = (info.mode & 0o777).toString(8).padStart(4, '0');
      return {
        kind: 'err',
        stderr:
          `Refusing to read "${path}": file mode ${octal} allows group/world read. ` +
          `Restrict to 0600 (chmod 600 ${path}) and retry.\nSecrets on disk must be readable by their owner only.\n`,
      };
    }
    const readImpl = cfg.readFileAt ?? (async (p: string) => await readFile(p, 'utf8'));
    try {
      const raw = await readImpl(path);
      return { kind: 'ok', value: stripTrailingNewline(raw) };
    } catch (err) {
      return { kind: 'err', stderr: `Failed to read "${path}": ${(err as Error).message}\n` };
    }
  }

  if (cfg.fromStdin) {
    const reader = cfg.readStdin ?? readStdinToEnd;
    try {
      const raw = await reader();
      return { kind: 'ok', value: stripTrailingNewline(raw) };
    } catch (err) {
      return { kind: 'err', stderr: `Failed to read stdin: ${(err as Error).message}\n` };
    }
  }

  // Default: TTY prompt.
  const stdinIsTty = cfg.stdinIsTty ?? (() => Boolean((process.stdin as ReadStream).isTTY));
  if (!stdinIsTty()) {
    return {
      kind: 'err',
      stderr:
        'Refusing to read from non-TTY stdin without --from-stdin. ' +
        'Pipe the value via `--from-stdin`, or use `--from-file <path>` (mode 0600), or run interactively.\n',
    };
  }

  const tty = cfg.tty ?? realTtySeam();
  try {
    const first = await tty.promptHidden('Value: ');
    const second = await tty.promptHidden('Re-enter to confirm: ');
    if (first !== second) {
      return { kind: 'err', stderr: 'Values did not match. Aborted.\n' };
    }
    if (first.length === 0) {
      return { kind: 'err', stderr: 'Empty value refused.\n' };
    }
    return { kind: 'ok', value: first };
  } finally {
    tty.close();
  }
}

function stripTrailingNewline(s: string): string {
  if (s.endsWith(EOL)) return s.slice(0, -EOL.length);
  if (s.endsWith('\n')) return s.slice(0, -1);
  return s;
}

async function readStdinToEnd(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------
// TTY prompt seam
// ---------------------------------------------------------------------

export interface TtySeam {
  promptHidden(prompt: string): Promise<string>;
  close(): void;
}

function realTtySeam(): TtySeam {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  // Silence output while user types. `readline` doesn't expose a
  // built-in "no-echo" mode; the standard trick is to override the
  // internal `_writeToOutput` on the interface. This is portable
  // enough across Node 22.x + prints only the prompt itself.
  const rlAny = rl as unknown as {
    _writeToOutput?: (s: string) => void;
    output?: NodeJS.WritableStream;
  };
  return {
    promptHidden: (prompt) =>
      new Promise<string>((resolve) => {
        const originalWrite = rlAny._writeToOutput;
        rlAny._writeToOutput = function overrideWrite(str: string): void {
          // Write only the prompt itself (rl.question emits the
          // prompt via the same channel); swallow keystrokes.
          if (str === prompt) {
            (rlAny.output ?? process.stderr).write(str);
          }
        };
        rl.question(prompt, (answer) => {
          if (originalWrite !== undefined) {
            rlAny._writeToOutput = originalWrite;
          } else {
            // biome-ignore lint/performance/noDelete: readline distinguishes missing property from undefined
            delete rlAny._writeToOutput;
          }
          (rlAny.output ?? process.stderr).write('\n');
          resolve(answer);
        });
      }),
    close: () => {
      rl.close();
    },
  };
}

// ---------------------------------------------------------------------
// SDK client access
// ---------------------------------------------------------------------

function secretsFrom(ctx: CommandContext): SecretsClient {
  return ctx.client().secrets;
}

// ---------------------------------------------------------------------
// list
// ---------------------------------------------------------------------

const listCmd: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List secret metadata under --scope + --env. Never returns values.',
  usage:
    'kindgi secrets list --env=<name> --scope=<kind>[:id] [--include-revoked] [--name-prefix=<p>] [--cursor=<c>] [--limit=<n>]',
  optionSpec: {
    ...SCOPE_OPTION_SPEC,
    'include-revoked': { type: 'boolean' as const },
    'name-prefix': { type: 'string' as const },
    cursor: { type: 'string' as const },
    limit: { type: 'string' as const },
  },
  run: async (ctx): Promise<CommandResult> => {
    const parsed = parseScopeAndEnv(ctx);
    if (parsed.kind === 'err') return { kind: 'error', stderr: parsed.stderr, exitCode: 2 };
    try {
      const page = await secretsFrom(ctx).list({
        scope: parsed.value.scope,
        envName: parsed.value.envName,
        ...(ctx.options['include-revoked'] === true && { includeRevoked: true }),
        ...(stringFlag(ctx, 'name-prefix') !== undefined && {
          namePrefix: stringFlag(ctx, 'name-prefix')!,
        }),
        ...(stringFlag(ctx, 'cursor') !== undefined && {
          cursor: stringFlag(ctx, 'cursor')! as never,
        }),
        ...(stringFlag(ctx, 'limit') !== undefined && {
          limit: integerFlag(ctx, 'limit')!,
        }),
      });
      return { kind: 'ok', rendered: renderJson(page, ctx.globals.format) };
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'kindgi secrets list');
    }
  },
};

// ---------------------------------------------------------------------
// get
// ---------------------------------------------------------------------

const getCmd: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch secret metadata (name + version + timestamps only, NEVER the value).',
  usage: 'kindgi secrets get <NAME> --env=<name> --scope=<kind>[:id]',
  optionSpec: SCOPE_OPTION_SPEC,
  run: async (ctx): Promise<CommandResult> => {
    const parsed = parseScopeAndEnv(ctx);
    if (parsed.kind === 'err') return { kind: 'error', stderr: parsed.stderr, exitCode: 2 };
    let name: string;
    try {
      name = requiredPositional(ctx, 0, 'NAME');
    } catch (err) {
      return { kind: 'error', stderr: `${(err as Error).message}\n`, exitCode: 2 };
    }
    try {
      const rec = await secretsFrom(ctx).get({
        scope: parsed.value.scope,
        envName: parsed.value.envName,
        name,
      });
      if (rec === null) {
        return {
          kind: 'error',
          stderr: `No secret "${name}" at scope ${describeScope(parsed.value.scope)} in env "${parsed.value.envName as unknown as string}".\n`,
          exitCode: 1,
        };
      }
      return { kind: 'ok', rendered: renderJson(sanitizeSecret(rec), ctx.globals.format) };
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'kindgi secrets get');
    }
  },
};

// ---------------------------------------------------------------------
// set
// ---------------------------------------------------------------------

/**
 * Injectable value-input seam so tests can drive the TTY / stdin /
 * file paths without a real terminal. Production `kindgi secrets`
 * commands don't consult this — they call `readValueInput` directly.
 */
export interface SecretsValueInputSeam {
  readonly tty?: TtySeam;
  readonly readStdin?: () => Promise<string>;
  readonly readFileAt?: (path: string) => Promise<string>;
  readonly statFile?: (path: string) => Promise<{ mode: number }>;
  readonly stdinIsTty?: () => boolean;
}

function valueInputSeamFromCtx(ctx: CommandContext): SecretsValueInputSeam {
  return ctx.secretsInputSeam ?? {};
}

const setCmd: LeafCommand = {
  kind: 'leaf',
  name: 'set',
  description:
    'Write a new secret value. Default: interactive TTY prompt. Use --from-stdin | --from-file for automation.',
  usage:
    'kindgi secrets set <NAME> --env=<name> --scope=<kind>[:id] [--write-mode=create-new|add-version] [--from-stdin | --from-file <path>] [--rotation-due-at=<iso>] [--if-version=<n>]',
  optionSpec: {
    ...SCOPE_OPTION_SPEC,
    'from-stdin': { type: 'boolean' as const },
    'from-file': { type: 'string' as const },
    'write-mode': { type: 'string' as const },
    'rotation-due-at': { type: 'string' as const },
    'if-version': { type: 'string' as const },
  },
  run: async (ctx): Promise<CommandResult> => {
    const parsed = parseScopeAndEnv(ctx);
    if (parsed.kind === 'err') return { kind: 'error', stderr: parsed.stderr, exitCode: 2 };
    let name: string;
    try {
      name = requiredPositional(ctx, 0, 'NAME');
    } catch (err) {
      return { kind: 'error', stderr: `${(err as Error).message}\n`, exitCode: 2 };
    }

    const seam = valueInputSeamFromCtx(ctx);
    const valueRes = await readValueInput({
      fromStdin: ctx.options['from-stdin'] === true,
      fromFile: stringFlag(ctx, 'from-file'),
      ...seam,
    });
    if (valueRes.kind === 'err') {
      return { kind: 'error', stderr: valueRes.stderr, exitCode: 1 };
    }

    const writeModeRaw = stringFlag(ctx, 'write-mode') ?? 'create-new';
    if (writeModeRaw !== 'create-new' && writeModeRaw !== 'add-version') {
      return {
        kind: 'error',
        stderr: `Invalid --write-mode "${writeModeRaw}". Accepted: create-new, add-version.\n`,
        exitCode: 2,
      };
    }

    try {
      const outcome = await secretsFrom(ctx).set({
        scope: parsed.value.scope,
        envName: parsed.value.envName,
        name,
        value: valueRes.value,
        writeMode: writeModeRaw,
        ...(stringFlag(ctx, 'rotation-due-at') !== undefined && {
          rotationDueAt: stringFlag(ctx, 'rotation-due-at')!,
        }),
        ...(stringFlag(ctx, 'if-version') !== undefined && {
          ifVersion: integerFlag(ctx, 'if-version')!,
        }),
      });

      if (outcome.kind === 'version-conflict') {
        return {
          kind: 'error',
          stderr: `Version conflict: ${name} already exists (version ${outcome.currentVersion}). To store a new version, retry with --write-mode=add-version${stringFlag(ctx, 'if-version') !== undefined ? ` --if-version=${outcome.currentVersion}` : ''}.\n`,
          exitCode: 1,
        };
      }
      const summary = {
        name,
        scope: parsed.value.scope,
        envName: parsed.value.envName as unknown as string,
        versionId: outcome.kind === 'ok' ? outcome.versionId : undefined,
      };
      const rendered = renderJson(summary, ctx.globals.format);
      return {
        kind: 'ok',
        rendered: {
          stdout: rendered.stdout,
          stderr: `\n  Set ${name} at ${describeScope(parsed.value.scope)} in ${parsed.value.envName as unknown as string}.\n\n`,
        },
      };
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'kindgi secrets set');
    }
  },
};

// ---------------------------------------------------------------------
// rotate
// ---------------------------------------------------------------------

const rotateCmd: LeafCommand = {
  kind: 'leaf',
  name: 'rotate',
  description:
    'Rotate a secret. Async providers polled to terminal; use --no-wait to bypass polling and return wire response.',
  usage:
    'kindgi secrets rotate <NAME> --env=<name> --scope=<kind>[:id] [--new-value | --from-stdin | --from-file <path>] [--revoke-old-after=<ms>] [--no-wait]',
  optionSpec: {
    ...SCOPE_OPTION_SPEC,
    'from-stdin': { type: 'boolean' as const },
    'from-file': { type: 'string' as const },
    'new-value': { type: 'boolean' as const },
    'revoke-old-after': { type: 'string' as const },
    'no-wait': { type: 'boolean' as const },
  },
  run: async (ctx): Promise<CommandResult> => {
    const parsed = parseScopeAndEnv(ctx);
    if (parsed.kind === 'err') return { kind: 'error', stderr: parsed.stderr, exitCode: 2 };
    let name: string;
    try {
      name = requiredPositional(ctx, 0, 'NAME');
    } catch (err) {
      return { kind: 'error', stderr: `${(err as Error).message}\n`, exitCode: 2 };
    }

    let newValue: string | undefined;
    if (
      ctx.options['new-value'] === true ||
      ctx.options['from-stdin'] === true ||
      stringFlag(ctx, 'from-file') !== undefined
    ) {
      const seam = valueInputSeamFromCtx(ctx);
      const valueRes = await readValueInput({
        fromStdin: ctx.options['from-stdin'] === true,
        fromFile: stringFlag(ctx, 'from-file'),
        ...seam,
      });
      if (valueRes.kind === 'err') {
        return { kind: 'error', stderr: valueRes.stderr, exitCode: 1 };
      }
      newValue = valueRes.value;
    }

    const revokeOldRaw = stringFlag(ctx, 'revoke-old-after');
    const revokeOldAfterMs = revokeOldRaw !== undefined ? Number(revokeOldRaw) : undefined;
    if (revokeOldAfterMs !== undefined && !Number.isFinite(revokeOldAfterMs)) {
      return {
        kind: 'error',
        stderr: `Invalid --revoke-old-after "${revokeOldRaw}": must be a number of milliseconds.\n`,
        exitCode: 2,
      };
    }

    try {
      const outcome = await secretsFrom(ctx).rotate({
        scope: parsed.value.scope,
        envName: parsed.value.envName,
        name,
        ...(newValue !== undefined && { newValue }),
        ...(revokeOldAfterMs !== undefined && { revokeOldAfterMs }),
        mode: ctx.options['no-wait'] === true ? 'raw' : 'wait-for-complete',
      });
      return renderRotationOutcome(ctx, name, parsed.value, outcome);
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'kindgi secrets rotate');
    }
  },
};

function renderRotationOutcome(
  ctx: CommandContext,
  name: string,
  target: ScopeAndEnv,
  outcome: RotationOutcome,
): CommandResult {
  if (outcome.kind === 'ok') {
    const summary = {
      name,
      scope: target.scope,
      envName: target.envName as unknown as string,
      newVersionId: outcome.newVersionId,
      oldVersionId: outcome.oldVersionId,
    };
    return {
      kind: 'ok',
      rendered: {
        stdout: renderJson(summary, ctx.globals.format).stdout,
        stderr: `\n  Rotated ${name} → v${outcome.newVersionId} (was v${outcome.oldVersionId}).\n\n`,
      },
    };
  }
  if (outcome.kind === 'raw') {
    return {
      kind: 'ok',
      rendered: renderJson({ raw: outcome.response }, ctx.globals.format),
    };
  }
  if (outcome.kind === 'timeout') {
    return {
      kind: 'error',
      stderr: `rotation still in progress; check status: kindgi secrets rotations get ${outcome.rotationId}\n`,
      exitCode: 1,
    };
  }
  if (outcome.kind === 'failed') {
    return {
      kind: 'error',
      stderr: `Rotation failed: ${outcome.error}\n`,
      exitCode: 1,
    };
  }
  return {
    kind: 'error',
    stderr: 'Rotation cancelled by the provider.\n',
    exitCode: 1,
  };
}

// ---------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------

const revokeCmd: LeafCommand = {
  kind: 'leaf',
  name: 'revoke',
  description:
    'Revoke a secret. Default: soft (keeps audit tombstone). --hard: cryptographic erasure.',
  usage: 'kindgi secrets revoke <NAME> --env=<name> --scope=<kind>[:id] [--hard] [--reason=<r>]',
  optionSpec: {
    ...SCOPE_OPTION_SPEC,
    hard: { type: 'boolean' as const },
    reason: { type: 'string' as const },
  },
  run: async (ctx): Promise<CommandResult> => {
    const parsed = parseScopeAndEnv(ctx);
    if (parsed.kind === 'err') return { kind: 'error', stderr: parsed.stderr, exitCode: 2 };
    let name: string;
    try {
      name = requiredPositional(ctx, 0, 'NAME');
    } catch (err) {
      return { kind: 'error', stderr: `${(err as Error).message}\n`, exitCode: 2 };
    }
    try {
      const out = await secretsFrom(ctx).revoke({
        scope: parsed.value.scope,
        envName: parsed.value.envName,
        name,
        ...(ctx.options.hard === true && { hard: true }),
        ...(stringFlag(ctx, 'reason') !== undefined && { reason: stringFlag(ctx, 'reason')! }),
      });
      const summary = {
        name,
        scope: parsed.value.scope,
        envName: parsed.value.envName as unknown as string,
        revoked: out.revoked,
        hard: out.hard,
      };
      return {
        kind: 'ok',
        rendered: {
          stdout: renderJson(summary, ctx.globals.format).stdout,
          stderr: `\n  ${out.hard ? 'HARD-revoked' : 'Revoked'} ${name} at ${describeScope(parsed.value.scope)} in ${parsed.value.envName as unknown as string}.\n\n`,
        },
      };
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'kindgi secrets revoke');
    }
  },
};

// ---------------------------------------------------------------------
// pull — writes metadata manifest to .secrets/<envName>/manifest.json
// ---------------------------------------------------------------------

const pullCmd: LeafCommand = {
  kind: 'leaf',
  name: 'pull',
  description: 'Fetch secret metadata into .secrets/<envName>/manifest.json. Never fetches bytes.',
  usage: 'kindgi secrets pull --env=<name> --scope=<kind>[:id] [--path <dir>]',
  optionSpec: {
    ...SCOPE_OPTION_SPEC,
    path: { type: 'string' as const },
  },
  run: async (ctx): Promise<CommandResult> => {
    const parsed = parseScopeAndEnv(ctx);
    if (parsed.kind === 'err') return { kind: 'error', stderr: parsed.stderr, exitCode: 2 };
    const runners = pickEnvRunners(ctx);
    if (runners === null) {
      return {
        kind: 'error',
        stderr:
          'Internal error: kindgi secrets pull requires env runners for the manifest write. ' +
          'Rebuild the CLI so the production wiring at packages/cli/src/env/defaults.ts is picked up.\n',
        exitCode: 1,
      };
    }
    const packDir = resolvePackDir(ctx);
    const manifestDir = `${packDir}/.secrets/${parsed.value.envName as unknown as string}`;
    const manifestPath = `${manifestDir}/manifest.json`;
    try {
      const records: SecretRecord[] = [];
      let cursor: string | undefined;
      // Cursor loop: pull all pages.
      for (let i = 0; i < 1_000; i += 1) {
        const page = await secretsFrom(ctx).list({
          scope: parsed.value.scope,
          envName: parsed.value.envName,
          ...(cursor !== undefined && { cursor: cursor as never }),
        });
        for (const r of page.data) records.push(r);
        if (page.nextCursor === undefined) break;
        cursor = page.nextCursor as unknown as string;
      }
      const manifest = {
        generatedAt: new Date().toISOString(),
        scope: parsed.value.scope,
        envName: parsed.value.envName as unknown as string,
        // Metadata only — value + tag payloads never cross into the manifest.
        secrets: records.map((r) => ({
          name: r.name,
          currentVersion: r.currentVersion,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          ...(r.revokedAt !== undefined && { revokedAt: r.revokedAt }),
          ...(r.rotationDueAt !== undefined && { rotationDueAt: r.rotationDueAt }),
        })),
      };
      await runners.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const summary = {
        manifestPath,
        count: records.length,
        envName: parsed.value.envName as unknown as string,
      };
      return {
        kind: 'ok',
        rendered: {
          stdout: renderJson(summary, ctx.globals.format).stdout,
          stderr: `\n  Wrote ${records.length} secret metadata entries → ${manifestPath}\n  (values NEVER cross the wire on pull.)\n\n`,
        },
      };
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'kindgi secrets pull');
    }
  },
};

function pickEnvRunners(ctx: CommandContext): EnvRunners | null {
  if (ctx.envRunners !== undefined) return ctx.envRunners;
  return null;
}

function resolvePackDir(ctx: CommandContext): string {
  const raw = ctx.options.path;
  if (typeof raw === 'string' && raw !== '') return raw;
  return ctx.cwd;
}

// ---------------------------------------------------------------------
// Group registration
// ---------------------------------------------------------------------

export const secretsCommand: Command = {
  kind: 'group',
  name: 'secrets',
  description: 'Manage per-environment secrets via the /v1/secrets/* wire.',
  subcommands: [listCmd, getCmd, setCmd, rotateCmd, revokeCmd, pullCmd],
};

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function describeScope(scope: Scope): string {
  if (scope.kind === 'tenant') return 'tenant';
  if (scope.kind === 'org') return `org:${scope.orgId as unknown as string}`;
  return `project:${scope.projectId as unknown as string}`;
}

function sanitizeSecret(rec: SecretRecord): Record<string, unknown> {
  // Structural: no `value` on SecretRecord. Kept as an explicit filter
  // so the CLI's output surface stays audit-obvious.
  return {
    name: rec.name,
    scope: rec.scope,
    envName: rec.envName as unknown as string,
    currentVersion: rec.currentVersion,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    ...(rec.revokedAt !== undefined && { revokedAt: rec.revokedAt }),
    ...(rec.revokeReason !== undefined && { revokeReason: rec.revokeReason }),
    ...(rec.rotationDueAt !== undefined && { rotationDueAt: rec.rotationDueAt }),
    ...(rec.tags !== undefined && { tags: rec.tags }),
  };
}

// Suppress unused import — `SecretVersionRecord` is only referenced in
// type comments today, but the shape is anticipated for `versions list`
// / `versions get` sub-verbs the docs call out.
void (undefined as unknown as SecretVersionRecord | undefined);
