// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `run.finished` names the agent of an agent's run (`data.run.agent`, as
 * `GET /v1/runs/{runId}` does), additively: optional in the schema, so a
 * receiver or a generated client keeps reading events from a runtime that
 * doesn't send it yet.
 */

import { describe, expect, test } from 'vitest';

import { FinishedRunSchema, RunAgentSchema } from '../src/openapi/schemas.js';

describe("run.finished's run: the agent", () => {
  test('is a RunAgent, the shape GET /v1/runs/{runId} uses', () => {
    const agent = (FinishedRunSchema.properties as Record<string, { $ref?: string }>).agent;
    expect(agent?.$ref).toBe('#/components/schemas/RunAgent');
    expect(RunAgentSchema.required).toEqual(['id', 'version', 'conversationId']);
  });

  test('is never required: an older runtime sends events without it', () => {
    expect(FinishedRunSchema.required).not.toContain('agent');
  });
});
