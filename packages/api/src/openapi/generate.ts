// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * OpenAPI 3.1 document generator. Assembles `info` + `servers` +
 * `components` + `paths` + `tags` from the operation registry
 * (`operations.ts`) and the schema registry (`schemas.ts`).
 *
 * The output is a plain JSON-serializable object — the caller decides
 * how to expose it (route handler, static file, both).
 */

import {
  OPERATIONS,
  type OperationSpec,
  type ParameterSpec,
  type ResponseSpec,
  honoToOpenapiPath,
} from './operations.js';
import { COMPONENT_SCHEMAS, type JsonSchema } from './schemas.js';

export interface OpenApiInfo {
  readonly title?: string;
  readonly version?: string;
  readonly description?: string;
}

export interface OpenApiServer {
  readonly url: string;
  readonly description?: string;
}

export interface GenerateOptions {
  readonly info?: OpenApiInfo;
  readonly servers?: readonly OpenApiServer[];
}

const DEFAULT_INFO: Required<OpenApiInfo> = {
  title: 'Kindgi Platform API',
  version: '0.1.0',
  description:
    'REST + SSE API for Kindgi: runs, agents, flows, human-in-the-loop approvals and the admin control plane. Generated from the route and schema registrations in `@kindgi/api` and drift-checked against the mounted routes.',
};

const DEFAULT_SERVERS: readonly OpenApiServer[] = [
  { url: '/', description: 'Same-origin — path relative to the deployment root.' },
];

