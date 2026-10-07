// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Providers declared in the config (`dev/providers.ts`): the parse and
 * its refusals, the reconcile against a runtime, and the record of which
 * providers this pack registered.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Provider, RegisterProviderInput } from '@kindgi/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  type DeclaredProvider,
  type OwnedProviders,
  type ProvidersClient,
  adoptLegacyBundledEntries,
  declaredProviders,
  describeReconcile,
  devProvidersKey,
  readOwnedProviders,
  reconcileProviders,
  writeOwnedProviders,
} from '../src/dev/providers.js';
import { type ProviderPreset, loadProviderPresets } from '../src/providers/preset-loader.js';

let presets: Readonly<Record<string, ProviderPreset>>;

beforeEach(async () => {
  presets = await loadProviderPresets();
});

const parse = (providers: unknown) =>
  declaredProviders(
    { pack: { id: 'acme', version: '0.1.0' }, providers },
    'kindgi.config.ts',
    presets,
  );

const ok = (providers: unknown): readonly DeclaredProvider[] => {
  const out = parse(providers);
  if (out.kind !== 'ok') throw new Error(out.message);
  return out.providers;
};

const refused = (providers: unknown): string => {
  const out = parse(providers);
  if (out.kind !== 'invalid') throw new Error('expected a refusal');
  return out.message;
};

describe('declaredProviders', () => {
  test('no `providers`: nothing declared', () => {
    expect(declaredProviders({ pack: {} }, 'kindgi.config.ts', presets)).toEqual({
      kind: 'ok',
      providers: [],
    });
  });

  test('a preset becomes its registration body, with the key in `local` by name', () => {
    const [anthropic] = ok([{ preset: 'anthropic', models: ['claude-haiku-4-5'] }]);
    expect(anthropic?.id).toBe('anthropic');
    expect(anthropic?.input.adapter_id).toBe('@kindgi/adapter-model-anthropic');
    expect(anthropic?.input.secret_ref).toEqual({ envName: 'local', name: 'ANTHROPIC_API_KEY' });
    expect(anthropic?.input.metadata.models.map((m) => m.name)).toEqual(['claude-haiku-4-5']);
  });

  test("a preset's choices: its project, another secret's name, an output cap", () => {
    const [gemini, anthropic] = ok([
      { preset: 'gemini', project: 'acme-gcp', maxOutputTokens: 16384 },
      { preset: 'anthropic', secret: 'ACME_ANTHROPIC_KEY' },
    ]);
    expect(gemini?.input.adapter_config).toEqual({ project: 'acme-gcp' });
    expect(gemini?.input.metadata.models.every((m) => m.maxOutputTokens === 16384)).toBe(true);
    expect(anthropic?.input.secret_ref?.name).toBe('ACME_ANTHROPIC_KEY');
  });

  test('a spec is taken as `providers register --spec` takes it; its secret resolves in `local`', () => {
    const [qwen] = ok([
      {
        spec: {
          metadata: { id: 'qwen', region: 'unspecified', models: [{ name: 'qwen3-14b' }] },
          adapter_id: '@kindgi/adapter-model-openai-compat',
          secret_ref: { name: 'QWEN_API_KEY' },
          adapter_config: { baseUrl: 'https://llm.acme.example/v1' },
        },
      },
    ]);
    expect(qwen?.id).toBe('qwen');
    expect(qwen?.input.secret_ref).toEqual({ envName: 'local', name: 'QWEN_API_KEY' });
    expect(qwen?.input.adapter_config).toEqual({ baseUrl: 'https://llm.acme.example/v1' });
  });

  test('a credential in a spec is refused: it goes in `secret_ref`, by name', () => {
    for (const key of ['apiKey', 'api_key', 'Authorization', 'token', 'headers.Authorization']) {
      expect(
        refused([
          {
            spec: {
              metadata: { id: 'qwen', region: 'unspecified', models: [{ name: 'q' }] },
              adapter_id: '@kindgi/adapter-model-openai-compat',
              adapter_config: { [key]: 'sk-…' },
            },
          },
        ]),
      ).toContain(`\`spec.adapter_config.${key}\` looks like a credential`);
    }
  });

  test('refusals name the entry and what to write', () => {
    expect(refused({ preset: 'anthropic' })).toBe(
      '`providers` in kindgi.config.ts: must be a list, each a `{ preset: … }` or a `{ spec: … }`.',
    );
    expect(refused([{ preset: 'anthropic', spec: {} }])).toContain(
      'entry 1 must have one of `preset` or `spec`.',
    );
    expect(refused([{ preset: 'nope' }])).toContain(
      'entry 1: no provider preset "nope"; there are anthropic, gemini-api, gemini, groq, openai, openrouter.',
    );
    expect(refused([{ preset: 'anthropic', model: 'claude-haiku-4-5' }])).toContain('not `model`');
    expect(refused([{ preset: 'gemini' }])).toContain('preset "gemini" needs `project`');
    expect(refused([{ preset: 'anthropic', models: ['gpt-9'] }])).toContain(
      'preset "anthropic" has no model gpt-9',
    );
    expect(refused([{ preset: 'anthropic', maxOutputTokens: 0 }])).toContain(
      '`maxOutputTokens` must be a whole number of at least 1.',
    );
    expect(refused([{ preset: 'anthropic' }, { preset: 'anthropic' }])).toContain(
      'entry 2: provider "anthropic" is declared twice.',
    );
    expect(refused([{ spec: { adapter_id: 'x' } }])).toContain(
      '`spec.metadata.id` must name the provider.',
    );
  });
});

