// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { KindgiClient } from '@kindgi/client';
import { LOCAL_ENV_NAME } from '@kindgi/secrets-dotenv';

import type { CommandContext } from './context.js';

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

/** The env a value command acts under, or why there's none. */
export type ValueTarget =
  | {
      readonly kind: 'ok';
      readonly envName: string;
      /** `served`: `--env` was left out, and the runtime refuses other envs. */
      readonly from: 'flag' | 'served' | 'default';
    }
  /** No `--env`, and neither a default nor a runtime that names one: the command's own message. */
  | { readonly kind: 'missing' }
  | { readonly kind: 'refused'; readonly stderr: string };

/**
 * Where a value command's value goes. `flag` is `--env` as given, `fallback`
 * the command's own default (none: `--env` is required).
 *
 * On a runtime that refuses other envs, `--env` defaults to the env it
 * serves, and a write (`write`) under another is refused here, before
 * anything is sent: it would never be read. A read or a delete may still
 * name another env, to find and remove what was stored there before.
 * Anywhere else: `flag`, then `fallback`, as before.
 *
 * `what` names what would be stored, for the refusal (`a secret`).
 * `mayOmit: false` when leaving `--env` out isn't the way (it picks more
 * than the env), so the refusal doesn't suggest it. A refused `local`
 * also says where `local` is: a `kindgi dev` runtime, which the CLI talks
 * to in its pack.
 */
export function resolveValueTarget(input: {
  readonly flag: string | undefined;
  readonly fallback?: string;
  readonly served: ServedEnv | undefined;
  readonly write: boolean;
  readonly what: string;
  readonly mayOmit?: boolean;
}): ValueTarget {
  const { flag, served } = input;
  if (served?.refusesOtherEnvs === true) {
    if (flag === undefined) return { kind: 'ok', envName: served.envName, from: 'served' };
    if (flag !== served.envName && input.write) {
      const local =
        flag === LOCAL_ENV_NAME
          ? "`local` is a `kindgi dev` runtime's env: in a pack where `kindgi dev` runs, the CLI talks to that runtime, unless --url or KINDGI_API_URL names another.\n"
          : '';
      return {
        kind: 'refused',
        stderr: `env-not-served: this runtime keeps its values under \`${served.envName}\` only, so ${input.what} under \`${flag}\` would never be read. Use --env=${served.envName}${input.mayOmit === false ? '' : ', or leave --env out'}.\n${local}`,
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
 * `resolveValueTarget` for a command: asks the runtime what it serves only
 * when that can change the answer, when `--env` is left out or the command
 * writes.
 */
export async function valueTargetFor(
  ctx: CommandContext,
  flag: string | undefined,
  options: { readonly write: boolean; readonly what: string; readonly fallback?: string },
): Promise<ValueTarget> {
  const served = flag === undefined || options.write ? await servedEnvOf(ctx.client) : undefined;
  return resolveValueTarget({ flag, served, ...options });
}
