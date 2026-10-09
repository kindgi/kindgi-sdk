// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for `kindgi-index` — the build-time pack manifest indexer.
 * Fixtures use `importModule` override so the indexer runs against
 * in-memory modules keyed by file URL; the on-disk files are empty
 * stubs used only for discovery.
 */

import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as addFormatsModule from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';

import { BUILT_IN_CHECK_IDS } from '@kindgi/guardrails';

import { RESERVED_CHECK_IDS, main, readBundleMap, runIndexer } from '../src/kindgi-index.js';

// Every index this suite writes must satisfy the spec (`@kindgi/specs/pack-index.schema.json`).
const addFormats = ((addFormatsModule as { default?: unknown }).default ??
  addFormatsModule) as unknown as (ajv: Ajv2020) => void;
const specAjv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: false });
addFormats(specAjv);
const validateIndexSpec = specAjv.compile(
  JSON.parse(
    await fs.readFile(
      createRequire(import.meta.url).resolve('@kindgi/specs/pack-index.schema.json'),
      'utf8',
    ),
  ) as object,
);

/** The written index, parsed — after checking it against the pack-index spec. */
async function readValidIndex(outputPath: string): Promise<any> {
  const parsed: unknown = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  expect(validateIndexSpec(parsed) ? [] : validateIndexSpec.errors).toEqual([]);
  return parsed;
}

// Fixed publishedAt for byte-determinism assertions.
const FIXED_TIMESTAMP = '2026-09-20T14:32:07.104Z';

interface FixtureFile {
  readonly module: unknown;
  readonly content?: string;
}

interface FixtureSpec {
  readonly files: Readonly<Record<string, FixtureFile>>;
}

interface FixtureHandle {
  readonly packDir: string;
  readonly importModule: (url: string) => Promise<unknown>;
}

let scratch: string;
const createdDirs: string[] = [];

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'kindgi-indexer-'));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
  for (const dir of createdDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  createdDirs.length = 0;
});

async function makeFixture(spec: FixtureSpec): Promise<FixtureHandle> {
  const packDir = await fs.mkdtemp(path.join(scratch, 'pack-'));
  const map = new Map<string, unknown>();

  for (const [relPath, entry] of Object.entries(spec.files)) {
    const absPath = path.join(packDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, entry.content ?? '// stub for indexer discovery\n');
    const url = pathToFileURL(absPath).href;
    map.set(url, entry.module);
  }

  const importModule = async (url: string): Promise<unknown> => {
    if (!map.has(url)) {
      throw new Error(`fixture: no module registered at ${url}`);
    }
    return map.get(url);
  };
  return { packDir, importModule };
}

function config(overrides: Record<string, unknown> = {}): FixtureFile {
  return {
    module: {
      default: {
        pack: { id: 'acme.pack', version: '1.0.0' },
        ...overrides,
      },
    },
  };
}

function toolModule(overrides: Record<string, unknown> = {}): FixtureFile {
  return {
    module: {
      default: {
        id: 'acme.echo',
        description: 'echo',
        input: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
          additionalProperties: false,
        },
        output: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
          additionalProperties: false,
        },
        effects: [{ kind: 'reads', resource: 'kb' }],
        handler: async (input: unknown) => input,
        ...overrides,
      },
    },
  };
}

function guardrailModule(overrides: Record<string, unknown> = {}): FixtureFile {
  return {
    module: {
      default: {
        id: 'acme.grounded',
        name: 'Response is grounded in retrieval',
        kind: 'zero-llm',
        check: 'acme.checks.grounded',
        action: { 'on-violation': 'halt' },
        severity: 'blocking',
        ...overrides,
      },
    },
  };
}

function agentModule(overrides: Record<string, unknown> = {}): FixtureFile {
  return {
    module: {
      default: {
        id: 'acme.support',
        version: '1.0.0',
        name: 'Support agent',
        instructions: 'You are helpful.',
        capabilities: [{ needs: [{ feature: 'tool-use' }] }],
        tools: [{ id: 'acme.echo', version: '1.0.0' }],
        retrieval: [],
        guardrails: ['acme.grounded'],
        ...overrides,
      },
    },
  };
}

function flowModule(overrides: Record<string, unknown> = {}): FixtureFile {
  return {
    module: {
      default: {
        id: 'acme.flow',
        version: '1.0.0',
        nodes: [{ id: 'step-1', kind: 'tool', ref: 'acme.echo' }],
        edges: [{ id: 'e-start', from: '$start', to: 'step-1' }],
        ...overrides,
      },
    },
  };
}

// -----------------------------------------------------------------------
// Happy path + count assertions
// -----------------------------------------------------------------------

