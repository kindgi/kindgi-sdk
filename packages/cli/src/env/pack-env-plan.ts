// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The process environment a deployed pack service gets: each name the
 * pack declares (`env.required` / `env.optional` in `kindgi.config`) and
 * where its value comes from in a target environment
 * (`environments.<name>.env`):
 *
 *   - a plain value, for what isn't secret (committed, and visible in the
 *     deployed revision);
 *   - `{ secret, version, project? }`, a Secret Manager secret the operator
 *     created, which the platform resolves with the pack service's own
 *     identity. Kindgi never reads, stores or generates its value.
 *
 * Only declared names are injected. A secret given as a plain value is
 * refused, by its name (`*_KEY`, `*_TOKEN`, …) or by a credential inside
 * it (a URL with a password), so it goes by reference.
 */

import { type PackEnvDeclaration, resolvePackEnv } from '@kindgi/handler-runtime';

/** Where a declared name's value comes from in one environment. */
export type PackEnvSource =
  | { readonly kind: 'value'; readonly value: string }
  | {
      readonly kind: 'secret';
      /** The Secret Manager secret id. */
      readonly secret: string;
      /** A version number, or `latest`. */
      readonly version: string;
      /** The number of the project that holds it, when it isn't the service's own. */
      readonly project?: string;
    };

export interface PackEnvPlanEntry {
  readonly name: string;
  readonly required: boolean;
  /** Absent: the environment gives it no value. */
  readonly source?: PackEnvSource;
}

export interface PackEnvPlan {
  readonly envName: string;
  /** Declared names, required ones first, each group sorted. */
  readonly entries: readonly PackEnvPlanEntry[];
  /** Required names the environment gives no value. */
  readonly missing: readonly string[];
  /** What makes the plan unusable: a secret as a plain value, a malformed entry. */
  readonly problems: readonly string[];
  /** Worth knowing, not blocking: `latest` versions, values for undeclared names. */
  readonly warnings: readonly string[];
}

/** Names operators commonly give to real secrets. */
const SECRET_SHAPED_NAME = /_(?:KEY|SECRET|TOKEN|PASSWORD|PRIVATE|APIKEY|API_KEY)$/i;
/** A Secret Manager secret id. */
const SECRET_ID = /^[A-Za-z0-9_-]{1,255}$/;
const VERSION = /^(?:latest|[1-9][0-9]*)$/;
const PROJECT_NUMBER = /^[0-9]+$/;

/** Whether a name looks like it holds a secret (`*_KEY`, `*_TOKEN`, `*_PASSWORD`, …). */
export function isSecretShapedName(name: string): boolean {
  return SECRET_SHAPED_NAME.test(name);
}

/** Whether a value carries a credential: a URL with a password (`postgres://user:pass@host/db`). */
export function carriesCredential(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return false;
  try {
    return new URL(value).password !== '';
  } catch {
    return /^[^:/]+:\/\/[^/@]*:[^/@]*@/.test(value);
  }
}

/**
 * Why `value` can't be given in the clear under `name`, or `undefined`
 * when it can. The one check behind `kindgi env plan`, the deploy
 * preflight and `kindgi deploy --sync-secrets`'s warning.
 */
export function plainSecretReason(name: string, value: string): string | undefined {
  if (carriesCredential(value))
    return `${name}'s value has a credential in it (a URL with a password)`;
  if (isSecretShapedName(name)) return `${name} is named like a secret`;
  return undefined;
}

