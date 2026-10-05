// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import { AGENT_GATE_SUBJECTS, TOOL_CALL_GATE_SUBJECT } from '@kindgi/agents';
import type { ConversationBinding, GateDecisionValue } from '@kindgi/agents';
import { REVIEWER_ROLE_RANK, type ReviewerRole } from '@kindgi/authz';
import { serializePublicKeyPem, signEd25519 } from '@kindgi/crypto';
import type { SigningKeyBinding } from '@kindgi/crypto';
import type { RunBinding } from '@kindgi/runtime';
import { canonicalize } from '@kindgi/schema';
import type {
  ApprovalId,
  ConversationId,
  Cursor,
  ReviewerId,
  RunId,
  SigningKeyId,
  TenantId,
  Timestamp,
  UserId,
} from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { RunHandlerBinding } from '../handler-binding.js';
import type {
  Approval,
  ApprovalStatus,
  HitlBinding,
  ReviewDecisionKind,
  ReviewDecisionRecord,
} from '../hitl-binding.js';
import type { ReviewerBinding } from '../reviewer-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { parseListScope } from './scope-params.js';

const APPROVAL_STATUSES: ReadonlySet<ApprovalStatus> = new Set([
  'pending',
  'assigned',
  'in_review',
  'approved',
  'rejected',
  'escalated',
  'expired',
  'withdrawn',
]);

const DECISION_KINDS: ReadonlySet<ReviewDecisionKind> = new Set([
  'approve',
  'reject',
  'escalate',
  'withdraw',
]);

const ROLE_VALUES: ReadonlySet<ReviewerRole> = new Set(['standard', 'senior', 'admin']);

/**
 * Terminal approval statuses — the ones an audit bundle can be exported for.
 * An `expired` approval has no recorded decision.
 */
const DECIDED_STATUSES: ReadonlySet<ApprovalStatus> = new Set([
  'approved',
  'rejected',
  'escalated',
  'expired',
  'withdrawn',
]);

/** Audit-bundle body schema version — bump when the bundle wire shape changes. */
const AUDIT_BUNDLE_SCHEMA_VERSION = 1;

export interface ApprovalsRouterOptions {
  readonly signingKey?: SigningKeyBinding;
  /**
   * When supplied, the POST /:approvalId/complete handler
   * invokes `runHandler.resumeRun(runId)` INLINE after `completeToken`
   * succeeds — the reviewer's HTTP response reflects the resumed run's
   * new terminal (or re-suspended) state. Absent = the route does
   * `completeToken` only; something else (a background job in the
   * deployment, or a later `POST /v1/runs/:runId/resume`) must drive
   * the resume.
   */
  readonly runHandler?: RunHandlerBinding;
}

/**
 * Approvals resource routes.
 *
 * Reviewer-role scoping: routes require `c.get('reviewerRole')` to be
 * set by the auth middleware (see `TokenResolution.reviewerRole`).
 * Tokens without a reviewer role get `403 permission-denied` on every
 * approvals route — this surface is reviewer-only.
 *
 * Visibility filter: a caller with role `R` sees approvals whose
 * `requiredRole` rank ≤ their rank (standard < senior < admin). The
 * scoping is applied post-fetch on the returned rows — pushing the
 * filter into the storage query would require a role-set predicate on
 * `listApprovals`.
 */