describe('runIndexer — happy path', () => {
  test('indexes 2 tools + 1 guardrail + 1 agent + 1 flow', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/echo.mjs': toolModule(),
        'tools/reverse.mjs': toolModule({ id: 'acme.reverse' }),
        'guardrails/grounded.mjs': guardrailModule(),
        'agents/support.mjs': agentModule(),
        'flows/flow.mjs': flowModule(),
      },
    });

    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      artifactVersion: '20260920.1',
      importModule: fixture.importModule,
    });

    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.counts).toEqual({
      tools: 2,
      guardrails: 1,
      agents: 1,
      flows: 1,
    });

    const parsed = await readValidIndex(outcome.value.outputPath);
    expect(parsed.v).toBe(1);
    expect(parsed.packId).toBe('acme.pack');
    expect(parsed.packVersion).toBe('1.0.0');
    expect(parsed.artifactVersion).toBe('20260920.1');
    expect(parsed.publishedAt).toBe(FIXED_TIMESTAMP);
    expect(parsed.tools.map((t: { id: string }) => t.id)).toEqual(['acme.echo', 'acme.reverse']);
    expect(parsed.tools[0].modulePath).toBe('tools/echo.mjs');
    expect(parsed.guardrails[0].checkModulePath).toBe('guardrails/grounded.mjs');
    expect(parsed.guardrails[0].checkId).toBe('acme.checks.grounded');
    expect(parsed.agents[0].modulePath).toBe('agents/support.mjs');
    expect(parsed.flows[0].modulePath).toBe('flows/flow.mjs');
    expect(parsed.flows[0].kernelPayloadVersion).toBe(1);
  });
});

describe('runIndexer — flows (schema-version 1.8.0)', () => {
  test('a flow keeps every field it declares: description, maxParallelism, metadata, output, node inputMapping', async () => {
    const output = { mapping: { result: { path: 'nodeOutputs.step-1' } } };
    const inputMapping = { id: { path: 'runInput.id' } };
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'flows/flow.mjs': flowModule({
          description: 'A one-step flow.',
          maxParallelism: 2,
          metadata: { owner: 'acme' },
          nodes: [{ id: 'step-1', kind: 'tool', ref: 'acme.echo', inputMapping }],
          output,
        }),
      },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      artifactVersion: '20260930.1',
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    const parsed = await readValidIndex(outcome.value.outputPath);
    expect(parsed.flows[0]).toMatchObject({
      description: 'A one-step flow.',
      maxParallelism: 2,
      metadata: { owner: 'acme' },
      output,
      nodes: [{ id: 'step-1', inputMapping }],
    });
  });

  test("an invalid flow fails indexing with the loader's message", async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'flows/flow.mjs': flowModule({ output: { mapping: { x: { path: 'nodeOutputs.ghost' } } } }),
      },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      artifactVersion: '20260930.1',
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.fileErrors[0]?.code).toBe('manifest-validation-failed');
    expect(outcome.value.fileErrors[0]?.filePath).toBe('flows/flow.mjs');
    expect(outcome.value.fileErrors[0]?.message).toContain('nodeOutputs.ghost names no node');
  });
});

// -----------------------------------------------------------------------
// Built-in check ids: a pack names one, never ships its own under one
// -----------------------------------------------------------------------

describe('built-in check ids', () => {
  const index = async (guardrailFile: FixtureFile) => {
    const fixture = await makeFixture({
      files: { 'kindgi.config.mjs': config(), 'guardrails/cites.mjs': guardrailFile },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      artifactVersion: '20261009.1',
      importModule: fixture.importModule,
    });
    if (outcome.kind !== 'ok') throw new Error('indexer failed');
    return outcome.value;
  };
  const evaluate = async () => ({ passed: true });

  test("RESERVED_CHECK_IDS is @kindgi/guardrails' BUILT_IN_CHECK_IDS", () => {
    expect([...RESERVED_CHECK_IDS].sort()).toEqual([...BUILT_IN_CHECK_IDS].sort());
  });

  test("the Python SDK's RESERVED_CHECK_IDS is the same set", async () => {
    const definePy = await fs.readFile(
      new URL('../../../sdks/python/src/kindgi/pack/define.py', import.meta.url),
      'utf8',
    );
    const block = /RESERVED_CHECK_IDS = frozenset\(\s*\{([^}]*)\}/.exec(definePy)?.[1];
    if (block === undefined) throw new Error('RESERVED_CHECK_IDS not found in define.py');
    const ids = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(ids.sort()).toEqual([...BUILT_IN_CHECK_IDS].sort());
  });

  test('a guardrail naming a built-in (a string) indexes: it uses the built-in', async () => {
    const report = await index(guardrailModule({ check: 'must-cite' }));
    expect(report.fileErrors).toEqual([]);
    const parsed = await readValidIndex(report.outputPath);
    expect(parsed.guardrails[0]).toMatchObject({ id: 'acme.grounded', checkId: 'must-cite' });
  });

  test.each([
    ["the guardrail's own check", (id: string) => guardrailModule({ check: { id, evaluate } })],
    [
      'a check the module exports',
      (id: string) => ({
        module: {
          default: (guardrailModule({ check: id }).module as { default: unknown }).default,
          check: { id, evaluate },
        },
      }),
    ],
  ] as const)(
    'an implementation under a built-in id, as %s: refused, saying to rename it',
    async (_how, file) => {
      const report = await index(file('must-cite') as FixtureFile);
      expect(report.fileErrors).toEqual([
        expect.objectContaining({
          code: 'reserved-check-id',
          filePath: 'guardrails/cites.mjs',
          message: expect.stringContaining(
            'ships its own check under "must-cite", a built-in check\'s id: a pack can\'t replace a built-in. Rename your check',
          ),
        }),
      ]);
    },
  );

  test('an object that only names a built-in (no evaluate) is no implementation', async () => {
    const report = await index({
      module: {
        default: (guardrailModule({ check: 'must-cite' }).module as { default: unknown }).default,
        citeSettings: { id: 'must-cite', minCitations: 2 },
      },
    });
    expect(report.fileErrors).toEqual([]);
  });

  test("an implementation under the pack's own id is fine", async () => {
    const report = await index(guardrailModule({ check: { id: 'acme.checks.cites', evaluate } }));
    expect(report.fileErrors).toEqual([]);
  });
});