const TAG_DESCRIPTIONS: Readonly<Record<string, string>> = {
  system: 'Health + spec discovery.',
  runs: 'Run lifecycle (start, list, get, cancel, resume, journal, stream).',
  'export-signing-keys':
    'The public keys this deployment signs its exports with (audit bundles, provenance, compliance evidence): what a verifier pins.',
  'signing-keys':
    'The deployment trust list: the public keys whose signatures `POST /v1/deployments` accepts. Revoked keys stay readable for audit.',
  tokens:
    'API token administration (mint + revoke), and public run tokens: short-lived, read-only tokens a browser uses to follow specific runs.',
  approvals: 'Human-in-the-loop review queue (role-scoped).',
  observations: 'Supervisor readback of run outcomes.',
  agents: 'Agent catalog (list, get, publish, unregister — caller-plugged registry).',
  'gate-policies':
    'What a promotion of an agent must show before a version goes live for a scope (evals step 4b).',
  flows:
    'Flow catalog (list, get, publish, unregister — caller-plugged registry). Enables non-agent workflows via HTTP — publish once, execute many via `POST /v1/runs`.',
  tools: 'Tool catalog (list, get, register, unregister — caller-plugged registry, metadata-only).',
  guardrails:
    'Guardrail catalog (list, get, register, unregister — caller-plugged registry, metadata-only).',
  conversations: 'Durable multi-turn threads (open, list, get, close, read messages).',
  memory:
    'Fact catalog + retrieval (list, get, write, supersede, retrieve — caller-plugged binding wraps the memory subsystem).',
  proposals:
    'Supervisor fix-proposal lifecycle (draft, dry-run, submit-review, apply, rollback, withdraw — caller-plugged binding wraps the supervisor).',
  provenance:
    "Causal DAG readback + signed exports (list, get, export), signed with the deployment's export key.",
  artifacts:
    'Blob storage (list metadata, multipart upload, streaming download, HEAD, delete). Caller-plugged via `BlobStorageBinding` (from `@kindgi/blob-binding`).',
  capabilities:
    'Capability catalog (list + get) — part of the admin control plane. Read-only over HTTP. Capabilities are framework-declared (`FEATURES` enum + `@kindgi/specs/capability.schema.json`) and deployment-extended at boot time via `CapabilityRegistryBinding`; tenants do NOT author capabilities via the API.',
  providers:
    'Model-provider catalog (list, get, register, unregister, capabilities sub-resource) — part of the admin control plane. Full CRUD. `ProviderMetadata` is the wire shape; secrets never cross the wire (they live inside `ProviderRegistryBinding`). The capability router picks a best-fit provider from this set per capability requirement at run time.',
  cost: 'Cost readback (list records, get record, aggregate across a required time window) — part of the admin control plane. Read-only over HTTP; records are written by the runtime usage instrumentation (agents, tools, sandboxes). Caller-plugged via `CostBinding`. Budgets are not enforced through this surface.',
  adapters:
    'Unified adapter catalog (list, get, test) — part of the admin control plane. Covers every adapter kind the deployment wired: model providers, embedding providers, blob storage, sandbox providers, eval judges. Read-only + smoke-test-only over HTTP; adapter lifecycle (register / unregister / reconfigure) is a deployment concern — the runtime learns about adapters at `CreateAppInput` time. Caller-plugged via `AdapterRegistryBinding`. Config is REDACTED on the wire — no secrets crossing.',
  policies:
    'Tenant policy catalog (list, get, versions, publish, unregister) — part of the admin control plane. Full versioned CRUD, mirrors `flows` 1:1. Registry-only: enforcement is out of scope. `policyKind` selects the shape of `spec` — closed enum, extended additively (`access-control`, `model-routing`, `adapter-allowlist`, `rate-limit`, `retention`, `compliance`). Runtime consumers (e.g. model routing for `model-routing`, retention sweeps for `retention`) read policies from this store and apply them at their own boundary. Caller-plugged via `PolicyRegistryBinding`.',
  retention:
    "Deleted rows' retention (scheduled, sweep) — part of the admin control plane. Deleting most things is a tombstone; a `retention` policy per domain (see `policies`) sets how long tombstones stay before a sweep purges them for good. `scheduled` lists what's due and when; `sweep` purges what's past its grace. Nothing sweeps on its own: call `sweep` from a schedule. Caller-plugged via `RetentionBinding`.",
  'eval-suites':
    'Evaluation suite catalog (list, get, versions, publish, unregister) — part of the admin control plane. Full versioned CRUD, mirrors `policies` 1:1. Registry-only: eval-run execution + per-kind grader dispatch live on the `eval-runs` tag. `evalKind` selects the shape of `spec` — closed enum, extended additively (`accuracy`, `pairwise`, `regression`, `human-review`, `benchmark`, `custom`, `judged`). The cases of a `judged` suite are copies of judged runs built from judgments (`POST .../versions/from-judgments`, listed at `GET .../versions/{version}/cases`; `EvalCaseStoreBinding`). Runs against these suites are started through the `eval-runs` tag. Caller-plugged via `EvalSuiteRegistryBinding`.',
  blocks:
    "Data blocks: versioned prompts and settings an agent version pins when it's published (list, get, versions, publish, unregister, reinstate). A version never changes, nor does a block's kind; a settings block's values satisfy its schema and the latest version's. A block belongs to one project and is authorized through it: `read` on the project to read, `write` to publish, unregister or reinstate. Caller-plugged via `BlockRegistryBinding`.",
  judgments:
    "Judgments: yes or no, with an optional reason, about one item of a finished run's output, optionally recorded under a judge class (list, get, create, unregister). Each judgment keeps copies of what was judged (the run's input and output, and the item) so they outlive the run's own retention. Who judged comes from the authenticated caller, never the body; an app judging for one of its users passes that user's opaque id as `participantId`. One live judgment per run, item key, caller and participant: judging again supersedes the earlier one, which stays as history. Caller-plugged via `JudgmentRegistryBinding`.",
  judging:
    "A project's judging rules (which runs to queue for a person's judgment when they end) and the queue they fill. Rules only list runs; nothing here starts a model.",
  'judge-classes':
    'Judge classes (list, get, create, update, unregister): the deployment\'s named kinds of judge ("expert", "user", ...), each with a weight, scoped to the tenant, a project, or an agent in a project. A judgment may name a class; an unclassified judgment counts with weight 1. Caller-plugged via `JudgmentRegistryBinding`.',
  'eval-runs':
    'Eval-run data plane (start, list, get, cancel, events SSE). Dispatches an eval run against a registered suite. Dispatch is per-`EvalKind`; kinds without a registered dispatcher return `422 dispatcher-not-registered`. `result` is kind-specific opaque JSON on the wire — for `accuracy` it is `{ passCount, totalCount, meanScore, perCase[] }`. SSE events mirror run streaming: per-case progress followed by a terminal frame carrying the aggregate. Caller-plugged via `EvalRunBinding`.',
  auth: 'OIDC and SAML identity providers + session lifecycle. Layers browser-based auth on top of the static bearer-token surface: bearer tokens continue to work byte-shape-identical; session tokens use the `kgi_sk_*` prefix so the same middleware routes both flavors. Providers are caller-plugged via `IdentityProviderBinding` (no baked-in list); sign-in runs in the deployment, which reads them. Sessions persist via `SessionStoreBinding`. `clientSecretRef` is a REFERENCE — the plaintext secret never crosses the wire.',
  identity:
    'Tenant-scoped identity directory (list, get, list-active-sessions, revoke-sessions, whoami) — part of the admin control plane. Caller-plugged via `IdentityDirectoryBinding` — deployments plug in their own user store (LDAP, SCIM, or bespoke). Registry-only over HTTP: the framework does NOT own user persistence. The directory is flat; groups, roles, invitations, directory sync and impersonation are not part of this surface. `primaryEmail` may be redacted per tenant policy — the routes treat it as opaque. Provider access-token / refresh-token NEVER cross the wire, even to admins.',
  mcp: "MCP-endpoint catalog (list, get, register, unregister). Tenants declare the remote MCP servers (`stdio` / `http-sse` / `streamable-http`) they want the runtime to consume. The runtime discovers each endpoint's tools and registers them into `ToolRegistryBinding` under the same tenant — remote MCP tools become native Kindgi tools without a recompile. Secrets never cross the wire: `secretRef` names a secret in the deployment's store, resolved at the endpoint's tenant scope. A deployment refuses `stdio` endpoints unless `KINDGI_TENANT_HOST_ACCESS=local`. Caller-plugged via `MCPEndpointRegistryBinding`.",
  deployments:
    'Signed pack deployments (register, list, get). The single wire surface that lands a signed OCI image + index.json into the platform. Register runs a six-step atomic transaction: Ed25519 signature verify over the canonical `{imageDigest, artifactVersion, indexHash, tenantId, publishedAt}` envelope, tenant-scoped trust-list check via `SigningKeyRegistryBinding`, image pullability + `/app/index.json` sha256 match via `ImageRegistryBinding`, per-primitive manifest validation, registry upserts (tools + guardrails + agents + flows), append-only deployment ledger row via `DeploymentBinding`. All-or-nothing rollback on any failure; digest-based idempotency (redeploying the same image returns the existing record). Records are immutable — rollback = re-register the previous digest.',
  compliance:
    'Compliance-evidence readback + signed exports (list, get, export). Reads are a classification lens over `AuditEventBinding`; only classifier-marked `exportable` kinds appear on the wire. A signed export is signed with the export signing key of the deployment (`exportSigning`); a deployment without one answers `404 signing-not-configured`. It is the same envelope as the audit-bundle and provenance exports, so one verifier reads all three. Redaction happens when evidence is generated, not at the export boundary — records are stored already redacted.',
  audit:
    'PDP decision audit stream (list). Every route-level authz `check()` emits one `AuditEvent` (kind `authz-decision`) via the `AuditEventBinding`; this route pages through them, tenant-scoped, with `?actorSubject=` / `?onBehalfOf=` / `?action=` / `?resource=` / `?outcome=` / `?runId=` / `?from=` / `?to=` filters. Admin@tenant only. This view is a filtered projection of the tenant audit events.',
  orgs: 'Multi-tenant hierarchy — Org CRUD (list, create, get, patch, delete). Optional structural subdivision within a tenant; small tenants ignore Orgs entirely. Caller-plugged via `OrgBinding` from `@kindgi/platform`.',
  teams:
    'Multi-tenant hierarchy — Team CRUD (list, create, get, patch, delete) + `TeamMembership` sub-resource (list, add, updateRole, remove). People-groups that work together on projects; users belong to many teams. Team memberships are framework-owned (no external directory sync). Membership add is idempotent on `(teamId, userId)` — role mutation goes through PATCH.',
  projects:
    'Multi-tenant hierarchy — Project CRUD (list, create, get, patch, delete) + `/projects/default` shortcut + `ProjectMembership` sub-resource (list, add, updateRole, remove). Primary content scope: every content resource belongs to exactly one project. The Default project (`isDefault: true`) is auto-created per tenant at inception — exactly one per tenant, enforced at the storage layer.',
  tenant:
    'Sovereignty boundary readback + tenant-scoped config (get tenant; list + upsert entries routed to the env / secrets bindings). There is no `/v1/tenants` collection — the caller\'s tenant is implicit from the bearer token. `PATCH /config` routes writes to `SecretBinding` when `sensitive: true` OR `kind: "secret"`; else to `EnvBinding`. `GET /config` merges both bindings at tenant scope; secret values are ALWAYS redacted here. The `/config` sub-routes mount when at least one of `envBinding` / `secretsBinding` is wired. Prefer `/v1/env/*` + `/v1/secrets/*` for new callers.',
  env: 'Non-sensitive per-env values (`/v1/env/*`). Every route requires `envName` + `scopeKind` (+ `scopeId` for org / project); `value` is present on every read path (env is non-sensitive by definition). Writes require the `env:write` capability. Caller-plugged via `EnvBinding` (`@kindgi/env-inmemory` is an in-memory implementation for development and tests).',
  schedules:
    "Run an agent or a flow on a schedule: a cron expression in a timezone. Each occurrence is one fire, which starts one run as the schedule's owner (re-checked at every fire), through the same path as `POST /v1/runs`; a run a schedule started names it (`Run.trigger`). After a gap, `catchUp` runs once for the latest missed occurrence (or skips them), never once per missed one; `overlap` skips an occurrence while the previous run is still going. `GET …/fires` is the schedule's history; `run-now` fires it outside the schedule. Mounted when the deployment fires schedules.",
  'webhook-endpoints':
    'Outbound webhooks: endpoints the platform sends signed events to (`run.finished` when a top-level run completes, fails or is cancelled), their delivery log, redelivery and a test event. Signed in the Standard Webhooks format with a secret the endpoint references by name (`secretRef`); delivered at least once, so receivers deduplicate on `webhook-id`. Event bodies are under `webhooks`. Not to be confused with `/v1/webhooks`, which are inbound triggers. Caller-plugged via `WebhookEndpointBinding`.',
  secrets:
    'Sensitive per-env values (`/v1/secrets/*`). The ONLY endpoint that accepts plaintext is `POST /v1/secrets`; every other route is metadata-only (`value` NEVER returns on list / get / listVersions / getVersion — structural redaction). Rotation is discriminated: sync providers return 201 inline, async providers return 202 with a status URL + SSE events URL. Hard-revoke performs cryptographic erasure. Every mutating route is capability-gated (`secrets:write`, `secrets:rotate`, `secrets:revoke`, `secrets:revoke:hard`).',
};

