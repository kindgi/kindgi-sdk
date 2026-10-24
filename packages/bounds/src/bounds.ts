// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The limits a Kindgi server puts on what a tenant sends it: one setting
 * for the whole process, set once at boot (`configureTenantInputBounds`)
 * and read where tenant input is compiled or read (`tenantInputBounds`).
 *
 * The runtime sets {@link HOSTED_BOUNDS} under the hosted profile, where
 * one tenant's input must never stall the server for the others. Anywhere
 * else (a self-hosted server, a pack's own process, a test) it's
 * {@link SELF_HOSTED_BOUNDS}: today's behaviour, with generous limits on
 * bodies, schemas and a render's memory.
 *
 * Why one setting rather than an argument: the places that compile tenant
 * input are deep inside the SDK's packages (guardrails, schema, agents,
 * flow, tools). One explicit call at boot is testable, and a second call
 * throwing keeps it from changing while the server runs. Why not the
 * environment: a library that reads `process.env` behaves differently in a
 * test than in the server.
 */
export interface TenantInputBounds {
  /**
   * The engine a tenant's pattern runs on: V8's, or RE2's, which runs in
   * linear time. On RE2, a tenant's JSON Schema checks its data in linear
   * time too (`@kindgi/schema`): its patterns run on RE2, its formats are
   * ajv-formats' `fast` ones, and `uniqueItems` compares items by a key.
   */
  readonly regex: 'v8' | 're2';
  /** The longest a tenant's pattern may be: its source plus its flags, in characters. */
  readonly patternMaxLength: number;
  /**
   * The most citations a `must-cite` guardrail may require (`minCitations`).
   * It counts matches up to that many, and on RE2 each match can read the
   * rest of the output, so this caps what one evaluation costs.
   */
  readonly mustCiteMaxCitations: number;
  /** The largest schema compiled: its JSON, in bytes, before it's compiled. */
  readonly schemaMaxBytes: number;
  /** The deepest a schema may nest, objects and arrays. */
  readonly schemaMaxDepth: number;
  /** Compiled schemas kept, by their JSON, the least recently used dropped first. */
  readonly schemaCacheEntries: number;
  /**
   * The most schema JSON those compiled schemas may add up to, in bytes: a
   * compiled schema takes 4 to 15 times its JSON in memory for real API
   * schemas, and up to about 20 times for the worst shapes measured.
   */
  readonly schemaCacheMaxBytes: number;
  /**
   * The time a tenant's schemas may spend compiling in any 60 seconds, in
   * milliseconds: the compiles that count (`runAsTenant` says whose work
   * it is, and which count). Past it, the tenant's next compile that
   * counts is refused until the window moves on; schemas already compiled
   * keep working.
   */
  readonly schemaCompileBudgetMs: number;
  /**
   * The time a tenant's templates may spend rendering in any 60 seconds,
   * in milliseconds, for renders done as its work (`runAsTenant`). Past it,
   * the tenant's next render is refused until the window moves on. A
   * render holds the event loop while it runs.
   */
  readonly templateRenderBudgetMs: number;
  /** A template's limits (liquidjs's own). */
  readonly liquid: {
    /** The longest template parsed, in characters. */
    readonly parseLimit: number;
    /** The longest one render may take, in milliseconds. */
    readonly renderLimitMs: number;
    /**
     * The most one render may allocate, in liquidjs's own units (roughly
     * characters of strings and arrays it builds), not bytes: 8,388,608 is
     * not 8 MiB, and isn't meant to be.
     */
    readonly memoryLimit: number;
  };
  /** The largest body read from a tenant-named endpoint, decompressed, in bytes. */
  readonly responseMaxBytes: number;
  /** The longest wait between two chunks of such a body, in milliseconds. */
  readonly responseIdleMs: number;
  /** The largest one event of a `text/event-stream` may be; the stream itself has no total. */
  readonly sseEventMaxBytes: number;
  /** The largest request body the API reads, in bytes (routes that take more set their own). */
  readonly requestMaxBytes: number;
  /**
   * The deepest a request's JSON may nest, in levels of objects and arrays,
   * the body's own being 1. It leaves room for a schema as deep as
   * `schemaMaxDepth` inside the body that carries it.
   */
  readonly requestJsonMaxDepth: number;
}