/** `environments.<envName>.env` from a loaded config: each name's source, and what's malformed. */
export function readEnvironmentEnv(
  config: Readonly<Record<string, unknown>> | undefined,
  envName: string,
): { readonly sources: ReadonlyMap<string, PackEnvSource>; readonly problems: readonly string[] } {
  const sources = new Map<string, PackEnvSource>();
  const problems: string[] = [];
  const environments = config?.environments;
  const block =
    environments !== null && typeof environments === 'object'
      ? (environments as Record<string, unknown>)[envName]
      : undefined;
  const env =
    block !== null && typeof block === 'object'
      ? (block as Record<string, unknown>).env
      : undefined;
  if (env === undefined) return { sources, problems };
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    return { sources, problems: [`environments.${envName}.env must be an object`] };
  }
  for (const [name, raw] of Object.entries(env as Record<string, unknown>)) {
    const at = `environments.${envName}.env.${name}`;
    if (typeof raw === 'string') {
      sources.set(name, { kind: 'value', value: raw });
      continue;
    }
    const source = readSecretSource(at, raw);
    if (typeof source === 'string') problems.push(source);
    else sources.set(name, source);
  }
  return { sources, problems };
}

function readSecretSource(at: string, raw: unknown): PackEnvSource | string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return `${at} must be a string or { secret, version, project? }`;
  }
  const { secret, version, project, ...rest } = raw as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length > 0) return `${at} takes secret, version and project, not ${extra.join(', ')}`;
  if (typeof secret !== 'string' || !SECRET_ID.test(secret)) {
    return `${at}.secret must be a Secret Manager secret id (letters, digits, _ and -)`;
  }
  if (typeof version !== 'string' || !VERSION.test(version)) {
    return `${at}.version must be a version number (e.g. "3") or "latest"`;
  }
  if (project !== undefined && (typeof project !== 'string' || !PROJECT_NUMBER.test(project))) {
    return `${at}.project must be a project number: Cloud Run names another project's secret by number`;
  }
  return {
    kind: 'secret',
    secret,
    version,
    ...(typeof project === 'string' && { project }),
  };
}

/**
 * The plan for `envName`: the pack's declaration (from `config.env`)
 * against that environment's sources. `err` when the declaration itself
 * is malformed, the same check the indexer runs.
 */
export function planPackEnv(
  config: Readonly<Record<string, unknown>> | undefined,
  envName: string,
):
  | { readonly kind: 'ok'; readonly plan: PackEnvPlan }
  | { readonly kind: 'err'; readonly message: string } {
  const declared = resolvePackEnv(config?.env);
  if (declared.kind === 'err')
    return { kind: 'err', message: `kindgi.config: ${declared.message}` };
  const declaration: PackEnvDeclaration = declared.value ?? { required: [], optional: [] };
  const { sources, problems: malformed } = readEnvironmentEnv(config, envName);

  const problems = [...malformed];
  const warnings: string[] = [];
  const entries: PackEnvPlanEntry[] = [];
  const add = (name: string, required: boolean): void => {
    const source = sources.get(name);
    entries.push({ name, required, ...(source !== undefined && { source }) });
    if (source?.kind === 'value') {
      const reason = plainSecretReason(name, source.value);
      if (reason !== undefined) {
        problems.push(`${reason}: give it as { secret, version } in environments.${envName}.env`);
      }
    }
    if (source?.kind === 'secret' && source.version === 'latest') {
      warnings.push(
        `${name} uses the latest version of ${source.secret}: it's read when an instance starts, so a new version needs a new revision`,
      );
    }
  };
  for (const name of declaration.required) add(name, true);
  for (const name of declaration.optional) add(name, false);

  const declaredNames = new Set([...declaration.required, ...declaration.optional]);
  for (const name of sources.keys()) {
    if (!declaredNames.has(name)) {
      warnings.push(
        `environments.${envName}.env.${name} isn't declared in env.required or env.optional, so it isn't injected`,
      );
    }
  }
  const missing = entries.filter((e) => e.required && e.source === undefined).map((e) => e.name);
  return { kind: 'ok', plan: { envName, entries, missing, problems, warnings } };
}

/** A secret source as Cloud Run takes it: `SECRET:VERSION`, or the full name for another project. */
export function secretReference(source: Extract<PackEnvSource, { kind: 'secret' }>): string {
  const secret =
    source.project === undefined
      ? source.secret
      : `projects/${source.project}/secrets/${source.secret}`;
  return `${secret}:${source.version}`;
}