// ---------- the reconcile, against an in-memory runtime ----------

/** A runtime's providers. `normalize` stands for what the runtime adds to a registration. */
function fakeRuntime(
  initial: readonly Provider[] = [],
  normalize: (m: Provider) => Provider = (m) => m,
): ProvidersClient & {
  readonly providers: Map<string, Provider>;
  readonly calls: string[];
  failRegister?: string | undefined;
} {
  const providers = new Map(initial.map((p) => [p.id, p]));
  const calls: string[] = [];
  const runtime = {
    providers,
    calls,
    failRegister: undefined as string | undefined,
    list: async () => [...providers.values()],
    register: async (input: RegisterProviderInput) => {
      calls.push(`register ${input.metadata.id}`);
      if (runtime.failRegister !== undefined) throw new Error(runtime.failRegister);
      if (providers.has(input.metadata.id)) throw new Error('already registered');
      providers.set(input.metadata.id, normalize(input.metadata));
      return {};
    },
    unregister: async (id: string) => {
      calls.push(`unregister ${id}`);
      providers.delete(id);
      return {};
    },
  };
  return runtime;
}

const run = (
  runtime: ProvidersClient,
  declared: readonly DeclaredProvider[],
  owned: OwnedProviders = {},
  hasSecret: (name: string) => boolean = () => true,
) => reconcileProviders({ declared, owned, client: runtime, hasSecret });

const HAND_REGISTERED: Provider = {
  id: 'local-llm',
  region: 'unspecified',
  models: [{ name: 'qwen3-14b' }],
} as Provider;

