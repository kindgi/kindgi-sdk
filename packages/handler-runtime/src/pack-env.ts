// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The process environment a pack's code reads: names its handlers and the
 * libraries they import take from `process.env` (a database URL a client
 * reads at import, a bucket name). Declared once per pack, in
 * `kindgi.config` (`env: { required, optional }`; Python:
 * `[tool.kindgi.env]`), and carried in `index.json`, so the pack service
 * in an image knows what it needs.
 *
 * A deployment injects exactly these names: `required` must be there for
 * the pack service to be ready, `optional` is injected when the target
 * has a value. Nothing else from an env file reaches the process.
 *
 * Distinct from `needsSpec.env` / `ctx.env`, the per-call values the
 * runtime resolves for a call's tenant, and from `needsSpec.secrets` /
 * `ctx.secrets`.
 */

/** A pack's declared process environment, as `index.json` carries it. */
export interface PackEnvDeclaration {
  /** Names the pack service needs, set and non-empty, to be ready. Sorted. */
  readonly required: readonly string[];
  /** Names the pack reads when present. Sorted. */
  readonly optional: readonly string[];
}

/** `env` in `kindgi.config`, as the author writes it. */
export interface PackEnvConfig {
  readonly required?: readonly string[];
  readonly optional?: readonly string[];
}

/** A process environment variable name. */
export const PACK_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The prefix of the names that configure Kindgi itself; never a pack's. */
export const RESERVED_ENV_PREFIX = 'KINDGI_';

export type PackEnvResult =
  | { readonly kind: 'ok'; readonly value: PackEnvDeclaration | undefined }
  | { readonly kind: 'err'; readonly message: string };

/**
 * Validate a config's `env` and normalize it to what the index carries:
 * both lists, each sorted (code-unit order). `undefined` when nothing is
 * declared, so an index without `env` stays byte-identical.
 *
 * Refused: a name that isn't an environment variable name, a `KINDGI_*`
 * name, a name listed twice, and a name in both lists.
 */
export function resolvePackEnv(env: unknown): PackEnvResult {
  if (env === undefined) return { kind: 'ok', value: undefined };
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    return {
      kind: 'err',
      message: '`env` must be an object: { required?: string[], optional?: string[] }',
    };
  }
  const unknownKeys = Object.keys(env).filter((k) => k !== 'required' && k !== 'optional');
  if (unknownKeys.length > 0) {
    return {
      kind: 'err',
      message: `\`env\` takes only \`required\` and \`optional\`, not ${unknownKeys.map((k) => `\`${k}\``).join(', ')}`,
    };
  }
  const { required, optional } = env as {
    readonly required?: unknown;
    readonly optional?: unknown;
  };
  const lists = { required, optional };
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const [list, names] of Object.entries(lists)) {
    if (names === undefined) continue;
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
      problems.push(`\`env.${list}\` must be a list of names`);
      continue;
    }
    for (const name of names as string[]) {
      if (!PACK_ENV_NAME.test(name)) {
        problems.push(`"${name}" in \`env.${list}\` isn't an environment variable name`);
      } else if (name.startsWith(RESERVED_ENV_PREFIX)) {
        problems.push(
          `"${name}" in \`env.${list}\`: \`${RESERVED_ENV_PREFIX}*\` names configure Kindgi, not the pack`,
        );
      } else if (seen.has(name)) {
        const first = seen.get(name);
        problems.push(
          first === list
            ? `"${name}" is listed twice in \`env.${list}\``
            : `"${name}" is in both \`env.required\` and \`env.optional\``,
        );
      } else {
        seen.set(name, list);
      }
    }
  }
  if (problems.length > 0) return { kind: 'err', message: problems.join('; ') };

  const sorted = (names: unknown): string[] =>
    Array.isArray(names) ? [...(names as string[])].sort(byCodeUnit) : [];
  const declaration = { optional: sorted(optional), required: sorted(required) };
  if (declaration.required.length === 0 && declaration.optional.length === 0) {
    return { kind: 'ok', value: undefined };
  }
  return { kind: 'ok', value: declaration };
}

/**
 * The required names `environment` doesn't provide: not set, or set to
 * the empty string. Sorted, like the declaration.
 */
export function missingPackEnv(
  declaration: PackEnvDeclaration | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  if (declaration === undefined) return [];
  return declaration.required.filter((name) => {
    const value = environment[name];
    return value === undefined || value === '';
  });
}

/** How the pack service treats missing required names (`KINDGI_PACK_ENV_CHECK`). */
export type PackEnvCheck = 'strict' | 'warn';

/** The variable that sets {@link PackEnvCheck}. */
export const PACK_ENV_CHECK_VAR = 'KINDGI_PACK_ENV_CHECK';

/** `KINDGI_PACK_ENV_CHECK`'s value; unset or empty is `strict`. */
export function parsePackEnvCheck(
  raw: string | undefined,
):
  | { readonly kind: 'ok'; readonly value: PackEnvCheck }
  | { readonly kind: 'err'; readonly message: string } {
  if (raw === undefined || raw === '' || raw === 'strict') return { kind: 'ok', value: 'strict' };
  if (raw === 'warn') return { kind: 'ok', value: 'warn' };
  return {
    kind: 'err',
    message: `${PACK_ENV_CHECK_VAR} must be \`strict\` or \`warn\`, not "${raw}"`,
  };
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
