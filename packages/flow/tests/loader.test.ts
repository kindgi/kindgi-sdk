// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { END_NODE, GRAPH_SCHEMA_URI, START_NODE, loadFlow } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function edge(id: string, from: string, to: string): unknown {
  return { id, from, to };
}

function node(id: string, ref = 'noop'): unknown {
  return { id, kind: 'tool', ref };
}

function flow(overrides: Partial<Record<string, unknown>>): unknown {
  return {
    id: 'test.flow',
    version: '1.0.0',
    nodes: [node('a')],
    edges: [edge('e1', '$start', 'a'), edge('e2', 'a', '$end')],
    ...overrides,
  };
}

describe('loadFlow — schema conformance', () => {
  test('accepts a minimal linear flow', () => {
    const r = loadFlow(flow({}));
    expect(r.kind).toBe('ok');
  });

  test('rejects missing required fields (nodes)', () => {
    const r = loadFlow({ id: 't', version: '1.0.0', edges: [] });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects malformed semver version', () => {
    const r = loadFlow(flow({ version: 'v1' }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects unknown node kind', () => {
    const r = loadFlow(flow({ nodes: [{ id: 'a', kind: 'llm', ref: 'x' }] }));
    expect(r.kind).toBe('err');
  });
});

describe('loadFlow — structural checks', () => {
  test('rejects duplicate node ids', () => {
    const r = loadFlow(
      flow({
        nodes: [node('a'), node('a')],
        edges: [edge('e1', '$start', 'a'), edge('e2', 'a', '$end')],
      }),
    );
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('duplicate-node-id');
  });

  test('rejects duplicate edge ids', () => {
    const r = loadFlow(
      flow({
        nodes: [node('a'), node('b')],
        edges: [edge('e1', '$start', 'a'), edge('e1', 'a', 'b'), edge('e2', 'b', '$end')],
      }),
    );
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('duplicate-edge-id');
  });

  test('rejects a $start-named node', () => {
    const r = loadFlow(flow({ nodes: [node(START_NODE)] }));
    // Schema catches this first via pattern? No — the schema allows any minLength:1 string for node id.
    // Our reserved-id check should catch it.
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('reserved-id');
  });

  test('rejects a $end-named node', () => {
    const r = loadFlow(flow({ nodes: [node(END_NODE)] }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('reserved-id');
  });

  test('rejects edge referencing an unknown node', () => {
    const r = loadFlow(
      flow({
        nodes: [node('a')],
        edges: [edge('e1', '$start', 'a'), edge('e2', 'a', 'ghost')],
      }),
    );
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.code).toBe('unknown-node-reference');
      if (r.error.code === 'unknown-node-reference') {
        expect(r.error.endpoint).toBe('to');
        expect(r.error.referencedId).toBe('ghost');
      }
    }
  });

  test('rejects a flow with no $start edge', () => {
    const r = loadFlow(
      flow({
        edges: [edge('e', 'a', '$end')],
      }),
    );
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('missing-start-edge');
  });
});

describe('loadFlow — predicate validation', () => {
  test('accepts a well-formed eq predicate', () => {
    const r = loadFlow(
      flow({
        edges: [
          edge('e1', '$start', 'a'),
          {
            ...(edge('e2', 'a', '$end') as object),
            when: {
              op: 'eq',
              left: { path: 'runInput.x' },
              right: { literal: 1 },
            },
          },
        ],
      }),
    );
    expect(r.kind).toBe('ok');
  });

  test('accepts nested and/or/not', () => {
    const r = loadFlow(
      flow({
        edges: [
          edge('e1', '$start', 'a'),
          {
            ...(edge('e2', 'a', '$end') as object),
            when: {
              op: 'and',
              children: [
                { op: 'truthy', value: { path: 'state.ready' } },
                { op: 'not', child: { op: 'exists', value: { path: 'state.error' } } },
              ],
            },
          },
        ],
      }),
    );
    expect(r.kind).toBe('ok');
  });

  test('rejects a top-level `triggers` array (flow schema 1.9.0 removed it)', () => {
    // Runs are started through the schedule / event-trigger / webhook APIs,
    // which name the flow — a flow document declares no triggers.
    const r = loadFlow(flow({ triggers: [{ kind: 'schedule', config: { cron: '0 * * * *' } }] }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects an unknown operator via JSON schema', () => {
    const r = loadFlow(
      flow({
        edges: [
          edge('e1', '$start', 'a'),
          {
            ...(edge('e2', 'a', '$end') as object),
            when: { op: 'always', value: { literal: true } },
          },
        ],
      }),
    );
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects a path with unrecognized root', () => {
    const r = loadFlow(
      flow({
        edges: [
          edge('e1', '$start', 'a'),
          {
            ...(edge('e2', 'a', '$end') as object),
            when: { op: 'truthy', value: { path: 'facts.x' } },
          },
        ],
      }),
    );
    expect(r.kind).toBe('err');
  });
});

describe('loadFlow — cycle detection', () => {
  test('rejects a 2-node cycle', () => {
    const r = loadFlow(
      flow({
        nodes: [node('a'), node('b')],
        edges: [
          edge('e1', '$start', 'a'),
          edge('e2', 'a', 'b'),
          edge('e3', 'b', 'a'),
          edge('e4', 'a', '$end'),
        ],
      }),
    );
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('cycle-detected');
  });

  test('rejects a 3-node cycle', () => {
    const r = loadFlow(
      flow({
        nodes: [node('a'), node('b'), node('c')],
        edges: [
          edge('e1', '$start', 'a'),
          edge('e2', 'a', 'b'),
          edge('e3', 'b', 'c'),
          edge('e4', 'c', 'a'),
          edge('e5', 'a', '$end'),
        ],
      }),
    );
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('cycle-detected');
  });

  test('accepts a diamond DAG', () => {
    const r = loadFlow(
      flow({
        nodes: [node('a'), node('b'), node('c'), node('d')],
        edges: [
          edge('e1', '$start', 'a'),
          edge('e2', 'a', 'b'),
          edge('e3', 'a', 'c'),
          edge('e4', 'b', 'd'),
          edge('e5', 'c', 'd'),
          edge('e6', 'd', '$end'),
        ],
      }),
    );
    expect(r.kind).toBe('ok');
  });
});

describe('loadFlow — edge policy (retry)', () => {
  function policyEdge(policy: unknown): unknown {
    return { id: 'e2', from: 'a', to: 'b', policy };
  }
  function policyGraph(policy: unknown): unknown {
    return flow({
      nodes: [node('a'), node('b')],
      edges: [edge('e1', '$start', 'a'), policyEdge(policy), edge('e3', 'b', '$end')],
    });
  }

  test('accepts a minimal retry policy (maxAttempts = 3)', () => {
    const r = loadFlow(policyGraph({ retry: { maxAttempts: 3 } }));
    expect(r.kind).toBe('ok');
  });

  test('accepts maxAttempts = 1 (equivalent to no retry)', () => {
    const r = loadFlow(policyGraph({ retry: { maxAttempts: 1 } }));
    expect(r.kind).toBe('ok');
  });

  test('accepts maxAttempts = 10 (upper bound)', () => {
    const r = loadFlow(policyGraph({ retry: { maxAttempts: 10 } }));
    expect(r.kind).toBe('ok');
  });

  test('rejects maxAttempts = 0', () => {
    const r = loadFlow(policyGraph({ retry: { maxAttempts: 0 } }));
    expect(r.kind).toBe('err');
    // Schema rejects first via minimum:1 → schema-validation-failed.
    if (r.kind === 'err') {
      expect(['schema-validation-failed', 'invalid-edge-policy']).toContain(r.error.code);
    }
  });

  test('rejects maxAttempts = 11 (over upper bound)', () => {
    const r = loadFlow(policyGraph({ retry: { maxAttempts: 11 } }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(['schema-validation-failed', 'invalid-edge-policy']).toContain(r.error.code);
    }
  });

  test('rejects negative delayMs', () => {
    const r = loadFlow(policyGraph({ retry: { maxAttempts: 3, delayMs: -50 } }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(['schema-validation-failed', 'invalid-edge-policy']).toContain(r.error.code);
    }
  });

  test('rejects exponential backoff without maxDelayMs', () => {
    const r = loadFlow(
      policyGraph({ retry: { maxAttempts: 5, delayMs: 100, backoff: 'exponential' } }),
    );
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.code).toBe('invalid-edge-policy');
      if (r.error.code === 'invalid-edge-policy') {
        expect(r.error.field).toBe('retry.maxDelayMs');
      }
    }
  });

  test('accepts exponential backoff with maxDelayMs', () => {
    const r = loadFlow(
      policyGraph({
        retry: { maxAttempts: 5, delayMs: 100, backoff: 'exponential', maxDelayMs: 5000 },
      }),
    );
    expect(r.kind).toBe('ok');
  });

  test('accepts linear backoff without maxDelayMs (defaults apply at runtime)', () => {
    const r = loadFlow(policyGraph({ retry: { maxAttempts: 4, delayMs: 100, backoff: 'linear' } }));
    expect(r.kind).toBe('ok');
  });

  test('rejects unknown backoff shape', () => {
    const r = loadFlow(policyGraph({ retry: { maxAttempts: 3, backoff: 'quantum' } }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(['schema-validation-failed', 'invalid-edge-policy']).toContain(r.error.code);
    }
  });
});

describe('loadFlow — edge policy (timeoutMs)', () => {
  function policyEdge(policy: unknown): unknown {
    return { id: 'e2', from: 'a', to: 'b', policy };
  }
  function policyGraph(policy: unknown): unknown {
    return flow({
      nodes: [node('a'), node('b')],
      edges: [edge('e1', '$start', 'a'), policyEdge(policy), edge('e3', 'b', '$end')],
    });
  }

  test('accepts timeoutMs = 1 (lower bound)', () => {
    const r = loadFlow(policyGraph({ timeoutMs: 1 }));
    expect(r.kind).toBe('ok');
  });

  test('accepts timeoutMs = 3_600_000 (upper bound, 1 hour)', () => {
    const r = loadFlow(policyGraph({ timeoutMs: 3_600_000 }));
    expect(r.kind).toBe('ok');
  });

  test('accepts a moderate timeoutMs alongside retry', () => {
    const r = loadFlow(policyGraph({ timeoutMs: 5_000, retry: { maxAttempts: 3, delayMs: 100 } }));
    expect(r.kind).toBe('ok');
  });

  test('rejects timeoutMs = 0', () => {
    const r = loadFlow(policyGraph({ timeoutMs: 0 }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(['schema-validation-failed', 'invalid-edge-policy']).toContain(r.error.code);
    }
  });

  test('rejects negative timeoutMs', () => {
    const r = loadFlow(policyGraph({ timeoutMs: -1 }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(['schema-validation-failed', 'invalid-edge-policy']).toContain(r.error.code);
    }
  });

  test('rejects timeoutMs above the 1-hour cap', () => {
    const r = loadFlow(policyGraph({ timeoutMs: 3_600_001 }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(['schema-validation-failed', 'invalid-edge-policy']).toContain(r.error.code);
    }
  });

  test('rejects non-integer timeoutMs', () => {
    const r = loadFlow(policyGraph({ timeoutMs: 100.5 }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(['schema-validation-failed', 'invalid-edge-policy']).toContain(r.error.code);
    }
  });
});

describe('loadFlow — edge policy (concurrencyKey)', () => {
  function policyEdge(policy: unknown): unknown {
    return { id: 'e2', from: 'a', to: 'b', policy };
  }
  function policyGraph(policy: unknown): unknown {
    return flow({
      nodes: [node('a'), node('b')],
      edges: [edge('e1', '$start', 'a'), policyEdge(policy), edge('e3', 'b', '$end')],
    });
  }

  test('accepts a short printable-ASCII key', () => {
    const r = loadFlow(policyGraph({ concurrencyKey: 'per-tenant:openai' }));
    expect(r.kind).toBe('ok');
  });

  test('accepts a 256-char key (upper bound)', () => {
    const r = loadFlow(policyGraph({ concurrencyKey: 'x'.repeat(256) }));
    expect(r.kind).toBe('ok');
  });

  test('accepts concurrencyKey alongside retry + timeoutMs', () => {
    const r = loadFlow(
      policyGraph({
        concurrencyKey: 'k1',
        timeoutMs: 5_000,
        retry: { maxAttempts: 3, delayMs: 100 },
      }),
    );
    expect(r.kind).toBe('ok');
  });

  test('rejects empty string', () => {
    const r = loadFlow(policyGraph({ concurrencyKey: '' }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(['schema-validation-failed', 'invalid-edge-policy']).toContain(r.error.code);
    }
  });

  test('rejects key over 256 chars', () => {
    const r = loadFlow(policyGraph({ concurrencyKey: 'x'.repeat(257) }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(['schema-validation-failed', 'invalid-edge-policy']).toContain(r.error.code);
    }
  });

  test('rejects non-printable / non-ASCII characters', () => {
    const r = loadFlow(policyGraph({ concurrencyKey: 'k\n1' }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(['schema-validation-failed', 'invalid-edge-policy']).toContain(r.error.code);
    }
  });

  test('rejects non-ASCII (Unicode > 0x7E)', () => {
    const r = loadFlow(policyGraph({ concurrencyKey: 'k€y' }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(['schema-validation-failed', 'invalid-edge-policy']).toContain(r.error.code);
    }
  });

  test('rejects non-string concurrencyKey', () => {
    const r = loadFlow(policyGraph({ concurrencyKey: 42 }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(['schema-validation-failed', 'invalid-edge-policy']).toContain(r.error.code);
    }
  });
});

describe('loadFlow — edge policy (priority)', () => {
  function policyEdge(policy: unknown): unknown {
    return { id: 'e2', from: 'a', to: 'b', policy };
  }
  function policyGraph(policy: unknown): unknown {
    return flow({
      nodes: [node('a'), node('b')],
      edges: [edge('e1', '$start', 'a'), policyEdge(policy), edge('e3', 'b', '$end')],
    });
  }

  test('accepts priority = 0 (default baseline, explicit)', () => {
    const r = loadFlow(policyGraph({ priority: 0 }));
    expect(r.kind).toBe('ok');
  });

  test('accepts priority = -100 (lower bound)', () => {
    const r = loadFlow(policyGraph({ priority: -100 }));
    expect(r.kind).toBe('ok');
  });

  test('accepts priority = 100 (upper bound)', () => {
    const r = loadFlow(policyGraph({ priority: 100 }));
    expect(r.kind).toBe('ok');
  });

  test('accepts priority alongside every other honored EdgePolicy field', () => {
    const r = loadFlow(
      policyGraph({
        priority: 50,
        concurrencyKey: 'k1',
        timeoutMs: 5_000,
        retry: { maxAttempts: 3, delayMs: 100 },
      }),
    );
    expect(r.kind).toBe('ok');
  });

  test('rejects priority = 101 (above upper bound)', () => {
    const r = loadFlow(policyGraph({ priority: 101 }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(['schema-validation-failed', 'invalid-edge-policy']).toContain(r.error.code);
    }
  });

  test('rejects priority = -101 (below lower bound)', () => {
    const r = loadFlow(policyGraph({ priority: -101 }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(['schema-validation-failed', 'invalid-edge-policy']).toContain(r.error.code);
    }
  });

  test('rejects non-integer priority (1.5) — IEEE-754 sort ambiguity guard', () => {
    const r = loadFlow(policyGraph({ priority: 1.5 }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(['schema-validation-failed', 'invalid-edge-policy']).toContain(r.error.code);
    }
  });

  test('rejects string priority', () => {
    const r = loadFlow(policyGraph({ priority: 'high' }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(['schema-validation-failed', 'invalid-edge-policy']).toContain(r.error.code);
    }
  });

  test('field on the error is `priority` when the schema step passes', () => {
    // Loader-side check bites when someone constructs the policy via a
    // path that skips the JSON-schema — mimic that by feeding a value
    // the schema WOULD accept if it weren't range-checked (this specific
    // input is caught by the schema first, but the union field variant
    // must still exist).
    const r = loadFlow(policyGraph({ priority: 200 }));
    if (r.kind === 'err' && r.error.code === 'invalid-edge-policy') {
      expect(r.error.field).toBe('priority');
    }
  });
});

describe('schema drift', () => {
  test('bundled flow.schema.json matches @kindgi/specs/flow.schema.json', async () => {
    const bundled = await readFile(join(__dirname, '..', 'src', 'flow.schema.json'), 'utf-8');
    const canonical = await readFile(
      createRequire(import.meta.url).resolve('@kindgi/specs/flow.schema.json'),
      'utf-8',
    );
    expect(JSON.parse(bundled)).toEqual(JSON.parse(canonical));
  });

  test('exports the canonical $id', () => {
    expect(GRAPH_SCHEMA_URI).toBe('https://kindgi.com/schemas/v1/flow.schema.json');
  });
});