export function approvalsRouter(
  conversationBinding: ConversationBinding,
  reviewerBinding: ReviewerBinding,
  hitlBinding: HitlBinding,
  runBinding: RunBinding,
  options: ApprovalsRouterOptions = {},
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const signingKey = options.signingKey;
  const runHandler = options.runHandler;

  // ---------- role gate for the whole resource ----------
  r.use('*', async (c, next) => {
    const requestId = c.get('requestId');
    const role = c.get('reviewerRole');
    if (role === undefined) {
      c.status(statusFor('permission-denied') as never);
      return c.json(
        toWireError(
          {
            code: 'permission-denied',
            message:
              'This token was not provisioned with a reviewer role; approvals surface is reviewer-only.',
          },
          requestId,
        ),
      );
    }
    await next();
    return;
  });

  // ---------- GET / (list, cursor-paginated, role-scoped) ----------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const role = c.get('reviewerRole') as ReviewerRole;
    const limit = clampLimit(c.req.query('limit'));

    const scopeParsed = parseListScope(c.req.query(), { tenantId });
    if (scopeParsed.kind === 'err') {
      c.status(statusFor('scope-invalid') as never);
      return c.json(
        toWireError({ code: 'scope-invalid', message: scopeParsed.message }, requestId),
      );
    }

    const statusRaw = c.req.query('status');
    let statusFilter: ApprovalStatus | undefined;
    if (statusRaw !== undefined && statusRaw.length > 0) {
      if (!APPROVAL_STATUSES.has(statusRaw as ApprovalStatus)) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: `Unknown \`status\` value: ${statusRaw}` },
            requestId,
          ),
        );
      }
      statusFilter = statusRaw as ApprovalStatus;
    }

    const requiredRoleRaw = c.req.query('requiredRole');
    let requiredRoleFilter: ReviewerRole | undefined;
    if (requiredRoleRaw !== undefined && requiredRoleRaw.length > 0) {
      if (!ROLE_VALUES.has(requiredRoleRaw as ReviewerRole)) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            {
              code: 'bad-input',
              message: `Unknown \`requiredRole\` value: ${requiredRoleRaw}`,
            },
            requestId,
          ),
        );
      }
      requiredRoleFilter = requiredRoleRaw as ReviewerRole;
      // Refuse a filter that asks for a tier the caller cannot decide —
      // preserves the "reviewer never sees above their tier" guardrail
      // regardless of what the caller passes.
      if (REVIEWER_ROLE_RANK[requiredRoleFilter] > REVIEWER_ROLE_RANK[role]) {
        c.status(statusFor('permission-denied') as never);
        return c.json(
          toWireError(
            {
              code: 'permission-denied',
              message: `Role ${role} cannot query approvals scoped to ${requiredRoleFilter}.`,
            },
            requestId,
          ),
        );
      }
    }

    const createdAfterRaw = c.req.query('createdAfter');
    let createdAfterIso: string | undefined;
    if (createdAfterRaw !== undefined && createdAfterRaw.length > 0) {
      const parsed = new Date(createdAfterRaw);
      if (Number.isNaN(parsed.getTime())) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: '`createdAfter` must be an ISO date string' },
            requestId,
          ),
        );
      }
      createdAfterIso = parsed.toISOString();
    }

    const cursor = c.req.query('cursor');
    if (cursor !== undefined && cursor.length > 0) {
      const parsed = new Date(cursor);
      if (Number.isNaN(parsed.getTime())) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError({ code: 'bad-input', message: '`cursor` is malformed' }, requestId),
        );
      }
    }

    // `listApprovals` takes an ISO-timestamp cursor. Over-fetch up to 4×
    // the page size (capped at 500) so a page still fills when
    // role-scoping filters rows out; the extra rows (or the binding's
    // own cursor) also tell us `hasMore`.
    const HITL_LIMIT_CAP = Math.min(limit * 4, 500);
    const listInput = {
      tenantId,
      limit: HITL_LIMIT_CAP,
      ...(scopeParsed.scope !== undefined && { scope: scopeParsed.scope }),
      ...(statusFilter !== undefined && { status: statusFilter }),
      ...(requiredRoleFilter !== undefined && { requiredRole: requiredRoleFilter }),
      ...(createdAfterIso !== undefined && { since: createdAfterIso as unknown as Timestamp }),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
    };
    const listed = await hitlBinding.listApprovals(listInput);
    if (listed.kind === 'err') {
      c.status(statusFor(listed.error.code) as never);
      return c.json(toWireError(listed.error as never, requestId));
    }
    const roleRank = REVIEWER_ROLE_RANK[role];
    const visible = listed.value.approvals.filter(
      (a) => REVIEWER_ROLE_RANK[a.requiredRole] <= roleRank,
    );
    const page = visible.slice(0, limit);
    const hasMore = visible.length > limit || listed.value.nextCursor !== undefined;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last !== undefined ? (last.createdAt as unknown as string) : undefined;
    return c.json({
      data: page.map(serializeApproval),
      hasMore,
      ...(nextCursor !== undefined && { nextCursor }),
    });
  });

  // ---------- GET /:approvalId (role-scoped) ----------
  r.get('/:approvalId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const role = c.get('reviewerRole') as ReviewerRole;
    const approvalId = c.req.param('approvalId') as ApprovalId;

    const got = await hitlBinding.getApproval(tenantId, approvalId);
    if (got.kind === 'err') {
      c.status(statusFor(got.error.code) as never);
      return c.json(toWireError(got.error as never, requestId));
    }
    const approval = got.value;
    // Out-of-scope reads are 404 (per API-ROUTE-CONVENTIONS.md §2.4 —
    // avoid leaking existence across role tiers).
    if (REVIEWER_ROLE_RANK[approval.requiredRole] > REVIEWER_ROLE_RANK[role]) {
      c.status(statusFor('approval-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'approval-not-found',
            message: `No approval with id ${approvalId as unknown as string}`,
            approvalId: approvalId as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeApproval(approval));
  });

  // ---------- POST /:approvalId/complete ----------
  r.post('/:approvalId/complete', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const role = c.get('reviewerRole') as ReviewerRole;
    const userId = c.get('userId');
    const approvalId = c.req.param('approvalId') as ApprovalId;

    if (userId === undefined) {
      c.status(statusFor('permission-denied') as never);
      return c.json(
        toWireError(
          {
            code: 'permission-denied',
            message:
              'Token has a reviewer role but no user identity — cannot resolve reviewer for decision.',
          },
          requestId,
        ),
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    const parsed = parseCompleteBody(body);
    if (parsed.kind === 'err') {
      c.status(statusFor(parsed.error.code) as never);
      return c.json(toWireError(parsed.error, requestId));
    }

    const found = await hitlBinding.getApproval(tenantId, approvalId);
    if (found.kind === 'err') {
      c.status(statusFor(found.error.code) as never);
      return c.json(toWireError(found.error as never, requestId));
    }
    const approval = found.value;
    if (REVIEWER_ROLE_RANK[approval.requiredRole] > REVIEWER_ROLE_RANK[role]) {
      c.status(statusFor('approval-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'approval-not-found',
            message: `No approval with id ${approvalId as unknown as string}`,
            approvalId: approvalId as unknown as string,
          },
          requestId,
        ),
      );
    }

    // An agent's tool-call and session gates resume on the decision alone
    // (`readGateDecision` fails closed on anything else), so a `value`
    // can't stand in for it: refused before anything is recorded.
    if (parsed.value.value !== undefined && AGENT_GATE_SUBJECTS.has(approval.subjectKind)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: `An approval of an agent's ${approval.subjectKind === TOOL_CALL_GATE_SUBJECT ? 'tool call' : 'session'} takes a decision (approve or reject) and an optional rationale, not a \`value\`: the turn resumes on the decision alone.`,
          },
          requestId,
        ),
      );
    }

    const reviewerId = await reviewerBinding.resolveReviewer({
      tenantId,
      userId: userId as UserId,
    });
    if (reviewerId === null) {
      c.status(statusFor('permission-denied') as never);
      return c.json(
        toWireError(
          {
            code: 'permission-denied',
            message: 'No reviewer row registered for this user under this tenant.',
          },
          requestId,
        ),
      );
    }

    const submitted = await hitlBinding.submitReview({
      tenantId,
      approvalId,
      reviewerId: reviewerId as ReviewerId,
      decision: parsed.value.decision,
      ...(parsed.value.rationale !== undefined && { rationale: parsed.value.rationale }),
    });
    if (submitted.kind === 'err') {
      c.status(statusFor(submitted.error.code) as never);
      return c.json(toWireError(submitted.error as never, requestId));
    }

    // If the approval carries a waitpoint reference AND the decision is
    // a terminal accept/reject, resolve the run's waitpoint so the
    // suspended run resumes. Escalate/withdraw don't resume — the run
    // stays suspended until the new (escalated) approval terminates,
    // or the run is cancelled explicitly.
    //
    // Resume value shape: `GateDecisionValue`, `{ decided, rationale?,
    // decidedBy, approvalId }`, the shape the agent's approval gate
    // consumes; the run's journal keeps who decided which approval. For
    // another subject, the caller CAN supply an explicit `value` to
    // override it, when the resume payload must carry more than the
    // decision (an agent gate refuses one, above).
    let waitpointResolved = false;
    if (
      approval.waitTokenId !== undefined &&
      approval.provenanceRef?.runId !== undefined &&
      (parsed.value.decision === 'approve' || parsed.value.decision === 'reject')
    ) {
      const decided: GateDecisionValue = {
        decided: parsed.value.decision,
        ...(parsed.value.rationale !== undefined && { rationale: parsed.value.rationale }),
        decidedBy: `user:${userId as unknown as string}`,
        approvalId: approval.id as unknown as string,
      };
      const resumeValue = parsed.value.value !== undefined ? parsed.value.value : decided;
      const resolved = await runBinding.completeToken(
        tenantId,
        approval.provenanceRef.runId as RunId,
        approval.waitTokenId,
        resumeValue,
      );
      if (resolved.kind === 'err') {
        c.status(statusFor(resolved.error.code) as never);
        return c.json(toWireError(resolved.error as never, requestId));
      }
      waitpointResolved = true;

      // Inline resume — when a runHandler is wired,
      // drive resumeRun synchronously in the same request. The runtime
      // replays from the journal; the parked run reaches its next
      // terminal state (or re-suspends on a subsequent gate). Reviewer
      // gets the new state in the same HTTP response.
      //
      // Failure here is intentionally soft: `completeToken` already
      // journaled `wait.resumed`. The approval-complete surface reports
      // the decision as successful; a run that stayed suspended because
      // the inline resume failed can be resumed later.
      if (runHandler !== undefined) {
        try {
          await runHandler.resumeRun({
            tenantId,
            runId: approval.provenanceRef.runId as RunId,
          });
        } catch {
          // Soft-fail — the decision is durable; the run can be resumed later.
        }
      }
    }

    const result = submitted.value;
    return c.json({
      kind: result.kind,
      approval: serializeApproval(result.approval),
      decision: serializeDecision(result.decision),
      ...(result.kind === 'escalated' && {
        nextApproval: serializeApproval(result.nextApproval),
      }),
      waitpointResolved,
    });
  });

  // ---------- POST /:approvalId/audit-bundle (signed bundle) ----------
  r.post('/:approvalId/audit-bundle', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const role = c.get('reviewerRole') as ReviewerRole;
    const approvalId = c.req.param('approvalId') as ApprovalId;

    if (signingKey === undefined) {
      c.status(statusFor('signing-not-configured') as never);
      return c.json(
        toWireError(
          {
            code: 'signing-not-configured',
            message:
              'This deployment does not have a `signingKey` binding mounted; signed audit bundles are unavailable.',
          },
          requestId,
        ),
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be an object' }, requestId),
      );
    }
    const parsed = parseAuditBundleBody(body as Record<string, unknown>);
    if (parsed.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: parsed.message }, requestId));
    }
    const { signingKeyId, includeMessages } = parsed.value;

    // 1. Load the approval + enforce role scoping (404 for out-of-scope).
    const found = await hitlBinding.getApproval(tenantId, approvalId);
    if (found.kind === 'err') {
      c.status(statusFor(found.error.code) as never);
      return c.json(toWireError(found.error as never, requestId));
    }
    const approval = found.value;
    if (REVIEWER_ROLE_RANK[approval.requiredRole] > REVIEWER_ROLE_RANK[role]) {
      c.status(statusFor('approval-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'approval-not-found',
            message: `No approval with id ${approvalId as unknown as string}`,
            approvalId: approvalId as unknown as string,
          },
          requestId,
        ),
      );
    }

    // 2. Refuse to sign a bundle for a still-pending approval — bundles
    //    are only meaningful post-decision.
    if (!DECIDED_STATUSES.has(approval.status)) {
      c.status(statusFor('approval-not-decided') as never);
      return c.json(
        toWireError(
          {
            code: 'approval-not-decided',
            message: `Approval ${approvalId as unknown as string} is still ${approval.status}; audit bundles are only exportable after a terminal decision.`,
            approvalId: approvalId as unknown as string,
            status: approval.status,
          },
          requestId,
        ),
      );
    }

    // 3. Load the decision row (may be absent when the approval expired
    //    without human interaction — status 'expired'). Bundle carries
    //    `decision: null` in that case.
    const decisionQuery = await hitlBinding.loadReviewDecision(tenantId, approvalId);
    if (decisionQuery.kind === 'err') {
      c.status(statusFor('persistence-error') as never);
      return c.json(
        toWireError(
          {
            code: 'persistence-error',
            message: `Failed to load review decision: ${decisionQuery.error.message}`,
          },
          requestId,
        ),
      );
    }
    const decisionRow = decisionQuery.value;

    // 4. Optionally hydrate messages tied to the approval's run.
    let messages: readonly unknown[] | undefined;
    if (includeMessages && approval.provenanceRef?.runId !== undefined) {
      const msgResult = await conversationBinding.readMessages({
        tenantId,
        conversationId: approval.provenanceRef.runId as unknown as ConversationId,
      });
      messages = msgResult.kind === 'ok' ? msgResult.value : [];
    } else if (includeMessages) {
      messages = [];
    }

    // 5. Look up the private key material.
    const privateKey = signingKey.getPrivateKey(signingKeyId);
    if (privateKey === null) {
      c.status(statusFor('signing-key-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'signing-key-not-found',
            message: `No signing key registered with id "${signingKeyId as unknown as string}"`,
            signingKeyId: signingKeyId as unknown as string,
          },
          requestId,
        ),
      );
    }
    const publicKeyRaw = signingKey.getPublicKey(signingKeyId);
    if (publicKeyRaw === null) {
      c.status(statusFor('signing-key-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'signing-key-not-found',
            message: `Signing key "${signingKeyId as unknown as string}" resolved a private key but no public key`,
            signingKeyId: signingKeyId as unknown as string,
          },
          requestId,
        ),
      );
    }

    // 6. Build the canonical bundle body.
    const guardrailResults = extractGuardrailResults(approval.context);
    const bundleBody: Record<string, unknown> = {
      bundleVersion: AUDIT_BUNDLE_SCHEMA_VERSION,
      approvalId: approval.id as unknown as string,
      tenantId: approval.tenantId as unknown as string,
      subjectKind: approval.subjectKind,
      subjectRef: approval.subjectRef,
      requiredRole: approval.requiredRole,
      status: approval.status,
      createdAt: approval.createdAt as unknown as string,
      ...(approval.decidedAt !== undefined && {
        decidedAt: approval.decidedAt as unknown as string,
      }),
      decision:
        decisionRow !== null
          ? {
              kind: decisionRow.decision,
              reviewerId: decisionRow.reviewerId,
              reviewerRoleAtDecision: decisionRow.reviewerRoleAtDecision,
              decidedAt: decisionRow.decidedAt as unknown as string,
              ...(decisionRow.rationale !== undefined && { rationale: decisionRow.rationale }),
            }
          : null,
      evidence: {
        ...(guardrailResults !== undefined && { guardrailResults }),
        ...(messages !== undefined && { messages }),
      },
      exportedAt: new Date().toISOString(),
    };
    const canonicalBundleBytes = new TextEncoder().encode(canonicalize(bundleBody));

    // 7. Sign.
    const signResult = signEd25519(privateKey, canonicalBundleBytes);
    if (signResult.kind === 'err') {
      c.status(statusFor('export-key-error') as never);
      return c.json(
        toWireError(
          {
            code: 'export-key-error',
            message: `Failed to sign audit bundle: ${signResult.error.message}`,
          },
          requestId,
        ),
      );
    }

    return c.json({
      approvalId: approvalId as unknown as string,
      bundle: Buffer.from(canonicalBundleBytes).toString('base64'),
      bundleSchemaVersion: AUDIT_BUNDLE_SCHEMA_VERSION,
      algorithm: 'ed25519' as const,
      signingKeyId: signingKeyId as unknown as string,
      signature: Buffer.from(signResult.value).toString('base64'),
      publicKey: serializePublicKeyPem(publicKeyRaw),
      canonicalization: 'sorted-key-json' as const,
      exportedAt: new Date().toISOString() as unknown as Timestamp,
    });
  });

  return r;
}

