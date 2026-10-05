// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The model providers a pack declares in its config, kept in step by
 * `kindgi dev`: `providers` in `kindgi.config.ts`, or
 * `[[tool.kindgi.providers]]` in `pyproject.toml`.
 *
 * Each project (and each git worktree) has its own dev database, so a
 * provider registered by hand has to be registered again per worktree,
 * after every `--reset`, and on every teammate's machine. Declared here,
 * `kindgi dev` registers them on boot.
 *
 * A declaration is a preset with the choices `providers register
 * --preset` takes, or a full registration body (`spec`), as `--spec`
 * takes it. A credential is always a secret's name, resolved in `local`
 * (the pack's env files); a `spec` that carries one in `adapter_config`
 * is refused.
 *
 * The reconcile reads the runtime's providers first, so a fresh or reset
 * database is handled. A provider is this pack's only while it is as
 * this pack registered it: `.kindgi/dev/providers.json` records, per dev
 * database and tenant, a hash of what was declared and of what the
 * runtime listed after registering it. Anything else in the runtime —
 * registered by hand, by another pack of the project, or changed since —
 * is never touched.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Provider, RegisterProviderInput } from '@kindgi/client';
import { LOCAL_ENV_NAME } from '@kindgi/secrets-dotenv';

import { stableStringify } from '../build/envelope.js';
import { type ProviderPreset, presetRegistration } from '../providers/preset-loader.js';

/** A provider the config declares, as it will be registered. */
export interface DeclaredProvider {
  readonly id: string;
  readonly input: RegisterProviderInput;
}

export type DeclaredProvidersOutcome =
  | { readonly kind: 'ok'; readonly providers: readonly DeclaredProvider[] }
  | { readonly kind: 'invalid'; readonly message: string };

const PRESET_KEYS: ReadonlySet<string> = new Set([
  'preset',
  'models',
  'project',
  'secret',
  'maxOutputTokens',
]);

/**
 * `adapter_config` keys that hold a credential, compared lowercase with
 * `-`/`_` dropped. A credential goes in `secret_ref`, by name.
 */
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'apikey',
  'key',
  'token',
  'accesstoken',
  'bearertoken',
  'authtoken',
  'secret',
  'clientsecret',
  'password',
  'authorization',
  'credentials',
  'privatekey',
  'serviceaccountkey',
]);

/**
 * The config's `providers`, as registration bodies. `file` names the
 * config in the messages (`kindgi.config.ts`, `pyproject.toml`).
 */
export function declaredProviders(
  config: Readonly<Record<string, unknown>> | undefined,
  file: string,
  presets: Readonly<Record<string, ProviderPreset>>,
): DeclaredProvidersOutcome {
  const raw = config?.providers;
  if (raw === undefined) return { kind: 'ok', providers: [] };
  const invalid = (message: string): DeclaredProvidersOutcome => ({
    kind: 'invalid',
    message: `\`providers\` in ${file}: ${message}`,
  });
  if (!Array.isArray(raw)) {
    return invalid('must be a list, each a `{ preset: … }` or a `{ spec: … }`.');
  }
  const out: DeclaredProvider[] = [];
  for (const [i, entry] of raw.entries()) {
    const at = `entry ${i + 1}`;
    if (!isRecord(entry)) return invalid(`${at} must be a \`{ preset: … }\` or a \`{ spec: … }\`.`);
    if ('preset' in entry === 'spec' in entry) {
      return invalid(`${at} must have one of \`preset\` or \`spec\`.`);
    }
    const built = 'preset' in entry ? fromPreset(entry, presets) : fromSpec(entry.spec);
    if (built.kind === 'invalid') return invalid(`${at}: ${built.message}`);
    if (out.some((p) => p.id === built.provider.id)) {
      return invalid(`${at}: provider "${built.provider.id}" is declared twice.`);
    }
    out.push(built.provider);
  }
  return { kind: 'ok', providers: out };
}

type Built =
  | { readonly kind: 'ok'; readonly provider: DeclaredProvider }
  | { readonly kind: 'invalid'; readonly message: string };

