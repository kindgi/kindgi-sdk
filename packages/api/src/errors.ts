// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Error envelope + code→status mapping for the platform API.
 *
 * Spec: `docs/API-ROUTE-CONVENTIONS.md` §4. Every 4xx/5xx response
 * carries `{ error: { code, message, details?, requestId } }`. Codes
 * match domain error discriminants (`unresolved-tool`,
 * `guardrail-violation`, etc.) so the SDK's `fromWire()` can pattern-
 * match without inspecting HTTP status.
 */

export interface WireErrorBody {
  readonly error: WireError;
}

export interface WireError {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly requestId: string;
}

/**
 * Maps a domain error `code` to the HTTP status the route layer should
 * return. Codes not in this map fall through to `500` — the middleware
 * treats that as a bug (unmapped code) rather than a plausible domain
 * error. New codes MUST have a row here.
 */
export const ERROR_CODE_TO_STATUS: Readonly<Record<string, number>> = {
  // 400 — bad request
  'validation-failed': 400,
  'kind-not-applied': 400,
  'unknown-field': 400,
  'bad-input': 400,
  'unresolved-tool': 400,
  'unresolved-guardrail': 400,
  'schema-validation-failed': 400,
  // Platform hierarchy scope filter.
  'scope-invalid': 400,
  // 401 — auth
  'auth-missing': 401,
  'auth-expired': 401,
  'auth-revoked': 401,
  // 403
  'permission-denied': 403,
  // A deployment refuses tenant configuration that reaches its host
  // (KINDGI_TENANT_HOST_ACCESS): a stdio MCP endpoint.
  'host-access-denied': 403,
  // 404
  'not-found': 404,
  'run-not-found': 404,
  'agent-not-found': 404,
  'conversation-not-found': 404,
  'tool-not-found': 404,
  'guardrail-not-found': 404,
  'fact-not-found': 404,
  'flow-not-found': 404,
  // 409 — conflict
  'already-terminal': 409,
  'run-already-terminal': 409,
  'run-lease-lost': 409,
  'idempotency-key-body-mismatch': 409,
  'hitl-required': 409,
  'duplicate-node-id': 409,
  'duplicate-edge-id': 409,
  'agent-version-mismatch': 409,
  'agent-already-registered': 409,
  'registry-read-only': 409,
  'agent-gone': 410,
  'flow-gone': 410,
  'policy-gone': 410,
  'eval-suite-gone': 410,
  'tool-gone': 410,
  'tool-already-registered': 409,
  'guardrail-already-registered': 409,
  'flow-already-registered': 409,
  'conversation-closed': 409,
  'invalid-agent': 400,
  'invalid-tool-definition': 400,
  'invalid-schema': 400,
  'unknown-effect': 400,
  'invalid-guardrail': 400,
  // 422 — unprocessable entity
  'guardrail-violation': 422,
  'agent-turn-aborted': 422,
  'budget-exceeded': 422,
  'output-schema-violation': 422,
  'model-invocation-failed': 422,
  'tool-invocation-failed': 422,
  'capability-routing-failed': 422,
  'runtime-not-configured': 422,
  // A run the runtime can't start or resume yet: a flow with a node no
  // handler is bound for, or a run shape the host's run handler doesn't
  // support.
  'flow-unbound': 422,
  'flow-runs-not-supported': 422,
  'flow-resume-not-supported': 422,
  // `POST /v1/runs/{runId}/resume` in this release: every waitpoint
  // belongs to an approval (decided through the approvals routes, which
  // check the reviewer and record the decision) or to the runtime itself.
  'run-resume-not-supported': 422,
  // 429 — rate limit. No route in this package emits it; a rate limiter
  // in front of the routes can.
  'rate-limit-exceeded': 429,
  // 500 — server
  'internal-server-error': 500,
  'journal-error': 500,
  stuck: 500,
  // Waitpoint domain: "no pending token" or "already resolved" are
  // 409-shaped (a caller conflict with the run's current state).
  'waitpoint-error': 409,
  // HITL (approvals + reviewers).
  'approval-not-found': 404,
  'reviewer-not-found': 404,
  'reviewer-deactivated': 409,
  'insufficient-role': 403,
  'approval-terminal': 409,
  'approval-already-decided': 409,
  'invalid-transition': 409,
  'audit-bundle-not-found': 404,
  'approval-not-decided': 409,
  'export-key-error': 500,
  'persistence-error': 500,
  // Supervisor observations query — same discriminants.
  'observation-not-found': 404,
  // Provenance routes.
  'provenance-not-found': 404,
  'signing-not-configured': 404,
  'signing-key-not-found': 404,
  'signing-key-conflict': 409,
  'signing-key-revoked': 409,
  'signing-key-algorithm-unsupported': 400,
  'signing-key-store-error': 500,
  // Supervisor proposals lifecycle.
  'proposal-not-found': 404,
  'proposal-invalid-state-transition': 409,
  'proposal-terminal': 409,
  'baseline-mismatch': 422,
  'apply-change-failed': 422,
  'ground-layer-violation': 422,
  'agent-not-in-registry': 422,
  'version-already-exists': 409,
  'invalid-new-version': 400,
  'supervisor-header-missing': 400,
  // Artifacts.
  'blob-not-found': 404,
  'blob-hash-mismatch': 400,
  'blob-size-mismatch': 400,
  'blob-storage-error': 500,
  // Admin plane — capabilities + providers.
  'capability-not-found': 404,
  'provider-not-found': 404,
  'provider-already-registered': 409,
  'invalid-provider': 400,
  // Admin plane — cost readback.
  'cost-record-not-found': 404,
  // Admin plane — adapters.
  'adapter-not-found': 404,
  // Admin plane — policies.
  'policy-not-found': 404,
  'policy-already-registered': 409,
  'policy-scope-taken': 409,
  'policy-scope-changed': 409,
  // Admin plane — eval suites.
  'block-not-found': 404,
  'block-already-registered': 409,
  'block-project-mismatch': 409,
  'eval-suite-not-found': 404,
  'eval-suite-already-registered': 409,
  // Admin plane — eval-run dispatch.
  'eval-run-not-found': 404,
  // Judgments (yes/no on a run's output items) and judge classes.
  'judgment-not-found': 404,
  'judge-class-not-found': 404,
  'judge-class-name-taken': 409,
  'judge-class-not-applicable': 400,
  // The judge class is restricted (`assertableBy`), and the caller isn't one who may assert it.
  'judge-class-not-allowed': 403,
  // Live versions of agents and their promotions.
  'agent-version-not-found': 404,
  'promotion-not-found': 404,
  'nothing-to-roll-back': 409,
  'not-pinned': 409,
  // The gate (evals step 4b).
  'gate-failed': 422,
  'promotion-superseded': 409,
  // The binding can't record a gated promotion, so one a policy applies to is refused.
  'promotion-gate-unsupported': 501,
  'separate-approver-required': 403,
  'gate-policy-not-found': 404,
  'gate-policy-already-registered': 409,
  'gate-policy-scope-taken': 409,
  'gate-policy-scope-changed': 409,
  'gate-policy-scope-unpinned': 409,
  'gate-policy-needs-pin': 409,
  'gate-policy-descendant-unpinned': 409,
  /** Unregister: the version is live in a scope; move that pin first. */
  'agent-version-live': 409,
  'run-not-finished': 409,
  'item-not-found': 400,
  // The judgment binding can't list judged runs, so no test sets from judgments.
  'test-sets-not-supported': 501,
  // Authorization is enforced, but a membership change can't be kept in step with it.
  'authz-membership-unsupported': 501,
  'eval-run-already-terminal': 409,
  'dispatcher-not-registered': 422,
  'dispatcher-input-invalid': 400,
  // Interop plane — MCP endpoint registry.
  'mcp-endpoint-not-found': 404,
  'mcp-endpoint-already-registered': 409,
  'invalid-mcp-endpoint': 400,
  // Interop plane — MCP resources + prompts.
  'mcp-resource-not-found': 404,
  'mcp-prompt-not-found': 404,
  'mcp-resource-read-failed': 502,
  'mcp-prompt-get-failed': 502,
  // Auth surface — OAuth + sessions.
  'session-not-found': 404,
  'session-revoked': 409,
  // NOTE: `session-expired` is a middleware-tier auth failure (401) —
  // the token authenticated but the session's absolute TTL has elapsed.
  // Distinct from `auth-expired` (bearer-token expiry) so callers can
  // tell static bearer-token expiry from session TTL.
  'session-expired': 401,
  'session-inactive': 401,
  'identity-provider-not-found': 404,
  'identity-provider-already-registered': 409,
  'oauth-state-invalid': 400,
  'oauth-code-exchange-failed': 422,
  'oauth-refresh-failed': 422,
  'oauth-refresh-not-supported': 422,
  'invalid-provider-config': 400,
  'auth-not-session-token': 400,
  // OAuth redirect URIs + refresh.
  'redirect-uri-not-allowed': 400,
  'redirect-uri-mismatch': 400,
  'refresh-token-invalid': 401,
  // Admin plane — identity directory.
  'identity-user-not-found': 404,
  'identity-revoke-failed': 500,
  // Signed deployments.
  'signature-invalid': 400,
  'signer-not-trusted': 403,
  'image-unverifiable': 400,
  'deployment-validation-failed': 400,
  'deployment-not-found': 404,
  // Compliance routes.
  'compliance-evidence-not-found': 404,
  'compliance-export-failed': 500,
  // Platform hierarchy.
  'org-not-found': 404,
  'team-not-found': 404,
  'project-not-found': 404,
  'team-membership-not-found': 404,
  'project-membership-not-found': 404,
  // A slug another org, team or project in the tenant already has; a
  // second Default project.
  'slug-conflict': 409,
  'project-default-already-exists': 409,
  'tenant-not-found': 404,
  'tenant-config-not-found': 404,
  'tenant-config-revision-conflict': 409,
  'authz-denied': 403,
  'authz-backend-unavailable': 503,
  // A tenant policy an agent turn must apply couldn't be (its store
  // failed, or a stored spec is invalid): the turn fails closed.
  'tenant-policy-unavailable': 503,
  // Env + Secrets.
  'env-not-found': 404,
  'secret-not-found': 404,
  'secret-revoked': 404,
  'secret-version-not-found': 404,
  'scope-kind-required': 400,
  'scope-mismatch': 400,
  'env-name-required': 400,
  'env-name-mismatch': 400,
  'env-cross-scope': 400,
  'reserved-name-prefix': 400,
  'secret-value-too-large': 400,
  'secret-write-conflict': 409,
  'env-write-conflict': 409,
  'secret-encryption-failed': 500,
  'secret-decryption-failed': 500,
  'secret-provider-unavailable': 503,
  'secret-provider-unauthorized': 502,
  'secret-provider-rate-limited': 429,
  'secret-store-error': 500,
  'env-store-error': 500,
  // Trigger HTTP surface.
  'trigger-not-found': 404,
  'trigger-invalid-config': 400,
  'trigger-webhook-id-conflict': 409,
  'trigger-already-in-state': 409,
  'trigger-register-failed': 500,
  'trigger-update-failed': 500,
  'trigger-lifecycle-failed': 500,
  'webhook-signature-invalid': 401,
  'webhook-inactive': 410,
  'webhook-secret-missing': 500,
  'webhook-flow-not-found': 502,
  // Outbound webhook endpoints.
  'webhook-endpoint-not-found': 404,
  'webhook-delivery-not-found': 404,
  'webhook-url-refused': 400,
  'webhook-secret-not-found': 400,
  'webhook-secret-too-weak': 400,
  // Public run tokens.
  'token-mint-failed': 500,
} as const;

/**
 * Look up the HTTP status for a domain error code. Unmapped codes
 * return `500` — the caller should log a warning; this indicates a
 * mapping-table gap.
 */
export function statusFor(code: string): number {
  return ERROR_CODE_TO_STATUS[code] ?? 500;
}

/** Build a wire error body from a domain error + requestId. */
export function toWireError(
  err: { readonly code: string; readonly message: string } & Readonly<Record<string, unknown>>,
  requestId: string,
): WireErrorBody {
  const { code, message, ...rest } = err as unknown as Record<string, unknown>;
  const detailKeys = Object.keys(rest).filter((k) => k !== 'cause');
  const details =
    detailKeys.length > 0 ? Object.fromEntries(detailKeys.map((k) => [k, rest[k]])) : undefined;
  return {
    error: {
      code: String(code),
      message: String(message),
      ...(details !== undefined && { details }),
      requestId,
    },
  };
}