// -----------------------------------------------------------------------
// Zod → JSON Schema pass
// -----------------------------------------------------------------------

describe('runIndexer — Zod schemas', () => {
  test('Zod input on a tool is converted to JSON Schema', async () => {
    const InputZod = z.object({
      query: z.string().min(1),
      topK: z.number().int().min(1).max(20),
    });
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/search.mjs': {
          module: {
            default: {
              id: 'acme.search',
              inputZod: InputZod,
              input: InputZod, // wire slot pre-conversion, indexer overwrites
              output: {
                type: 'object',
                properties: { hits: { type: 'array' } },
                required: ['hits'],
              },
              handler: async () => ({ hits: [] }),
            },
          },
        },
      },
    });

    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;

    const parsed = await readValidIndex(outcome.value.outputPath);
    // The input side: what a caller sends.
    const expected = z.toJSONSchema(InputZod, { io: 'input' });
    expect(parsed.tools[0].input).toEqual(expected);
  });

  test('Zod output + JSON Schema input on the same tool — both preserved', async () => {
    const OutputZod = z.object({ ok: z.boolean() });
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/mixed.mjs': {
          module: {
            default: {
              id: 'acme.mixed',
              input: {
                type: 'object',
                properties: { x: { type: 'number' } },
                required: ['x'],
              },
              output: OutputZod, // wire slot holds the raw Zod schema
              outputZod: OutputZod,
              handler: async () => ({ ok: true }),
            },
          },
        },
      },
    });

    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;

    const parsed = await readValidIndex(outcome.value.outputPath);
    expect(parsed.tools[0].input.type).toBe('object');
    expect(parsed.tools[0].output).toEqual(z.toJSONSchema(OutputZod));
  });

  test("a declarative tool's spec is carried into the index, so the runtime runs it", async () => {
    const spec = {
      kind: 'http',
      method: 'GET',
      urlTemplate: 'https://api.example.com/{owner}',
      authorization: { kind: 'bearer', secretRef: { envName: 'local', name: 'API_TOKEN' } },
    };
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/echo.mjs': toolModule({ spec }),
      },
    });

    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;

    const parsed = await readValidIndex(outcome.value.outputPath);
    expect(parsed.tools[0].spec).toEqual(spec);
  });

  test("a tool's `mutating` is carried into the index: a read-only tool stays read-only", async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/lookup.mjs': toolModule({ id: 'acme.lookup', mutating: false }),
        'tools/save.mjs': toolModule({ id: 'acme.save', mutating: true }),
        'tools/plain.mjs': toolModule({ id: 'acme.plain' }),
      },
    });

    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;

    const parsed = await readValidIndex(outcome.value.outputPath);
    const byId = new Map(
      (parsed.tools as { id: string; mutating?: boolean }[]).map((t) => [t.id, t]),
    );
    expect(byId.get('acme.lookup')?.mutating).toBe(false);
    expect(byId.get('acme.save')?.mutating).toBe(true);
    expect(byId.get('acme.plain')).not.toHaveProperty('mutating');
  });

  test("the pack's declared env is carried, sorted; a pack that declares none has no `env`", async () => {
    const declared = await makeFixture({
      files: {
        'kindgi.config.mjs': config({
          env: { required: ['STORAGE_BUCKET', 'DATABASE_URL'], optional: ['LOG_LEVEL'] },
        }),
        'tools/echo.mjs': toolModule(),
      },
    });
    const outcome = await runIndexer({
      packDir: declared.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: declared.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    const parsed = await readValidIndex(outcome.value.outputPath);
    expect(parsed.env).toEqual({
      optional: ['LOG_LEVEL'],
      required: ['DATABASE_URL', 'STORAGE_BUCKET'],
    });

    const none = await makeFixture({
      files: {
        'kindgi.config.mjs': config({ env: { required: [], optional: [] } }),
        'tools/echo.mjs': toolModule(),
      },
    });
    const plain = await runIndexer({
      packDir: none.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: none.importModule,
    });
    expect(plain.kind).toBe('ok');
    if (plain.kind !== 'ok') return;
    expect(await readValidIndex(plain.value.outputPath)).not.toHaveProperty('env');
  });

  test('a malformed env declaration fails indexing as config-invalid, naming every problem', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config({
          env: {
            required: ['DATABASE_URL', 'KINDGI_ENV', 'not a name'],
            optional: ['DATABASE_URL'],
          },
        }),
        'tools/echo.mjs': toolModule(),
      },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('err');
    if (outcome.kind !== 'err') return;
    expect(outcome.error).toMatchObject({ code: 'config-invalid', field: 'env' });
    expect(outcome.error.message).toContain('`KINDGI_*` names configure Kindgi');
    expect(outcome.error.message).toContain(
      `"not a name" in \`env.required\` isn't an environment variable name`,
    );
    expect(outcome.error.message).toContain(
      '"DATABASE_URL" is in both `env.required` and `env.optional`',
    );
  });

  test("Guardrail's config is carried into the index", async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/echo.mjs': toolModule(),
        'guardrails/no-secrets.mjs': {
          module: {
            default: {
              id: 'acme.no-secrets',
              kind: 'zero-llm',
              check: 'forbidden-substring',
              config: { substrings: ['password', 'api_key'], caseSensitive: false },
              action: { 'on-violation': 'halt' },
            },
          },
        },
      },
    });

    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;

    const parsed = await readValidIndex(outcome.value.outputPath);
    expect(parsed.guardrails[0].config).toEqual({
      substrings: ['password', 'api_key'],
      caseSensitive: false,
    });
  });

  test('Guardrail with Zod configSchema → converted to JSON Schema', async () => {
    const ConfigZod = z.object({ threshold: z.number().min(0).max(1) });
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/echo.mjs': toolModule(),
        'guardrails/threshold.mjs': {
          module: {
            default: {
              id: 'acme.threshold',
              kind: 'zero-llm',
              check: 'acme.checks.threshold',
              action: { 'on-violation': 'halt' },
              configZod: ConfigZod,
              config: { threshold: 0.5 },
            },
          },
        },
      },
    });

    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;

    const parsed = await readValidIndex(outcome.value.outputPath);
    expect(parsed.guardrails[0].configSchema).toEqual(z.toJSONSchema(ConfigZod, { io: 'input' }));
  });

  describe("a guardrail's config is checked against its configSchema", () => {
    /** Index a pack whose one guardrail has `fields` added. */
    async function indexGuardrail(fields: Record<string, unknown>) {
      const fixture = await makeFixture({
        files: {
          'kindgi.config.mjs': config(),
          'tools/echo.mjs': toolModule(),
          'guardrails/limit.mjs': {
            module: {
              default: {
                id: 'acme.limit',
                kind: 'zero-llm',
                check: 'acme.checks.limit',
                action: { 'on-violation': 'halt' },
                ...fields,
              },
            },
          },
        },
      });
      return runIndexer({
        packDir: fixture.packDir,
        publishedAt: FIXED_TIMESTAMP,
        importModule: fixture.importModule,
      });
    }

    /** The one file error, and that the guardrail isn't in the index (`kindgi build` refuses). */
    async function rejected(outcome: Awaited<ReturnType<typeof indexGuardrail>>) {
      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') throw new Error('expected the index to be written');
      expect((await readValidIndex(outcome.value.outputPath)).guardrails).toEqual([]);
      expect(outcome.value.fileErrors).toHaveLength(1);
      return outcome.value.fileErrors[0];
    }

    test("a config that doesn't fit is a file error, naming the guardrail and where", async () => {
      const error = await rejected(
        await indexGuardrail({
          configZod: z.object({ maxChars: z.number().int().min(0) }),
          config: { maxChars: -5 },
        }),
      );
      expect(error).toMatchObject({
        code: 'manifest-validation-failed',
        field: 'config',
        filePath: 'guardrails/limit.mjs',
        message:
          "guardrails/limit.mjs: guardrail acme.limit's config doesn't fit its configSchema at /maxChars: must be >= 0",
      });
    });

    test('no config, with a required field that has no default: a file error', async () => {
      const error = await rejected(
        await indexGuardrail({ configZod: z.object({ maxChars: z.number().int().min(0) }) }),
      );
      expect(error?.message).toContain(
        "guardrail acme.limit's config doesn't fit its configSchema: must have required property 'maxChars'",
      );
    });

    test('a config that is not an object: a file error', async () => {
      const error = await rejected(await indexGuardrail({ config: 'strict' }));
      expect(error?.message).toContain("guardrail acme.limit's config must be an object");
    });

    test('no config, and every field has a default: indexed, the config kept as declared', async () => {
      const outcome = await indexGuardrail({
        configZod: z.object({ minLength: z.number().int().min(0).default(1) }),
      });
      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;
      const parsed = await readValidIndex(outcome.value.outputPath);
      expect(parsed.guardrails[0].config).toBeUndefined();
    });
  });

  test('Zod converter failure surfaces as zod-conversion-failed', async () => {
    // A schema Zod v4 cannot represent as JSON Schema on either side
    // (a bigint). A transform no longer qualifies: its input side converts.
    const BrokenZod = z.object({ n: z.bigint() });
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/broken.mjs': {
          module: {
            default: {
              id: 'acme.broken',
              inputZod: BrokenZod,
              input: BrokenZod,
              output: { type: 'object' },
              handler: async () => ({}),
            },
          },
        },
      },
    });

    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.fileErrors[0]?.code).toBe('zod-conversion-failed');
    expect(outcome.value.fileErrors[0]?.filePath).toBe('tools/broken.mjs');
  });
});

