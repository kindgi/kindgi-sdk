// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { isAbsolute, resolve } from 'node:path';

import type { KindgiClient } from '@kindgi/client';
import { LOCAL_ENV_NAME } from '@kindgi/secrets-dotenv';

import { projectOfEnv } from './commands/build.js';
import type { CommandResult } from './commands/types.js';
import type { CommandContext } from './context.js';
import { UsageError, extractKindgiError } from './errors.js';
import { loadPackConfig } from './pack-config.js';
import { resolveProjectRef } from './project-ref.js';

/**
 * What a runtime says it serves (whoami's `servedEnv`): the env its tools'
 * values are read under, and whether it refuses values under any other.
 */
export interface ServedEnv {
  readonly envName: string;
  readonly refusesOtherEnvs: boolean;
}

/**
 * The runtime's `servedEnv`, or `undefined` when it doesn't say (a runtime
 * that serves no env, or an older one) or can't be asked. Then every default
 * stays as it was, and a runtime that refuses other envs still refuses the
 * write itself (`409 env-not-served`).
 */
export async function servedEnvOf(client: () => KindgiClient): Promise<ServedEnv | undefined> {
  try {
    const served = (await client().identity.whoami()).servedEnv;
    return served === undefined
      ? undefined
      : { envName: served.envName, refusesOtherEnvs: served.refusesOtherEnvs };
  } catch {
    return undefined;
  }
}

/**
 * A pack's environments: each name in its config's `environments`, with
 * the project (id or slug) its `project` names, if it names one.
 */
export type PackEnvironments = Readonly<Record<string, string | undefined>>;

/** A pack environment `--env` named, and the project its config names for it. */
export interface MappedEnvironment {
  readonly name: string;
  /** As the config names it: an id or a slug. */
  readonly projectRef: string;
}

/** The env a value command acts under, or why there's none. */
export type ValueTarget =
  | {
      readonly kind: 'ok';
      readonly envName: string;
      /**
       * `served`: `--env` was left out, and the runtime refuses other envs.
       * `environment`: `--env` named a pack environment with a project, on
       * such a runtime.
       */
      readonly from: 'flag' | 'served' | 'default' | 'environment';
      /** With `from: 'environment'`: the environment, whose project is the value's scope. */
      readonly environment?: MappedEnvironment;
    }
  /** No `--env`, and neither a default nor a runtime that names one: the command's own message. */
  | { readonly kind: 'missing' }
  | { readonly kind: 'refused'; readonly stderr: string };

/** A pack environment `--env` named, with its project resolved to an id. */
export interface ResolvedEnvironment extends MappedEnvironment {
  readonly projectId: string;
}

/** `ValueTarget` for a command: a named environment's project resolved to its id. */
export type CommandValueTarget =
  | (Extract<ValueTarget, { kind: 'ok' }> & { readonly environment?: ResolvedEnvironment })
  | Exclude<ValueTarget, { kind: 'ok' }>;

/**
 * Where a value command's value goes. `flag` is `--env` as given, `fallback`
 * the command's own default (none: `--env` is required).
 *
 * On a runtime that refuses other envs, `--env` defaults to the env it
 * serves, and a write (`write`) under another is refused here, before
 * anything is sent: it would never be read. A read or a delete may still
 * name another env, to find and remove what was stored there before.
 * There, `--env` may also name one of the pack's `environments` that has a
 * `project`: the value is that project's, under the env the runtime serves.
 * The environment picks the scope, so a `--scope` with it (`scope`, as
 * given) may only name that project: `project`, or `project:<its id>`
 * (`valueTargetFor` compares the id).
 * Anywhere else: `flag`, then `fallback`, as before.
 *
 * `what` names what would be stored, for the refusal (`a secret`).
 * `mayOmit: false` when leaving `--env` out isn't the way (it picks more
 * than the env), so the refusal doesn't suggest it. A refused `local`
 * also says where `local` is: a `kindgi dev` runtime, which the CLI talks
 * to in its pack. `environments` is the pack's (none: outside a pack).
 */