function fromPreset(
  entry: Readonly<Record<string, unknown>>,
  presets: Readonly<Record<string, ProviderPreset>>,
): Built {
  const invalid = (message: string): Built => ({ kind: 'invalid', message });
  const problem = presetEntryProblem(entry);
  if (problem !== undefined) return invalid(problem);
  const { preset: name, models, project, secret, maxOutputTokens } = entry;
  const preset = presets[name as string];
  if (preset === undefined) {
    return invalid(`no provider preset "${name}"; there are ${Object.keys(presets).join(', ')}.`);
  }
  const built = presetRegistration(preset, {
    ...(models !== undefined && { models: models as readonly string[] }),
    ...(secret !== undefined && { secret: secret as string }),
    envName: LOCAL_ENV_NAME,
    settings: { project: project as string | undefined },
    ...(maxOutputTokens !== undefined && { maxOutputTokens: maxOutputTokens as number }),
  });
  if (built.kind === 'err') {
    // The preset's messages name the CLI flags (`--project=<…>`); the config names keys.
    return invalid(built.message.replace(/--([a-z]+)=<…>/g, '`$1`'));
  }
  return { kind: 'ok', provider: { id: built.input.metadata.id, input: built.input } };
}

/** What's wrong with a preset entry's keys and values, before the preset is looked up. */
function presetEntryProblem(entry: Readonly<Record<string, unknown>>): string | undefined {
  const unknown = Object.keys(entry).filter((k) => !PRESET_KEYS.has(k));
  if (unknown.length > 0) {
    return `a preset takes ${[...PRESET_KEYS].map((k) => `\`${k}\``).join(', ')}; not ${unknown.map((k) => `\`${k}\``).join(', ')}.`;
  }
  const { preset: name, models, project, secret, maxOutputTokens } = entry;
  if (typeof name !== 'string' || name === '') return '`preset` must be a preset name.';
  if (
    models !== undefined &&
    (!Array.isArray(models) ||
      models.length === 0 ||
      !models.every((m): m is string => typeof m === 'string' && m !== ''))
  ) {
    return '`models` must be a non-empty list of model names.';
  }
  for (const [key, value] of [
    ['project', project],
    ['secret', secret],
  ] as const) {
    if (value !== undefined && (typeof value !== 'string' || value === '')) {
      return `\`${key}\` must be a non-empty string.`;
    }
  }
  if (
    maxOutputTokens !== undefined &&
    (typeof maxOutputTokens !== 'number' ||
      !Number.isInteger(maxOutputTokens) ||
      maxOutputTokens < 1)
  ) {
    return '`maxOutputTokens` must be a whole number of at least 1.';
  }
  return undefined;
}

function fromSpec(spec: unknown): Built {
  const invalid = (message: string): Built => ({ kind: 'invalid', message });
  if (!isRecord(spec)) {
    return invalid('`spec` must be a registration body, as `providers register --spec` takes it.');
  }
  const metadata = spec.metadata;
  if (!isRecord(metadata) || typeof metadata.id !== 'string' || metadata.id === '') {
    return invalid('`spec.metadata.id` must name the provider.');
  }
  if (typeof spec.adapter_id !== 'string' || spec.adapter_id === '') {
    return invalid('`spec.adapter_id` must name the adapter.');
  }
  const config = spec.adapter_config;
  if (config !== undefined) {
    if (!isRecord(config)) return invalid('`spec.adapter_config` must be an object.');
    // Keys may be dotted (`extraBody.x`, one per request field): any part counts.
    const credentials = Object.keys(config).filter((k) =>
      k.split('.').some((part) => CREDENTIAL_KEYS.has(part.toLowerCase().replace(/[-_]/g, ''))),
    );
    if (credentials.length > 0) {
      return invalid(
        `\`spec.adapter_config.${credentials[0]}\` looks like a credential. Credentials go in \`secret_ref\`, by name ({ name: "MY_API_KEY" }), with the value in the env files.`,
      );
    }
  }
  const ref = spec.secret_ref;
  if (ref !== undefined && (!isRecord(ref) || typeof ref.name !== 'string' || ref.name === '')) {
    return invalid('`spec.secret_ref` must be `{ name: "<SECRET_NAME>" }`.');
  }
  // Under `kindgi dev`, secrets resolve in `local`: the pack's env files.
  const input = (ref === undefined
    ? spec
    : {
        ...spec,
        secret_ref: { envName: LOCAL_ENV_NAME, ...ref },
      }) as unknown as RegisterProviderInput;
  return { kind: 'ok', provider: { id: metadata.id, input } };
}

