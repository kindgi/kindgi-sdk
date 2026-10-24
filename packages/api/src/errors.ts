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
  // A flow, agent, trigger or run names an item its project doesn't reach (`reference-scope.ts`).
  'reference-out-of-scope': 400,
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
  // A request signed in by the session cookie, from an origin the
  // deployment doesn't allow (or with no Origin): cross-site request
  // forgery protection for browser sessions.
  'csrf-origin-mismatch': 403,
  // `POST /v1/auth/token-sign-in` on a deployment that doesn't allow
  // signing in to the console with an API token.
  'token-sign-in-off': 403,
  // `POST /v1/auth/token-sign-in` with a key that can't open a console
  // session: a service account's, or a narrowed one (a `member` role or one
  // project), which a session would widen to the person's full grants.
  'token-sign-in-not-allowed': 403,
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
  'fact-changed': 409,
  'legal-hold': 409,
  'erasure-in-progress': 409,
  'run-already-terminal': 409,
  'run-lease-lost': 409,
  'idempotency-key-body-mismatch': 409,
  'idempotency-key-in-flight': 409,
  'idempotency-key-replay-withheld': 409,
  'hitl-required': 409,
  'duplicate-node-id': 409,
  'duplicate-edge-id': 409,
  'agent-version-mismatch': 409,
  'agent-already-registered': 409,
  'agent-project-mismatch': 409,
  'registry-read-only': 409,
  'live-scope-spans-environments': 409,
  'agent-gone': 410,
  'run-erased': 410,
  'flow-gone': 410,
  'policy-gone': 410,
  'eval-suite-gone': 410,
  'tool-gone': 410,
  'tool-already-registered': 409,
  'tool-project-mismatch': 409,
  // A tool's active versions are all one kind: an MCP endpoint's, or published here.
  'tool-kind-mismatch': 409,
  'guardrail-already-registered': 409,
  // A deploy's guardrail id is live in another project: a deploy never takes it.
  'guardrail-project-mismatch': 409,
  'guardrail-config-invalid': 422,
  'flow-already-registered': 409,
  'flow-project-mismatch': 409,
  'conversation-closed': 409,
  // A turn names a project other than its conversation's: a conversation belongs to one.
  'conversation-project-mismatch': 409,
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
  /** No registered provider satisfies the agent's capability declaration (`needs`). */
  'capability-unsatisfiable': 422,
  /** A tool the agent names has no version satisfying its range (or the pinned one is gone). */
  'tool-version-unresolvable': 422,
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
  /** Memory was asked to search by meaning, and no embedding model is configured. */
  'semantic-unavailable': 422,
  // 429 — a limit over a time window: the sign-in lookups' and a webhook
  // trigger's, a budget kept per tenant (a refused publish, an agent
  // turn's work), or a rate limiter in front of the routes. With
  // `Retry-After`.
  'rate-limit-exceeded': 429,
  // A gate asked for an approval past the tenant's limit on approvals waiting.
  'approvals-pending-limit': 429,
  // An invitation renewed again too soon for one person, or past the
  // invitation emails the workspace, or the deployment, may send in 24
  // hours. With `Retry-After`.
  'invite-capped': 429,
  // An agent turn's memory, charged by size, is past the tenant's share or
  // the runtime's whole (a runtime's limit, as Kindgi Cloud sets). No
  // `Retry-After`: there's no honest time to give.
  'turn-memory-limit-reached': 429,
  // 500 — server
  'internal-server-error': 500,
  'journal-error': 500,
  stuck: 500,
  // 503 — the database, on any GET or HEAD. With `Retry-After`.
  /**
   * A GET or HEAD the database was too busy to answer in time: a lock or
   * statement timeout, or no free connection within the pool's wait. Any
   * other method answers 500 (`mapThrownError`).
   */
  'database-busy': 503,
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
  // Improvement proposals.
  'proposal-not-found': 404,
  'proposal-invalid-state-transition': 409,
  // Evaluating would make a version that serves every unpinned scope.
  'proposal-needs-pin': 409,
  // Improvement passes.
  'improve-unsupported': 501,
  'improvement-pass-not-found': 404,
  'improvement-pass-finished': 409,
  'version-already-exists': 409,
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
  'provider-config-invalid': 422,
  // Admin plane — cost readback.
  'cost-record-not-found': 404,
  // Admin plane — adapters.
  'adapter-not-found': 404,
  // Admin plane — policies.
  'policy-not-found': 404,
  'policy-already-registered': 409,
  'policy-scope-taken': 409,
  'policy-scope-changed': 409,
  /** A retention policy that keeps its domain's rows longer than the server's limit allows (`retentionLimits`), or holds them. */
  'retention-over-limit': 400,
  // Admin plane — eval suites.
  'block-not-found': 404,
  'block-already-registered': 409,
  'block-project-mismatch': 409,
  'eval-suite-not-found': 404,
  'eval-suite-already-registered': 409,
  'eval-suite-project-mismatch': 409,
  // Admin plane — eval-run dispatch.
  'eval-run-not-found': 404,
  'eval-run-not-rescorable': 409,
  // Judgments (yes/no on a run's output items) and judge classes.
  'judgment-not-found': 404,
  'judge-class-not-found': 404,
  /** A judging rule that isn't in the project (`/v1/projects/:projectId/judging-rules/:ruleId`). */
  'judging-rule-not-found': 404,
  /** A run that isn't in the project's judging queue. */
  'judging-item-not-found': 404,
  /** Dismissing a queued run that isn't open, or reopening one that wasn't dismissed. */
  'judging-item-not-open': 409,
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
  // API keys: whom a key acts for, and what it may do.
  /** Mint: the person or service account named doesn't exist. */
  'principal-not-found': 404,
  /** Mint: an `admin` key for a principal that isn't a tenant admin. */
  'role-exceeds-principal': 403,
  /** A key limited to one project, on a request that names another. */
  'key-project-mismatch': 403,
  /** A turn run as a participant whose memory the caller may not read (not themselves, and no `write` on the turn's project). */
  'participant-not-allowed': 403,
  /** Mint: a key that would outlive the key minting it (a later or absent `expiresAt`). */
  'token-expiry-exceeds-minter': 403,
  /** Mint: a capability a tenant's key can't carry (`system:*`; `kindgi:system` on a runtime serving many tenants). */
  'capability-not-mintable': 403,
  /** A system key (it acts in no tenant) on a route outside `/v1/system/*`. */
  'system-key-on-tenant-route': 403,
  /** A system route called with a tenant's key or session. */
  'system-principal-required': 403,
  /** A system key without the scope the system route takes (`details.scope`). */
  'system-scope-missing': 403,
  /** Serving one tenant: a system key holding more than `system:license` (`details.scopes`), refused on every route. */
  'system-key-scope-not-served': 403,
  /** No system key with that id. */
  'system-key-not-found': 404,
  /** A full system key minted by another system key, with no `expiresAt`: only the deployment's own token mints one that never expires. */
  'system-key-expiry-required': 403,
  /** The operator's access record can't be written, so a system request that would change something was not acted on. */
  'access-record-unavailable': 503,
  /**
   * A pack service's secret values, not given just now: the secret store is
   * out, a secret changed while it was read (twice), or their audit rows
   * weren't written. No `Retry-After`: the orchestrator's back-off decides.
   */
  'pack-env-unavailable': 503,
  /** A system route naming a tenant in a state it refuses. */
  'tenant-closing': 409,
  'tenant-suspended': 409,
  /** A purge's `confirm` that isn't the tenant's slug: nothing was changed. */
  'tenant-slug-mismatch': 400,
  /** A purge of a tenant that isn't closing (`details.state`). */
  'tenant-not-closing': 409,
  /** A purge of a closing tenant whose export window is still open (`details.windowEndsAt`). */
  'tenant-export-window-open': 409,
  /** A purge on a runtime with nowhere set to keep purge records, so a restore couldn't purge it again. */
  'purge-record-unset': 409,
  /** A purge of a tenant holding what a setting the runtime lacks reaches (its artifacts' bytes, its authorization store). */
  'purge-setting-missing': 409,
  /** A purge's delete of the tenant's authorization store failed; the message says what that left. */
  'authz-store-delete-failed': 502,
  /** A runtime whose tenants binding doesn't purge. */
  'tenant-purge-unsupported': 501,
  /** A deployment, eval run or improvement pass whose project, or pack, is suspended. */
  'project-suspended': 409,
  'pack-suspended': 409,
  /** A deployment's endpoint refused: its URL isn't `https://<host>`, with no user info or path. */
  'endpoint-url-invalid': 400,
  /** A deployment's endpoint refused: its host isn't on the operator's allowlist. */
  'endpoint-host-not-allowed': 422,
  /** A deployment's endpoint refused: its host doesn't name the deployment's own pack service. */
  'endpoint-name-mismatch': 422,
  /** A deployment's endpoint refused: the pack service didn't answer `/v1/info`. */
  'endpoint-unreachable': 422,
  /** A deployment's endpoint refused: the pack service answered as another pack or version. */
  'endpoint-info-mismatch': 422,
  /** A problem recorded for a deployment whose endpoint isn't pending. */
  'endpoint-not-pending': 409,
  /** What a pack service runs, recorded for a deployment whose endpoint isn't ready. */
  'endpoint-not-ready': 409,
  /** A retired deployment's pack env asked for: it isn't given out. */
  'endpoint-retired': 409,
  /** What a pack service runs, recorded over another revision recorded since. */
  'pack-env-conflict': 409,
  /** Creating or renaming a tenant with a slug another tenant has. */
  'tenant-slug-taken': 409,
  /**
   * Renaming a tenant's slug while the deployment's verified sign-in
   * domains name its current slug, or name the new one.
   */
  'tenant-slug-in-config': 409,
  /** Renaming a tenant whose setup hasn't finished. */
  'tenant-setup-pending': 409,
  /** A deployment's image outside its tenant's repository (`details.imagePrefix`, the tenant's own). */
  'image-not-allowed': 409,
  /** A deployment on a runtime serving many tenants, by a tenant with no image repository set. */
  'image-prefix-unset': 409,
  /** An image prefix that equals, holds or sits inside another tenant's. */
  'image-prefix-taken': 409,
  /** The tenant's state can't be read, so a write is refused (`Retry-After`). */
  'tenant-state-unavailable': 503,
  'service-account-not-found': 404,
  /** An active service account of the tenant already has the name. */
  'service-account-name-taken': 409,
  /** A grant for an unregistered service account. */
  'service-account-unregistered': 409,
  /** Adding a person with an email another person of the tenant has. */
  'identity-user-email-taken': 409,
  /** Removing tenant admin from the only person who holds it: the tenant would have none. */
  'last-tenant-admin': 409,
  /** Removing tenant admin from the seed user, whom the runtime re-grants it at every boot. */
  'seed-user-admin': 409,
  /** Unregistering yourself, or the deployment's seed user (`details.reason`). */
  'identity-user-unregister-refused': 409,
  /** A grant or a key for a person who was unregistered. */
  'identity-user-unregistered': 409,
  /**
   * Renewing the invitation of a person who has joined, was added before
   * invitations, or has no email to send one to.
   */
  'identity-user-not-invited': 409,
  /** A person's grants on a runtime without an authorization store. */
  'person-grants-unsupported': 501,
  /** A caller's permissions on a runtime without an authorization store (`GET /v1/identity/me/permissions`). */
  'permissions-unsupported': 501,
  /** Unregister: the version is live in a scope; move that pin first. */
  'agent-version-live': 409,
  /** An artifact upload over the runtime's cap (`KINDGI_ARTIFACT_MAX_BYTES`). */
  'artifact-too-large': 413,
  /** A request body over the API's limit (`requestMaxBytes`); `details.maxBytes` says how much. */
  'request-too-large': 413,
  'run-not-finished': 409,
  'item-not-found': 400,
  // The judgment binding can't list judged runs, so no test sets from judgments.
  'test-sets-not-supported': 501,
  'run-failures-not-supported': 501,
  'memory-operation-unsupported': 501,
  // The conversation binding can't unregister (a runtime built before it).
  'conversation-unregister-unsupported': 501,
  // Authorization is enforced, but a membership change can't be kept in step with it.
  'authz-membership-unsupported': 501,
  // The guardrail registry keeps no outcome ledger.
  'guardrail-outcomes-not-supported': 501,
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
  // The deployment couldn't use a provider's configuration (its issuer's
  // discovery failed, its SAML metadata didn't parse, a host it may not
  // reach): 422 with what went wrong.
  'identity-provider-invalid': 422,
  // The operator manages sign-in (KINDGI_AUTH_TENANT_PROVIDERS=off): a
  // change to a provider takes the deployment's own token.
  'identity-providers-operator-managed': 403,
  // The deployment has no secrets store (KINDGI_SECRETS_BACKEND), which a
  // provider's client secret and keys are references into: adding or
  // changing a provider waits until it has one.
  'identity-providers-need-secrets-store': 409,
  // `GET /v1/license` or `GET /v1/license/usage` by anyone but the
  // deployment's own token or a system key holding `system:license`, save a
  // sole tenant's admins reading the license's countdown.
  'license-operator-only': 403,
  'invalid-provider-config': 400,
  'auth-not-session-token': 400,
  // A second factor (`/v1/identity/me/second-factor*`, token sign-in):
  // the tenant requires one (token sign-in can't give it; taking yours
  // off); a code that isn't right; too many wrong ones lately (with
  // `Retry-After`); a key that can't be opened any more (a recovery code
  // still works); requiring one from a session made without one; none set
  // up; no new key to confirm.
  'second-factor-required': 403,
  'second-factor-invalid': 403,
  'second-factor-locked': 429,
  'second-factor-unusable': 403,
  'second-factor-enroll-first': 409,
  'second-factor-not-set-up': 409,
  'second-factor-not-started': 409,
  // `POST /v1/auth/refresh` with a browser session (cookie): refused, so a
  // fresh session token never reaches page scripts.
  'cookie-session-not-refreshable': 400,
  // `POST /v1/auth/refresh` with a session limited to a project or a role:
  // refused, so no copy of it can come back without its limits.
  'limited-session-not-refreshable': 400,
  // `POST /v1/tokens` by a session limited to a project or a role: a key
  // would outlive whatever ends the session.
  'limited-session-cannot-mint': 403,
  // Sites that sign their own people in to one project (`SiteBinding`).
  'site-not-found': 404,
  'site-invalid': 400,
  // `POST /v1/auth/sites/enroll`: a wrong, used or expired code, or a
  // paused or unregistered site, all alike.
  'site-enrollment-refused': 401,
  'site-key-invalid': 400,
  // `POST /v1/auth/site-sign-in`: a statement refused; `details.reason` says why.
  'site-sign-in-refused': 401,
  'site-request-too-large': 413,
  // A grant, membership or reviewer role given to a person a site signs in:
  // they hold only what their site's sign-in writes.
  'site-person-grants-managed': 403,
  // `POST …/sites/:siteId/people/:userId/restore`: the site has no link to
  // that person, live or retired.
  'site-person-not-found': 404,
  // The restore refused, with nothing changed; `details.reason` says why.
  'site-person-restore-refused': 409,
  // `POST /v1/auth/token-sign-in` signed in by a session (a cookie or a
  // session token) rather than an API token: there's nothing to exchange.
  'token-sign-in-needs-an-api-token': 400,
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
  /** Putting a project in production while the tenant isn't allowed to (the production gate; `details.next`). */
  'production-not-allowed': 403,
  /** Putting a project in production while the tenant's projects in production are at its limit (`details.limit`, `projectsInProduction`, `inProduction`). */
  'production-limit-reached': 403,
  /** The production route on a runtime whose project binding can't set it. */
  'production-unsupported': 501,
  'team-membership-not-found': 404,
  'project-membership-not-found': 404,
  // Re-adding a member with another role: the role they hold is kept.
  'membership-exists': 409,
  // A team's role on a project.
  'team-grant-not-found': 404,
  'team-grant-exists': 409,
  // Who has access to a project: a runtime without an authorization store can't say.
  'project-access-unsupported': 501,
  // The tenant's env names, from a runtime whose env or secret store can't list them.
  'environments-unsupported': 501,
  // A pack service's declared env, from a server that doesn't give it one:
  // the system routes (`pack-env-unsupported`), and a deployment's names
  // (`pack-env-not-served`), where its pack services take it from how they're run.
  'pack-env-unsupported': 501,
  'pack-env-not-served': 501,
  /** Secret values asked for from a server with nowhere to audit them: none is read or given. */
  'pack-env-secrets-unaudited': 501,
  // A project named in `PUT /v1/environment-orders/*` already belongs to another order.
  'project-in-another-order': 409,
  // A build, a publish or a derived version aimed at a later environment of
  // an order: a later environment takes builds by promotion only.
  'environment-takes-promotions': 409,
  // Deleting or moving (to another parent) a project that is a member of an environment order.
  'project-in-environment-order': 409,
  // Deleting an org that is the parent of an environment order; a tenant admin clears the order first.
  'org-has-environment-order': 409,
  // A promotion to a project that isn't the next environment of the
  // deployment's order (`details.nextProjectId` when the caller reads it).
  'promotion-not-next-environment': 409,
  // A promotion whose build needs values the target environment doesn't
  // have ready, each in `details.values`.
  'promotion-values-not-ready': 409,
  // A promotion from a deployment that no longer serves its environment, or
  // onto a copy in the target that doesn't: newer deployments serve its
  // tool versions (`details.newerDeploymentId`).
  'deployment-superseded': 409,
  // A runtime whose deployment ledger can't promote.
  'promotions-unsupported': 501,
  // A model provider's key is used by its provider only: named by a tool or
  // an endpoint (400), or registered for a provider while one uses it (409).
  'provider-key-refused': 400,
  'provider-key-in-use': 409,
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
  // A runtime that refuses other envs keeps every value under the one it
  // serves: a value or a reference under another would never be read.
  'env-not-served': 409,
  'env-cross-scope': 400,
  'reserved-name-prefix': 400,
  /** A name the secrets store can't write (the dev store's env-file keys); the message says its rule. */
  'secret-name-invalid': 400,
  'secret-value-too-large': 400,
  /** A value the secrets store can't hold as given (the dev store's env files); the message says why. */
  'secret-value-invalid': 400,
  'secret-write-conflict': 409,
  'env-write-conflict': 409,
  'secret-encryption-failed': 500,
  'secret-decryption-failed': 500,
  'secret-provider-unavailable': 503,
  'secret-provider-unauthorized': 502,
  'secret-provider-rate-limited': 429,
  'secret-store-error': 500,
  /** The secret store doesn't do this by design (the dev store's rotate and revoke). */
  'secret-operation-unsupported': 501,
  'env-store-error': 500,
  // Trigger HTTP surface.
  'trigger-not-found': 404,
  'trigger-invalid-config': 400,
  'trigger-webhook-id-conflict': 409,
  'trigger-already-in-state': 409,
  'trigger-register-failed': 500,
  'trigger-update-failed': 500,
  'trigger-lifecycle-failed': 500,
  /** The deployment's trigger registry can't do this yet (fire history, run-now, a new owner). */
  'trigger-operation-unsupported': 501,
  // The inbound receiver (`POST /v1/hooks/…`): one answer for any request
  // that doesn't prove its sender, whatever the reason (recorded, not said).
  'webhook-refused': 401,
  'webhook-gone': 410,
  'webhook-body-too-large': 413,
  'webhook-body-not-json': 400,
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

/** A wait as `Retry-After`'s whole seconds: rounded up, at least one. */
export function retryAfterSeconds(waitMs: number): number {
  return Math.max(Math.ceil(waitMs / 1000), 1);
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