export function generateOpenApiDocument(opts: GenerateOptions = {}): Record<string, unknown> {
  const info: OpenApiInfo = { ...DEFAULT_INFO, ...opts.info };
  const servers = opts.servers ?? DEFAULT_SERVERS;

  // What the runtime doesn't serve yet stays out, with the schemas only it uses.
  const served = OPERATIONS.filter((o) => o.unserved === undefined);
  const paths = buildPaths(served);
  const unservedOnly = schemasOnlyUnserved(OPERATIONS);
  const components = {
    schemas: Object.fromEntries(COMPONENT_SCHEMAS.filter(([name]) => !unservedOnly.has(name))),
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          "Bearer token minted via `POST /v1/tokens` (or the deployment's equivalent). See `docs/API-ROUTE-CONVENTIONS.md` §2.",
      },
      publicRunToken: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'kgi_pt',
        description:
          'Public run token (`kgi_pt_…`): short-lived and read-only, for a browser following specific runs. Returned by `POST /v1/runs` and minted by `POST /v1/tokens/public`. Accepted only by `GET /v1/runs/{runId}/progress` and its stream.',
      },
    },
  };
  const tags = uniqueTags(served).map((name) => ({
    name,
    ...(TAG_DESCRIPTIONS[name] !== undefined && { description: TAG_DESCRIPTIONS[name] }),
  }));

  return {
    openapi: '3.1.0',
    info,
    servers,
    tags,
    components,
    paths,
    webhooks: buildOutboundWebhooks(),
  };
}