// -----------------------------------------------------------------------
// Failure surfaces
// -----------------------------------------------------------------------

describe('runIndexer — error variants', () => {
  test('missing kindgi.config.* → config-not-found', async () => {
    const emptyDir = await fs.mkdtemp(path.join(scratch, 'empty-'));
    // handler present so a nonzero discovery isn't the failure
    await fs.mkdir(path.join(emptyDir, 'tools'), { recursive: true });
    await fs.writeFile(path.join(emptyDir, 'tools', 'echo.mjs'), '// stub');

    const outcome = await runIndexer({
      packDir: emptyDir,
      importModule: async () => ({ default: {} }),
    });
    expect(outcome.kind).toBe('err');
    if (outcome.kind !== 'err') return;
    expect(outcome.error.code).toBe('config-not-found');
  });

  test('no discovered files → discovery-empty', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
      },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('err');
    if (outcome.kind !== 'err') return;
    expect(outcome.error.code).toBe('discovery-empty');
  });

  test('file that throws on import → file-import-failed', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/boom.mjs': toolModule(),
      },
    });
    const boomUrl = pathToFileURL(path.join(fixture.packDir, 'tools', 'boom.mjs')).href;
    const throwing = async (url: string): Promise<unknown> => {
      if (url === boomUrl) throw new Error('kaboom');
      return fixture.importModule(url);
    };
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: throwing,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.fileErrors[0]?.code).toBe('file-import-failed');
    expect(outcome.value.fileErrors[0]?.filePath).toBe('tools/boom.mjs');
  });

  test('file under tools/ with no default export → no-default-export', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/named-only.mjs': {
          module: { echo: 'not-a-tool' } as unknown as Record<string, unknown>,
        },
      },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.fileErrors[0]?.code).toBe('no-default-export');
    expect(outcome.value.fileErrors[0]?.filePath).toBe('tools/named-only.mjs');
  });

  test('file under tools/ that default-exports an guardrail → kind-mismatch', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/wrong.mjs': guardrailModule({ id: 'acme.misplaced' }),
      },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.fileErrors[0]?.code).toBe('kind-mismatch');
    expect(outcome.value.fileErrors[0]?.filePath).toBe('tools/wrong.mjs');
    expect(outcome.value.fileErrors[0]?.message).toContain("'tool'");
    expect(outcome.value.fileErrors[0]?.message).toContain("'guardrail'");
  });

  test.each([
    { kind: 'tool', folder: 'tools', list: 'tools', make: toolModule, id: 'acme.echo', what: '' },
    {
      kind: 'guardrail',
      folder: 'guardrails',
      list: 'guardrails',
      make: guardrailModule,
      id: 'acme.grounded',
      what: '',
    },
    {
      kind: 'agent',
      folder: 'agents',
      list: 'agents',
      make: agentModule,
      id: 'acme.support',
      what: ' version 1.0.0',
    },
    {
      kind: 'flow',
      folder: 'flows',
      list: 'flows',
      make: flowModule,
      id: 'acme.flow',
      what: ' version 1.0.0',
    },
  ] as const)(
    'two files with the same $kind id and version → the first is kept, the second is an error',
    async ({ kind, folder, list, make, id, what }) => {
      const fixture = await makeFixture({
        files: {
          'kindgi.config.mjs': config(),
          [`${folder}/a.mjs`]: make(),
          [`${folder}/b.mjs`]: make(),
        },
      });
      const outcome = await runIndexer({
        packDir: fixture.packDir,
        publishedAt: FIXED_TIMESTAMP,
        importModule: fixture.importModule,
      });
      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;
      expect(outcome.value.fileErrors).toEqual([
        {
          code: 'manifest-validation-failed',
          message: `${folder}/b.mjs: duplicate ${kind} '${id}'${what} (also defined in ${folder}/a.mjs)`,
          filePath: `${folder}/b.mjs`,
        },
      ]);
      expect(outcome.value.counts[list]).toBe(1);
      const parsed = await readValidIndex(outcome.value.outputPath);
      const [entry] = parsed[list] as {
        id: string;
        modulePath?: string;
        checkModulePath?: string;
      }[];
      expect(entry?.id).toBe(id);
      expect(entry?.modulePath ?? entry?.checkModulePath).toBe(`${folder}/a.mjs`);
    },
  );

  test('an agent whose instructions are a prompt block, with settings blocks, is indexed as one', async () => {
    const refs = {
      instructions: { prompt: 'acme.support-prompt', version: '^1.0.0' },
      settings: [{ id: 'acme.weights', version: '^1.0.0' }],
      modelSettings: { id: 'acme.model', version: '^1.0.0' },
    };
    const fixture = await makeFixture({
      files: { 'kindgi.config.mjs': config(), 'agents/support.mjs': agentModule(refs) },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.fileErrors).toEqual([]);
    const parsed = await readValidIndex(outcome.value.outputPath);
    expect((parsed.agents as unknown[])[0]).toMatchObject(refs);
  });

  test('two versions of one tool, or of one agent, are indexed side by side', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/echo.mjs': toolModule({ version: '1.0.0' }),
        'tools/echo-v2.mjs': toolModule({ version: '2.0.0' }),
        'agents/support.mjs': agentModule(),
        'agents/support-v2.mjs': agentModule({ version: '2.0.0' }),
      },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.fileErrors).toEqual([]);
    const parsed = await readValidIndex(outcome.value.outputPath);
    const versions = (list: 'tools' | 'agents') =>
      (parsed[list] as { id: string; version: string }[]).map((e) => `${e.id}@${e.version}`).sort();
    expect(versions('tools')).toEqual(['acme.echo@1.0.0', 'acme.echo@2.0.0']);
    expect(versions('agents')).toEqual(['acme.support@1.0.0', 'acme.support@2.0.0']);
  });

  test('a tool with no version next to a versioned one of its id is an error: nothing tells them apart', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/a.mjs': toolModule({ version: '1.0.0' }),
        'tools/b.mjs': toolModule(),
      },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.fileErrors).toEqual([
      {
        code: 'manifest-validation-failed',
        message: "tools/b.mjs: duplicate tool 'acme.echo' (also defined in tools/a.mjs)",
        filePath: 'tools/b.mjs',
      },
    ]);
  });

  test('the same id on two different kinds is not a duplicate', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/echo.mjs': toolModule({ id: 'acme.shared' }),
        'flows/flow.mjs': flowModule({ id: 'acme.shared' }),
      },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.fileErrors).toEqual([]);
    expect(outcome.value.counts).toMatchObject({ tools: 1, flows: 1 });
  });

  test('Result-wrapped error default export surfaces underlying error', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/bad.mjs': {
          module: {
            default: {
              kind: 'err',
              error: { code: 'invalid-schema', message: 'oh no' },
            },
          },
        },
      },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.fileErrors[0]?.code).toBe('manifest-validation-failed');
    expect(outcome.value.fileErrors[0]?.filePath).toBe('tools/bad.mjs');
    expect(outcome.value.fileErrors[0]?.message).toContain('oh no');
  });

  test('ambiguous default export shape → ambiguous-kind (custom pattern)', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config({
          discovery: {
            tools: 'tools/**/*.{ts,js,mjs}',
            guardrails: 'guardrails/**/*.{ts,js,mjs}',
            agents: 'agents/**/*.{ts,js,mjs}',
            flows: 'src/**/*.{ts,js,mjs}',
          },
        }),
        // Under a custom-discovery folder; default export doesn't match
        // any primitive shape.
        'src/mystery.mjs': {
          module: { default: { hello: 'world' } },
        },
      },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.fileErrors[0]?.code).toBe('ambiguous-kind');
  });

  test('output-write-failed when output path is under an unwritable parent', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/echo.mjs': toolModule(),
      },
    });
    // Point output at an existing FILE with a subpath — mkdir under a
    // regular file always fails with ENOTDIR.
    const filePath = path.join(scratch, 'not-a-dir.txt');
    await fs.writeFile(filePath, 'block');
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      outputPath: path.join(filePath, 'index.json'),
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('err');
    if (outcome.kind !== 'err') return;
    expect(outcome.error.code).toBe('output-write-failed');
  });
});

