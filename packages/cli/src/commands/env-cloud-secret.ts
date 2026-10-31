// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi env set/unset/list --cloud-secret --tenant=…`: the operator's
 * cloud secrets (`/v1/system/tenants/{tenantId}/env`). Each sets an env
 * name, at a scope of a tenant and one env, to a version of a secret the
 * operator's cloud holds, `projects/<project>/secrets/<secret>/versions/<number>`.
 * A pack service is given it by that name, and its host reads the value
 * as the pack service's own account: Kindgi keeps the name, never a value.
 * The token is a system key holding `system:env-refs`.
 *
 * A tenant sees only which names are set this way: `kindgi env list
 * --scope` prints them as `NAME (cloud secret)` (`env-scoped.ts`).
 */

import type { EnvCloudSecret, ScopeRef } from '@kindgi/client';
import type { EnvName } from '@kindgi/types';
import { parseCloudSecretVersion } from '@kindgi/types';

import type { CommandContext } from '../context.js';
import { extractKindgiError } from '../errors.js';
import { renderJson } from '../output.js';
import { type SaidLine, note, renderLines } from '../progress-lines.js';
import { describeScope, parseScope } from './env-scoped.js';
import { commandResultFromThrown, stringFlag } from './helpers.js';
import type { CommandResult } from './types.js';

interface CloudSecretTarget {
  readonly tenantId: string;
  readonly scope: ScopeRef;
  readonly envName: EnvName;
}

/** `--tenant`, `--scope` and `--env`, each required: the operator names where, always. */
function cloudSecretTarget(
  ctx: CommandContext,
  verb: 'set' | 'unset' | 'list',
):
  | { readonly kind: 'ok'; readonly target: CloudSecretTarget }
  | (CommandResult & { kind: 'error' }) {
  const tenantId = stringFlag(ctx, 'tenant');
  if (tenantId === undefined) {
    return {
      kind: 'error',
      stderr: `Missing required flag: --tenant=<tenantId>. \`kindgi env ${verb} --cloud-secret\` acts on a tenant's env as the operator, with a system key holding system:env-refs.\n`,
      exitCode: 2,
    };
  }
  const scope = parseScope(stringFlag(ctx, 'scope'));
  if (scope.kind === 'err') return { kind: 'error', stderr: scope.stderr, exitCode: 2 };
  const envName = stringFlag(ctx, 'env');
  if (envName === undefined) {
    return {
      kind: 'error',
      stderr:
        'Missing required flag: --env=<name>. A cloud secret is set under one env: name the one the runtime serves (`KINDGI_ENV`).\n',
      exitCode: 2,
    };
  }
  return {
    kind: 'ok',
    target: { tenantId, scope: scope.scope, envName: envName as EnvName },
  };
}

function where(t: CloudSecretTarget): string {
  return `${describeScope(t.scope)} in env ${t.envName as unknown as string} of tenant ${t.tenantId}`;
}

function ok(summary: unknown, ctx: CommandContext, lines: readonly SaidLine[]): CommandResult {
  const rendered = renderJson(summary, ctx.globals.format);
  const stderr = renderLines(lines, ctx.globals.format === 'quiet');
  return { kind: 'ok', rendered: { stdout: rendered.stdout, stderr } };
}

/** The refusals an operator meets, said plainly; anything else as thrown. */
function cloudSecretError(err: unknown, ctx: CommandContext, label: string): CommandResult {
  const wire = extractKindgiError(err);
  const code = wire !== null && 'serverCode' in wire ? wire.serverCode : undefined;
  const plain: Readonly<Record<string, string>> = {
    'cloud-secrets-unsupported':
      "this runtime doesn't set env names to cloud secrets (Kindgi Cloud keeps none).",
    'system-principal-required':
      'a cloud secret is set with a system key holding system:env-refs: set KINDGI_API_TOKEN to one.',
    'system-scope-missing':
      'this system key lacks system:env-refs: mint one that holds it (POST /v1/system/keys).',
    'system-key-scope-not-served':
      'this runtime serves one tenant, where a system key holds system:env-refs only when it runs a pack service per deployment.',
    'tenant-not-found': 'no tenant with that id.',
  };
  const said = code !== undefined ? plain[code] : undefined;
  if (said !== undefined) {
    return { kind: 'error', stderr: `${label}: ${said} (${code})\n`, exitCode: 1 };
  }
  return commandResultFromThrown(err, ctx, label);
}

/** Every one set at the target, all pages. */
async function listAll(
  ctx: CommandContext,
  t: CloudSecretTarget,
): Promise<readonly EnvCloudSecret[]> {
  const out: EnvCloudSecret[] = [];
  let cursor: string | undefined;
  const system = ctx.client().systemEnv;
  for (let i = 0; i < 1_000; i += 1) {
    const page = await system.listCloudSecrets({
      ...t,
      ...(cursor !== undefined && { cursor: cursor as never }),
    });
    out.push(...page.data);
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }
  return out;
}

