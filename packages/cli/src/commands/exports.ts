// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';

import { verifySignedExport } from '@kindgi/client';
import type { SignedExportEnvelope } from '@kindgi/client';

import { renderJson } from '../output.js';
import { commandResultFromThrown, listFlag, requiredPositional } from './helpers.js';
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

export const exportsCommand: Command = {
  kind: 'group',
  name: 'exports',
  description: 'Signed exports: check one (an audit bundle, provenance, compliance evidence).',
  subcommands: [verify],
};