// -----------------------------------------------------------------------
// Discovery — custom patterns + structural fallback
// -----------------------------------------------------------------------

describe('runIndexer — discovery', () => {
  test('custom discovery patterns override defaults', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config({
          discovery: {
            tools: 'src/tools/**/*.{ts,js,mjs}',
            guardrails: 'guardrails/**/*.{ts,js,mjs}',
            agents: 'agents/**/*.{ts,js,mjs}',
            flows: 'flows/**/*.{ts,js,mjs}',
          },
        }),
        'src/tools/echo.mjs': toolModule(),
      },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.counts.tools).toBe(1);

    const parsed = await readValidIndex(outcome.value.outputPath);
    expect(parsed.tools[0].modulePath).toBe('src/tools/echo.mjs');
  });

  test('structural fallback resolves kind when file matched by custom pattern', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config({
          discovery: {
            tools: 'src/**/*.{ts,js,mjs}',
            guardrails: 'guardrails/**/*.{ts,js,mjs}',
            agents: 'agents/**/*.{ts,js,mjs}',
            flows: 'flows/**/*.{ts,js,mjs}',
          },
        }),
        // File matched only by the custom `src/**/*.{ts,js,mjs}` tools
        // pattern — NOT under the default `tools/` folder. Structural
        // detection must still recognize it as a tool.
        'src/nested/echo.mjs': toolModule(),
      },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.counts.tools).toBe(1);
  });

  test('pack embedded in an app (kindgi/**): finds its primitives, ignores the app', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config({
          discovery: {
            tools: 'kindgi/tools/**/*.{ts,js,mjs}',
            guardrails: 'kindgi/guardrails/**/*.{ts,js,mjs}',
            agents: 'kindgi/agents/**/*.{ts,js,mjs}',
            flows: 'kindgi/flows/**/*.{ts,js,mjs}',
          },
        }),
        'kindgi/tools/echo.mjs': toolModule(),
        // The host app's own `tools/` folder — not the pack's.
        'tools/app-script.mjs': toolModule({ id: 'app.not-a-kindgi-tool' }),
      },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.counts.tools).toBe(1);
    const parsed = await readValidIndex(outcome.value.outputPath);
    expect(parsed.tools.map((t: { modulePath: string }) => t.modulePath)).toEqual([
      'kindgi/tools/echo.mjs',
    ]);
  });
});