export function resolveValueTarget(input: {
  readonly flag: string | undefined;
  readonly fallback?: string;
  readonly served: ServedEnv | undefined;
  readonly write: boolean;
  readonly what: string;
  readonly mayOmit?: boolean;
  readonly environments?: PackEnvironments;
  readonly scope?: string;
}): ValueTarget {
  const { flag, served } = input;
  if (served?.refusesOtherEnvs === true) {
    if (flag === undefined) return { kind: 'ok', envName: served.envName, from: 'served' };
    const projectRef = input.environments?.[flag];
    if (projectRef !== undefined) {
      const { scope } = input;
      if (scope !== undefined && scope !== 'project' && !scope.startsWith('project:')) {
        return {
          kind: 'refused',
          stderr: `--env=${flag} is the pack's environment ${flag}, so its scope is its project, ${projectRef}, not ${scope}. For a value every environment without its own reads, leave --env out (--scope=${scope}).\n`,
        };
      }
      return {
        kind: 'ok',
        envName: served.envName,
        from: 'environment',
        environment: { name: flag, projectRef },
      };
    }
    if (flag !== served.envName && input.write) {
      return {
        kind: 'refused',
        stderr: `env-not-served: this runtime keeps its values under \`${served.envName}\` only, so ${input.what} under \`${flag}\` would never be read. Use --env=${served.envName}${input.mayOmit === false ? '' : ', or leave --env out'}.\n${environmentsHint(flag, input.environments)}${localEnvHint(flag)}`,
      };
    }
    return { kind: 'ok', envName: flag, from: 'flag' };
  }
  if (flag !== undefined) return { kind: 'ok', envName: flag, from: 'flag' };
  if (input.fallback !== undefined) {
    return { kind: 'ok', envName: input.fallback, from: 'default' };
  }
  return { kind: 'missing' };
}

/**
 * What the pack's environments offer in place of a refused `--env`: the
 * ones with a project, and how to give one a project. Nothing outside a
 * pack, or for `local`, which has its own (`localEnvHint`).
 */
function environmentsHint(flag: string, environments: PackEnvironments | undefined): string {
  if (environments === undefined || flag === LOCAL_ENV_NAME) return '';
  const mapped = Object.entries(environments).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const unmapped =
    flag in environments
      ? `The pack's environment ${flag} names no project: add \`environments.${flag}.project\` to kindgi.config.ts, and --env=${flag} stores values in that project.\n`
      : '';
  if (mapped.length === 0) {
    return (
      unmapped ||
      "No environment in the pack's config names a project: add `environments.<name>.project` to kindgi.config.ts, and --env=<name> stores values in that project.\n"
    );
  }
  const list = mapped.map(([name, project]) => `${name} (project ${project})`).join(', ');
  return `${unmapped}The pack's environments: ${list}. --env=<one of them> stores a value in its project.\n`;
}

/**
 * The environments of the pack at `--path` (else the cwd), or `undefined`
 * when there's no pack config there, or it can't be read.
 */
export async function packEnvironmentsOf(
  ctx: Pick<CommandContext, 'buildConfigLoader' | 'options' | 'cwd'>,
): Promise<PackEnvironments | undefined> {
  const raw = ctx.options.path;
  const dir = typeof raw === 'string' && raw !== '' ? raw : '.';
  const loaded = await loadPackConfig(ctx, isAbsolute(dir) ? dir : resolve(ctx.cwd, dir));
  return loaded.kind === 'ok' ? environmentsOf(loaded.config) : undefined;
}

/** A pack config's environments, each with the project it names (`projectOfEnv`). */
export function environmentsOf(config: { readonly environments?: unknown }): PackEnvironments {
  const { environments } = config;
  if (environments === null || typeof environments !== 'object') return {};
  return Object.fromEntries(
    Object.keys(environments).map((name) => [name, projectOfEnv(config, name)]),
  );
}

