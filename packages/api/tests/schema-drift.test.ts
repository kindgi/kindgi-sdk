// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Drift tests between `packages/api/src/openapi/schemas.ts` (wire shapes)
 * and `@kindgi/specs/*.schema.json` (canonical domain shapes).
 *
 * Why we tolerate the duplication (see the comment at the top of
 * `openapi/schemas.ts` for the full rationale):
 *   - `@kindgi/specs` is the language-agnostic canonical domain schema.
 *     Packages that validate against one at runtime (Ajv) bundle a copy for
 *     offline validation, each guarded by its own drift test.
 *   - `openapi/schemas.ts` is the wire shape — JSON Schema fragments the
 *     OpenAPI generator emits into `openapi.json`. Sometimes it's
 *     byte-equal with the spec (Agent, Flow, Guardrail), sometimes it's
 *     a wire-side variant (Provenance wraps the DAG in `dag`; Policy uses
 *     a `kind + spec` discriminant that the domain schema doesn't).
 *
 * These tests catch SILENT DRIFT — someone edits the canonical spec
 * without updating the wire (or vice versa). For pairs that are known to
 * legitimately diverge, the test is skipped with a rationale here rather
 * than swept under the rug.
 *
 * The RunEvent drift test lives in `openapi.test.ts` ("RunEvent schema
 * mirrors …") — same pattern, just older; kept where it is for now.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { describe, expect, test } from 'vitest';

import {
  AgentSchema,
  CodeArtifactRefSchema,
  ComplianceEvidenceSchema,
  EvalSuiteSchema,
  FlowSchema,
  GuardrailSchema,
  HttpAuthSpecSchema,
  HttpHeaderSpecSchema,
  HttpRequestBodySpecSchema,
  HttpToolSpecSchema,
  NetworkPolicySchema,
  RuntimeLimitsSchema,
  SandboxModeSchema,
  ToolSchema,
  ToolSecretRefSchema,
  ToolSpecSchema,
  TypedNeedsSchema,
} from '../src/openapi/schemas.js';

interface JsonSchemaLike {
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly $defs?: Readonly<Record<string, unknown>>;
}

async function loadSpec(name: string): Promise<JsonSchemaLike> {
  const raw = await readFile(
    createRequire(import.meta.url).resolve(`@kindgi/specs/${name}.schema.json`),
    'utf8',
  );
  return JSON.parse(raw) as JsonSchemaLike;
}

function assertRequiredIdentical(
  specName: string,
  spec: JsonSchemaLike,
  wire: JsonSchemaLike,
): void {
  const specReq = [...(spec.required ?? [])].sort();
  const wireReq = [...(wire.required ?? [])].sort();
  expect(
    wireReq,
    `${specName}: openapi/schemas.ts required[] drifted from @kindgi/specs/${specName}.schema.json`,
  ).toEqual(specReq);
}

/**
 * For each ALIGNED overlap, assert `required[]` matches when sorted.
 * `properties` are NOT compared byte-equal — wire may add descriptions or
 * override `$ref` references; the guardrail we care about is "someone
 * added a required field on one side and forgot the other."
 */
describe('OpenAPI ↔ specs drift — aligned pairs (required[] identical)', () => {
  test('Agent', async () => {
    assertRequiredIdentical('agent', await loadSpec('agent'), AgentSchema as JsonSchemaLike);
  });

  test('ComplianceEvidence', async () => {
    assertRequiredIdentical(
      'compliance-evidence',
      await loadSpec('compliance-evidence'),
      ComplianceEvidenceSchema as JsonSchemaLike,
    );
  });

  test('EvalSuite', async () => {
    assertRequiredIdentical(
      'eval-suite',
      await loadSpec('eval-suite'),
      EvalSuiteSchema as JsonSchemaLike,
    );
  });

  test('Flow', async () => {
    assertRequiredIdentical('flow', await loadSpec('flow'), FlowSchema as JsonSchemaLike);
  });

  test('Guardrail', async () => {
    assertRequiredIdentical(
      'guardrail',
      await loadSpec('guardrail'),
      GuardrailSchema as JsonSchemaLike,
    );
  });
});

/** A spec fragment as the wire writes it: `#/$defs/X` is `#/components/schemas/X`. */
function asWire(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(asWire);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node).map(([k, v]) => [
      k,
      k === '$ref' && typeof v === 'string'
        ? v.replace(/^#\/\$defs\//, '#/components/schemas/')
        : asWire(v),
    ]),
  );
}

/**
 * Tool: the wire carries every manifest field the spec declares, so a
 * client reads back what it registered (where the code runs, the
 * sandbox, the declarative spec). The fields added to the wire after the
 * first cut, and the declarative-HTTP `$defs`, are held equal to the spec.
 */
describe('OpenAPI ↔ specs drift — Tool carries the whole manifest', () => {
  /** What the registry sets on a tool it reads: where it keeps it, not what it is. */
  const REGISTRY_SET = ['projectId'];

  test("the wire declares exactly the spec's properties, and what the registry sets", async () => {
    const spec = await loadSpec('tool');
    expect(Object.keys(ToolSchema.properties as object).sort()).toEqual(
      [...Object.keys(spec.properties ?? {}), ...REGISTRY_SET].sort(),
    );
  });

  test("mutating is the spec's definition", async () => {
    const spec = await loadSpec('tool');
    expect((ToolSchema.properties as Record<string, unknown>).mutating).toEqual(
      spec.properties?.mutating,
    );
  });

  test.each([
    ['sandbox', 'SandboxMode', SandboxModeSchema],
    ['limits', 'RuntimeLimits', RuntimeLimitsSchema],
    ['network', 'NetworkPolicy', NetworkPolicySchema],
    ['needsSpec', 'TypedNeeds', TypedNeedsSchema],
    ['codeArtifactRef', 'CodeArtifactRef', CodeArtifactRefSchema],
    ['spec', 'ToolSpec', ToolSpecSchema],
  ] as const)("%s is component %s, the spec's definition", async (field, name, component) => {
    const spec = await loadSpec('tool');
    expect((ToolSchema.properties as Record<string, unknown>)[field]).toEqual({
      $ref: `#/components/schemas/${name}`,
    });
    expect(component).toEqual(asWire(spec.properties?.[field]));
  });

  test.each([
    ['ToolSecretRef', ToolSecretRefSchema],
    ['HttpHeaderSpec', HttpHeaderSpecSchema],
    ['HttpAuthSpec', HttpAuthSpecSchema],
    ['HttpRequestBodySpec', HttpRequestBodySpecSchema],
    ['HttpToolSpec', HttpToolSpecSchema],
  ] as const)("component %s is the spec's $defs entry", async (name, wire) => {
    const spec = await loadSpec('tool');
    expect(wire).toEqual(asWire(spec.$defs?.[name]));
  });
});

/**
 * Pairs that legitimately diverge. Documented here so a future maintainer
 * doesn't wire a "byte-equal" test that would trip on intentional wire-side
 * transformations.
 *
 * If any of these ever converges (or if a new legitimate divergence lands),
 * update this list AND the openapi/schemas.ts header comment together.
 */
describe('OpenAPI ↔ specs drift — known legitimate divergences', () => {
  test('Capability — wire is intentionally open (additionalProperties: true, no required[])', () => {
    // `@kindgi/specs/capability.schema.json` requires `needs`; the wire drops the
    // constraint because future capability kinds shouldn't require a wire
    // bump. Structural drift not enforced by design.
    expect(true).toBe(true);
  });

  test('Policy — wire uses `kind + spec` discriminant; spec uses `rules`', () => {
    // The wire is a broader union across policy kinds (access-control,
    // model-routing, rate-limit, retention, ...). Each kind's body shape
    // is defined by the kind's runtime consumer, not by
    // `@kindgi/specs/policy.schema.json` (which was written when policies were
    // access-control only).
    expect(true).toBe(true);
  });

  test('Provenance — wire wraps DAG in `dag` field; spec has nodes/edges flat', () => {
    // `packages/api/src/openapi/schemas.ts::ProvenanceRecordSchema` uses
    // `{ id, runId, tenantId, version, createdAt, dag }`. The `dag` field
    // contains what @kindgi/specs/provenance.schema.json has flat. Wire wraps for
    // future-extensibility (we may add non-DAG fields to a provenance
    // record later without restructuring).
    expect(true).toBe(true);
  });

  test('Tool — wire drops `version` from required[]', () => {
    // `@kindgi/specs/tool.schema.json` requires `version`; ToolSchema on the wire
    // drops it because tool references dispatch a semver RANGE (npm-style
    // `^1.2.3`, resolved to a concrete version via
    // `semver.maxSatisfying`), not an exact pin at wire time. The wire
    // shape represents the reference-time contract, not the resolved
    // artifact.
    expect(true).toBe(true);
  });
});
