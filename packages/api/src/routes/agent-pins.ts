// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, Hono } from 'hono';

import type { AgentId } from '@kindgi/agents';
import type { ReviewerRole } from '@kindgi/authz';
import type {
  AgentPinScope,
  Cursor,
  OrgId,
  ProjectId,
  RunId,
  Semver,
  TenantId,
} from '@kindgi/types';

import type { ProjectBinding } from '@kindgi/platform';

import type { AgentRegistryBinding } from '../agent-binding.js';
import type {
  AgentPinBindings,
  AgentPinInput,
  AgentPinResolveInput,
  AgentPinnedVersion,
  Pin,
  PinActor,
} from '../agent-pin-binding.js';
import type { CorrectedComparisonSummary } from '../corrected-dispatcher.js';
import { statusFor, toWireError } from '../errors.js';
import { type GateApproval, type GateCheck, type GateResult, evaluateGate } from '../gate.js';
import type { ItemRights } from '../item-rights.js';
import {
  type ReferenceScopeBinding,
  agentPinScopeOutOfScope,
  outOfScopeResponse,
} from '../reference-scope.js';
import type { ReleaseGate } from '../release-gate-binding.js';
import type { TestRun, TestRunBinding } from '../test-run-binding.js';
import type { AppEnv } from '../types.js';
import { agentPinScopeToWire, parseAgentPinScopeBody } from './agent-pin-scope-wire.js';
import { refuseUnissuedCursor } from './issued-cursor.js';
import { clampLimit } from './pagination.js';
import { serializeReleaseGate } from './release-gate-wire.js';
import { parseSegmentsQuery } from './segments.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The routes that change what's pinned: authorized as `pin` on the agent, not `admin`. */
export function isAgentPinWrite(method: string, path: string): boolean {
  return method === 'POST' && /\/pinned\/(pin|unpin)$/.test(path);
}

/** The pin writes that set a pinned version — a pin, not an unpin: only these span an order's environments. */
export function isAgentPinSet(method: string, path: string): boolean {
  return method === 'POST' && path.endsWith('/pinned/pin');
}

/** `POST …/pinned/pin`: a request that a version be pinned. */
export function isAgentPinRequest(method: string, path: string): boolean {
  return method === 'POST' && path.endsWith('/pinned/pin');
}

/** `POST …/pinned/unpin`: undoing what's pinned. */
export function isAgentUnpin(method: string, path: string): boolean {
  return method === 'POST' && path.endsWith('/pinned/unpin');
}

/** `POST …/pinned/check` changes nothing: `read` on the agent. */
export function isAgentPinCheck(method: string, path: string): boolean {
  return method === 'POST' && path.endsWith('/pinned/check');
}

/** What the gate reads besides the pins: comparisons, and a project's org. */
export interface AgentPinGateDeps {
  readonly testRuns?: TestRunBinding;
  readonly projects?: ProjectBinding;
  /** A project or segment scope must reach the agent (`reference-scope.ts`); absent → as named. */
  readonly referenceScope?: ReferenceScopeBinding;
}

/**
 * Pinned versions of an agent per scope, and the pin changes that set
 * them:
 *   GET  /:agentId/pinned            the version a run would use for a project and segment path
 *   GET  /:agentId/pinned-versions   every pin
 *   POST /:agentId/pinned/pin        pin a version for a scope, through its gate
 *                                      (201 pinned, 202 waiting for approval, 422 gate-failed)
 *   POST /:agentId/pinned/check      what the gate would say, writing nothing
 *   GET  /:agentId/release-gate      the release gate that applies to a scope
 *   GET  /:agentId/pin-history[/:id] the history
 *   POST /:agentId/pinned/unpin      remove the scope's pin (it falls back to the scope above)
 * Going back to an earlier version is a pin of that version.
 */
