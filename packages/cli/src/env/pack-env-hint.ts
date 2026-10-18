// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * How to set the env a deployment's pack declares, where a server gives
 * each pack service the values set in the workspace (`kindgi env set`):
 * what `kindgi deploy --hosted` says, and what `kindgi promote` says for a
 * target that lacks them. One wording, so both say the same.
 */

/** Where a value is set, as `GET /v1/deployments/:id/pack-env` names it. */
export interface PackEnvScopeRecord {
  readonly kind: 'project' | 'org' | 'tenant';
  readonly id?: string;
}

/** One name a deployment's pack declares, as `GET /v1/deployments/:id/pack-env` gives it: never a value. */
export interface PackEnvNameRecord {
  readonly name: string;
  readonly required: boolean;
  readonly kind: 'env' | 'secret' | null;
  readonly scope: PackEnvScopeRecord | null;
  readonly missing: boolean;
  /**
   * `ambiguous` or `missing`, or from an older runtime, `secret-not-yet`; a
   * later runtime may add others. A name set only as a secret is
   * `kind: 'secret'` with no problem: the orchestrator gives it.
   */
  readonly problem?: string;
  /** `ambiguous` only: the secret's scope. */
  readonly secretScope?: PackEnvScopeRecord;
}

export interface PackEnvHintTarget {
  /** The env the values are read at. */
  readonly envName: string;
  /** The deployment's project. Absent: a tenant-wide deployment. */
  readonly projectId?: string;
  /** The environment maps to its project, so `--env` alone says where a value goes. */
  readonly hasProjectMapping: boolean;
}

/** The command that sets one of a deployment's names, `NAME` and `<value>` left to fill in. */
export function packEnvSetCommand(target: PackEnvHintTarget): string {
  if (target.hasProjectMapping) return `kindgi env set NAME <value> --env=${target.envName}`;
  const scope = target.projectId !== undefined ? `project:${target.projectId}` : 'tenant';
  return `kindgi env set NAME <value> --scope=${scope} --env=${target.envName}`;
}

/** The command that sets one of a deployment's names as a secret, `NAME` left to fill in: it asks for the value. */
export function packEnvSecretSetCommand(
  target: Omit<PackEnvHintTarget, 'hasProjectMapping'>,
): string {
  const scope = target.projectId !== undefined ? `project:${target.projectId}` : 'tenant';
  return `kindgi secrets set NAME --scope=${scope} --env=${target.envName}`;
}

/** "API_BASE and SHOP_URL aren't set for staging. Set each with `kindgi env set …`." */
export function packEnvHint(
  input: PackEnvHintTarget & { readonly names: readonly string[] },
): string {
  const one = input.names.length === 1;
  return `${listNames(input.names)} ${one ? "isn't" : "aren't"} set for ${input.envName}. Set ${one ? 'it' : 'each'} with \`${packEnvSetCommand(input)}\`.`;
}

/**
 * What stands in the way of giving a deployment's pack service its env, a
 * sentence per reason: required names set nowhere (with `packEnvHint`),
 * names set only as secrets where an older runtime keeps secrets out of a
 * pack service's environment, names set both ways, and by its code a
 * reason a later runtime names. Empty when nothing does.
 */
export function packEnvProblemLines(
  names: readonly PackEnvNameRecord[],
  target: PackEnvHintTarget,
): string[] {
  const lines: string[] = [];
  const missing = names.filter((n) => n.problem === 'missing').map((n) => n.name);
  if (missing.length > 0) lines.push(packEnvHint({ ...target, names: missing }));
  const secretOnly = names.filter((n) => n.problem === 'secret-not-yet').map((n) => n.name);
  if (secretOnly.length > 0) {
    const one = secretOnly.length === 1;
    lines.push(
      `${listNames(secretOnly)} ${one ? 'is' : 'are'} set only as ${one ? 'a secret' : 'secrets'}, which this server keeps out of a pack service's environment: a tool reads ${one ? 'it' : 'them'} per call (\`ctx.secrets\`).`,
    );
  }
  for (const n of names.filter((x) => x.problem === 'ambiguous')) {
    lines.push(
      `${n.name} is set both as a secret (${scopeText(n.secretScope)}) and as a plain value (${scopeText(n.scope)}): remove one, so it's clear which the pack service gets.`,
    );
  }
  // A reason a later runtime names: said by its code.
  for (const n of names.filter((x) => x.problem !== undefined && !KNOWN.has(x.problem))) {
    lines.push(`${n.name} can't be given to the pack service yet (${n.problem}).`);
  }
  return lines;
}

const KNOWN: ReadonlySet<string> = new Set(['missing', 'secret-not-yet', 'ambiguous']);

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function scopeText(scope: PackEnvScopeRecord | null | undefined): string {
  if (scope === null || scope === undefined) return 'nowhere';
  return scope.id === undefined ? scope.kind : `${scope.kind} ${scope.id}`;
}