/**
 * The component schemas only unserved operations reach: reachable from
 * them and not from a served operation or the outbound webhooks. A schema
 * nothing reaches (a shared type the clients use) is kept.
 */
function schemasOnlyUnserved(operations: readonly OperationSpec[]): ReadonlySet<string> {
  const byName = new Map<string, JsonSchema>(COMPONENT_SCHEMAS);
  const reach = (roots: readonly unknown[]): Set<string> => {
    const seen = new Set<string>();
    const stack: unknown[] = [...roots];
    while (stack.length > 0) {
      const x = stack.pop();
      if (Array.isArray(x)) stack.push(...x);
      else if (x !== null && typeof x === 'object') {
        const ref = (x as { $ref?: unknown }).$ref;
        if (typeof ref === 'string' && ref.startsWith('#/components/schemas/')) {
          const name = ref.slice('#/components/schemas/'.length);
          if (!seen.has(name)) {
            seen.add(name);
            stack.push(byName.get(name));
          }
        }
        stack.push(...Object.values(x));
      }
    }
    return seen;
  };
  const servedReach = reach([
    ...operations.filter((o) => o.unserved === undefined),
    buildOutboundWebhooks(),
  ]);
  const unservedReach = reach(operations.filter((o) => o.unserved !== undefined));
  return new Set([...unservedReach].filter((name) => !servedReach.has(name)));
}

/**
 * The requests the platform sends to registered webhook endpoints
 * (OpenAPI 3.1 `webhooks`): one entry per event type, all signed the same
 * way.
 */