// Extract guardrail results out of the approval's `context` envelope. HITL
// stores kind-specific context opaquely; agent-turn approvals populate
// `context.guardrailResults` when guardrail violations trigger the approval.
// Absent-or-mismatched → return undefined so the bundle omits the field.
function extractGuardrailResults(
  context: Readonly<Record<string, unknown>> | undefined,
): readonly unknown[] | undefined {
  if (context === undefined) return undefined;
  const raw = (context as Record<string, unknown>).guardrailResults;
  return Array.isArray(raw) ? (raw as readonly unknown[]) : undefined;
}

function serializeApproval(a: Approval): Record<string, unknown> {
  return {
    id: a.id,
    tenantId: a.tenantId,
    projectId: a.projectId,
    subjectKind: a.subjectKind,
    subjectRef: a.subjectRef,
    requiredRole: a.requiredRole,
    status: a.status,
    assignedTo: a.assignedTo,
    batchKey: a.batchKey,
    title: a.title,
    description: a.description,
    context: a.context,
    provenanceRef: a.provenanceRef,
    waitTokenId: a.waitTokenId,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    decidedAt: a.decidedAt,
    expiresAt: a.expiresAt,
    decision: a.decision === undefined ? undefined : serializeApprovalDecision(a.decision),
  };
}

