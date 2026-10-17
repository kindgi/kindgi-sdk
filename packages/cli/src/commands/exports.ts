// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';

import { verifySignedExport } from '@kindgi/client';
import type { SignedExportEnvelope } from '@kindgi/client';

import { UsageError } from '../errors.js';
import { createExport } from '../exports/create.js';
import type { Manifest } from '../exports/create.js';
import { EXPORT_PLAN } from '../exports/plan.js';
import { createReader } from '../exports/reader.js';
import type { Reader } from '../exports/reader.js';
import { renderJson } from '../output.js';
import { CLI_VERSION } from '../version-info.js';
import { commandResultFromThrown, listFlag, requiredPositional, stringFlag } from './helpers.js';
import type { Command, CommandResult, LeafCommand } from './types.js';

const verify: LeafCommand = {
  kind: 'leaf',
  name: 'verify',
  description:
    "Check a signed export (an approval's audit bundle, a run's provenance, compliance evidence): that its bytes are the ones signed, and, with --trust or --from-runtime, who signed them. Exit 0 when it checks out, 1 when it doesn't.",
  usage: 'kindgi exports verify <file> [--trust=<public-key.pem>]... [--from-runtime]',
  optionSpec: {
    trust: {
      type: 'string',
      multiple: true,
      description: 'A public key file (PEM) you trust. Repeat for several.',
    },
    'from-runtime': {
      type: 'boolean',
      description: 'Trust the keys the runtime signs exports with (`GET /v1/export-signing-keys`).',
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    try {
      const file = requiredPositional(ctx, 0, 'file');
      const envelope = parseEnvelope(await readFile(file, 'utf8'), file);
      const trusted = await Promise.all(listFlag(ctx, 'trust').map((p) => readFile(p, 'utf8')));
      const fromRuntime = ctx.options['from-runtime'] === true;
      if (fromRuntime) {
        const keys = await ctx.client().exportSigningKeys.list();
        if (keys.length === 0) {
          throw new Error(
            "The runtime lists no export signing keys: it doesn't sign exports. Pass --trust=<public-key.pem> instead.",
          );
        }
        trusted.push(...keys.map((k) => k.publicKeyPem));
      }
      const pinned = trusted.length > 0;
      const checked = await verifySignedExport(envelope, pinned ? { trustedKeys: trusted } : {});
      const rendered = renderJson(
        {
          valid: checked.valid,
          ...(envelope.kind !== undefined && { kind: envelope.kind }),
          signingKeyId: checked.signingKeyId,
          checkedAgainst: checked.checkedAgainst,
          ...(checked.issues !== undefined && { issues: checked.issues }),
          ...(checked.notes !== undefined && { notes: checked.notes }),
        },
        ctx.globals.format,
      );
      const note =
        checked.valid && !pinned
          ? "Checked against the export's own key only: its bytes are unchanged, but anyone could have signed it. Pass --from-runtime, or --trust=<public-key.pem>, to know who did.\n"
          : '';
      return {
        kind: 'ok',
        rendered: { stdout: rendered.stdout, stderr: rendered.stderr + note },
        exitCode: checked.valid ? 0 : 1,
      };
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'exports verify');
    }
  },
};

function parseEnvelope(text: string, file: string): SignedExportEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} isn't JSON: ${(err as Error).message}`);
  }
  const fields = ['bundle', 'signature', 'publicKey', 'signingKeyId'] as const;
  const record = value as Record<string, unknown> | null;
  const missing = fields.filter((f) => typeof record?.[f] !== 'string');
  if (missing.length > 0) {
    throw new Error(
      `${file} isn't a signed export: it has no ${missing.join(', ')}. Export one with kindgi approvals export or kindgi provenance export.`,
    );
  }
  return value as SignedExportEnvelope;
}