// ---------- the ownership record ----------

/** What this pack registered: hashes of the declared body and of the runtime's listing after. */
export interface OwnedProvider {
  readonly declared: string;
  readonly registered: string;
}

export type OwnedProviders = Readonly<Record<string, OwnedProvider>>;

interface ProvidersRecordFile {
  readonly v: 1;
  /** By `devProvidersKey`: the dev database and tenant. */
  readonly runtimes: Readonly<Record<string, OwnedProviders>>;
}

/** Where `kindgi dev` records which providers this pack registered. */
export function devProvidersRecordPath(packDir: string): string {
  return join(packDir, '.kindgi', 'dev', 'providers.json');
}

/**
 * The record's key: the dev database (host, port, name; never the
 * credentials) and the tenant. Another database, or a new tenant, starts
 * with nothing owned.
 */
export function devProvidersKey(databaseUrl: string | undefined, tenantId: string): string {
  let database = 'unknown';
  if (databaseUrl !== undefined) {
    try {
      const url = new URL(databaseUrl);
      database = `${url.hostname}:${url.port === '' ? '5432' : url.port}${url.pathname}`;
    } catch {
      database = createHash('sha256').update(databaseUrl).digest('hex').slice(0, 16);
    }
  }
  return `${database} tenant ${tenantId}`;
}

/** This pack's providers in that database and tenant; nothing when the record is missing or unreadable. */
export async function readOwnedProviders(path: string, key: string): Promise<OwnedProviders> {
  const file = await readRecordFile(path);
  return file?.runtimes[key] ?? {};
}

export async function writeOwnedProviders(
  path: string,
  key: string,
  owned: OwnedProviders,
): Promise<void> {
  const file = await readRecordFile(path);
  const runtimes: Record<string, OwnedProviders> = { ...(file?.runtimes ?? {}) };
  if (Object.keys(owned).length === 0) delete runtimes[key];
  else runtimes[key] = owned;
  if (file === undefined && Object.keys(runtimes).length === 0) return;
  const next: ProvidersRecordFile = { v: 1, runtimes };
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

async function readRecordFile(path: string): Promise<ProvidersRecordFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed) && parsed.v === 1 && isRecord(parsed.runtimes)) {
      return parsed as unknown as ProvidersRecordFile;
    }
  } catch {
    // A record that can't be read owns nothing: providers are then left alone.
  }
  return undefined;
}

// ---------- the reconcile ----------

export interface ProvidersClient {
  /** Every provider of the tenant (all pages). */
  readonly list: () => Promise<readonly Provider[]>;
  readonly register: (input: RegisterProviderInput) => Promise<unknown>;
  readonly unregister: (id: string) => Promise<unknown>;
}

export type ProviderOutcome =
  | { readonly id: string; readonly kind: 'registered' | 'updated' | 'unchanged' | 'removed' }
  /**
   * Registered already, not by this pack, with the declared metadata: left.
   * The runtime lists only a provider's metadata (not its adapter, the
   * adapter's settings or the key's name), so those can't be compared.
   */
  | { readonly id: string; readonly kind: 'present' }
  /** Registered already, not by this pack, with other metadata (region, models): left. */
  | { readonly id: string; readonly kind: 'conflict' }
  /** This pack's before, changed since in the runtime: left, and no longer this pack's. */
  | { readonly id: string; readonly kind: 'released' }
  /** Its secret isn't in the env files: not registered. */
  | { readonly id: string; readonly kind: 'skipped'; readonly secret: string }
  | { readonly id: string; readonly kind: 'failed'; readonly message: string };