function serializeApprovalDecision(d: ReviewDecisionRecord): Record<string, unknown> {
  return {
    decision: d.decision,
    ...(d.decidedBy !== undefined && { decidedBy: d.decidedBy }),
    reviewerId: d.reviewerId,
    reviewerRoleAtDecision: d.reviewerRoleAtDecision,
    decidedAt: d.decidedAt,
    ...(d.rationale !== undefined && { rationale: d.rationale }),
  };
}

function serializeDecision(d: {
  readonly id: string;
  readonly approvalId: unknown;
  readonly reviewerId: unknown;
  readonly decision: string;
  readonly rationale?: string;
  readonly reviewerRoleAtDecision: string;
  readonly decidedAt: string;
}): Record<string, unknown> {
  return {
    id: d.id,
    approvalId: d.approvalId,
    reviewerId: d.reviewerId,
    decision: d.decision,
    ...(d.rationale !== undefined && { rationale: d.rationale }),
    reviewerRoleAtDecision: d.reviewerRoleAtDecision,
    decidedAt: d.decidedAt,
  };
}

type ParsedComplete = {
  readonly decision: ReviewDecisionKind;
  readonly rationale?: string;
  readonly value?: unknown;
};

function parseCompleteBody(
  body: unknown,
):
  | { kind: 'ok'; value: ParsedComplete }
  | { kind: 'err'; error: { code: string; message: string } } {
  if (body === null || typeof body !== 'object') {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: 'Request body must be an object' },
    };
  }
  const b = body as Record<string, unknown>;
  const decision = b.decision;
  if (typeof decision !== 'string' || !DECISION_KINDS.has(decision as ReviewDecisionKind)) {
    return {
      kind: 'err',
      error: {
        code: 'bad-input',
        message: '`decision` must be one of: approve, reject, escalate, withdraw',
      },
    };
  }
  const rationale = b.rationale;
  if (rationale !== undefined && typeof rationale !== 'string') {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: '`rationale` must be a string when supplied' },
    };
  }
  const out: ParsedComplete = {
    decision: decision as ReviewDecisionKind,
    ...(rationale !== undefined && { rationale }),
    ...('value' in b && { value: b.value }),
  };
  return { kind: 'ok', value: out };
}

interface ParsedAuditBundle {
  readonly signingKeyId: SigningKeyId;
  readonly includeMessages: boolean;
}

function parseAuditBundleBody(
  body: Record<string, unknown>,
):
  | { readonly kind: 'ok'; readonly value: ParsedAuditBundle }
  | { readonly kind: 'err'; readonly message: string } {
  const raw = body.signingKeyId;
  if (typeof raw !== 'string' || raw.length === 0) {
    return { kind: 'err', message: 'Field `signingKeyId` must be a non-empty string' };
  }
  let includeMessages = false;
  if ('includeMessages' in body) {
    const im = body.includeMessages;
    if (typeof im !== 'boolean') {
      return { kind: 'err', message: 'Field `includeMessages` must be a boolean when present' };
    }
    includeMessages = im;
  }
  return {
    kind: 'ok',
    value: {
      signingKeyId: raw as SigningKeyId,
      includeMessages,
    },
  };
}