/**
 * The Terraform input for the pack service's revision: `env` (plain
 * values) and `secret_env` (references), as JSON.
 */
export function renderTerraform(plan: PackEnvPlan): string {
  const env: Record<string, string> = {};
  const secretEnv: Record<string, { secret: string; version: string; project?: string }> = {};
  for (const entry of plan.entries) {
    const source = entry.source;
    if (source?.kind === 'value') env[entry.name] = source.value;
    if (source?.kind === 'secret') {
      secretEnv[entry.name] = {
        secret: source.secret,
        version: source.version,
        ...(source.project !== undefined && { project: source.project }),
      };
    }
  }
  return `${JSON.stringify({ env, secret_env: secretEnv }, null, 2)}\n`;
}

/**
 * `gcloud run deploy` (or `gcloud run services update`) flags:
 * `--update-env-vars` and `--update-secrets`, one per line. They add or
 * replace the names they list and leave the service's other variables as
 * they are; `--set-*` would replace the whole env, silently dropping
 * whatever else the service had (the runtime's own settings, say).
 */
export function renderGcloud(plan: PackEnvPlan): string {
  const values: string[] = [];
  const secrets: string[] = [];
  for (const entry of plan.entries) {
    const source = entry.source;
    if (source?.kind === 'value') values.push(`${entry.name}=${source.value}`);
    if (source?.kind === 'secret') secrets.push(`${entry.name}=${secretReference(source)}`);
  }
  const lines: string[] = [];
  if (values.length > 0) lines.push(`--update-env-vars=${joinForGcloud(values)}`);
  if (secrets.length > 0) lines.push(`--update-secrets=${joinForGcloud(secrets)}`);
  return lines.length > 0 ? `${lines.join(' \\\n')}\n` : '';
}

/**
 * gcloud splits a list on commas; a value with a comma needs another
 * delimiter, given as `^DELIM^` in front of the list.
 */
function joinForGcloud(items: readonly string[]): string {
  if (!items.some((item) => item.includes(','))) return items.join(',');
  const delimiter = ['@', '|', ';', '#', '~'].find((d) => !items.some((item) => item.includes(d)));
  if (delimiter === undefined) {
    throw new Error('a value contains every gcloud list delimiter Kindgi tries; set it by hand');
  }
  return `^${delimiter}^${items.join(delimiter)}`;
}

/** The plan as lines for a terminal: one per declared name, then what's wrong and worth knowing. */
/** Where an entry's value comes from, for a terminal. A secret given in the clear is never shown. */
function describeSource(entry: PackEnvPlanEntry): string {
  const source = entry.source;
  if (source === undefined) return entry.required ? '✗ no value' : '(unset: not injected)';
  if (source.kind === 'secret') return `secret ${secretReference(source)}`;
  return plainSecretReason(entry.name, source.value) === undefined
    ? `value ${JSON.stringify(source.value)}`
    : '✗ value withheld: a secret in the clear';
}

export function describePackEnvPlan(plan: PackEnvPlan): string[] {
  const lines = [`  The pack service's env in ${plan.envName}:`];
  if (plan.entries.length === 0) {
    lines.push('    (the pack declares none: add env.required / env.optional to kindgi.config)');
  }
  for (const entry of plan.entries) {
    const kind = entry.required ? 'required' : 'optional';
    lines.push(`    ${kind.padEnd(8)}  ${entry.name.padEnd(28)}  ${describeSource(entry)}`);
  }
  for (const name of plan.missing) {
    lines.push(`  ✗ ${name} is required and has no value in environments.${plan.envName}.env`);
  }
  for (const problem of plan.problems) lines.push(`  ✗ ${problem}`);
  for (const warning of plan.warnings) lines.push(`  ⚠ ${warning}`);
  return lines;
}