const KiB = 1024;
const MiB = 1024 * KiB;

/*
 * The numbers: fitted to limits the code already enforces (a pack
 * service's body and an HTTP tool's response 10 MiB, a webhook body
 * 256 KiB, MCP sign-in 64 KiB), until hosted usage tunes them. The
 * compile cache's bytes and the compile budget are measured: a 256 KiB
 * schema compiles to 4–5 MiB of heap in up to 0.75 s, and a 100 KiB one
 * derived from a public OpenAPI document in 0.1–0.2 s.
 */

/**
 * Anywhere but the hosted profile: today's behaviour. A pattern on V8's
 * engine, a template's length and render time, and idle time without
 * limits; caps where today has none that a self-hoster could still hurt
 * itself without (bodies, schemas, the compile cache, a render's memory).
 */
export const SELF_HOSTED_BOUNDS: TenantInputBounds = deepFreeze({
  regex: 'v8',
  patternMaxLength: 8_192,
  mustCiteMaxCitations: Number.POSITIVE_INFINITY,
  schemaMaxBytes: 1 * MiB,
  schemaMaxDepth: 64,
  schemaCacheEntries: 1_000,
  schemaCacheMaxBytes: Number.POSITIVE_INFINITY,
  schemaCompileBudgetMs: Number.POSITIVE_INFINITY,
  templateRenderBudgetMs: Number.POSITIVE_INFINITY,
  liquid: {
    parseLimit: Number.POSITIVE_INFINITY,
    renderLimitMs: Number.POSITIVE_INFINITY,
    memoryLimit: 16_777_216,
  },
  responseMaxBytes: 10 * MiB,
  responseIdleMs: Number.POSITIVE_INFINITY,
  sseEventMaxBytes: 10 * MiB,
  requestMaxBytes: 10 * MiB,
  requestJsonMaxDepth: 128,
});

/** The hosted profile: patterns on RE2 (linear time), and tight limits. */
export const HOSTED_BOUNDS: TenantInputBounds = deepFreeze({
  regex: 're2',
  patternMaxLength: 1_024,
  mustCiteMaxCitations: 100,
  schemaMaxBytes: 256 * KiB,
  schemaMaxDepth: 64,
  schemaCacheEntries: 512,
  schemaCacheMaxBytes: 8 * MiB,
  schemaCompileBudgetMs: 2_000,
  templateRenderBudgetMs: 5_000,
  liquid: {
    parseLimit: 262_144,
    renderLimitMs: 1_000,
    memoryLimit: 8_388_608,
  },
  responseMaxBytes: 10 * MiB,
  responseIdleMs: 60_000,
  sseEventMaxBytes: 10 * MiB,
  requestMaxBytes: 2 * MiB,
  requestJsonMaxDepth: 128,
});

let configured: TenantInputBounds | undefined;

/**
 * Sets the process's bounds, once, at boot. A second call throws: they
 * never change while the server runs.
 */
export function configureTenantInputBounds(bounds: TenantInputBounds): void {
  if (configured !== undefined) {
    throw new Error('Tenant input bounds are already set: they are set once, at boot.');
  }
  configured = deepFreeze(structuredClone(bounds));
}

/** The process's bounds: what boot set, or {@link SELF_HOSTED_BOUNDS}. */
export function tenantInputBounds(): TenantInputBounds {
  return configured ?? SELF_HOSTED_BOUNDS;
}

/**
 * For tests (`@kindgi/bounds/testing`): runs with other bounds, and puts
 * back what was set.
 */
export function overrideTenantInputBounds(bounds: TenantInputBounds): () => void {
  const before = configured;
  configured = deepFreeze(structuredClone(bounds));
  return () => {
    configured = before;
  };
}

function deepFreeze<T extends object>(value: T): T {
  for (const inner of Object.values(value)) {
    if (inner !== null && typeof inner === 'object') deepFreeze(inner);
  }
  return Object.freeze(value);
}