describe('reconcileProviders', () => {
  test('absent: registered, and recorded as the runtime lists it', async () => {
    const runtime = fakeRuntime([], (m) => ({ ...m, description: 'added by the runtime' }));
    const declared = ok([{ preset: 'anthropic' }]);
    const first = await run(runtime, declared);
    expect(first.outcomes).toEqual([{ id: 'anthropic', kind: 'registered' }]);
    expect(Object.keys(first.owned)).toEqual(['anthropic']);

    // The next boot: the same, so nothing is sent.
    runtime.calls.length = 0;
    const second = await run(runtime, declared, first.owned);
    expect(second.outcomes).toEqual([{ id: 'anthropic', kind: 'unchanged' }]);
    expect(runtime.calls).toEqual([]);
    expect(second.owned).toEqual(first.owned);
  });

  test('changed in the config, and this pack registered it: unregistered, then registered', async () => {
    const runtime = fakeRuntime();
    const first = await run(runtime, ok([{ preset: 'anthropic' }]));
    runtime.calls.length = 0;
    const changed = await run(
      runtime,
      ok([{ preset: 'anthropic', models: ['claude-haiku-4-5'] }]),
      first.owned,
    );
    expect(changed.outcomes).toEqual([{ id: 'anthropic', kind: 'updated' }]);
    expect(runtime.calls).toEqual(['unregister anthropic', 'register anthropic']);
    expect(runtime.providers.get('anthropic')?.models.map((m) => m.name)).toEqual([
      'claude-haiku-4-5',
    ]);
    expect(changed.owned.anthropic).not.toEqual(first.owned.anthropic);
  });

  test('registered already, not by this pack: left; `present` when its metadata is as declared', async () => {
    const [anthropic] = ok([{ preset: 'anthropic' }]);
    const same = fakeRuntime([{ ...(anthropic?.input.metadata as Provider), fallback: false }]);
    const asDeclared = await run(same, ok([{ preset: 'anthropic' }]));
    expect(asDeclared.outcomes).toEqual([{ id: 'anthropic', kind: 'present' }]);
    expect(same.calls).toEqual([]);
    // Not this pack's: a later change in the config never overwrites it.
    expect(asDeclared.owned).toEqual({});

    const other = fakeRuntime([
      {
        id: 'anthropic',
        region: 'unspecified',
        models: [{ name: 'claude-haiku-4-5' }],
      } as Provider,
    ]);
    const differently = await run(other, ok([{ preset: 'anthropic' }]));
    expect(differently.outcomes).toEqual([{ id: 'anthropic', kind: 'conflict' }]);
    expect(other.calls).toEqual([]);
  });

  test("only the metadata is compared: the runtime doesn't list a provider's adapter settings or key", async () => {
    const declared = ok([
      {
        spec: {
          metadata: { id: 'qwen', region: 'unspecified', models: [{ name: 'qwen3-14b' }] },
          adapter_id: '@kindgi/adapter-model-openai-compat',
          adapter_config: { baseURL: 'https://llm.acme.example/v1' },
        },
      },
    ]);
    // Registered by hand against another endpoint: the listing shows only the metadata.
    const runtime = fakeRuntime([declared[0]?.input.metadata as Provider]);
    const out = await run(runtime, declared);
    expect(out.outcomes).toEqual([{ id: 'qwen', kind: 'present' }]);
    expect(runtime.calls).toEqual([]);
  });

  test("this pack's before, but changed in the runtime since: no longer this pack's", async () => {
    const runtime = fakeRuntime();
    const first = await run(runtime, ok([{ preset: 'anthropic' }]));
    // Someone re-registers it by hand, with other models.
    runtime.providers.set('anthropic', {
      id: 'anthropic',
      region: 'unspecified',
      models: [{ name: 'claude-opus-5-5' }],
    } as Provider);
    runtime.calls.length = 0;
    const next = await run(
      runtime,
      ok([{ preset: 'anthropic', models: ['claude-haiku-4-5'] }]),
      first.owned,
    );
    expect(next.outcomes).toEqual([{ id: 'anthropic', kind: 'conflict' }]);
    expect(runtime.calls).toEqual([]);
    expect(next.owned).toEqual({});
  });

  test("its secret isn't in the env files: skipped, nothing registered", async () => {
    const runtime = fakeRuntime();
    const out = await run(
      runtime,
      ok([{ preset: 'anthropic' }, { preset: 'gemini', project: 'p' }]),
      {},
      () => false,
    );
    expect(out.outcomes).toEqual([
      { id: 'anthropic', kind: 'skipped', secret: 'ANTHROPIC_API_KEY' },
      // Gemini finds its own credentials: nothing to check.
      { id: 'gemini', kind: 'registered' },
    ]);
    expect(runtime.calls).toEqual(['register gemini']);
  });

  test('no longer declared: unregistered when it is as this pack registered it, else left', async () => {
    const runtime = fakeRuntime([HAND_REGISTERED]);
    const first = await run(
      runtime,
      ok([{ preset: 'anthropic' }, { preset: 'gemini', project: 'p' }]),
    );
    runtime.providers.set('gemini', {
      ...(runtime.providers.get('gemini') as Provider),
      description: 'edited by hand',
    });
    runtime.calls.length = 0;
    const next = await run(runtime, [], first.owned);
    expect(next.outcomes).toEqual([
      { id: 'anthropic', kind: 'removed' },
      { id: 'gemini', kind: 'released' },
    ]);
    expect(runtime.calls).toEqual(['unregister anthropic']);
    expect(next.owned).toEqual({});
    // Registered by hand, never declared: untouched.
    expect(runtime.providers.has('local-llm')).toBe(true);
  });

  test('a fresh database (after --reset): registered again, whatever the record says', async () => {
    const before = await run(fakeRuntime(), ok([{ preset: 'anthropic' }]));
    const fresh = fakeRuntime();
    const out = await run(fresh, ok([{ preset: 'anthropic' }]), before.owned);
    expect(out.outcomes).toEqual([{ id: 'anthropic', kind: 'registered' }]);
    expect(fresh.calls).toEqual(['register anthropic']);
  });

  test('the runtime refuses one: that one fails, the rest go on, nothing recorded for it', async () => {
    const runtime = fakeRuntime();
    runtime.failRegister = 'bad-input: adapter @kindgi/adapter-model-gemini is not registered';
    const out = await run(runtime, ok([{ preset: 'gemini', project: 'p' }]));
    expect(out.outcomes).toEqual([
      {
        id: 'gemini',
        kind: 'failed',
        message: 'bad-input: adapter @kindgi/adapter-model-gemini is not registered',
      },
    ]);
    expect(out.owned).toEqual({});
  });
});