function buildOutboundWebhooks(): Record<string, unknown> {
  const signatureHeaders = [
    {
      name: 'webhook-id',
      in: 'header',
      required: true,
      description: 'The event id; the same on every retry. Deduplicate on it.',
      schema: { type: 'string' },
    },
    {
      name: 'webhook-timestamp',
      in: 'header',
      required: true,
      description: 'Unix seconds when the request was signed. Reject requests far from your clock.',
      schema: { type: 'string', pattern: '^[0-9]+$' },
    },
    {
      name: 'webhook-signature',
      in: 'header',
      required: true,
      description:
        '`v1,<base64 HMAC-SHA256 of "{webhook-id}.{webhook-timestamp}.{body}">` under the endpoint\'s secret; space-separated when two secrets sign during a rotation.',
      schema: { type: 'string' },
    },
  ];
  const event = (type: string, summary: string, schema: string): Record<string, unknown> => ({
    post: {
      operationId: `webhook.${type}`,
      summary,
      tags: ['webhook-endpoints'],
      // The receiver authenticates the request by its signature
      // (`webhook-signature`), not by an API credential.
      security: [],
      parameters: signatureHeaders,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
      },
      responses: {
        '2XX': {
          description: 'Received. Any other answer, or none within 10 seconds, is retried.',
        },
      },
    },
  });
  return {
    'run.finished': event(
      'run.finished',
      'A top-level run completed, failed or was cancelled',
      'RunFinishedEvent',
    ),
    'improvement-pass.finished': event(
      'improvement-pass.finished',
      'An improvement pass completed, failed or was cancelled',
      'ImprovementPassFinishedEvent',
    ),
    'approval.requested': event(
      'approval.requested',
      "An approval was asked for: a reviewer's decision is waiting",
      'ApprovalRequestedEvent',
    ),
    'webhook.test': event(
      'webhook.test',
      'A test event sent on request (`POST /v1/webhook-endpoints/{endpointId}/test`)',
      'WebhookTestEvent',
    ),
  };
}

// ---------------- internals ----------------

function buildPaths(ops: readonly OperationSpec[]): Record<string, Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of ops) {
    const key = op.openapiPath ?? honoToOpenapiPath(op.honoPath);
    let bucket = paths[key];
    if (bucket === undefined) {
      bucket = {};
      paths[key] = bucket;
    }
    if (bucket[op.method] !== undefined) {
      throw new Error(`Duplicate operation for ${op.method.toUpperCase()} ${key}`);
    }
    bucket[op.method] = buildOperation(op);
  }
  return paths;
}

function buildOperation(op: OperationSpec): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    operationId: op.operationId,
    summary: op.summary,
    tags: [...op.tags],
    responses: buildResponses(op.responses),
  };
  if (op.description !== undefined) doc.description = op.description;
  if (op.parameters !== undefined && op.parameters.length > 0) {
    doc.parameters = op.parameters.map(buildParameter);
  }
  if (op.requestBody !== undefined) {
    const contentType = op.requestBody.contentType ?? 'application/json';
    const contentSlot: Record<string, unknown> = { schema: op.requestBody.schema };
    if (op.requestBody.encoding !== undefined) {
      contentSlot.encoding = op.requestBody.encoding;
    }
    doc.requestBody = {
      required: op.requestBody.required ?? true,
      ...(op.requestBody.description !== undefined && {
        description: op.requestBody.description,
      }),
      content: {
        [contentType]: contentSlot,
      },
    };
  }
  if (op.security === 'bearer') {
    doc.security = [{ bearerAuth: [] }];
  } else if (op.security === 'bearer-or-public-run') {
    doc.security = [{ bearerAuth: [] }, { publicRunToken: [] }];
  } else {
    doc.security = [];
  }
  return doc;
}

function buildParameter(p: ParameterSpec): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    name: p.name,
    in: p.in,
    schema: p.schema,
  };
  if (p.required !== undefined) doc.required = p.required;
  else if (p.in === 'path') doc.required = true;
  if (p.description !== undefined) doc.description = p.description;
  if (p.segmentPath === true) doc['x-kindgi-segment-path'] = true;
  return doc;
}

function buildResponses(
  responses: Readonly<Record<string, ResponseSpec>>,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  for (const [status, spec] of Object.entries(responses)) {
    const entry: Record<string, unknown> = { description: spec.description };
    if (spec.schema !== undefined) {
      const contentType = spec.contentType ?? 'application/json';
      entry.content = { [contentType]: { schema: spec.schema as JsonSchema } };
    }
    doc[status] = entry;
  }
  return doc;
}

function uniqueTags(ops: readonly OperationSpec[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const op of ops) {
    for (const t of op.tags) {
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}
