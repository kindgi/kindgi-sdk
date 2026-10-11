// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/guardrails/:guardrailId/outcomes`: what a guardrail's checks
 * came to in a project over a window (`GuardrailRegistryBinding.outcomes`):
 * passes, violations, blocks and errors, the same per agent version, and
 * the window's latest blocked turns. Only ids and times: a blocked turn's
 * answer stays behind its run's own page.
 */

import type { Context } from 'hono';

import { ref } from '@kindgi/authz';
import type { GuardrailId, ProjectId, TenantId, Timestamp } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { GuardrailRegistryBinding } from '../guardrail-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { deniedBy } from './denied.js';

/** The longest window: outcomes go with their run's retention anyway. */
export const GUARDRAIL_OUTCOMES_MAX_WINDOW_DAYS = 90;
export const GUARDRAIL_OUTCOMES_DEFAULT_RECENT = 10;
export const GUARDRAIL_OUTCOMES_MAX_RECENT = 50;

const DAY_MS = 86_400_000;

interface OutcomesQuery {
  readonly projectId: ProjectId;
  readonly from: Timestamp;
  readonly to: Timestamp;
  readonly recent: number;
}

/** The query, or what's wrong with it. */
export function parseOutcomesQuery(
  query: Readonly<Record<string, string | undefined>>,
):
  | { readonly kind: 'ok'; readonly value: OutcomesQuery }
  | { readonly kind: 'err'; readonly message: string } {
  const err = (message: string) => ({ kind: 'err' as const, message });
  const projectId = query.projectId;
  if (projectId === undefined || projectId === '') return err('`projectId` is required');
  const from = time(query.from);
  const to = time(query.to);
  if (from === undefined || to === undefined) {
    return err('`from` and `to` are required, as ISO 8601 times');
  }
  if (Date.parse(from) >= Date.parse(to)) return err('`from` must be before `to`');
  if (Date.parse(to) - Date.parse(from) > GUARDRAIL_OUTCOMES_MAX_WINDOW_DAYS * DAY_MS) {
    return err(`The window is at most ${GUARDRAIL_OUTCOMES_MAX_WINDOW_DAYS} days`);
  }
  const recent =
    query.recent === undefined || query.recent === ''
      ? GUARDRAIL_OUTCOMES_DEFAULT_RECENT
      : Number(query.recent);
  if (!Number.isInteger(recent) || recent < 0 || recent > GUARDRAIL_OUTCOMES_MAX_RECENT) {
    return err(`\`recent\` is a whole number from 0 to ${GUARDRAIL_OUTCOMES_MAX_RECENT}`);
  }
  return { kind: 'ok', value: { projectId: projectId as ProjectId, from, to, recent } };
}

function time(raw: string | undefined): Timestamp | undefined {
  if (raw === undefined || raw === '' || Number.isNaN(Date.parse(raw))) return undefined;
  return new Date(raw).toISOString() as Timestamp;
}

/**
 * The route's handler. `read` on the guardrail is asked by the router's
 * `/:guardrailId/*` check; `read` on the project is asked here, since the
 * project comes from the query.
 */
export function guardrailOutcomesHandler(
  binding: GuardrailRegistryBinding,
  authorizer: Authorizer | undefined,
) {
  return async (c: Context<AppEnv>) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const guardrailId = c.req.param('guardrailId') as GuardrailId;
    const fail = (code: string, message: string) => {
      c.status(statusFor(code) as never);
      return c.json(toWireError({ code, message }, requestId));
    };
    const parsed = parseOutcomesQuery(c.req.query());
    if (parsed.kind === 'err') return fail('bad-input', parsed.message);
    const refused = await deniedBy(
      authorizer,
      c,
      'read',
      ref('project', parsed.value.projectId as unknown as string),
    );
    if (refused !== undefined) return refused;
    if (binding.outcomes === undefined) {
      return fail(
        'guardrail-outcomes-not-supported',
        "This deployment doesn't record guardrail outcomes.",
      );
    }
    const outcomes = await binding.outcomes({ tenantId, guardrailId, ...parsed.value });
    return c.json({ guardrailId, from: parsed.value.from, to: parsed.value.to, ...outcomes });
  };
}
