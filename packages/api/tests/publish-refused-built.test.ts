// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
// reads-source: packages/api/src/publish-refused.ts packages/api/tsconfig.build.json tsconfig.base.json

/**
 * `PublishRefused` as the package ships it. vitest compiles with esbuild,
 * which assigns a class's parameter properties after every `super`; tsc,
 * which builds the package, assigns them only after the constructor's
 * root-level one. So this compiles the source with tsc and the package's
 * build settings, and checks what a deploy's refusal carries
 * (`details.primitive`, `details.id`) from there.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import { PublishRefused as SourcePublishRefused } from '../src/publish-refused.js';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `src/publish-refused.ts` compiled by tsc with `tsconfig.build.json`'s
 * options, as CommonJS so it runs here (the module format leaves a class's
 * emit as it is). Its imports are types only, so it needs nothing at run time.
 */
function builtPublishRefused(): typeof SourcePublishRefused {
  const configPath = join(PACKAGE, 'tsconfig.build.json');
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, PACKAGE);
  const { outputText } = ts.transpileModule(
    readFileSync(join(PACKAGE, 'src/publish-refused.ts'), 'utf8'),
    {
      compilerOptions: {
        ...options,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        verbatimModuleSyntax: false,
        declaration: false,
        declarationMap: false,
        sourceMap: false,
      },
      fileName: 'publish-refused.ts',
    },
  );
  const module = { exports: {} as { PublishRefused?: typeof SourcePublishRefused } };
  const noRequire = (id: string) => {
    throw new Error(`publish-refused.ts needs ${id} at run time`);
  };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, noRequire);
  if (module.exports.PublishRefused === undefined) throw new Error('no PublishRefused export');
  return module.exports.PublishRefused;
}

const Built = builtPublishRefused();

/** What a deploy's 409 answer is built from (routes/deployments.ts). */
const answered = (refused: InstanceType<typeof SourcePublishRefused>) => ({
  code: refused.code,
  message: refused.message,
  primitive: refused.primitive,
  id: refused.id,
  projectId: refused.projectId,
  endpointId: refused.endpointId,
});

describe('PublishRefused, built by tsc: every refusal keeps its primitive and id', () => {
  test("a refusal the deploy decides itself (a guardrail it can't keep)", () => {
    const refused = new Built('guardrail', 'acme.min-length', {
      code: 'guardrail-project-mismatch',
      reason: 'it belongs to another project',
    });
    expect(answered(refused)).toStrictEqual({
      code: 'guardrail-project-mismatch',
      message: "The guardrail acme.min-length wasn't published: it belongs to another project",
      primitive: 'guardrail',
      id: 'acme.min-length',
      projectId: undefined,
      endpointId: undefined,
    });
  });

  test("a registry's project-mismatch: the primitive's code, and the owner for the log", () => {
    const refused = new Built('tool', 'acme.search@1.0.0', {
      kind: 'project-mismatch',
      projectId: 'p-owner' as never,
    } as never);
    expect(answered(refused)).toMatchObject({
      code: 'tool-project-mismatch',
      primitive: 'tool',
      id: 'acme.search@1.0.0',
      projectId: 'p-owner',
    });
  });

  test("a registry's other refusal: its kind as the code", () => {
    const refused = new Built('agent', 'acme.helper@1.0.0', { kind: 'project-not-found' } as never);
    expect(answered(refused)).toMatchObject({
      code: 'project-not-found',
      message: "The agent acme.helper@1.0.0 wasn't published: project-not-found",
      primitive: 'agent',
      id: 'acme.helper@1.0.0',
    });
  });

  test("a registry's kind-mismatch: `tool-kind-mismatch`, with the endpoint when the id is one's", () => {
    const endpoints = new Built('tool', 'acme.search@1.0.0', {
      kind: 'kind-mismatch',
      endpointId: 'acme',
    } as never);
    expect(answered(endpoints)).toMatchObject({
      code: 'tool-kind-mismatch',
      primitive: 'tool',
      id: 'acme.search@1.0.0',
      endpointId: 'acme',
    });
    const published = new Built('tool', 'acme.search@1.0.0', { kind: 'kind-mismatch' } as never);
    expect(answered(published)).toMatchObject({
      code: 'tool-kind-mismatch',
      primitive: 'tool',
      id: 'acme.search@1.0.0',
      endpointId: undefined,
    });
  });

  test('the built class and the source the other tests run answer alike', () => {
    const refusals = [
      ['guardrail', { code: 'guardrail-already-registered', reason: 'its definition differs' }],
      ['guardrail', { kind: 'project-mismatch', projectId: 'p-owner' }],
      ['guardrail', { kind: 'project-not-found' }],
      ['tool', { kind: 'kind-mismatch', endpointId: 'acme' }],
      ['tool', { kind: 'kind-mismatch' }],
    ] as const;
    for (const [primitive, outcome] of refusals) {
      expect(answered(new Built(primitive, 'acme.check', outcome as never))).toStrictEqual(
        answered(new SourcePublishRefused(primitive, 'acme.check', outcome as never)),
      );
    }
  });
});