describe('describeReconcile', () => {
  const inputs = {
    file: 'kindgi.config.ts',
    kindgi: (...a: string[]) => `npx --no kindgi ${a.join(' ')}`,
    envFiles: '.env, .env.local',
  };

  test('nothing declared and nothing changed: no lines', () => {
    expect(describeReconcile([], inputs)).toEqual([]);
  });

  test('all unchanged: one line', () => {
    expect(
      describeReconcile(
        [
          { id: 'anthropic', kind: 'unchanged' },
          { id: 'gemini', kind: 'unchanged' },
        ],
        inputs,
      ),
    ).toEqual(['✓ Providers from kindgi.config.ts: anthropic, gemini (unchanged)']);
  });

  test('each outcome its line, with the command that fixes it', () => {
    expect(
      describeReconcile(
        [
          { id: 'gemini', kind: 'unchanged' },
          { id: 'anthropic', kind: 'skipped', secret: 'ANTHROPIC_API_KEY' },
          { id: 'local-llm', kind: 'conflict' },
          { id: 'qwen', kind: 'present' },
          { id: 'old', kind: 'removed' },
        ],
        inputs,
      ),
    ).toEqual([
      'Providers from kindgi.config.ts:',
      '  · gemini: unchanged',
      '  ⚠ anthropic: not registered: ANTHROPIC_API_KEY is not in .env, .env.local. Set it (npx --no kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant), then restart kindgi dev',
      "  ⚠ local-llm: registered already, not from kindgi.config.ts, with another region or models; left as it is. For the config's: npx --no kindgi providers unregister local-llm, then restart kindgi dev",
      "  · qwen: registered already, not from kindgi.config.ts, with the same models (its adapter settings and key aren't listed to compare); left as it is. For the config's: npx --no kindgi providers unregister qwen, then restart kindgi dev",
      '  ✓ old: unregistered (no longer in kindgi.config.ts)',
    ]);
  });
});