// -----------------------------------------------------------------------
// Indexing a build: the bundle map
// -----------------------------------------------------------------------

describe('runIndexer — a build (bundleMap)', () => {
  test('indexes the bundles the map lists, with no source tree; records the source paths', async () => {
    // A pack image's layout: the config and the bundles, no sources.
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'dist/tools/echo.mjs': toolModule(),
        'dist/agents/support.mjs': agentModule({ guardrails: [] }),
      },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
      moduleRoot: path.join(fixture.packDir, 'dist'),
      bundleMap: {
        'tools/echo.ts': 'tools/echo.mjs',
        'agents/support.ts': 'agents/support.mjs',
        // A test file next to a tool, and a file no pattern matches: skipped.
        'tools/echo.test.ts': 'tools/echo.test.mjs',
        'lib/helpers.ts': 'lib/helpers.mjs',
      },
    });
    if (outcome.kind !== 'ok') throw new Error(JSON.stringify(outcome.error));
    expect(outcome.value.fileErrors).toEqual([]);
    expect(outcome.value.counts).toMatchObject({ tools: 1, agents: 1 });
    const parsed = await readValidIndex(outcome.value.outputPath);
    expect(parsed.tools.map((t: { modulePath: string }) => t.modulePath)).toEqual([
      'tools/echo.ts',
    ]);
    expect(parsed.agents.map((a: { modulePath: string }) => a.modulePath)).toEqual([
      'agents/support.ts',
    ]);
  });

  test('custom discovery patterns classify the map the way they classify the disk', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config({ discovery: { tools: 'kindgi/tools/**/*.{ts,js,mjs}' } }),
        'dist/kindgi/tools/echo.mjs': toolModule(),
      },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
      moduleRoot: path.join(fixture.packDir, 'dist'),
      bundleMap: { 'kindgi/tools/echo.ts': 'kindgi/tools/echo.mjs' },
    });
    if (outcome.kind !== 'ok') throw new Error(JSON.stringify(outcome.error));
    const parsed = await readValidIndex(outcome.value.outputPath);
    expect(parsed.tools.map((t: { modulePath: string }) => t.modulePath)).toEqual([
      'kindgi/tools/echo.ts',
    ]);
  });

  test('a map with nothing the patterns match is discovery-empty', async () => {
    const fixture = await makeFixture({ files: { 'kindgi.config.mjs': config() } });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      importModule: fixture.importModule,
      bundleMap: { 'lib/helpers.ts': 'lib/helpers.mjs' },
    });
    expect(outcome).toMatchObject({ kind: 'err', error: { code: 'discovery-empty' } });
  });

  test('readBundleMap: a JSON object of strings, or why not', async () => {
    const file = path.join(scratch, 'bundle-map.json');
    await fs.writeFile(file, JSON.stringify({ 'tools/a.ts': 'tools/a.mjs' }));
    expect(await readBundleMap(file)).toEqual({
      kind: 'ok',
      value: { 'tools/a.ts': 'tools/a.mjs' },
    });
    for (const body of ['[]', '{"tools/a.ts": 1}', '{"tools/a.ts": ""}', 'not json']) {
      await fs.writeFile(file, body);
      expect((await readBundleMap(file)).kind).toBe('err');
    }
    expect((await readBundleMap(path.join(scratch, 'missing.json'))).kind).toBe('err');
  });

  test('the command: --module-root goes with --bundle-map; a bad map exits 2', async () => {
    const fixture = await makeFixture({ files: { 'kindgi.config.mjs': config() } });
    const stderr: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await main(['--pack-dir', fixture.packDir, '--module-root', 'dist'])).toBe(2);
      const bad = path.join(scratch, 'bad-map.json');
      await fs.writeFile(bad, '[]');
      expect(await main(['--pack-dir', fixture.packDir, '--bundle-map', bad])).toBe(2);
    } finally {
      process.stderr.write = write;
    }
    expect(stderr.join('')).toContain('--module-root goes with --bundle-map');
    expect(stderr.join('')).toContain('must be a JSON object');
  });

  test('the command: --strict exits 1 when a module fails to load, saying which and why', async () => {
    const tool = (id: string, prelude = ''): string =>
      `${prelude}export default { id: '${id}', description: 'echo', input: { type: 'object', properties: {}, additionalProperties: false }, output: { type: 'object', properties: {}, additionalProperties: false }, effects: [], handler: async () => ({}) };\n`;
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': {
          module: undefined,
          content: "export default { pack: { id: 'acme.pack', version: '1.0.0' } };\n",
        },
        'tools/ok.mjs': { module: undefined, content: tool('acme.ok') },
        // A package the image doesn't have (a devDependency its prune dropped).
        'tools/broken.mjs': {
          module: undefined,
          content: tool('acme.broken', "import 'acme-package-not-installed';\n"),
        },
      },
    });
    const output = path.join(scratch, 'index.json');
    const stderr: string[] = [];
    const stdout = process.stdout.write;
    const write = process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const args = [
        '--pack-dir',
        fixture.packDir,
        '--output',
        output,
        '--published-at',
        FIXED_TIMESTAMP,
      ];
      // Without --strict the index is written without the broken tool, and the command succeeds.
      expect(await main(args)).toBe(0);
      expect(await main([...args, '--strict'])).toBe(1);
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = write;
    }
    expect(stderr.join('')).toContain(
      'kindgi-index: file-import-failed: Failed to import tools/broken.mjs',
    );
    expect(stderr.join('')).toContain('acme-package-not-installed');
  });
});