/**
 * `resolveValueTarget` for a command: asks the runtime what it serves only
 * when that can change the answer: when `--env` is left out, the command
 * writes, or `--env` names one of the pack's environments with a project.
 * The pack's environments are read only when `--env` is given, and the
 * named environment's project is then looked up (a slug that names none or
 * several is refused).
 */
export async function valueTargetFor(
  ctx: CommandContext,
  flag: string | undefined,
  options: {
    readonly write: boolean;
    readonly what: string;
    readonly fallback?: string;
    readonly mayOmit?: boolean;
    readonly scope?: string;
  },
): Promise<CommandValueTarget> {
  let served: ServedEnv | undefined;
  let environments: PackEnvironments | undefined;
  if (flag === undefined || options.write) {
    served = await servedEnvOf(ctx.client);
    if (flag !== undefined && served?.refusesOtherEnvs === true) {
      environments = await packEnvironmentsOf(ctx);
    }
  } else {
    environments = await packEnvironmentsOf(ctx);
    if (environments?.[flag] !== undefined) served = await servedEnvOf(ctx.client);
  }
  const target = resolveValueTarget({
    flag,
    served,
    ...(environments !== undefined && { environments }),
    ...options,
  });
  if (target.kind !== 'ok' || target.environment === undefined) {
    return target as CommandValueTarget;
  }
  const { name, projectRef } = target.environment;
  let projectId: string;
  try {
    projectId = await resolveProjectRef(ctx, projectRef);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    return { kind: 'refused', stderr: `The pack's environment ${name}: ${err.message}\n` };
  }
  const named = options.scope?.startsWith('project:') === true ? options.scope.slice(8) : undefined;
  if (named !== undefined && named !== projectId) {
    return {
      kind: 'refused',
      stderr: `--env=${name} is the pack's environment ${name}, project ${projectRef} (${projectId}), but --scope names project ${named}. Name one: --env=${name} with --scope=project, or --scope=project:${named} without --env.\n`,
    };
  }
  return { ...target, environment: { name, projectRef, projectId } };
}

/**
 * A command's result, with the line saying which project and env a pack
 * environment named by `--env` stood for. Nothing for any other target.
 */
export function withEnvironmentNote(
  result: CommandResult,
  target: { readonly envName: string; readonly environment?: ResolvedEnvironment },
): CommandResult {
  const { environment } = target;
  if (environment === undefined) return result;
  const shown =
    environment.projectRef === environment.projectId
      ? environment.projectId
      : `${environment.projectRef} (${environment.projectId})`;
  const note = `Environment ${environment.name}: project ${shown}, values under ${target.envName}.\n`;
  return result.kind === 'ok'
    ? { ...result, rendered: { ...result.rendered, stderr: `${note}${result.rendered.stderr}` } }
    : { ...result, stderr: `${note}${result.stderr}` };
}

/** Where `local` is, when that's the env a refused value named; otherwise nothing. */
function localEnvHint(envName: string): string {
  return envName === LOCAL_ENV_NAME
    ? "`local` is a `kindgi dev` runtime's env: in a pack where `kindgi dev` runs, the CLI talks to that runtime, unless --url or KINDGI_API_URL names another.\n"
    : '';
}

/**
 * A command's result for `thrown`, with where `local` is added when the
 * runtime refused a value under `local` (`409 env-not-served`). For a write
 * the CLI sends anyway, since only the runtime knows whether a registration
 * still reads it there.
 */
export function withLocalEnvHint(
  result: CommandResult,
  thrown: unknown,
  envName: string,
): CommandResult {
  const wire = extractKindgiError(thrown) as { readonly reason?: unknown } | null;
  if (result.kind !== 'error' || wire?.reason !== 'env-not-served') return result;
  return { ...result, stderr: `${result.stderr}${localEnvHint(envName)}` };
}
