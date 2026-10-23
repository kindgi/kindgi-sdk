// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { LOOP_END_NODE, LOOP_START_NODE, flowSchemaProblems, loadFlow } from '../src/index.js';

// ---------- fixture builders ----------

const compiles = { type: 'object' };
/** Strict mode refuses a keyword it doesn't know. */
const broken = { type: 'object', 'x-unknown': true };

/** Where a flow carries an inline schema a run compiles. */
type Site = 'outer' | 'inner' | 'subgraph' | 'branch' | 'output';

const PATHS: Readonly<Record<Site, string>> = {
  outer: '/nodes/0/outputSchema',
  inner: '/nodes/0/body/nodes/0/outputSchema',
  subgraph: '/nodes/1/outputSchema',
  branch: '/nodes/2/branches/1/outputSchema',
  output: '/output/schema',
};

/** A node, as far as these fixtures need: its id and the rest. */
type NodeLike = { readonly id: string; readonly [field: string]: unknown };

function whileLoop(id: string, outputSchema: unknown, body: NodeLike): NodeLike {
  return {
    id,
    kind: 'loop',
    loopKind: 'while',
    body: {
      nodes: [body],
      edges: [
        { id: `${id}-be1`, from: LOOP_START_NODE, to: body.id },
        { id: `${id}-be2`, from: body.id, to: LOOP_END_NODE },
      ],
    },
    exitCondition: { op: 'gte', left: { path: 'iterationIndex' }, right: { literal: 3 } },
    maxIterations: 5,
    outputSchema,
  };
}

/**
 * A loop holding a loop in its body, a subgraph node and a fanout, and an
 * output schema: every schema compiles unless `schemas` names its site.
 */
function flow(schemas: Partial<Record<Site, unknown>> = {}): Record<string, unknown> {
  const at = (site: Site): unknown => (site in schemas ? schemas[site] : compiles);
  const inner = whileLoop('inner', at('inner'), { id: 'worker', kind: 'tool', ref: 'noop' });
  return {
    id: 'test.schemas',
    version: '1.0.0',
    nodes: [
      whileLoop('outer', at('outer'), inner),
      {
        id: 'sg',
        kind: 'subgraph',
        flowRef: { flowId: 'child.flow', version: '1.0.0' },
        inputMapping: { hint: { literal: 'go' } },
        outputSchema: at('subgraph'),
        convergence: 'settle-all',
      },
      {
        id: 'fan',
        kind: 'fanout',
        convergence: 'settle-all',
        branches: [
          { branchId: 'a', handler: 'ha', outputSchema: compiles },
          { branchId: 'b', handler: 'hb', outputSchema: at('branch') },
        ],
      },
    ],
    edges: [
      { id: 'oe1', from: '$start', to: 'outer' },
      { id: 'oe2', from: 'outer', to: 'sg' },
      { id: 'oe3', from: 'sg', to: 'fan' },
      { id: 'oe4', from: 'fan', to: '$end' },
    ],
    output: { mapping: { x: { literal: 1 } }, schema: at('output') },
  };
}

/** What `loadFlow` says of the one schema it refused: the compiler's words. */
function loaderWords(input: unknown): string | undefined {
  const loaded = loadFlow(input);
  if (loaded.kind === 'ok') return undefined;
  return (loaded.error as { issues?: readonly { message: string }[] }).issues?.[0]?.message;
}

// ---------- tests ----------

describe('flowSchemaProblems', () => {
  test('a flow whose schemas all compile has none, and loadFlow takes it', () => {
    expect(loadFlow(flow()).kind).toBe('ok');
    expect(flowSchemaProblems(flow())).toEqual([]);
  });

  test.each(Object.entries(PATHS) as [Site, string][])(
    "a %s schema that doesn't compile: where it sits, in loadFlow's words",
    (site, path) => {
      const input = flow({ [site]: broken });
      const words = loaderWords(input);
      expect(words).toContain('unknown keyword: "x-unknown"');
      expect(flowSchemaProblems(input)).toEqual([{ path, message: `doesn't compile: ${words}` }]);
    },
  );

  test('every one, in the order they sit, not only the first', () => {
    const input = flow({
      outer: broken,
      inner: broken,
      subgraph: broken,
      branch: broken,
      output: broken,
    });
    expect(flowSchemaProblems(input).map((p) => p.path)).toEqual([
      PATHS.outer,
      PATHS.inner,
      PATHS.subgraph,
      PATHS.branch,
      PATHS.output,
    ]);
  });

  test("a branch's missing outputSchema is one: a run compiles it all the same", () => {
    const problems = flowSchemaProblems(flow({ branch: undefined }));
    expect(problems).toEqual([
      { path: PATHS.branch, message: expect.stringMatching(/^doesn't compile: /) },
    ]);
  });

  test('a schema past the depth bound is one', () => {
    let deep: Record<string, unknown> = { type: 'object' };
    for (let i = 0; i < 1000; i++) deep = { type: 'object', properties: { a: deep } };
    expect(flowSchemaProblems(flow({ subgraph: deep }))).toEqual([
      { path: PATHS.subgraph, message: expect.stringMatching(/^doesn't compile: /) },
    ]);
  });

  test('a flow output with no schema has none to compile', () => {
    expect(flowSchemaProblems(flow({ output: undefined }))).toEqual([]);
  });

  test("what isn't a flow, a node or a branch is passed over", () => {
    expect(flowSchemaProblems(null)).toEqual([]);
    expect(flowSchemaProblems('a flow')).toEqual([]);
    expect(flowSchemaProblems({ nodes: 'nodes' })).toEqual([]);
    expect(
      flowSchemaProblems({
        nodes: [null, 3, [], { kind: 'fanout', branches: [null, 'b'] }, { kind: 'tool' }],
        output: 'output',
      }),
    ).toEqual([]);
  });
});