const create: LeafCommand = {
  kind: 'leaf',
  name: 'create',
  description:
    "Export the whole workspace as files: every kind of record the API reads, one JSON line per record, as the API answers it, and the signed exports (each decided approval's audit bundle, each run's provenance, the compliance evidence). Run it as a tenant admin. manifest.json says what each file holds. Exit 0 when every kind is exported or skipped, 1 when any failed.",
  usage: 'kindgi exports create --out <dir> [--resume] [--no-signed] [--yes]',
  optionSpec: {
    out: {
      type: 'string',
      description:
        'The folder to write the export to: a new or empty one, or, with --resume, one an export stopped in.',
    },
    resume: {
      type: 'boolean',
      description:
        'Finish the export in --out: the kinds its manifest.json marks ok are kept, and the rest are read again.',
    },
    'no-signed': {
      type: 'boolean',
      description:
        "Don't make the signed exports: fewer requests, and no `export-signed` audit events.",
    },
    yes: {
      type: 'boolean',
      description:
        "Export as someone who isn't a tenant admin: the kinds only a tenant admin reads are skipped.",
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    try {
      const out = stringFlag(ctx, 'out');
      if (out === undefined || out === '') {
        throw new UsageError('Name the folder to write the export to: --out <dir>.');
      }
      const seam = ctx.exportsSeam ?? {};
      const reader = createReader({
        fetch: ctx.fetch,
        apiUrl: ctx.apiUrl(),
        token: ctx.token(),
        stopSignal: ctx.stopSignal,
        rateLimitWaits: ctx.rateLimitWaits,
        ...(seam.pause !== undefined && { pause: seam.pause }),
      });
      const { tenantId, admin } = await caller(reader);
      if (!admin && ctx.options.yes !== true) {
        const skipped = EXPORT_PLAN.filter((k) => k.admin === true).map((k) => k.name);
        throw new Error(
          `You aren't a tenant admin here, so the export would skip ${skipped.join(', ')}, and hold only what you may read of the rest. Run it as a tenant admin, or pass --yes to export what you can.`,
        );
      }
      const manifest = await createExport({
        out,
        resume: ctx.options.resume === true,
        signed: ctx.options['no-signed'] !== true,
        admin,
        tenantId,
        reader,
        server: ctx.apiUrl().replace(/\/+$/, ''),
        cliVersion: CLI_VERSION,
        progress:
          seam.progress ??
          ((line) => {
            process.stderr.write(line);
          }),
        ...(seam.now !== undefined && { now: seam.now }),
        ...(ctx.stopSignal !== undefined && { stopSignal: ctx.stopSignal }),
      });
      const failed = Object.values(manifest.kinds).some((k) => k.status === 'failed');
      const stopped = manifest.finishedAt === undefined;
      const exitCode = stopped ? 130 : failed ? 1 : 0;
      if (ctx.globals.formatRequested && ctx.globals.format === 'json') {
        return { kind: 'ok', rendered: renderJson(manifest, 'json'), exitCode };
      }
      return { kind: 'ok', rendered: { stdout: summary(manifest, out), stderr: '' }, exitCode };
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'exports create');
    }
  },
};

/**
 * The caller's tenant, and whether they're its admin, as whoami answers:
 * it's always served, unlike `me/permissions`, which a runtime without an
 * authorization store answers `501`.
 */
async function caller(
  reader: Reader,
): Promise<{ readonly tenantId: string; readonly admin: boolean }> {
  const me = (await reader.one('/v1/identity/whoami')) as {
    tenantId?: unknown;
    tenantAdmin?: unknown;
    scopes?: unknown;
    role?: unknown;
    projectId?: unknown;
  };
  if (typeof me.tenantId !== 'string' || me.tenantId === '') {
    throw new Error(
      'GET /v1/identity/whoami answered no tenantId, so the export has no tenant to name.',
    );
  }
  // A server that answers no `tenantAdmin` says it by the key, as its admin
  // routes decide it without an authorizer: the `tenant-admin` scope of a
  // full key, never a `member` key's or one limited to a project.
  const admin =
    typeof me.tenantAdmin === 'boolean'
      ? me.tenantAdmin
      : Array.isArray(me.scopes) &&
        me.scopes.includes('tenant-admin') &&
        me.role !== 'member' &&
        me.projectId === undefined;
  return { tenantId: me.tenantId, admin };
}

/** What the export holds, in a few lines. */
function summary(manifest: Manifest, out: string): string {
  const outcomes = Object.entries(manifest.kinds);
  const count = (status: string) => outcomes.filter(([, k]) => k.status === status).length;
  const lines = [
    manifest.finishedAt === undefined
      ? `Stopped. The export in ${out} is unfinished: run it again with --resume to finish it.`
      : `Exported to ${out}: ${count('ok')} kinds written, ${count('skipped')} skipped, ${count('failed')} failed. manifest.json says what each file holds.`,
  ];
  for (const [name, k] of outcomes) {
    if (k.status === 'failed') lines.push(`  ${name}: failed, ${k.error}`);
  }
  if (count('failed') > 0) lines.push('Run it again with --resume to read the failed kinds again.');
  return `${lines.join('\n')}\n`;
}

export const exportsCommand: Command = {
  kind: 'group',
  name: 'exports',
  description: 'Exports: create an export of the whole workspace as files, or verify a signed one.',
  subcommands: [create, verify],
};
