// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';
import type { Context } from 'hono';

import { AGENT_GATE_SUBJECTS, TOOL_CALL_GATE_SUBJECT } from '@kindgi/agents';
import type { ConversationBinding, GateDecisionValue } from '@kindgi/agents';
import type { AuditEventBinding } from '@kindgi/audit-events';
import { REVIEWER_ROLE_RANK, type ResourceRef, type ReviewerRole, ref } from '@kindgi/authz';
import type { ExportSigningBinding } from '@kindgi/crypto';
import type { RunBinding } from '@kindgi/runtime';
import type {
  ApprovalId,
  ConversationId,
  Cursor,
  ReviewerId,
  RunId,
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
import type { Authorizer } from '../middleware/authorize.js';
import type { ReviewerBinding } from '../reviewer-binding.js';
import { callerReviewerRole } from '../reviewer-role.js';
import {
  exportActor,
  parseSigningKeyId,
  readExportBody,
  signExport,
  signExportFailure,
  signingNotConfigured,
} from '../signed-export.js';
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

/** How many `waitTokenId` values a list takes, and how long each may be. */
const MAX_WAIT_TOKEN_IDS = 50;
const MAX_WAIT_TOKEN_ID_LENGTH = 512;

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

/**
 * Audit-bundle body schema version — bump when the bundle wire shape changes.
 * 2.0.0: a string like the other exports' (was the integer 1), named
 * `bundleSchemaVersion` in the body too, `exportedAt` signed once.
 */
const AUDIT_BUNDLE_SCHEMA_VERSION = '2.0.0';

export interface ApprovalsRouterOptions {
  /** Signs audit bundles. Absent: `POST /:approvalId/audit-bundle` answers `404 signing-not-configured`. */
  readonly exportSigning?: ExportSigningBinding;
  /** Records each signed export (`export-signed`). */
  readonly auditEvents?: AuditEventBinding;
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
 * Reviewer-role scoping: routes require a reviewer role — the token's
 * (`TokenResolution.reviewerRole`), or its user's in the reviewer roster
 * (`ReviewerBinding.resolveReviewerRole`). A caller with neither gets
 * `403 permission-denied` on every approvals route — this surface is
 * reviewer-only.
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
  /**
   * With one (T243 A): on top of the reviewer role, a caller sees and
   * decides only approvals whose project it may read (the approval's, or
   * its run's). Another project's approval is not found, as one above the
   * caller's tier is.
   */
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const { exportSigning, auditEvents } = options;
  const runHandler = options.runHandler;

  /** What an approval is checked on: its project, else its run's, else the tenant. */
  const approvalRef = async (tenantId: TenantId, approval: Approval): Promise<ResourceRef> => {
    if (approval.projectId !== undefined) {
      return ref('project', approval.projectId as unknown as string);
    }
    const runId = approval.provenanceRef?.runId;
    const run = runId === undefined ? null : await runBinding.getRun(tenantId, runId as never);
    return run === null
      ? ref('tenant', tenantId as unknown as string)
      : ref('project', run.projectId as unknown as string);
  };
  /** Whether the caller may read the approval's project (always, without an authorizer). */
  const mayRead = async (c: Context<AppEnv>, approval: Approval): Promise<boolean> =>
    authorizer === undefined ||
    authorizer.can(c, 'read', await approvalRef(c.get('tenantId') as TenantId, approval));

  // ---------- role gate for the whole resource ----------
  // A reviewer: a token that carries a role, or whose user the roster
  // names (a session or API key of a registered reviewer).
  r.use('*', async (c, next) => {
    const requestId = c.get('requestId');
    const role = await callerReviewerRole(c, reviewerBinding);
    if (role === undefined) {
      c.status(statusFor('permission-denied') as never);
      return c.json(
        toWireError(
          {
            code: 'permission-denied',
            message:
              "The caller isn't a reviewer: its token carries no reviewer role, and its user isn't registered as one (`kindgi reviewers register`). The approvals surface is reviewer-only.",
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

    const waitTokenIds = c.req.queries('waitTokenId') ?? [];
    if (
      waitTokenIds.length > MAX_WAIT_TOKEN_IDS ||
      waitTokenIds.some((t) => t.length === 0 || t.length > MAX_WAIT_TOKEN_ID_LENGTH)
    ) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: `\`waitTokenId\` takes at most ${MAX_WAIT_TOKEN_IDS} values, each 1–${MAX_WAIT_TOKEN_ID_LENGTH} characters`,
          },
          requestId,
        ),
      );
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
      ...(waitTokenIds.length > 0 && { waitTokenIds }),
    };
    const listed = await hitlBinding.listApprovals(listInput);
    if (listed.kind === 'err') {
      c.status(statusFor(listed.error.code) as never);
      return c.json(toWireError(listed.error as never, requestId));
    }
    const roleRank = REVIEWER_ROLE_RANK[role];
    const inTier = listed.value.approvals.filter(
      (a) => REVIEWER_ROLE_RANK[a.requiredRole] <= roleRank,
    );
    let visible = inTier;
    if (authorizer !== undefined) {
      const refs = await Promise.all(inTier.map((a) => approvalRef(tenantId, a)));
      const readable = await authorizer.filterByCan(
        c,
        'read',
        inTier.map((approval, i) => ({ approval, at: refs[i] as ResourceRef })),
        (row) => row.at,
      );
      visible = readable.map((row) => row.approval);
    }
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
    if (
      REVIEWER_ROLE_RANK[approval.requiredRole] > REVIEWER_ROLE_RANK[role] ||
      !(await mayRead(c, approval))
    ) {
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
    if (
      REVIEWER_ROLE_RANK[approval.requiredRole] > REVIEWER_ROLE_RANK[role] ||
      !(await mayRead(c, approval))
    ) {
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
    let resume: ResumeReport | undefined;
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
      //
      // The response says how the resume went (`resume`), so a decision
      // whose run couldn't go on (a tool version it started with is gone,
      // say) isn't reported as plain success.
      if (runHandler !== undefined) {
        resume = await resumeInline(runHandler, tenantId, approval.provenanceRef.runId as RunId);
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
      ...(resume !== undefined && { resume }),
    });
  });

  // ---------- POST /:approvalId/audit-bundle (signed bundle) ----------
  r.post('/:approvalId/audit-bundle', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const role = c.get('reviewerRole') as ReviewerRole;
    const approvalId = c.req.param('approvalId') as ApprovalId;

    if (exportSigning === undefined) return signingNotConfigured(c, 'signed audit bundles');

    const read = await readExportBody(c);
    const parsed = read.kind === 'ok' ? parseAuditBundleBody(read.value) : read;
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
    if (
      REVIEWER_ROLE_RANK[approval.requiredRole] > REVIEWER_ROLE_RANK[role] ||
      !(await mayRead(c, approval))
    ) {
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

    // 5. Sign the bundle body (and record the export).
    const guardrailResults = extractGuardrailResults(approval.context);
    const runId = approval.provenanceRef?.runId as unknown as string | undefined;
    const signed = await signExport({
      signer: exportSigning,
      kind: 'audit-bundle',
      bundleSchemaVersion: AUDIT_BUNDLE_SCHEMA_VERSION,
      ...(signingKeyId !== undefined && { signingKeyId }),
      body: {
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
      },
      ...(auditEvents !== undefined && {
        record: {
          auditEvents,
          tenantId,
          ...(approval.projectId !== undefined && { projectId: approval.projectId }),
          ...(runId !== undefined && { runId }),
          actor: exportActor(c),
          subject: { approvalId: approval.id as unknown as string },
        },
      }),
    });
    if (signed.kind === 'err') return signExportFailure(c, signed.error, 'export-key-error');
    return c.json({ approvalId: approvalId as unknown as string, ...signed.value });
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
  readonly signingKeyId: string | undefined;
  readonly includeMessages: boolean;
}

function parseAuditBundleBody(
  body: Record<string, unknown>,
):
  | { readonly kind: 'ok'; readonly value: ParsedAuditBundle }
  | { readonly kind: 'err'; readonly message: string } {
  const signingKeyId = parseSigningKeyId(body);
  if (signingKeyId.kind === 'err') return signingKeyId;
  let includeMessages = false;
  if ('includeMessages' in body) {
    const im = body.includeMessages;
    if (typeof im !== 'boolean') {
      return { kind: 'err', message: 'Field `includeMessages` must be a boolean when present' };
    }
    includeMessages = im;
  }
  return { kind: 'ok', value: { signingKeyId: signingKeyId.value, includeMessages } };
}

/** How the inline resume after a decision went. */
type ResumeReport =
  | { readonly kind: 'ok' }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

/**
 * Resume the run a decision released, in the same request. A resume that
 * fails is reported, not raised: the decision is durable either way, and
 * the runtime ends a run that can't go on, or resumes it later.
 */
async function resumeInline(
  runHandler: RunHandlerBinding,
  tenantId: TenantId,
  runId: RunId,
): Promise<ResumeReport> {
  try {
    const outcome = await runHandler.resumeRun({ tenantId, runId });
    return outcome.kind === 'ok'
      ? { kind: 'ok' }
      : { kind: 'failed', code: outcome.error.code, message: outcome.error.message };
  } catch (cause) {
    return {
      kind: 'failed',
      code: 'resume-failed',
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