export function mountAgentPinRoutes(
  r: Hono<AppEnv>,
  registry: AgentRegistryBinding,
  agentPins: AgentPinBindings,
  deps: AgentPinGateDeps = {},
  /** What a project-scoped pin's project may run (`reference-scope.ts`); absent → as named. */
  referenceScope?: ReferenceScopeBinding,
  /** Rights on an agent more than one project serves (`item-rights.ts`); absent → the agent's own. */
  itemRights?: ItemRights,
): void {
  const seen = (c: Ctx, agentId: string, versions: readonly string[]) =>
    seenVersions(itemRights, c, agentId, versions);
  /** A pin change the caller can see: every version it names is one. */
  const named = (p: Pin): string[] =>
    [p.fromVersion, p.toVersion].filter((v): v is Semver => v !== null).map(String);
  const shows = (p: Pin, visible: ReadonlySet<string>) => named(p).every((v) => visible.has(v));
  /** A project or segment pin of an agent that project doesn't reach: refused. */
  const outOfScope = (tenantId: TenantId, agentId: string, scope: AgentPinScope) =>
    agentPinScopeOutOfScope(referenceScope, tenantId, agentId, scope);
  const gateDeps: AgentPinGateDeps = {
    ...deps,
    ...(referenceScope !== undefined && { referenceScope }),
  };
  r.get('/:agentId/pinned', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId');
    const projectId = c.req.query('projectId');
    if (projectId !== undefined && !UUID_RE.test(projectId)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`projectId` must be a project id (a UUID)' },
          requestId,
        ),
      );
    }
    const segments = parseSegmentsQuery(c.req.queries('segment') ?? []);
    if (segments.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: segments.message }, requestId));
    }
    if (segments.segments !== undefined && projectId === undefined) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: 'A `segment` path needs a `projectId`' },
          requestId,
        ),
      );
    }
    const resolved = await agentPins.pinned.resolve({
      tenantId,
      agentId,
      ...(projectId !== undefined && { projectId: projectId as ProjectId }),
      ...(segments.segments !== undefined && { segments: segments.segments }),
    });
    return answerPinned(c, tenantId, agentId, resolved);
  });

  /**
   * What `GET …/pinned` answers: the pinned version `resolved` names, else
   * (nothing pinned on the way up) the latest registered version, which is
   * what a run gets. A version the caller can't see answers as no agent
   * does (`item-rights.ts`).
   */
  async function answerPinned(
    c: Ctx,
    tenantId: TenantId,
    agentId: string,
    resolved: Awaited<ReturnType<typeof agentPins.pinned.resolve>>,
  ) {
    const hidden = async (version: string) => !(await seen(c, agentId, [version])).has(version);
    if (resolved !== null && !(await hidden(resolved.version as unknown as string))) {
      return c.json({
        agentId,
        version: resolved.version as unknown as string,
        via: 'pinned',
        pinnedScope: agentPinScopeToWire(resolved.scope),
      });
    }
    const latest =
      resolved === null ? await registry.get({ tenantId, agentId: agentId as AgentId }) : null;
    if (latest === null || (await hidden(latest.version as unknown as string))) {
      c.status(statusFor('agent-not-found') as never);
      return c.json(
        toWireError(
          { code: 'agent-not-found', message: `No agent "${agentId}" is registered` },
          c.get('requestId'),
        ),
      );
    }
    return c.json({ agentId, version: latest.version as unknown as string, via: 'latest' });
  }

  r.get('/:agentId/pinned-versions', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId');
    const all = await agentPins.pinned.list({ tenantId, agentId });
    const visible = await seen(
      c,
      agentId,
      all.map((p) => p.version as unknown as string),
    );
    const pins = all.filter((p) => visible.has(p.version as unknown as string));
    return c.json({ data: pins.map(serializeAgentPinnedVersion) });
  });

  r.post('/:agentId/pinned/pin', async (c) => {
    const requestId = c.get('requestId');
    const parsed = await readPinBody(c);
    if (parsed.kind === 'err') return badInput(c, requestId, parsed.message);
    const agentId = c.req.param('agentId');
    const outcome = await requestPin(registry, agentPins, gateDeps, {
      tenantId: c.get('tenantId') as TenantId,
      agentId,
      version: parsed.value.version,
      scope: parsed.value.scope,
      requestedBy: actorOf(c),
      ...(parsed.value.reason !== undefined && { reason: parsed.value.reason }),
      ...(parsed.value.testRunId !== undefined && { testRunId: parsed.value.testRunId }),
    });
    return pinResponse(c, outcome);
  });

  r.post('/:agentId/pinned/check', async (c) => {
    const requestId = c.get('requestId');
    const parsed = await readPinBody(c);
    if (parsed.kind === 'err') return badInput(c, requestId, parsed.message);
    const tenantId = c.get('tenantId') as TenantId;
    const agentId = c.req.param('agentId');
    const refused = await outOfScope(tenantId, agentId, parsed.value.scope);
    if (refused !== undefined) return outOfScopeResponse(c, requestId, refused);
    const releaseGate = await releaseGateFor(agentPins, tenantId, agentId, parsed.value.scope);
    const gate = await runGate(
      registry,
      agentPins,
      deps,
      { ...parsed.value, tenantId, agentId },
      releaseGate,
    );
    if (gate.kind === 'err') return failed(c, requestId, gate.error);
    const { result } = gate;
    return c.json({
      outcome: !result.passed
        ? 'gate-failed'
        : result.approval !== undefined
          ? 'needs-approval'
          : 'would-pin',
      releaseGate:
        releaseGate === null ? null : { id: releaseGate.id, version: releaseGate.version },
      checks: result.checks,
      ...(result.approval !== undefined && { approval: result.approval }),
    });
  });

  r.get('/:agentId/release-gate', async (c) => {
    const requestId = c.get('requestId');
    const scope = scopeFromQuery((n) => c.req.query(n), c.req.queries('segment') ?? []);
    if (scope.kind === 'err') return badInput(c, requestId, scope.message);
    if (scope.scope === undefined) {
      return badInput(c, requestId, '`scopeKind` is required: the scope a pin would be for');
    }
    const releaseGate = await releaseGateFor(
      agentPins,
      c.get('tenantId') as TenantId,
      c.req.param('agentId'),
      scope.scope,
    );
    return c.json({
      releaseGate: releaseGate === null ? null : serializeReleaseGate(releaseGate),
    });
  });

  r.get('/:agentId/pin-history', async (c) => {
    const requestId = c.get('requestId');
    const scope = scopeFromQuery((n) => c.req.query(n), c.req.queries('segment') ?? []);
    if (scope.kind === 'err') return badInput(c, requestId, scope.message);
    const cursor = c.req.query('cursor');
    const refused = refuseUnissuedCursor(c, agentPins.changes, 'pin-history', cursor);
    if (refused !== undefined) return refused;
    const agentId = c.req.param('agentId');
    const page = await agentPins.changes.list({
      tenantId: c.get('tenantId') as TenantId,
      agentId,
      limit: clampLimit(c.req.query('limit')),
      ...(scope.scope !== undefined && { scope: scope.scope }),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
    });
    const visible = await seen(c, agentId, [...new Set(page.data.flatMap(named))]);
    return c.json({
      data: page.data.filter((p) => shows(p, visible)).map(serializePin),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  r.get('/:agentId/pin-history/:changeId', async (c) => {
    const requestId = c.get('requestId');
    const found = await agentPins.changes.get(
      c.get('tenantId') as TenantId,
      c.req.param('changeId'),
    );
    if (
      found === null ||
      found.agentId !== c.req.param('agentId') ||
      !shows(found, await seen(c, found.agentId, named(found)))
    ) {
      c.status(statusFor('pin-not-found') as never);
      return c.json(
        toWireError(
          { code: 'pin-not-found', message: 'No such pin change for this agent' },
          requestId,
        ),
      );
    }
    return c.json(serializePin(found));
  });

  r.post('/:agentId/pinned/unpin', async (c) => {
    const requestId = c.get('requestId');
    const body = await readBody(c);
    if (body === undefined) return badJson(c, requestId);
    const scope = parseAgentPinScopeBody(body.scope);
    if (scope.kind === 'err') return badInput(c, requestId, scope.message);
    const text = optionalText(body, ['reason']);
    if (text.kind === 'err') return badInput(c, requestId, text.message);
    const outcome = await agentPins.changes.unpin({
      tenantId: c.get('tenantId') as TenantId,
      agentId: c.req.param('agentId'),
      scope: scope.scope,
      requestedBy: actorOf(c),
      ...text.value,
    });
    if (outcome.kind === 'err') return failed(c, requestId, outcome.error);
    return c.json(serializePin(outcome.value));
  });
}

type Ctx = Context<AppEnv>;

/**
 * The versions among `versions` of an agent the caller can see: all of
 * them, unless more than one project serves the agent (`item-rights.ts`,
 * rule 2).
 */
export async function seenVersions(
  itemRights: ItemRights | undefined,
  c: Ctx,
  agentId: string,
  versions: readonly string[],
): Promise<ReadonlySet<string>> {
  return visibleOf(itemRights, c, agentId, await itemRights?.multi(c, 'agent', agentId), versions);
}

/**
 * The pins among `pins` whose version the caller can see, in order, by the
 * rule `seenVersions` applies to each pin's agent. One ask finds the agents
 * more than one project serves; only their versions are read further.
 */
export async function seenPins<P extends Pick<AgentPinnedVersion, 'agentId' | 'version'>>(
  itemRights: ItemRights | undefined,
  c: Ctx,
  pins: readonly P[],
): Promise<P[]> {
  if (itemRights === undefined || pins.length === 0) return [...pins];
  const versionOf = (p: P) => p.version as unknown as string;
  const multi = await itemRights.multiOfMany(
    c,
    'agent',
    pins.map((p) => p.agentId),
  );
  const visible = new Map<string, ReadonlySet<string>>();
  for (const [agentId, projects] of multi) {
    const versions = [...new Set(pins.filter((p) => p.agentId === agentId).map(versionOf))];
    visible.set(agentId, await visibleOf(itemRights, c, agentId, projects, versions));
  }
  return pins.filter((p) => visible.get(p.agentId)?.has(versionOf(p)) ?? true);
}

/** A pin on the wire (`AgentPinnedVersion`), as an agent's and a project's lists show it. */
export function serializeAgentPinnedVersion(p: AgentPinnedVersion) {
  return {
    agentId: p.agentId,
    scope: agentPinScopeToWire(p.scope),
    version: p.version as unknown as string,
    changeId: p.changeId,
    setAt: p.setAt as unknown as string,
  };
}

/** Rule 2 for one agent, given its projects when more than one serves it. */
async function visibleOf(
  itemRights: ItemRights | undefined,
  c: Ctx,
  agentId: string,
  projects: readonly ProjectId[] | undefined,
  versions: readonly string[],
): Promise<ReadonlySet<string>> {
  if (itemRights === undefined || projects === undefined) return new Set(versions);
  return new Set(
    await itemRights.visibleVersions(c, 'agent', agentId, projects, versions, (v) => v),
  );
}

/** A pin request's outcome: recorded, refused before recording, or unsupported here. */
export type PinRequestOutcome =
  | {
      readonly kind: 'ok';
      readonly pin: Pin;
      /** The gate's checks as they ran (a binding may not echo them on the row). */
      readonly checks?: readonly GateCheck[];
    }
  | { readonly kind: 'err'; readonly error: { code: string; message: string } }
  | { readonly kind: 'gate-unsupported'; readonly releaseGate: ReleaseGate };

/**
 * Request that `version` be pinned for `scope`, through the scope's gate:
 * the binding records it as pinned, waiting for approval, or refused
 * (`pin.status`). Without gated requests in this deployment, an
 * ungated scope pins as before and a gated one is unsupported.
 */
export async function requestPin(
  registry: AgentRegistryBinding,
  agentPins: AgentPinBindings,
  deps: AgentPinGateDeps,
  input: AgentPinInput,
  options: {
    /** An approval the pin waits for even when the scope's release gate asks for none. */
    readonly requireApproval?: GateApproval;
    /**
     * For a drafter's pin: whether the tenant has a separate approver (a
     * reviewer other than the requester who could decide) ranked at or above
     * the given role. Consulted only when a scope's release gate sets
     * `separateApprover: false`, so the drafter's rule is re-checked at the
     * gate's role rather than the drafter's own `standard`.
     */
    readonly draftedEligibleAtRole?: (role: ReviewerRole) => Promise<boolean>;
  } = {},
): Promise<PinRequestOutcome> {
  // Every way a pin is asked for comes through here (the route, a
  // suggested change's request): a project or segment scope must reach the agent.
  const outOfScope = await agentPinScopeOutOfScope(
    deps.referenceScope,
    input.tenantId,
    input.agentId,
    input.scope,
  );
  if (outOfScope !== undefined) return { kind: 'err', error: outOfScope };
  const releaseGate = await releaseGateFor(agentPins, input.tenantId, input.agentId, input.scope);
  if (agentPins.changes.request === undefined) {
    if (releaseGate !== null) return { kind: 'gate-unsupported', releaseGate };
    if (options.requireApproval !== undefined) {
      return {
        kind: 'err',
        error: {
          code: 'pin-gate-unsupported',
          message:
            "This pin waits for a reviewer's approval, and this deployment can't record a gated pin yet.",
        },
      };
    }
    // No gate, and a binding from before gates: pin as before.
    const outcome = await agentPins.changes.pin(input);
    return outcome.kind === 'err'
      ? { kind: 'err', error: outcome.error }
      : { kind: 'ok', pin: outcome.value };
  }
  const gate = await runGate(registry, agentPins, deps, input, releaseGate);
  if (gate.kind === 'err') return gate;
  const approval = await resolveApproval(gate.result.approval, options);
  const outcome = await agentPins.changes.request({
    ...input,
    gate: {
      releaseGate:
        releaseGate === null ? null : { id: releaseGate.id, version: releaseGate.version },
      checks: gate.result.checks,
      passed: gate.result.passed,
      ...(approval !== undefined && { approval }),
      servingVersion: gate.servingVersion as Semver,
      ...(gate.pinInPlace && { pinInPlace: true }),
    },
  });
  return outcome.kind === 'err'
    ? { kind: 'err', error: outcome.error }
    : { kind: 'ok', pin: outcome.value, checks: gate.result.checks };
}

/**
 * The approval a pin request waits for. A scope's release gate approval
 * wins — its role and its reviewer eligibility. For a drafter's pin the
 * gate's rule is only a floor: the drafter's separate-approver rule can make
 * it stricter, never looser, so whoever started the pass can't approve their
 * own drafter's work. The gate's `separateApprover` defaults to `true`
 * (`gateApproval`), so only an explicit `false` defers to the drafter's rule,
 * re-checked at the gate's role (`draftedEligibleAtRole`) rather than the
 * drafter's own `standard`. A gate with no approvals block, and any
 * non-drafted pin, are left unchanged.
 */
async function resolveApproval(
  gateApproval: GateApproval | undefined,
  options: {
    readonly requireApproval?: GateApproval;
    readonly draftedEligibleAtRole?: (role: ReviewerRole) => Promise<boolean>;
  },
): Promise<GateApproval | undefined> {
  if (gateApproval === undefined) return options.requireApproval;
  // A non-drafted pin carries no drafter approval: the gate's stands.
  if (options.requireApproval === undefined) return gateApproval;
  // Already strict (the default, or an explicit true): nothing to add.
  if (gateApproval.separateApprover) return gateApproval;
  const separateApprover =
    options.draftedEligibleAtRole !== undefined
      ? await options.draftedEligibleAtRole(gateApproval.role)
      : options.requireApproval.separateApprover;
  return { ...gateApproval, separateApprover };
}

/**
 * The answer to a pin request: 201 pinned, 202 waiting for
 * approval, 422 `gate-failed` with the checks, or the error. `extra` is
 * merged into whichever answer comes out — the caller carries fields it
 * knows the outcome alone can't, such as a promotion's pins so far.
 */
export function pinResponse(
  c: Ctx,
  outcome: PinRequestOutcome,
  extra: Readonly<Record<string, unknown>> = {},
) {
  const requestId = c.get('requestId');
  if (outcome.kind === 'gate-unsupported') {
    c.status(statusFor('pin-gate-unsupported') as never);
    return c.json(
      toWireError(
        {
          code: 'pin-gate-unsupported',
          message: `Release gate ${outcome.releaseGate.id} ${outcome.releaseGate.version} applies to this pin, and this deployment can't record a gated pin yet.`,
          ...extra,
        },
        requestId,
      ),
    );
  }
  if (outcome.kind === 'err') return failed(c, requestId, outcome.error, extra);
  const { pin } = outcome;
  if (pin.status === 'refused') {
    const checks = pin.checks ?? outcome.checks ?? [];
    c.status(statusFor('gate-failed') as never);
    return c.json(
      toWireError(
        {
          code: 'gate-failed',
          message: `The release gate refused ${pin.agentId} ${pin.toVersion as unknown as string}: ${checks
            .filter((check) => !check.passed)
            .map((check) => check.message)
            .join(' ')}`,
          changeId: pin.id,
          releaseGate: pin.releaseGate ?? null,
          checks,
          ...extra,
        },
        requestId,
      ),
    );
  }
  c.status(pin.status === 'pending-approval' ? 202 : 201);
  return c.json({ ...serializePin(pin), ...extra });
}

async function readBody(c: Ctx): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await c.req.json();
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function badJson(c: Ctx, requestId: string) {
  return badInput(c, requestId, 'Request body must be a JSON object');
}

function badInput(c: Ctx, requestId: string, message: string) {
  c.status(statusFor('bad-input') as never);
  return c.json(toWireError({ code: 'bad-input', message }, requestId));
}

function failed(
  c: Ctx,
  requestId: string,
  error: { code: string; message: string },
  extra: Readonly<Record<string, unknown>> = {},
) {
  c.status(statusFor(error.code) as never);
  return c.json(toWireError({ ...error, ...extra }, requestId));
}

/** Optional short strings (`reason`, `testRunId`): absent, or a non-empty string. */
function optionalText(
  body: Readonly<Record<string, unknown>>,
  fields: readonly ('reason' | 'testRunId')[],
):
  | { kind: 'ok'; value: { reason?: string; testRunId?: string } }
  | { kind: 'err'; message: string } {
  const value: { reason?: string; testRunId?: string } = {};
  for (const field of fields) {
    const v = body[field];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.trim() === '' || v.length > 2000) {
      return { kind: 'err', message: `\`${field}\` must be a non-empty string when supplied` };
    }
    value[field] = v;
  }
  return { kind: 'ok', value };
}

/** The pin body: `{version, scope, testRunId?, reason?}`. */
async function readPinBody(c: Ctx): Promise<
  | {
      kind: 'ok';
      value: { version: Semver; scope: AgentPinScope; testRunId?: string; reason?: string };
    }
  | { kind: 'err'; message: string }
> {
  const body = await readBody(c);
  if (body === undefined) return { kind: 'err', message: 'Request body must be a JSON object' };
  const scope = parseAgentPinScopeBody(body.scope);
  if (scope.kind === 'err') return scope;
  if (typeof body.version !== 'string' || body.version.length === 0) {
    return { kind: 'err', message: '`version` is required: the agent version to pin' };
  }
  const text = optionalText(body, ['reason', 'testRunId']);
  if (text.kind === 'err') return text;
  return {
    kind: 'ok',
    value: { version: body.version as Semver, scope: scope.scope, ...text.value },
  };
}

/** The release gate for a pin of `agentId` for `scope`; `null` when none applies. */
export async function releaseGateFor(
  agentPins: AgentPinBindings,
  tenantId: TenantId,
  agentId: string,
  scope: AgentPinScope,
): Promise<ReleaseGate | null> {
  return agentPins.releaseGates === undefined
    ? null
    : agentPins.releaseGates.resolve({ tenantId, agentId, scope });
}

/** The scope's coordinates, as a run in it would resolve its version. */
export function coordinatesOf(
  scope: AgentPinScope,
): Omit<AgentPinResolveInput, 'tenantId' | 'agentId'> {
  switch (scope.kind) {
    case 'tenant':
      return {};
    case 'org':
      return { orgId: scope.orgId };
    case 'project':
      return { projectId: scope.projectId };
    case 'segment':
      return { projectId: scope.projectId, segments: scope.path };
  }
}

/** A finished comparison's summary, or `null` for any other test run. */
function summaryOf(run: TestRun): CorrectedComparisonSummary | null {
  const summary = run.result?.summary;
  return run.kind === 'corrections' && summary !== null && typeof summary === 'object'
    ? (summary as CorrectedComparisonSummary)
    : null;
}

/** Whether two pin scopes are the same scope. */
function sameScope(a: AgentPinScope, b: AgentPinScope): boolean {
  switch (a.kind) {
    case 'tenant':
      return b.kind === 'tenant';
    case 'org':
      return b.kind === 'org' && b.orgId === a.orgId;
    case 'project':
      return b.kind === 'project' && b.projectId === a.projectId;
    case 'segment':
      return (
        b.kind === 'segment' &&
        b.projectId === a.projectId &&
        b.path.length === a.path.length &&
        b.path.every((s, i) => s.key === a.path[i]?.key && s.value === a.path[i]?.value)
      );
  }
}

/**
 * The gate for a pin request: what serves the scope now, the
 * comparison it names, and the release gate's checks against them. With
 * no gate there's nothing to check. A pin in place (the scope has no pin
 * of its own and serves exactly the version already) changes nothing any
 * run gets, so the gate's checks and approval don't apply: one passing
 * `pinInPlace` check, and `pinInPlace` for the binding to re-check.
 */
async function runGate(
  registry: AgentRegistryBinding,
  agentPins: AgentPinBindings,
  deps: AgentPinGateDeps,
  req: {
    readonly tenantId: TenantId;
    readonly agentId: string;
    readonly version: Semver;
    readonly scope: AgentPinScope;
    readonly testRunId?: string;
  },
  releaseGate: ReleaseGate | null,
): Promise<
  | { kind: 'ok'; result: GateResult; servingVersion: string; pinInPlace?: boolean }
  | { kind: 'err'; error: { code: string; message: string } }
> {
  const { tenantId, agentId } = req;
  const err = (code: string, message: string) => ({
    kind: 'err' as const,
    error: { code, message },
  });
  const candidate = await registry.getVersion({
    tenantId,
    agentId: agentId as AgentId,
    version: req.version,
  });
  if (candidate === null || candidate.unregisteredAt !== undefined) {
    return err('agent-version-not-found', `${agentId} has no active version ${req.version}`);
  }
  const pinned = await agentPins.pinned.resolve({
    tenantId,
    agentId,
    ...coordinatesOf(req.scope),
  });
  let servingVersion = pinned?.version as unknown as string | undefined;
  if (servingVersion === undefined) {
    const latest = await registry.get({ tenantId, agentId: agentId as AgentId });
    if (latest === null) return err('agent-not-found', `No agent "${agentId}" is registered`);
    servingVersion = latest.version as unknown as string;
  }
  if (releaseGate === null) {
    return { kind: 'ok', result: { checks: [], passed: true }, servingVersion };
  }
  if (servingVersion === (req.version as unknown as string)) {
    const pins = await agentPins.pinned.list({ tenantId, agentId });
    if (!pins.some((pin) => sameScope(pin.scope, req.scope))) {
      const from = pinned === null ? 'as the latest version' : 'from a pin above it';
      return {
        kind: 'ok',
        result: {
          checks: [
            {
              name: 'pinInPlace',
              passed: true,
              message: `${agentId} ${servingVersion} already serves this scope (${from}), so pinning it here changes nothing for runs: the gate's checks and approval don't apply.`,
            },
          ],
          passed: true,
        },
        servingVersion,
        pinInPlace: true,
      };
    }
  }

  let summary: CorrectedComparisonSummary | null = null;
  if (req.testRunId !== undefined) {
    const run =
      deps.testRuns === undefined
        ? null
        : await deps.testRuns.get({ tenantId, testRunId: req.testRunId as RunId });
    if (run === null) return err('test-run-not-found', `No test run ${req.testRunId}`);
    summary = summaryOf(run);
    if (summary === null) {
      return err(
        'bad-input',
        `Test run ${req.testRunId} isn't a finished comparison: it has no comparison summary`,
      );
    }
  }
  let summaryProjectOrgId: string | undefined;
  const correctedIn = summary?.scope.projectId;
  if (req.scope.kind === 'org' && correctedIn !== undefined && deps.projects !== undefined) {
    const project = await deps.projects.get(tenantId, correctedIn as ProjectId);
    summaryProjectOrgId = project?.orgId as unknown as string | undefined;
  }
  const result = evaluateGate({
    spec: releaseGate.spec,
    pin: {
      agentId,
      version: req.version as unknown as string,
      pinsDigest: candidate.pinsDigest ?? null,
      scope: req.scope,
    },
    summary,
    servingVersion,
    ...(summaryProjectOrgId !== undefined && { summaryProjectOrgId }),
    now: new Date(),
  });
  return { kind: 'ok', result, servingVersion };
}

/** Who asked, from the request's principal. */
export function actorOf(c: Ctx): PinActor {
  const actor = c.get('principal')?.actor;
  if (actor === undefined) return { kind: 'service', id: 'unknown' };
  return { kind: actor.kind === 'user' ? 'user' : 'service', id: actor.id };
}

/** `?scopeKind=tenant|org|project|segment&scopeId=…&segment=key:value` for the history filter. */
export function scopeFromQuery(
  query: (name: string) => string | undefined,
  segmentValues: readonly string[],
): { kind: 'ok'; scope?: AgentPinScope } | { kind: 'err'; message: string } {
  const kind = query('scopeKind');
  const id = query('scopeId');
  if (kind === undefined || kind === '') {
    return id === undefined
      ? { kind: 'ok' }
      : { kind: 'err', message: '`scopeId` needs `scopeKind`' };
  }
  if (kind === 'tenant') return { kind: 'ok', scope: { kind: 'tenant' } };
  if (id === undefined || !UUID_RE.test(id)) {
    return { kind: 'err', message: '`scopeId` must be an org or project id (a UUID)' };
  }
  if (kind === 'org') return { kind: 'ok', scope: { kind: 'org', orgId: id as OrgId } };
  if (kind === 'project')
    return { kind: 'ok', scope: { kind: 'project', projectId: id as ProjectId } };
  if (kind === 'segment') {
    const path = parseSegmentsQuery(segmentValues);
    if (path.kind === 'err') return path;
    if (path.segments === undefined)
      return { kind: 'err', message: 'A segment scope needs `segment`' };
    return {
      kind: 'ok',
      scope: { kind: 'segment', projectId: id as ProjectId, path: path.segments },
    };
  }
  return { kind: 'err', message: '`scopeKind` must be one of tenant, org, project, segment' };
}

export function serializePin(p: Pin): Record<string, unknown> {
  return {
    id: p.id,
    agentId: p.agentId,
    scope: agentPinScopeToWire(p.scope),
    action: p.action,
    fromVersion: p.fromVersion as unknown as string | null,
    toVersion: p.toVersion as unknown as string | null,
    requestedBy: p.requestedBy,
    ...(p.reason !== undefined && { reason: p.reason }),
    ...(p.testRunId !== undefined && { testRunId: p.testRunId }),
    createdAt: p.createdAt as unknown as string,
    ...(p.status !== undefined && { status: p.status }),
    ...(p.releaseGate !== undefined && { releaseGate: p.releaseGate }),
    ...(p.checks !== undefined && { checks: p.checks }),
    ...(p.approvalId !== undefined && { approvalId: p.approvalId }),
    ...(p.resolvedAt !== undefined && { resolvedAt: p.resolvedAt as unknown as string }),
  };
}