/** `kindgi env set <KEY> --cloud-secret <path> --tenant=… --scope=… --env=… [--force]`. KEY is already checked. */
export async function setCloudSecret(
  ctx: CommandContext,
  key: string,
  raw: string,
): Promise<CommandResult> {
  const parsed = parseCloudSecretVersion(raw);
  if (parsed.kind === 'err') {
    return {
      kind: 'error',
      stderr: `kindgi env set --cloud-secret: ${parsed.message}\n`,
      exitCode: 2,
    };
  }
  const tt = cloudSecretTarget(ctx, 'set');
  if (tt.kind === 'error') return tt;
  const t = tt.target;
  try {
    const existing = (await listAll(ctx, t)).find((r) => r.name === key);
    if (existing !== undefined && existing.cloudSecret === raw && ctx.options.force !== true) {
      return ok(
        {
          tenantId: t.tenantId,
          envName: t.envName,
          scope: describeScope(t.scope),
          key,
          changed: false,
          revision: existing.revision,
        },
        ctx,
        [
          note(''),
          note(`  ✓ ${key} is already set to that cloud secret at ${where(t)}: no change.`),
          note(''),
        ],
      );
    }
    if (existing !== undefined && ctx.options.force !== true) {
      return {
        kind: 'error',
        stderr: `kindgi env set refuses to change ${key}, already set at ${where(t)} to ${existing.cloudSecret}. Re-run with --force to replace it.\n`,
        exitCode: 1,
      };
    }
    const outcome = await ctx.client().systemEnv.setCloudSecret({
      ...t,
      name: key,
      cloudSecret: raw,
      ...(existing !== undefined && { ifRevision: existing.revision }),
    });
    if (outcome.kind === 'revision-conflict') {
      return {
        kind: 'error',
        stderr: `kindgi env set: ${key} at ${where(t)} changed while this ran (now revision ${outcome.currentRevision}). Re-run to see it.\n`,
        exitCode: 1,
      };
    }
    return ok(
      {
        tenantId: t.tenantId,
        envName: t.envName,
        scope: describeScope(t.scope),
        key,
        cloudSecret: raw,
        changed: true,
        overwritten: existing !== undefined,
        revision: outcome.record.revision,
      },
      ctx,
      [
        note(''),
        note(
          `  ✓ ${existing !== undefined ? 'Updated' : 'Set'} ${key} at ${where(t)} to ${raw}. A pack service that declares it gets it at its next revision, read from the cloud as the pack service's own account: that account must be able to read this secret.`,
        ),
        note(''),
      ],
    );
  } catch (err) {
    return cloudSecretError(err, ctx, 'kindgi env set');
  }
}

/** `kindgi env unset <KEY> --cloud-secret --tenant=… --scope=… --env=…`. Idempotent. */
export async function unsetCloudSecret(ctx: CommandContext, key: string): Promise<CommandResult> {
  const tt = cloudSecretTarget(ctx, 'unset');
  if (tt.kind === 'error') return tt;
  const t = tt.target;
  try {
    const { deleted } = await ctx.client().systemEnv.deleteCloudSecret({ ...t, name: key });
    const outcome = deleted
      ? `Removed ${key}'s cloud secret at ${where(t)}. Its pack services lose it at their next revision.`
      : `${key} wasn't set to a cloud secret at ${where(t)}: no change.`;
    return ok(
      {
        tenantId: t.tenantId,
        envName: t.envName,
        scope: describeScope(t.scope),
        key,
        removed: deleted,
      },
      ctx,
      [note(''), note(`  ✓ ${outcome}`), note('')],
    );
  } catch (err) {
    return cloudSecretError(err, ctx, 'kindgi env unset');
  }
}

/** `kindgi env list --cloud-secret --tenant=… --scope=… --env=…`: the operator's view, with each path. */
export async function listCloudSecrets(ctx: CommandContext): Promise<CommandResult> {
  const tt = cloudSecretTarget(ctx, 'list');
  if (tt.kind === 'error') return tt;
  const t = tt.target;
  try {
    const records = listed(await listAll(ctx, t));
    const lines = [
      '',
      `  Tenant:    ${t.tenantId}`,
      `  Value set: ${t.envName as unknown as string}`,
      `  Scope:     ${describeScope(t.scope)}`,
      '',
      records.length === 0
        ? '  (no cloud secrets set here)'
        : `  ${records.length} cloud secret(s):`,
      ...records.map((r) => `    ${r.key.padEnd(24, ' ')} ${r.cloudSecret}`),
      '',
    ].map(note);
    return ok(
      {
        tenantId: t.tenantId,
        envName: t.envName,
        scope: describeScope(t.scope),
        count: records.length,
        cloudSecrets: records,
      },
      ctx,
      lines,
    );
  } catch (err) {
    return cloudSecretError(err, ctx, 'kindgi env list');
  }
}

function listed(records: readonly EnvCloudSecret[]) {
  return [...records]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((r) => ({
      key: r.name,
      cloudSecret: r.cloudSecret,
      revision: r.revision,
      updatedAt: r.updatedAt,
    }));
}
