// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi env set/list/unset --scope=…`: the runtime's env values
 * (`/v1/env`), which a tool that declares a name in `needsSpec.env` gets
 * as `ctx.env` on each call — the project's value, else its org's, else
 * the tenant's, in the env the runtime serves (`KINDGI_ENV`).
 *
 * Without `--scope`, those commands keep editing the pack's local env
 * files (`./env.ts`). `--env` is required with `--scope`, as for
 * `kindgi secrets`: a value under the wrong env name never resolves.
 */

import type { EnvRecord, ScopeRef } from '@kindgi/client';
import type { EnvName } from '@kindgi/types';

import type { CommandContext } from '../context.js';
import { extractKindgiError } from '../errors.js';
import { renderJson } from '../output.js';
import { commandResultFromThrown, stringFlag } from './helpers.js';
import type { CommandResult } from './types.js';

type ScopeParseResult =
  | { readonly kind: 'ok'; readonly scope: ScopeRef }
  | { readonly kind: 'err'; readonly stderr: string };

/** `--scope=tenant`, `--scope=org:<orgId>` or `--scope=project:<projectId>`. */
export function parseScope(raw: string | undefined): ScopeParseResult {
  if (raw === undefined) {
    return {
      kind: 'err',
      stderr:
        'Missing required flag: --scope=<kind>[:id].\n' +
        'Accepted forms:\n  --scope=tenant\n  --scope=org:<orgId>\n  --scope=project:<projectId>\n',
    };
  }
  const [kind, id] = raw.split(':');
  if (kind === 'tenant') {
    if (id !== undefined && id !== '') {
      return { kind: 'err', stderr: `Malformed --scope: tenant carries no id, got "${raw}".\n` };
    }
    return { kind: 'ok', scope: { kind: 'tenant' } };
  }
  if (kind === 'org') {
    if (id === undefined || id === '') {
      return {
        kind: 'err',
        stderr: `Malformed --scope: expected --scope=org:<orgId>, got "${raw}".\n`,
      };
    }
    return { kind: 'ok', scope: { kind: 'org', orgId: id } };
  }
  if (kind === 'project') {
    if (id === undefined || id === '') {
      return {
        kind: 'err',
        stderr: `Malformed --scope: expected --scope=project:<projectId>, got "${raw}".\n`,
      };
    }
    return { kind: 'ok', scope: { kind: 'project', projectId: id } };
  }
  return {
    kind: 'err',
    stderr: `Unknown --scope kind "${String(kind)}". Accepted: tenant, org:<orgId>, project:<projectId>.\n`,
  };
}

export function describeScope(scope: ScopeRef): string {
  if (scope.kind === 'tenant') return 'tenant';
  if (scope.kind === 'org') return `org:${scope.orgId}`;
  return `project:${scope.projectId}`;
}

/** Every record under `(scope, envName)`, all pages. */
export async function listAllEnv(
  ctx: CommandContext,
  scope: ScopeRef,
  envName: EnvName,
): Promise<readonly EnvRecord[]> {
  const out: EnvRecord[] = [];
  let cursor: string | undefined;
  const env = ctx.client().env;
  for (let i = 0; i < 1_000; i += 1) {
    const page = await env.list({
      scope,
      envName,
      ...(cursor !== undefined && { cursor: cursor as never }),
    });
    out.push(...page.data);
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor as unknown as string;
  }
  return out;
}

/**
 * A thrown client error, with one case said plainly: a runtime that
 * doesn't serve `/v1/env` answers `route-not-found`.
 */
export function envErrorResult(err: unknown, ctx: CommandContext, label: string): CommandResult {
  const wire = extractKindgiError(err);
  if (wire?.code === 'not-found' && wire.serverCode === 'route-not-found') {
    return {
      kind: 'error',
      stderr: `${label}: this runtime doesn't serve \`/v1/env\`, so it has no scoped env values (runtimes serve it from 0.1.5).\nWithout --scope, \`kindgi env\` edits the pack's local env files.\n`,
      exitCode: 1,
    };
  }
  return commandResultFromThrown(err, ctx, label);
}

interface ScopedTarget {
  readonly scope: ScopeRef;
  readonly envName: string;
}

/** `--scope` and the `--env` it requires. */
function scopedTarget(
  ctx: CommandContext,
  verb: 'set' | 'list' | 'unset',
): { readonly kind: 'ok'; readonly target: ScopedTarget } | (CommandResult & { kind: 'error' }) {
  const parsed = parseScope(stringFlag(ctx, 'scope'));
  if (parsed.kind === 'err') return { kind: 'error', stderr: parsed.stderr, exitCode: 2 };
  const envName = stringFlag(ctx, 'env');
  if (envName === undefined) {
    return {
      kind: 'error',
      stderr: `Missing required flag: --env=<name>. \`kindgi env ${verb} --scope\` acts on the runtime's env values, which are per env: name the one the runtime serves (\`KINDGI_ENV\`; under \`kindgi dev\`, \`--env=local\`).\n`,
      exitCode: 2,
    };
  }
  return { kind: 'ok', target: { scope: parsed.scope, envName } };
}

/**
 * Names that look like a credential. Env values aren't secret — they're
 * recorded with the runs that use them — so `set` warns (and still sets).
 */
const CREDENTIAL_NAME =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|KEY|APIKEY|CREDENTIAL|CREDENTIALS|PRIVATE)(?:_|$)/;