export interface ReconcileInputs {
  readonly declared: readonly DeclaredProvider[];
  readonly owned: OwnedProviders;
  readonly client: ProvidersClient;
  /** Whether a secret of `local` can be resolved (it's in the pack's env files). */
  readonly hasSecret: (name: string) => boolean;
}

export interface ReconcileResult {
  readonly outcomes: readonly ProviderOutcome[];
  /** The record to keep. */
  readonly owned: OwnedProviders;
}

/** Bring the runtime's providers in step with the config's. Throws only when they can't be listed. */
export async function reconcileProviders(inputs: ReconcileInputs): Promise<ReconcileResult> {
  const runtime = new Map((await inputs.client.list()).map((p) => [p.id, p]));
  const owned: Record<string, OwnedProvider> = {};
  const outcomes: ProviderOutcome[] = [];
  const toRecord: DeclaredProvider[] = [];

  for (const provider of inputs.declared) {
    const step = await reconcileDeclared(provider, runtime.get(provider.id), inputs);
    outcomes.push(step.outcome);
    if (step.keep !== undefined) owned[provider.id] = step.keep;
    if (step.registered) toRecord.push(provider);
  }

  // This pack's providers its config no longer declares.
  for (const [id, before] of Object.entries(inputs.owned)) {
    if (inputs.declared.some((p) => p.id === id)) continue;
    const step = await removeUndeclared(id, before, runtime.get(id), inputs.client);
    if (step.outcome !== undefined) outcomes.push(step.outcome);
    if (step.keep !== undefined) owned[id] = step.keep;
  }

  Object.assign(owned, await recordRegistered(toRecord, inputs.client));
  return { outcomes, owned };
}

/**
 * A provider this pack registered and its config no longer declares:
 * unregistered when it is as this pack registered it, else left.
 */
async function removeUndeclared(
  id: string,
  before: OwnedProvider,
  current: Provider | undefined,
  client: ProvidersClient,
): Promise<{ readonly outcome?: ProviderOutcome; readonly keep?: OwnedProvider }> {
  if (current === undefined) return {};
  if (hashOf(current) !== before.registered) return { outcome: { id, kind: 'released' } };
  try {
    await client.unregister(id);
    return { outcome: { id, kind: 'removed' } };
  } catch (err) {
    return { outcome: { id, kind: 'failed', message: messageOf(err) }, keep: before };
  }
}

/**
 * The record entries for providers registered now, as the runtime lists
 * them: that is what "still this pack's" is checked against. Not listed,
 * they aren't recorded, and the next boot leaves them as they are.
 */
async function recordRegistered(
  registered: readonly DeclaredProvider[],
  client: ProvidersClient,
): Promise<Record<string, OwnedProvider>> {
  if (registered.length === 0) return {};
  const after = await client.list().then(
    (all) => new Map(all.map((p) => [p.id, p])),
    () => new Map<string, Provider>(),
  );
  const owned: Record<string, OwnedProvider> = {};
  for (const provider of registered) {
    const listed = after.get(provider.id);
    if (listed !== undefined) {
      owned[provider.id] = { declared: hashOf(provider.input), registered: hashOf(listed) };
    }
  }
  return owned;
}

interface DeclaredStep {
  readonly outcome: ProviderOutcome;
  /** The record entry kept for it, when it stays this pack's as it was. */
  readonly keep?: OwnedProvider;
  /** Registered now: recorded once the runtime lists it. */
  readonly registered?: true;
}