// -----------------------------------------------------------------------
// Artifact version + determinism
// -----------------------------------------------------------------------

describe('runIndexer — artifactVersion behavior', () => {
  test('auto YYYYMMDD.N when opts.artifactVersion is not supplied', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/echo.mjs': toolModule(),
      },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.artifactVersion).toMatch(/^\d{8}\.\d+$/);
    expect(outcome.value.artifactVersion.endsWith('.1')).toBe(true);
  });

  test('auto artifactVersion increments N when an index.json already exists for today', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/echo.mjs': toolModule(),
      },
    });
    const first = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    const second = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      importModule: fixture.importModule,
    });
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;

    const firstMatch = /^\d{8}\.(\d+)$/.exec(first.value.artifactVersion);
    const secondMatch = /^\d{8}\.(\d+)$/.exec(second.value.artifactVersion);
    expect(firstMatch).not.toBeNull();
    expect(secondMatch).not.toBeNull();
    const firstN = firstMatch?.[1];
    const secondN = secondMatch?.[1];
    expect(firstN).toBeDefined();
    expect(secondN).toBeDefined();
    expect(Number.parseInt(secondN as string, 10)).toBe(Number.parseInt(firstN as string, 10) + 1);
  });

  test('explicit opts.artifactVersion overrides the auto shape', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/echo.mjs': toolModule(),
      },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      artifactVersion: 'pinned-v42',
      importModule: fixture.importModule,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.artifactVersion).toBe('pinned-v42');
  });

  test('byte-identical index.json for byte-identical source (determinism)', async () => {
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'tools/echo.mjs': toolModule(),
        'tools/reverse.mjs': toolModule({ id: 'acme.reverse' }),
        'guardrails/grounded.mjs': guardrailModule(),
        'agents/support.mjs': agentModule(),
        'flows/flow.mjs': flowModule(),
      },
    });

    const commonOpts = {
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      artifactVersion: '20260920.7',
      importModule: fixture.importModule,
    };
    const first = await runIndexer(commonOpts);
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    const bytesA = await fs.readFile(first.value.outputPath, 'utf8');

    const second = await runIndexer(commonOpts);
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    const bytesB = await fs.readFile(second.value.outputPath, 'utf8');

    expect(bytesB).toBe(bytesA);
  });
});