export function credentialWarning(key: string, target: ScopedTarget): string | undefined {
  if (!CREDENTIAL_NAME.test(key)) return undefined;
  return (
    `${key} looks like a credential. Env values aren't secret: they're recorded with each run that uses them, ` +
    `and shown in its journal. Store a credential as a secret: kindgi secrets set ${key} --env=${target.envName} --scope=${describeScope(target.scope)}`
  );
}

function ok(summary: unknown, ctx: CommandContext, banner: string): CommandResult {
  const rendered = renderJson(summary, ctx.globals.format);
  return { kind: 'ok', rendered: { stdout: rendered.stdout, stderr: banner } };
}

/** `kindgi env set <KEY> <VALUE> --scope=… --env=…`. KEY is already checked. */
export async function setScoped(
  ctx: CommandContext,
  key: string,
  value: string,
): Promise<CommandResult> {
  const t = scopedTarget(ctx, 'set');
  if (t.kind === 'error') return t;
  const { scope, envName } = t.target;
  const where = `${describeScope(scope)} in env ${envName}`;
  const warning = credentialWarning(key, t.target);
  const env = ctx.client().env;
  try {
    const existing = await env.get({ scope, envName: envName as EnvName, name: key });
    if (existing !== null && existing.value === value) {
      return ok(
        { envName, scope: describeScope(scope), key, changed: false, revision: existing.revision },
        ctx,
        `\n  ✓ ${key} is already set to that value at ${where}: no change.\n\n`,
      );
    }
    if (existing !== null && ctx.options.force !== true) {
      return {
        kind: 'error',
        stderr: `kindgi env set refuses to change ${key}, already set at ${where} to "${existing.value}". Re-run with --force to replace it.\n`,
        exitCode: 1,
      };
    }
    const outcome = await env.set({
      scope,
      envName: envName as EnvName,
      name: key,
      value,
      ...(existing !== null && { ifRevision: existing.revision }),
    });
    if (outcome.kind === 'revision-conflict') {
      return {
        kind: 'error',
        stderr: `kindgi env set: ${key} at ${where} changed while this ran (now revision ${outcome.currentRevision}). Re-run to see the current value.\n`,
        exitCode: 1,
      };
    }
    const lines = [
      '',
      `  ✓ ${existing !== null ? 'Updated' : 'Set'} ${key} at ${where}. A tool that declares it (\`needsSpec.env\`) gets it on its next call.`,
      ...(warning !== undefined ? ['', `  ⚠ ${warning}`] : []),
      '',
      '',
    ];
    return ok(
      {
        envName,
        scope: describeScope(scope),
        key,
        changed: true,
        overwritten: existing !== null,
        revision: outcome.record.revision,
        ...(warning !== undefined && { warnings: [warning] }),
      },
      ctx,
      lines.join('\n'),
    );
  } catch (err) {
    return envErrorResult(err, ctx, 'kindgi env set');
  }
}

/** `kindgi env list --scope=… --env=…`: values shown (env isn't secret). */
export async function listScoped(ctx: CommandContext): Promise<CommandResult> {
  const t = scopedTarget(ctx, 'list');
  if (t.kind === 'error') return t;
  const { scope, envName } = t.target;
  try {
    const records = [...(await listAllEnv(ctx, scope, envName as EnvName))].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    const values = records.map((r) => ({
      key: r.name,
      value: r.value,
      revision: r.revision,
      updatedAt: r.updatedAt,
    }));
    const lines = ['', `  Environment: ${envName}`, `  Scope:       ${describeScope(scope)}`, ''];
    lines.push(values.length === 0 ? '  (no values set here)' : `  ${values.length} key(s):`);
    for (const v of values) lines.push(`    ${v.key.padEnd(24, ' ')} ${v.value}`);
    lines.push('', "  A tool gets the project's value, else its org's, else the tenant's.", '', '');
    return ok(
      { envName, scope: describeScope(scope), count: values.length, values },
      ctx,
      lines.join('\n'),
    );
  } catch (err) {
    return envErrorResult(err, ctx, 'kindgi env list');
  }
}

/** What a call sees once a scope's value is gone. */
const FALLBACK: Readonly<Record<ScopeRef['kind'], string>> = {
  project: "its org's value, else the tenant's, else its schema's default",
  org: "the tenant's value, else its schema's default (a project's own value still wins)",
  tenant:
    "its schema's default, or fails before it runs (an org's or a project's own value still wins)",
};

/** `kindgi env unset <KEY> --scope=… --env=…`. Idempotent. */
export async function unsetScoped(ctx: CommandContext, key: string): Promise<CommandResult> {
  const t = scopedTarget(ctx, 'unset');
  if (t.kind === 'error') return t;
  const { scope, envName } = t.target;
  const where = `${describeScope(scope)} in env ${envName}`;
  try {
    const { deleted } = await ctx
      .client()
      .env.delete({ scope, envName: envName as EnvName, name: key });
    const outcome = deleted
      ? `Removed ${key} at ${where}. A tool that declares it now gets ${FALLBACK[scope.kind]}.`
      : `${key} wasn't set at ${where}: no change.`;
    return ok(
      { envName, scope: describeScope(scope), key, removed: deleted },
      ctx,
      `\n  ✓ ${outcome}\n\n`,
    );
  } catch (err) {
    return envErrorResult(err, ctx, 'kindgi env unset');
  }
}
