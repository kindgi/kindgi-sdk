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
import { type SaidLine, note, renderLines, warning } from '../progress-lines.js';
import { type ResolvedEnvironment, valueTargetFor, withEnvironmentNote } from '../value-target.js';
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

/** Why `--scope=project`, with no id, names no project here. */
export const PROJECT_SCOPE_ALONE =
  "--scope=project alone is the project of the pack's environment --env names, on a runtime that keeps its values under one env. Here, name the project: --scope=project:<projectId>.\n";

interface ScopedTarget {
  readonly scope: ScopeRef;
  readonly envName: string;
  /** `--env` named one of the pack's environments: its project is `scope`. */
  readonly environment?: ResolvedEnvironment;
}

/**
 * `--scope` and the `--env` it requires: on a runtime that keeps its values
 * under one env, that one by default, and a `set` under
 * another is refused (`valueTargetFor`). There, `--env` may name one of the
 * pack's environments with a project, and `--scope=project` is that
 * project, under the env the runtime serves. `--scope` stays required:
 * without it, `kindgi env` edits the pack's own env files.
 */
async function scopedTarget(
  ctx: CommandContext,
  verb: 'set' | 'list' | 'unset',
): Promise<
  { readonly kind: 'ok'; readonly target: ScopedTarget } | (CommandResult & { kind: 'error' })
> {
  const raw = stringFlag(ctx, 'scope');
  // `project` alone is the pack environment's project: known once --env is.
  const parsed = raw === 'project' ? undefined : parseScope(raw);
  if (parsed?.kind === 'err') return { kind: 'error', stderr: parsed.stderr, exitCode: 2 };
  const target = await valueTargetFor(ctx, stringFlag(ctx, 'env'), {
    write: verb === 'set',
    what: 'an env value',
    ...(raw !== undefined && { scope: raw }),
  });
  if (target.kind === 'missing') {
    return {
      kind: 'error',
      stderr: `Missing required flag: --env=<name>. \`kindgi env ${verb} --scope\` acts on the runtime's env values, which are per env: name the one the runtime serves (\`KINDGI_ENV\`; under \`kindgi dev\`, \`--env=local\`).\n`,
      exitCode: 2,
    };
  }
  if (target.kind === 'refused') return { kind: 'error', stderr: target.stderr, exitCode: 2 };
  const { environment } = target;
  if (environment !== undefined) {
    return {
      kind: 'ok',
      target: {
        scope: { kind: 'project', projectId: environment.projectId },
        envName: target.envName,
        environment,
      },
    };
  }
  if (parsed === undefined) return { kind: 'error', stderr: PROJECT_SCOPE_ALONE, exitCode: 2 };
  return { kind: 'ok', target: { scope: parsed.scope, envName: target.envName } };
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
    `and shown in its journal. Store a credential as a secret: kindgi secrets set ${key} --env=${target.environment?.name ?? target.envName}${target.environment !== undefined ? '' : ` --scope=${describeScope(target.scope)}`}`
  );
}

function ok(summary: unknown, ctx: CommandContext, lines: readonly SaidLine[]): CommandResult {
  const rendered = renderJson(summary, ctx.globals.format);
  const stderr = renderLines(lines, ctx.globals.format === 'quiet');
  return { kind: 'ok', rendered: { stdout: rendered.stdout, stderr } };
}

/** `kindgi env set <KEY> <VALUE> --scope=… --env=…`. KEY is already checked. */
export async function setScoped(
  ctx: CommandContext,
  key: string,
  value: string,
): Promise<CommandResult> {
  const t = await scopedTarget(ctx, 'set');
  if (t.kind === 'error') return t;
  return withEnvironmentNote(
    await setScopedAt(ctx, key, value, t.target),
    t.target,
    ctx.globals.format,
  );
}