/** One declared provider against the runtime's `current`. */
async function reconcileDeclared(
  provider: DeclaredProvider,
  current: Provider | undefined,
  inputs: ReconcileInputs,
): Promise<DeclaredStep> {
  const { id } = provider;
  const before = inputs.owned[id];
  // This pack's: registered by it, and as it registered it.
  const mine = current !== undefined && before?.registered === hashOf(current) ? before : undefined;
  if (current !== undefined && mine === undefined) {
    return {
      outcome: { id, kind: covers(provider.input.metadata, current) ? 'present' : 'conflict' },
    };
  }
  const keep = mine !== undefined ? { keep: mine } : {};
  if (mine !== undefined && mine.declared === hashOf(provider.input)) {
    return { outcome: { id, kind: 'unchanged' }, ...keep };
  }
  const ref = provider.input.secret_ref;
  if (ref !== undefined && ref.envName === LOCAL_ENV_NAME && !inputs.hasSecret(ref.name)) {
    return { outcome: { id, kind: 'skipped', secret: ref.name }, ...keep };
  }
  // There's no update: a changed provider is unregistered, then registered.
  try {
    if (mine !== undefined) await inputs.client.unregister(id);
  } catch (err) {
    return { outcome: { id, kind: 'failed', message: messageOf(err) }, ...keep };
  }
  try {
    await inputs.client.register(provider.input);
    return {
      outcome: { id, kind: mine !== undefined ? 'updated' : 'registered' },
      registered: true,
    };
  } catch (err) {
    return { outcome: { id, kind: 'failed', message: messageOf(err) } };
  }
}

export interface DescribeInputs {
  /** The config's file name. */
  readonly file: string;
  /** A `kindgi` command line, in the pack's own runner. */
  readonly kindgi: (...args: string[]) => string;
  /** The env files `local` reads, for a missing secret's line. */
  readonly envFiles: string;
}

/** The boot log's lines for a reconcile; none when the config declares nothing and nothing changed. */
export function describeReconcile(
  outcomes: readonly ProviderOutcome[],
  inputs: DescribeInputs,
): readonly string[] {
  if (outcomes.length === 0) return [];
  const unchanged = outcomes.filter((o) => o.kind === 'unchanged').map((o) => o.id);
  if (unchanged.length === outcomes.length) {
    return [`✓ Providers from ${inputs.file}: ${unchanged.join(', ')} (unchanged)`];
  }
  const unregister = (id: string): string =>
    `${inputs.kindgi('providers', 'unregister', id)}, then restart kindgi dev`;
  const lines = [`Providers from ${inputs.file}:`];
  if (unchanged.length > 0) lines.push(`  · ${unchanged.join(', ')}: unchanged`);
  for (const o of outcomes) {
    switch (o.kind) {
      case 'unchanged':
        break;
      case 'registered':
        lines.push(`  ✓ ${o.id}: registered`);
        break;
      case 'updated':
        lines.push(`  ✓ ${o.id}: registered again (changed in ${inputs.file})`);
        break;
      case 'removed':
        lines.push(`  ✓ ${o.id}: unregistered (no longer in ${inputs.file})`);
        break;
      case 'present':
        lines.push(
          `  · ${o.id}: registered already, not from ${inputs.file}, with the same models (its adapter settings and key aren't listed to compare); left as it is. For the config's: ${unregister(o.id)}`,
        );
        break;
      case 'conflict':
        lines.push(
          `  ⚠ ${o.id}: registered already, not from ${inputs.file}, with another region or models; left as it is. For the config's: ${unregister(o.id)}`,
        );
        break;
      case 'released':
        lines.push(
          `  · ${o.id}: changed in the runtime since kindgi dev registered it; left as it is`,
        );
        break;
      case 'skipped':
        lines.push(
          `  ⚠ ${o.id}: not registered: ${o.secret} is not in ${inputs.envFiles}. Set it (${inputs.kindgi('secrets', 'set', o.secret, `--env=${LOCAL_ENV_NAME}`, '--scope=tenant')}), then restart kindgi dev`,
        );
        break;
      case 'failed':
        lines.push(`  ✗ ${o.id}: ${o.message}`);
        break;
    }
  }
  return lines;
}

function hashOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

/** Whether everything `expected` says, `actual` says too (the runtime may add defaults). */
function covers(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, i) => covers(item, actual[i]))
    );
  }
  if (isRecord(expected)) {
    return isRecord(actual) && Object.entries(expected).every(([k, v]) => covers(v, actual[k]));
  }
  return expected === actual;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