describe('runIndexer — agents (agent schema-version 1.3.0)', () => {
  test('an agent keeps every field it declares: output, toolErrors, memory, preferred provider/model, policy, description, tags', async () => {
    const output = {
      name: 'axes',
      schema: { type: 'object', properties: { remedy: { type: 'array' } }, required: ['remedy'] },
      maxRepairs: 2,
    };
    const conversationPolicy = { historyLimit: 5 };
    const toolErrors = { maxRetries: 2, retryOn: ['invalid-arguments'] };
    const fixture = await makeFixture({
      files: {
        'kindgi.config.mjs': config(),
        'agents/support.mjs': agentModule({
          output,
          toolErrors,
          memory: { instructionTypes: ['acme.policy'] },
          conversationPolicy,
          preferredProvider: 'anthropic',
          preferredModel: 'claude-x',
          description: 'Answers support questions.',
          tags: ['support'],
        }),
      },
    });
    const outcome = await runIndexer({
      packDir: fixture.packDir,
      publishedAt: FIXED_TIMESTAMP,
      artifactVersion: '20260930.1',
      importModule: fixture.importModule,
    });
    if (outcome.kind !== 'ok') throw new Error(outcome.error.message);
    const parsed = await readValidIndex(outcome.value.outputPath);
    expect(parsed.agents[0]).toMatchObject({
      output,
      toolErrors,
      memory: { instructionTypes: ['acme.policy'] },
      conversationPolicy,
      preferredProvider: 'anthropic',
      preferredModel: 'claude-x',
      description: 'Answers support questions.',
      tags: ['support'],
    });
  });
});