describe('the record', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kindgi-dev-providers-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('keyed by the runtime (never credentials) and the tenant', () => {
    // A database the developer names: host, port and name.
    expect(
      devProvidersKey(
        { kind: 'database', url: 'postgres://kindgi:secret@localhost:5433/kindgi_acme' },
        't-1',
      ),
    ).toBe('localhost:5433/kindgi_acme tenant t-1');
    expect(
      devProvidersKey({ kind: 'database', url: 'postgres://localhost/kindgi_acme' }, 't-1'),
    ).toBe('localhost:5432/kindgi_acme tenant t-1');
    // The bundled Postgres: the project's database, whatever port it's on.
    expect(devProvidersKey({ kind: 'bundled', database: 'kindgi_acme' }, 't-1')).toBe(
      'bundled kindgi_acme tenant t-1',
    );
    // A runtime the developer runs: its origin.
    expect(devProvidersKey({ kind: 'runtime', url: 'http://127.0.0.1:4811/' }, 't-1')).toBe(
      'runtime http://127.0.0.1:4811 tenant t-1',
    );
  });

  test("0.1.3's bundled entries (keyed on a host port) are adopted once, for that database and tenant only", async () => {
    const path = join(dir, '.kindgi', 'dev', 'providers.json');
    const mine = { anthropic: { declared: 'sha256:1', registered: 'sha256:2' } };
    const other = { gemini: { declared: 'sha256:3', registered: 'sha256:4' } };
    await writeOwnedProviders(path, '127.0.0.1:58091/kindgi_acme tenant t-1', mine);
    await writeOwnedProviders(path, '127.0.0.1:58091/kindgi_other tenant t-1', other);
    await writeOwnedProviders(path, '127.0.0.1:58091/kindgi_acme tenant t-2', other);
    await writeOwnedProviders(path, 'db.acme.example:5432/kindgi_acme tenant t-1', other);

    await adoptLegacyBundledEntries(path, 'kindgi_acme', 't-1');
    expect(await readOwnedProviders(path, 'bundled kindgi_acme tenant t-1')).toEqual(mine);
    expect(Object.keys(JSON.parse(await readFile(path, 'utf8')).runtimes).sort()).toEqual([
      '127.0.0.1:58091/kindgi_acme tenant t-2',
      '127.0.0.1:58091/kindgi_other tenant t-1',
      'bundled kindgi_acme tenant t-1',
      'db.acme.example:5432/kindgi_acme tenant t-1',
    ]);

    // Once: an entry under the new key is never overwritten.
    await writeOwnedProviders(path, '127.0.0.1:62374/kindgi_acme tenant t-1', other);
    await adoptLegacyBundledEntries(path, 'kindgi_acme', 't-1');
    expect(await readOwnedProviders(path, 'bundled kindgi_acme tenant t-1')).toEqual(mine);
    // No record: nothing to adopt, nothing written.
    await adoptLegacyBundledEntries(join(dir, 'missing.json'), 'kindgi_acme', 't-1');
  });

  test('read back per key; an emptied key is dropped; an unreadable record owns nothing', async () => {
    const path = join(dir, '.kindgi', 'dev', 'providers.json');
    expect(await readOwnedProviders(path, 'a')).toEqual({});
    const owned = { anthropic: { declared: 'sha256:1', registered: 'sha256:2' } };
    await writeOwnedProviders(path, 'a', owned);
    await writeOwnedProviders(path, 'b', owned);
    expect(await readOwnedProviders(path, 'a')).toEqual(owned);
    await writeOwnedProviders(path, 'a', {});
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ v: 1, runtimes: { b: owned } });

    await writeFile(path, '{ not json');
    expect(await readOwnedProviders(path, 'b')).toEqual({});
  });
});