async function setScopedAt(
  ctx: CommandContext,
  key: string,
  value: string,
  target: ScopedTarget,
): Promise<CommandResult> {
  const { scope, envName } = target;
  const where = `${describeScope(scope)} in env ${envName}`;
  const credential = credentialWarning(key, target);
  const env = ctx.client().env;
  try {
    const existing = await env.get({ scope, envName: envName as EnvName, name: key });
    const same = existing !== null && existing.value === value;
    // With --force, the same value is set again: a new revision, which a
    // pack service whose new values didn't start tries again.
    if (same && ctx.options.force !== true) {
      return ok(
        { envName, scope: describeScope(scope), key, changed: false, revision: existing.revision },
        ctx,
        [
          note(''),
          note(
            `  ✓ ${key} is already set to that value at ${where}: no change. Re-run with --force to set it again: on Kindgi Cloud, a pack service whose new values didn't start tries them again.`,
          ),
          note(''),
        ],
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
      note(''),
      note(
        same
          ? `  ✓ Set ${key} again at ${where}, to the same value: a new revision.`
          : `  ✓ ${existing !== null ? 'Updated' : 'Set'} ${key} at ${where}. A tool that declares it (\`needsSpec.env\`) gets it on its next call.`,
      ),
      ...(credential !== undefined ? [note(''), warning(`  ⚠ ${credential}`)] : []),
      note(''),
    ];
    return ok(
      {
        envName,
        scope: describeScope(scope),
        key,
        changed: true,
        overwritten: existing !== null,
        revision: outcome.record.revision,
        ...(credential !== undefined && { warnings: [credential] }),
      },
      ctx,
      lines,
    );
  } catch (err) {
    return envErrorResult(err, ctx, 'kindgi env set');
  }
}

/** `kindgi env list --scope=… --env=…`: values shown (env isn't secret). */
export async function listScoped(ctx: CommandContext): Promise<CommandResult> {
  const t = await scopedTarget(ctx, 'list');
  if (t.kind === 'error') return t;
  return withEnvironmentNote(await listScopedAt(ctx, t.target), t.target, ctx.globals.format);
}

async function listScopedAt(ctx: CommandContext, target: ScopedTarget): Promise<CommandResult> {
  const { scope, envName } = target;
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
    const cloudSecrets = await tenantCloudSecretNames(ctx, scope, envName as EnvName);
    const lines = [
      '',
      `  Value set: ${envName}`,
      `  Scope:     ${describeScope(scope)}`,
      '',
      values.length === 0 ? '  (no values set here)' : `  ${values.length} key(s):`,
      ...values.map((v) => `    ${v.key.padEnd(24, ' ')} ${v.value}`),
      ...(cloudSecrets.length > 0
        ? [
            '',
            `  ${cloudSecrets.length} set by your operator to a cloud secret, which a pack service reads from the cloud:`,
            ...cloudSecrets.map((c) => `    ${c.key} (cloud secret)`),
          ]
        : []),
      '',
      "  A tool gets the project's value, else its org's, else the tenant's.",
      '',
    ].map(note);
    return ok(
      {
        envName,
        scope: describeScope(scope),
        count: values.length,
        values,
        ...(cloudSecrets.length > 0 && { cloudSecrets }),
      },
      ctx,
      lines,
    );
  } catch (err) {
    return envErrorResult(err, ctx, 'kindgi env list');
  }
}

/**
 * The names the operator set to a cloud secret at a tenant's scope, as the
 * tenant sees them: no path. Empty from a runtime that keeps none (`501`)
 * or doesn't know them (`404`).
 */
export async function tenantCloudSecretNames(
  ctx: CommandContext,
  scope: ScopeRef,
  envName: EnvName,
): Promise<
  readonly { readonly key: string; readonly revision: number; readonly updatedAt: string }[]
> {
  const out: { key: string; revision: number; updatedAt: string }[] = [];
  let cursor: string | undefined;
  try {
    for (let i = 0; i < 1_000; i += 1) {
      const page = await ctx.client().env.listCloudSecrets({
        scope,
        envName,
        ...(cursor !== undefined && { cursor: cursor as never }),
      });
      out.push(
        ...page.data.map((r) => ({ key: r.name, revision: r.revision, updatedAt: r.updatedAt })),
      );
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
  } catch (err) {
    // A runtime that keeps none, or before the route (`/v1/env/:name` then
    // reads `cloud-secrets` as a name): none.
    const wire = extractKindgiError(err);
    const code = wire !== null && 'serverCode' in wire ? wire.serverCode : undefined;
    if (code !== undefined && TENANT_LIST_NONE.has(code)) return [];
    throw err;
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const TENANT_LIST_NONE: ReadonlySet<string> = new Set([
  'cloud-secrets-unsupported',
  'route-not-found',
  'env-not-found',
]);

/** What a call sees once a scope's value is gone. */
const FALLBACK: Readonly<Record<ScopeRef['kind'], string>> = {
  project: "its org's value, else the tenant's, else its schema's default",
  org: "the tenant's value, else its schema's default (a project's own value still wins)",
  tenant:
    "its schema's default, or fails before it runs (an org's or a project's own value still wins)",
};

/** `kindgi env unset <KEY> --scope=… --env=…`. Idempotent. */
export async function unsetScoped(ctx: CommandContext, key: string): Promise<CommandResult> {
  const t = await scopedTarget(ctx, 'unset');
  if (t.kind === 'error') return t;
  return withEnvironmentNote(await unsetScopedAt(ctx, key, t.target), t.target, ctx.globals.format);
}

async function unsetScopedAt(
  ctx: CommandContext,
  key: string,
  target: ScopedTarget,
): Promise<CommandResult> {
  const { scope, envName } = target;
  const where = `${describeScope(scope)} in env ${envName}`;
  try {
    const { deleted } = await ctx
      .client()
      .env.delete({ scope, envName: envName as EnvName, name: key });
    const outcome = deleted
      ? `Removed ${key} at ${where}. A tool that declares it now gets ${FALLBACK[scope.kind]}.`
      : `${key} wasn't set at ${where}: no change.`;
    return ok({ envName, scope: describeScope(scope), key, removed: deleted }, ctx, [
      note(''),
      note(`  ✓ ${outcome}`),
      note(''),
    ]);
  } catch (err) {
    return envErrorResult(err, ctx, 'kindgi env unset');
  }
}
