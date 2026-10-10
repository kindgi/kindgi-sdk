// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Every list call answers in one shape: the wire's page, `data`,
 * `hasMore` and `nextCursor`, as the API and the Python client have it.
 *
 * Not here: `retention.scheduled`, a report capped at `limit` with no
 * cursor, that can't yet say whether it was cut short.
 */

import { describe, expectTypeOf, test } from 'vitest';

import type { KindgiClient } from '../src/index.js';

/** The wire's page. */
interface WirePage {
  readonly data: readonly unknown[];
  readonly hasMore: boolean;
  readonly nextCursor?: unknown;
}

/** What a call answers. */
type Answer<F> = F extends (...args: never[]) => Promise<infer R> ? R : never;

describe('every list call answers with data, hasMore and nextCursor', () => {
  test('adapters.list', () => {
    expectTypeOf<Answer<KindgiClient['adapters']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('agents.list', () => {
    expectTypeOf<Answer<KindgiClient['agents']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('agents.versions.list', () => {
    expectTypeOf<Answer<KindgiClient['agents']['versions']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('approvals.list', () => {
    expectTypeOf<Answer<KindgiClient['approvals']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('approvals.reviewers.list', () => {
    expectTypeOf<
      Answer<KindgiClient['approvals']['reviewers']['list']>
    >().toMatchTypeOf<WirePage>();
  });
  test('approvals.audit.list', () => {
    expectTypeOf<Answer<KindgiClient['approvals']['audit']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('artifacts.list', () => {
    expectTypeOf<Answer<KindgiClient['artifacts']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('audit.authz.list', () => {
    expectTypeOf<Answer<KindgiClient['audit']['authz']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('audit.signIns.list', () => {
    expectTypeOf<Answer<KindgiClient['audit']['signIns']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('auth.providers.list', () => {
    expectTypeOf<Answer<KindgiClient['auth']['providers']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('blocks.list', () => {
    expectTypeOf<Answer<KindgiClient['blocks']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('blocks.versions.list', () => {
    expectTypeOf<Answer<KindgiClient['blocks']['versions']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('capabilities.list', () => {
    expectTypeOf<Answer<KindgiClient['capabilities']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('capabilities.providers.list', () => {
    expectTypeOf<
      Answer<KindgiClient['capabilities']['providers']['list']>
    >().toMatchTypeOf<WirePage>();
  });
  test('compliance.evidence.list', () => {
    expectTypeOf<
      Answer<KindgiClient['compliance']['evidence']['list']>
    >().toMatchTypeOf<WirePage>();
  });
  test('conversations.list', () => {
    expectTypeOf<Answer<KindgiClient['conversations']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('conversations.messages', () => {
    expectTypeOf<Answer<KindgiClient['conversations']['messages']>>().toMatchTypeOf<WirePage>();
  });
  test('cost.usage.query', () => {
    expectTypeOf<Answer<KindgiClient['cost']['usage']['query']>>().toMatchTypeOf<WirePage>();
  });
  test('deployments.list', () => {
    expectTypeOf<Answer<KindgiClient['deployments']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('env.list', () => {
    expectTypeOf<Answer<KindgiClient['env']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('evalRuns.list', () => {
    expectTypeOf<Answer<KindgiClient['evalRuns']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('evalSuites.list', () => {
    expectTypeOf<Answer<KindgiClient['evalSuites']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('evalSuites.listCases', () => {
    expectTypeOf<Answer<KindgiClient['evalSuites']['listCases']>>().toMatchTypeOf<WirePage>();
  });
  test('gatePolicies.list', () => {
    expectTypeOf<Answer<KindgiClient['gatePolicies']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('gatePolicies.versions.list', () => {
    expectTypeOf<
      Answer<KindgiClient['gatePolicies']['versions']['list']>
    >().toMatchTypeOf<WirePage>();
  });
  test('evalSuites.versions.list', () => {
    expectTypeOf<
      Answer<KindgiClient['evalSuites']['versions']['list']>
    >().toMatchTypeOf<WirePage>();
  });
  test('events.query', () => {
    expectTypeOf<Answer<KindgiClient['events']['query']>>().toMatchTypeOf<WirePage>();
  });
  test('events.subscriptions.list', () => {
    expectTypeOf<
      Answer<KindgiClient['events']['subscriptions']['list']>
    >().toMatchTypeOf<WirePage>();
  });
  test('flows.list', () => {
    expectTypeOf<Answer<KindgiClient['flows']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('flows.versions.list', () => {
    expectTypeOf<Answer<KindgiClient['flows']['versions']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('guardrails.list', () => {
    expectTypeOf<Answer<KindgiClient['guardrails']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('guardrails.versions', () => {
    expectTypeOf<Answer<KindgiClient['guardrails']['versions']>>().toMatchTypeOf<WirePage>();
  });
  test('guardrails.builtIns', () => {
    expectTypeOf<Answer<KindgiClient['guardrails']['builtIns']>>().toMatchTypeOf<WirePage>();
  });
  test('identity.users.list', () => {
    expectTypeOf<Answer<KindgiClient['identity']['users']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('identity.users.listSessions', () => {
    expectTypeOf<
      Answer<KindgiClient['identity']['users']['listSessions']>
    >().toMatchTypeOf<WirePage>();
  });
  test('judgeClasses.list', () => {
    expectTypeOf<Answer<KindgiClient['judgeClasses']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('judgments.list', () => {
    expectTypeOf<Answer<KindgiClient['judgments']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('mcp.tools', () => {
    expectTypeOf<Answer<KindgiClient['mcp']['tools']>>().toMatchTypeOf<WirePage>();
  });
  test('mcp.agents', () => {
    expectTypeOf<Answer<KindgiClient['mcp']['agents']>>().toMatchTypeOf<WirePage>();
  });
  test('mcp.endpoints.list', () => {
    expectTypeOf<Answer<KindgiClient['mcp']['endpoints']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('memory.facts.list', () => {
    expectTypeOf<Answer<KindgiClient['memory']['facts']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('memory.logs.list', () => {
    expectTypeOf<Answer<KindgiClient['memory']['logs']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('observations.query', () => {
    expectTypeOf<Answer<KindgiClient['observations']['query']>>().toMatchTypeOf<WirePage>();
  });
  test('orgs.list', () => {
    expectTypeOf<Answer<KindgiClient['orgs']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('packs.installed', () => {
    expectTypeOf<Answer<KindgiClient['packs']['installed']>>().toMatchTypeOf<WirePage>();
  });
  test('packs.versions', () => {
    expectTypeOf<Answer<KindgiClient['packs']['versions']>>().toMatchTypeOf<WirePage>();
  });
  test('packs.registry.browse', () => {
    expectTypeOf<Answer<KindgiClient['packs']['registry']['browse']>>().toMatchTypeOf<WirePage>();
  });
  test('packs.registry.configured', () => {
    expectTypeOf<
      Answer<KindgiClient['packs']['registry']['configured']>
    >().toMatchTypeOf<WirePage>();
  });
  test('policies.list', () => {
    expectTypeOf<Answer<KindgiClient['policies']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('policies.versions', () => {
    expectTypeOf<Answer<KindgiClient['policies']['versions']>>().toMatchTypeOf<WirePage>();
  });
  test('projects.list', () => {
    expectTypeOf<Answer<KindgiClient['projects']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('projects.memberships.list', () => {
    expectTypeOf<
      Answer<KindgiClient['projects']['memberships']['list']>
    >().toMatchTypeOf<WirePage>();
  });
  test('provenance.query', () => {
    expectTypeOf<Answer<KindgiClient['provenance']['query']>>().toMatchTypeOf<WirePage>();
  });
  test('providers.list', () => {
    expectTypeOf<Answer<KindgiClient['providers']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('runs.list', () => {
    expectTypeOf<Answer<KindgiClient['runs']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('runs.journal', () => {
    expectTypeOf<Answer<KindgiClient['runs']['journal']>>().toMatchTypeOf<WirePage>();
  });
  test('schedules.list', () => {
    expectTypeOf<Answer<KindgiClient['schedules']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('secrets.list', () => {
    expectTypeOf<Answer<KindgiClient['secrets']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('secrets.listVersions', () => {
    expectTypeOf<Answer<KindgiClient['secrets']['listVersions']>>().toMatchTypeOf<WirePage>();
  });
  test('signingKeys.list', () => {
    expectTypeOf<Answer<KindgiClient['signingKeys']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('supervisor.list', () => {
    expectTypeOf<Answer<KindgiClient['supervisor']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('supervisor.versions', () => {
    expectTypeOf<Answer<KindgiClient['supervisor']['versions']>>().toMatchTypeOf<WirePage>();
  });
  test('improvementPasses.list', () => {
    expectTypeOf<Answer<KindgiClient['improvementPasses']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('proposals.list', () => {
    expectTypeOf<Answer<KindgiClient['proposals']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('teams.list', () => {
    expectTypeOf<Answer<KindgiClient['teams']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('teams.memberships.list', () => {
    expectTypeOf<Answer<KindgiClient['teams']['memberships']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('tenant.config.list', () => {
    expectTypeOf<Answer<KindgiClient['tenant']['config']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('tokens.list', () => {
    expectTypeOf<Answer<KindgiClient['tokens']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('tools.list', () => {
    expectTypeOf<Answer<KindgiClient['tools']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('tools.versions.list', () => {
    expectTypeOf<Answer<KindgiClient['tools']['versions']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('users.list', () => {
    expectTypeOf<Answer<KindgiClient['users']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('users.sessions.list', () => {
    expectTypeOf<Answer<KindgiClient['users']['sessions']['list']>>().toMatchTypeOf<WirePage>();
  });
  test('webhookEndpoints.list', () => {
    expectTypeOf<Answer<KindgiClient['webhookEndpoints']['list']>>().toMatchTypeOf<WirePage>();
  });
});
