// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * The hand-written parts of the error codes reference (`../errors.mjs`).
 * The codes and their statuses come from the API's own map.
 *
 * `scripts/check-reference.mjs` fails the docs build when a code in the
 * map has no entry here, or an entry names a code the map no longer has.
 */

/**
 * By code: `description` (when the API answers it, and what to do),
 * `details` (the keys its `details` object carries) and an optional
 * `seeAlso` (routes like `POST /v1/runs`, or page slugs) for a code no
 * operation or guide names.
 */
export const ERROR_ENTRIES = {
  'validation-failed': {
    description:
      "The request body is well-formed JSON but fails validation, for example an agent, flow, tool, policy or eval suite definition that breaks the rules, or a version pin that can't be resolved. Fix the entries in `details.issues` and resend.",
    details: [
      {
        key: 'issues',
        meaning: 'list of problems, each with a path to the offending field and a message',
      },
    ],
  },
  'kind-not-applied': {
    description:
      "You publish a policy of a kind this runtime doesn't enforce, so publishing it would change nothing. Publish one of the kinds listed in `details.appliedKinds`.",
    details: [
      {
        key: 'kind',
        meaning: 'the policy kind you sent',
      },
      {
        key: 'appliedKinds',
        meaning: 'the policy kinds this runtime applies',
      },
    ],
  },
  'unknown-field': {
    description:
      "The request body has a field the endpoint doesn't accept. The message names the field; remove it and resend.",
    details: [],
    seeAlso: ['POST /v1/tokens/public', 'POST /v1/webhook-endpoints/{endpointId}/test'],
  },
  'bad-input': {
    description:
      "The request is malformed: the body isn't valid JSON or isn't an object, a field has the wrong type or value, a `projectId` isn't a UUID, or a `cursor` wasn't issued by this list. Fix the input named in the message.",
    details: [],
  },
  'unresolved-tool': {
    description:
      "An agent's turn needs a tool that isn't registered: the agent declares a tool the project doesn't have, or the model asks for a tool the agent doesn't declare. Register the tool or fix the agent definition.",
    details: [
      {
        key: 'toolId',
        meaning: "the tool that couldn't be resolved",
      },
      {
        key: 'runId',
        meaning: 'the run the turn belongs to, when it has one',
      },
    ],
  },
  'unresolved-guardrail': {
    description:
      "An agent names a guardrail that isn't registered, so its turn can't start. Register the missing guardrails or remove them from the agent.",
    details: [
      {
        key: 'guardrailIds',
        meaning: "the guardrail ids that aren't registered",
      },
      {
        key: 'runId',
        meaning: 'the run the turn belongs to, when it has one',
      },
    ],
    seeAlso: ['guides/guardrails/configure-a-guardrail'],
  },
  'schema-validation-failed': {
    description:
      "The API doesn't send this code. A flow definition with this problem is answered `validation-failed`, with the problem in `details.issues`.",
    details: [],
    seeAlso: ['#validation-failed', 'guides/flows/write-a-flow'],
  },
  'scope-invalid': {
    description:
      "The scope you sent is malformed or unusable: `scopeKind` and `scopeId` don't fit together, `inherit` isn't true or false, or the org or project doesn't exist for your tenant. Fix the scope fields.",
    details: [
      {
        key: 'projectId',
        meaning: "the project that wasn't found (MCP endpoint register only)",
      },
      {
        key: 'orgId',
        meaning: "the org that wasn't found (MCP endpoint register only)",
      },
    ],
  },
  'auth-missing': {
    description:
      "The request has no usable credentials: the Authorization header is absent or not `Bearer <token>`, or the token isn't recognised. Send a valid API key or session token.",
    details: [],
    seeAlso: ['deploy/people-and-keys'],
  },
  'auth-expired': {
    description:
      'Your API key or public run token has expired. Use a new one; an expired console session answers `session-expired` instead.',
    details: [],
    seeAlso: ['deploy/people-and-keys', '#session-expired'],
  },
  'auth-revoked': {
    description:
      'The API key you used has been revoked. Use another key. Also sent when a console session was opened with a key that has since been revoked: sign in again.',
    details: [],
    seeAlso: ['POST /v1/tokens/{tokenId}/revoke'],
  },
  'permission-denied': {
    description:
      "Your key or session isn't allowed to do this on this resource, or lacks a capability the route needs. Ask an admin for the permission or use a key that has it.",
    details: [
      {
        key: 'action',
        meaning: 'the action that was refused',
      },
      {
        key: 'resource',
        meaning: 'the resource it was refused on, as type:id',
      },
      {
        key: 'reason',
        meaning: 'why the check refused it',
      },
    ],
  },
  'host-access-denied': {
    description:
      "The deployment doesn't let tenant configuration reach its host, so a `stdio` MCP endpoint (a command on the host) is refused. Use an HTTP endpoint instead, or ask whoever runs the deployment.",
    details: [
      {
        key: 'action',
        meaning: 'the action that was refused',
      },
      {
        key: 'resource',
        meaning: 'the resource it was refused on, as type:id',
      },
      {
        key: 'reason',
        meaning: 'why the check refused it',
      },
    ],
  },
  'csrf-origin-mismatch': {
    description:
      "A request authenticated by the console session cookie came from an origin the deployment doesn't allow, or carried no Origin header. Use the console at its own address, or an API key.",
    details: [],
  },
  'token-sign-in-off': {
    description:
      "This deployment doesn't allow signing in to the console with an API token. Sign in with the organization's identity provider, or ask whoever runs the deployment to allow it.",
    details: [
      {
        key: 'action',
        meaning: 'the action that was refused',
      },
      {
        key: 'resource',
        meaning: 'the resource it was refused on, as type:id',
      },
      {
        key: 'reason',
        meaning: 'why the check refused it',
      },
    ],
  },
  'token-sign-in-not-allowed': {
    description:
      "The key can't open a console session: it belongs to a service account, or it is narrowed to a member role or one project. Use a full key of a person, or the identity provider.",
    details: [
      {
        key: 'action',
        meaning: 'the action that was refused',
      },
      {
        key: 'resource',
        meaning: 'the resource it was refused on, as type:id',
      },
      {
        key: 'reason',
        meaning: 'why the check refused it',
      },
    ],
  },
  'not-found': {
    description:
      "The token, secret rotation or memory erasure you named doesn't exist for your tenant, or its id isn't valid. Check the id.",
    details: [],
  },
  'run-not-found': {
    description: "The run doesn't exist in your tenant. Check the run id.",
    details: [
      {
        key: 'runId',
        meaning: "the run id that wasn't found (only some routes)",
      },
    ],
  },
  'agent-not-found': {
    description:
      "The agent, or the agent version, doesn't exist in the project, or your key can't see it. Check the id and version; for a run, the agent version the run started with may have been removed.",
    details: [
      {
        key: 'agentId',
        meaning: 'the agent id',
      },
      {
        key: 'version',
        meaning: 'the version asked for, when one was named',
      },
    ],
  },
  'conversation-not-found': {
    description: "The conversation doesn't exist in your tenant. Check the conversation id.",
    details: [
      {
        key: 'conversationId',
        meaning: "the conversation id that wasn't found",
      },
    ],
    seeAlso: ['GET /v1/conversations/{conversationId}'],
  },
  'tool-not-found': {
    description:
      "The tool, or the tool version, isn't registered in the project. Check the id and version.",
    details: [
      {
        key: 'toolId',
        meaning: 'the tool id',
      },
      {
        key: 'version',
        meaning: 'the version asked for, when one was named',
      },
    ],
    seeAlso: ['GET /v1/tools/{toolId}', 'GET /v1/tools/{toolId}/versions/{version}'],
  },
  'guardrail-not-found': {
    description: 'No guardrail with this id is registered. Check the id.',
    details: [
      {
        key: 'guardrailId',
        meaning: 'the guardrail id',
      },
    ],
    seeAlso: ['GET /v1/guardrails/{guardrailId}', 'POST /v1/guardrails/{guardrailId}/unregister'],
  },
  'fact-not-found': {
    description: "The memory fact doesn't exist in your tenant. Check the fact id.",
    details: [
      {
        key: 'factId',
        meaning: 'the fact id',
      },
    ],
  },
  'flow-not-found': {
    description:
      "The flow, or the flow version, isn't registered. Check the id and version; a run can't start on an unregistered flow version.",
    details: [
      {
        key: 'flowId',
        meaning: 'the flow id',
      },
      {
        key: 'version',
        meaning: 'the version asked for, when one was named',
      },
    ],
    seeAlso: ['GET /v1/flows/{flowId}', 'GET /v1/flows/{flowId}/versions/{version}'],
  },
  'already-terminal': {
    description:
      "The API doesn't send this code. Cancelling an eval run that has finished is answered `eval-run-already-terminal`.",
    details: [],
    seeAlso: ['#eval-run-already-terminal'],
  },
  'fact-changed': {
    description:
      "The fact moved on since you read it: its current revision isn't the `expectVersion` you sent. Read it again, then retry with the new revision.",
    details: [
      {
        key: 'factId',
        meaning: 'the fact id',
      },
      {
        key: 'currentVersion',
        meaning: "the fact's current revision",
      },
    ],
  },
  'legal-hold': {
    description:
      "The fact is under legal hold, so it can't be deleted or superseded; or a memory erasure would reach facts under hold, and nothing is erased. Lift the hold first.",
    details: [
      {
        key: 'factId',
        meaning: 'the fact under hold (delete or supersede)',
      },
      {
        key: 'factIds',
        meaning: 'the facts under hold (starting an erasure)',
      },
    ],
  },
  'erasure-in-progress': {
    description:
      "An erasure of this person's data is running, so no new turn starts and no new fact is stored for them until it completes. Retry after the erasure finishes.",
    details: [],
  },
  'run-already-terminal': {
    description:
      "The run has already finished (completed, failed or cancelled), so it can't be cancelled, resumed or given a decision. Start a new run if you need another.",
    details: [
      {
        key: 'runId',
        meaning: 'the run',
      },
      {
        key: 'status',
        meaning: 'the state it ended in',
      },
    ],
    seeAlso: ['guides/runs/cancel-a-run'],
  },
  'run-lease-lost': {
    description:
      "Another executor holds or has taken over the run, so this attempt can't go on. Retry later; the run continues in the executor that holds it.",
    details: [
      {
        key: 'runId',
        meaning: 'the run',
      },
    ],
  },
  'idempotency-key-body-mismatch': {
    description:
      'You reused an Idempotency-Key with a different request body. Send the original body to get its answer back, or use a fresh key.',
    details: [],
  },
  'idempotency-key-in-flight': {
    description:
      'A request with this Idempotency-Key is still running. Retry after the `Retry-After` header; you then get its answer.',
    details: [],
  },
  'idempotency-key-replay-withheld': {
    description:
      "The request with this Idempotency-Key already succeeded, but its answer held a secret that isn't kept, so it can't be replayed. Read what it created, or make a new one with a fresh key.",
    details: [
      {
        key: 'status',
        meaning: 'the HTTP status the first request answered with',
      },
      {
        key: 'at',
        meaning: 'when it succeeded, as an ISO timestamp',
      },
    ],
  },
  'hitl-required': {
    description:
      "The API doesn't send this code. A conversation that reaches its review threshold parks the turn for an approval instead.",
    details: [],
    seeAlso: ['guides/approvals/ask-after-n-turns'],
  },
  'duplicate-node-id': {
    description:
      "The API doesn't send this code. A flow definition that uses a node id twice is answered `validation-failed`, with the problem in `details.issues`.",
    details: [],
    seeAlso: ['#validation-failed', 'guides/flows/write-a-flow'],
  },
  'duplicate-edge-id': {
    description:
      "The API doesn't send this code. A flow definition that uses an edge id twice is answered `validation-failed`, with the problem in `details.issues`.",
    details: [],
    seeAlso: ['#validation-failed', 'guides/flows/write-a-flow'],
  },
  'agent-version-mismatch': {
    description:
      'The conversation was opened with one agent version, but the turn or resume names another. Use the version the conversation started with.',
    details: [
      {
        key: 'conversationId',
        meaning: 'the conversation (new turn only)',
      },
      {
        key: 'expectedVersion',
        meaning: 'the version the conversation or run is bound to',
      },
      {
        key: 'actualVersion',
        meaning: 'the version the call used',
      },
    ],
  },
  'agent-already-registered': {
    description:
      'That agent id and version is already published, and versions never change. Publish under a new version; `details.nextFreeVersion` suggests the next free one.',
    details: [
      {
        key: 'agentId',
        meaning: 'the agent id',
      },
      {
        key: 'version',
        meaning: 'the version already taken',
      },
      {
        key: 'nextFreeVersion',
        meaning: 'the next unused version, when one can be worked out',
      },
    ],
  },
  'agent-project-mismatch': {
    description:
      "The agent belongs to a different project than the one you named; an agent stays in the project its first version went to. Publish its versions there. The answer doesn't name that project.",
    details: [
      {
        key: 'agentId',
        meaning: 'the agent id (publish, derive)',
      },
      {
        key: 'primitive',
        meaning: 'the kind of item (deployment only)',
      },
      {
        key: 'id',
        meaning: "the item's id and version (deployment only)",
      },
    ],
  },
  'registry-read-only': {
    description:
      "This registry takes no writes, for example when a local dev server serves the project's own files. The message says what to do instead.",
    details: [],
  },
  'agent-gone': {
    description:
      'The agent has no active versions left; it exists but every version is unregistered. Reinstate a version or publish a new one.',
    details: [
      {
        key: 'agentId',
        meaning: 'the agent id',
      },
    ],
  },
  'run-erased': {
    description:
      "An erasure cleared the run's content (a person's words were removed), so there is nothing to judge or replay.",
    details: [],
  },
  'flow-gone': {
    description:
      'The flow has no active versions left; it exists but every version is unregistered. Reinstate a version or publish a new one.',
    details: [
      {
        key: 'flowId',
        meaning: 'the flow id',
      },
    ],
    seeAlso: ['GET /v1/flows/{flowId}'],
  },
  'policy-gone': {
    description:
      'The policy has no active versions left; it exists but every version is unregistered. Reinstate a version or publish a new one.',
    details: [
      {
        key: 'policyId',
        meaning: 'the policy id',
      },
    ],
    seeAlso: ['GET /v1/policies/{policyId}'],
  },
  'eval-suite-gone': {
    description:
      'The eval suite has no active versions left; it exists but every version is unregistered. Reinstate a version or publish a new one.',
    details: [
      {
        key: 'suiteId',
        meaning: 'the suite id',
      },
    ],
    seeAlso: ['GET /v1/eval-suites/{suiteId}'],
  },
  'tool-gone': {
    description:
      "The tool existed but has no active version left, so it can't be read or run. Reinstate a retired version or publish a new one.",
    details: [
      {
        key: 'toolId',
        meaning: "the tool's id",
      },
    ],
    seeAlso: ['GET /v1/tools/{toolId}'],
  },
  'tool-already-registered': {
    description:
      "The tool id and version you're publishing already exist. Published versions are immutable, so publish under a new version number.",
    details: [
      {
        key: 'toolId',
        meaning: "the tool's id",
      },
      {
        key: 'version',
        meaning: 'the version that is already registered',
      },
    ],
  },
  'tool-project-mismatch': {
    description:
      "The tool id belongs to another project, because its first version was published there, and versions can't be published from a different project.",
    details: [
      {
        key: 'toolId',
        meaning: "the tool's id (single publish)",
      },
      {
        key: 'primitive',
        meaning: 'on a deployment: the kind of item refused (`tool`)',
      },
      {
        key: 'id',
        meaning: 'on a deployment: the refused item, as `id@version`',
      },
    ],
  },
  'guardrail-already-registered': {
    description:
      'A guardrail with this id is already registered. On a deployment, the existing one has a different definition, so unregister it first and deploy again.',
    details: [
      {
        key: 'guardrailId',
        meaning: "the guardrail's id (direct registration)",
      },
      {
        key: 'primitive',
        meaning: 'on a deployment: the kind of item refused (`guardrail`)',
      },
      {
        key: 'id',
        meaning: 'on a deployment: the guardrail id',
      },
    ],
    seeAlso: ['POST /v1/deployments/{deploymentId}/secrets', 'POST /v1/guardrails'],
  },
  'guardrail-project-mismatch': {
    description:
      'A guardrail id in your deployment is already in use in another project. A deployment never takes over a guardrail from another project.',
    details: [
      {
        key: 'primitive',
        meaning: 'the kind of item refused (`guardrail`)',
      },
      {
        key: 'id',
        meaning: 'the guardrail id',
      },
    ],
    seeAlso: ['POST /v1/deployments/{deploymentId}/secrets'],
  },
  'guardrail-config-invalid': {
    description:
      "The guardrail's `config` doesn't satisfy the config schema of the check it names, so the check would refuse it on every call. Fix the config and register again.",
    details: [
      {
        key: 'issues',
        meaning: 'one entry per problem found in the config',
      },
    ],
  },
  'flow-already-registered': {
    description:
      "The flow id and version you're publishing already exist. Publish the change under a new version.",
    details: [
      {
        key: 'flowId',
        meaning: "the flow's id",
      },
      {
        key: 'version',
        meaning: 'the version that is already registered',
      },
    ],
  },
  'flow-project-mismatch': {
    description:
      "The flow id belongs to another project, because its first version was published there, and its versions can't be published from a different project.",
    details: [
      {
        key: 'flowId',
        meaning: "the flow's id (single publish)",
      },
      {
        key: 'primitive',
        meaning: 'on a deployment: the kind of item refused (`flow`)',
      },
      {
        key: 'id',
        meaning: 'on a deployment: the refused item, as `id@version`',
      },
    ],
  },
  'conversation-closed': {
    description:
      "The conversation you're adding a turn to has been closed. Start a new conversation instead.",
    details: [
      {
        key: 'conversationId',
        meaning: 'the closed conversation',
      },
      {
        key: 'runId',
        meaning: 'the run the failure belongs to, when one was started',
      },
    ],
    seeAlso: ['guides/agents/conversations'],
  },
  'invalid-agent': {
    description:
      'An agent definition breaks the rules. Defining it in code raises this code before anything is sent; the API answers the same problem as `validation-failed`, with each issue in `details.issues`.',
    details: [
      {
        key: 'issues',
        meaning: 'each problem: its path and what is wrong',
      },
    ],
    seeAlso: ['POST /v1/agents'],
  },
  'invalid-tool-definition': {
    description:
      'A tool manifest breaks the rules, for example a missing or inexact `version`, or both or neither of `handler` and `spec`. Defining it in code raises this code; the API answers `validation-failed`, with each issue in `details.issues`.',
    details: [
      {
        key: 'issues',
        meaning: 'each problem: its path and what is wrong',
      },
    ],
    seeAlso: ['POST /v1/tools'],
  },
  'invalid-schema': {
    description:
      "A tool's input or output schema isn't a valid JSON Schema. Defining the tool in code raises this code; the API answers `validation-failed`, with the issue's path `/input` or `/output`.",
    details: [
      {
        key: 'issues',
        meaning: 'each problem: its path and what is wrong',
      },
    ],
    seeAlso: ['POST /v1/tools'],
  },
  'unknown-effect': {
    description:
      "A tool declares an effect kind that isn't supported. Defining the tool in code raises this code; the API answers `validation-failed`, with the issue in `details.issues`.",
    details: [],
    seeAlso: ['#validation-failed', 'guides/tools/write-a-tool'],
  },
  'invalid-guardrail': {
    description:
      "A guardrail definition breaks the rules, or its kind doesn't match the check it names. Defining it in code raises this code; the API answers `validation-failed`, with each issue in `details.issues`.",
    details: [
      {
        key: 'issues',
        meaning: 'each problem: its path and what is wrong',
      },
    ],
    seeAlso: ['POST /v1/guardrails'],
  },
  'guardrail-violation': {
    description:
      "A blocking guardrail stopped the agent's turn, or a halting guardrail's check couldn't run. The run fails; the violations say which guardrails fired.",
    details: [
      {
        key: 'violations',
        meaning: 'the blocking guardrail results',
      },
      {
        key: 'evaluationErrors',
        meaning: "guardrails whose check couldn't run (missing check, bad config)",
      },
      {
        key: 'runId',
        meaning: 'the run that failed',
      },
    ],
  },
  'agent-turn-aborted': {
    description: "The agent's turn was cancelled or timed out before it finished.",
    details: [
      {
        key: 'reason',
        meaning: '`external` when cancelled by a caller, `timeout` when it ran out of time',
      },
      {
        key: 'runId',
        meaning: 'the run that was aborted',
      },
    ],
  },
  'budget-exceeded': {
    description:
      "The agent's turn went over its budget: the cost cap, or the step cap while the model still wanted another tool call. Raise the budget or simplify the task.",
    details: [
      {
        key: 'kind',
        meaning: 'which budget: `steps` or `cost` (the type also allows `wall-time`)',
      },
      {
        key: 'limit',
        meaning: "the agent's cap",
      },
      {
        key: 'observed',
        meaning: 'the value reached',
      },
      {
        key: 'runId',
        meaning: 'the run that failed',
      },
    ],
  },
  'output-schema-violation': {
    description:
      "The agent declares an output schema and its final answer still didn't match after the allowed repair attempts.",
    details: [
      {
        key: 'errors',
        meaning: 'the schema problems from the last attempt',
      },
      {
        key: 'attempts',
        meaning: 'how many answers were checked',
      },
      {
        key: 'runId',
        meaning: 'the run that failed',
      },
    ],
  },
  'model-invocation-failed': {
    description:
      "The model provider call failed, for example it refused the key or was rate limited. The message carries the provider's own words.",
    details: [
      {
        key: 'runId',
        meaning: 'the run that failed',
      },
    ],
  },
  'capability-unsatisfiable': {
    description:
      "No registered model provider meets what the agent's capabilities ask for, after your organization's model policy is applied. It appears as the cause of capability-routing-failed.",
    details: [
      {
        key: 'reasons',
        meaning: 'per provider, why it was rejected (inside `cause`)',
      },
      {
        key: 'tenantId',
        meaning: 'the tenant whose policy applied, when one did (inside `cause`)',
      },
    ],
    seeAlso: ['#capability-routing-failed', 'guides/agents/choose-a-model'],
  },
  'tool-version-unresolvable': {
    description:
      'No registered version of a tool the agent uses matches its version range, or the pinned version is no longer registered. Publish a matching version or fix the range.',
    details: [
      {
        key: 'toolId',
        meaning: 'the tool',
      },
      {
        key: 'requestedRange',
        meaning: 'the version range or pin the agent asked for',
      },
      {
        key: 'availableVersions',
        meaning: 'versions that are registered, when known',
      },
      {
        key: 'runId',
        meaning: 'the run that failed',
      },
    ],
    seeAlso: ['guides/agents/agent-and-tool-versions'],
  },
  'tool-invocation-failed': {
    description:
      "A tool the agent called failed, and the agent's tool-error policy didn't let the model recover. The message carries the tool's own error.",
    details: [
      {
        key: 'toolId',
        meaning: 'the tool that failed',
      },
      {
        key: 'validationIssues',
        meaning: "when the model's arguments broke the tool's input schema: the validator's issues",
      },
      {
        key: 'receivedInput',
        meaning: 'with validationIssues: the arguments the model sent, truncated',
      },
      {
        key: 'toolRetries',
        meaning: 'failed calls already sent back to the model, when retries ran out',
      },
      {
        key: 'runId',
        meaning: 'the run that failed',
      },
    ],
    seeAlso: ['guides/tools/write-a-tool', 'guides/runs/see-why-runs-failed'],
  },
  'capability-routing-failed': {
    description:
      "No model provider could take the agent's call: the agent declares no capabilities, or no provider meets them under your policy, or the pinned route is no longer allowed.",
    details: [
      {
        key: 'runId',
        meaning: 'the run that failed',
      },
    ],
  },
  'runtime-not-configured': {
    description: "The API doesn't send this code.",
    details: [],
    seeAlso: ['guides/models/index'],
  },
  'flow-unbound': {
    description:
      "The flow can't start or resume because a node has nothing to run it: a step names a tool the tenant doesn't have, an agent step can't bind, or a node kind isn't runnable.",
    details: [
      {
        key: 'nodeIds',
        meaning: "the flow nodes that can't be bound",
      },
    ],
    seeAlso: ['guides/flows/write-a-flow', 'guides/flows/dry-run-a-flow'],
  },
  'flow-runs-not-supported': {
    description: "The API doesn't send this code.",
    details: [],
    seeAlso: ['guides/flows/write-a-flow'],
  },
  'flow-resume-not-supported': {
    description: "The API doesn't send this code.",
    details: [],
    seeAlso: ['guides/flows/wait-for-an-approval'],
  },
  'run-resume-not-supported': {
    description:
      "Resuming a run at a waitpoint through `POST /v1/runs/{runId}/resume` isn't available. A run waiting for an approval continues when a reviewer decides it.",
    details: [],
  },
  'semantic-unavailable': {
    description:
      "A search by meaning (`semantic`, or the agent's semantic retrieval) can't run because the deployment has no embeddings or the embedding provider isn't answering. Use keyword or `both` mode, or ask an admin.",
    details: [
      {
        key: 'intent',
        meaning: 'for an agent turn: the position of the retrieval intent that failed',
      },
    ],
  },
  'rate-limit-exceeded': {
    description:
      'You sent too many requests: a webhook trigger got more deliveries than its per-minute limit, a client sent too many refused webhook requests, or too many sign-in lookups came from one source. Retry after the `Retry-After` header.',
    details: [],
  },
  'internal-server-error': {
    description:
      'The server hit an unexpected error while handling the request. Retry; if it persists, contact support with the `requestId`.',
    details: [],
    seeAlso: ['GET /v1/deployments'],
  },
  'journal-error': {
    description:
      "The run's record couldn't be written or read back: the run was started but its row isn't readable, or it couldn't be started or reloaded after cancelling.",
    details: [],
    seeAlso: ['POST /v1/runs', 'POST /v1/runs/{runId}/cancel'],
  },
  'waitpoint-error': {
    description:
      "The wait token the approval or cancel targets isn't pending any more: no pending token, or it was already resolved or cancelled.",
    details: [
      {
        key: 'tokenId',
        meaning: 'the wait token',
      },
    ],
    seeAlso: ['POST /v1/approvals/{approvalId}/complete'],
  },
  'approval-not-found': {
    description: "No approval with this id exists, or your role can't see it.",
    details: [
      {
        key: 'approvalId',
        meaning: 'the approval id',
      },
    ],
    seeAlso: ['GET /v1/approvals/{approvalId}', 'POST /v1/approvals/{approvalId}/complete'],
  },
  'reviewer-not-found': {
    description: 'No reviewer is registered with this id.',
    details: [
      {
        key: 'reviewerId',
        meaning: 'the reviewer id',
      },
    ],
    seeAlso: [
      'GET /v1/approvals/reviewers/{reviewerId}',
      'POST /v1/approvals/reviewers/{reviewerId}/unregister',
    ],
  },
  'reviewer-deactivated': {
    description:
      "The reviewer was deactivated, so it can't decide approvals. Ask an admin to reactivate or use another reviewer.",
    details: [
      {
        key: 'reviewerId',
        meaning: 'the reviewer id',
      },
    ],
    seeAlso: ['guides/approvals/decide-an-approval'],
  },
  'insufficient-role': {
    description:
      "The reviewer's role ranks below the tier the approval requires, so it can't decide it. Ask a reviewer of a higher role, or escalate.",
    details: [
      {
        key: 'reviewerId',
        meaning: 'the reviewer',
      },
      {
        key: 'reviewerRole',
        meaning: "the reviewer's role",
      },
      {
        key: 'requiredRole',
        meaning: 'the role the approval needs',
      },
    ],
    seeAlso: ['guides/approvals/decide-an-approval'],
  },
  'approval-terminal': {
    description:
      'The approval already ended (decided, expired or withdrawn), so it takes no more decisions.',
    details: [
      {
        key: 'approvalId',
        meaning: 'the approval',
      },
      {
        key: 'status',
        meaning: 'its final status',
      },
    ],
    seeAlso: ['guides/approvals/decide-an-approval'],
  },
  'approval-already-decided': {
    description: 'The approval already has a decision recorded; a second decision is refused.',
    details: [
      {
        key: 'approvalId',
        meaning: 'the approval',
      },
    ],
    seeAlso: ['guides/approvals/decide-an-approval'],
  },
  'invalid-transition': {
    description: "The API doesn't send this code.",
    details: [],
    seeAlso: ['guides/evals/propose-a-change'],
  },
  'audit-bundle-not-found': {
    description:
      "The API doesn't send this code. The audit bundle of an approval that doesn't exist is answered `approval-not-found`.",
    details: [],
    seeAlso: ['#approval-not-found', 'guides/approvals/decide-an-approval'],
  },
  'approval-not-decided': {
    description:
      "The approval is still pending, so a signed audit bundle can't be exported. Export it after a terminal decision.",
    details: [
      {
        key: 'approvalId',
        meaning: 'the approval',
      },
      {
        key: 'status',
        meaning: 'its current status',
      },
    ],
    seeAlso: ['POST /v1/approvals/{approvalId}/audit-bundle'],
  },
  'export-key-error': {
    description:
      "Signing the export with the deployment's export key failed. The message carries the reason.",
    details: [],
    seeAlso: ['POST /v1/approvals/{approvalId}/audit-bundle', 'POST /v1/provenance/{runId}/export'],
  },
  'persistence-error': {
    description:
      "The runtime couldn't read or write its storage. Retry; if it persists, contact support.",
    details: [],
    seeAlso: ['GET /v1/audit/authz'],
  },
  'observation-not-found': {
    description: "The API doesn't send this code.",
    details: [],
    seeAlso: ['guides/evals/improve-an-agent'],
  },
  'provenance-not-found': {
    description:
      "No provenance record exists for the run id in the path, or the id isn't a valid run id.",
    details: [
      {
        key: 'runId',
        meaning: 'the run id that was looked up',
      },
    ],
    seeAlso: ['GET /v1/provenance/{runId}'],
  },
  'signing-not-configured': {
    description:
      'The runtime has no export signing key, so signed exports and the features that depend on them are unavailable.',
    details: [],
    seeAlso: ['guides/observability/export-signed-evidence'],
  },
  'signing-key-not-found': {
    description:
      "The signing key id doesn't exist among the tenant's trusted keys, or a signed export asked for a signing key the runtime doesn't sign with. Omit the key id to use the active key.",
    details: [
      {
        key: 'signingKeyId',
        meaning: 'the key id requested for signing; present only on export signing',
      },
    ],
    seeAlso: ['GET /v1/signing-keys/{keyId}'],
  },
  'signing-key-conflict': {
    description:
      'The key id is already trusted with a different public key. Trust the new key under a new key id.',
    details: [],
  },
  'signing-key-revoked': {
    description:
      "The key id was revoked and revocation is final, so it can't be trusted again. Trust the key under a new key id.",
    details: [],
  },
  'signing-key-algorithm-unsupported': {
    description:
      "The signing key uses an algorithm other than ed25519: a trust request names another `algorithm`, or a stored key can't be used to verify.",
    details: [
      {
        key: 'algorithm',
        meaning: 'the unsupported algorithm; present only when a stored key fails verification',
      },
    ],
    seeAlso: ['POST /v1/signing-keys/{keyId}/revoke'],
  },
  'signing-key-store-error': {
    description: "The API doesn't send this code.",
    details: [],
    seeAlso: ['guides/observability/export-signed-evidence'],
  },
  'proposal-not-found': {
    description:
      "The improvement proposal doesn't exist in the tenant, or your key can't see its agent.",
    details: [
      {
        key: 'proposalId',
        meaning: 'the proposal id that was looked up',
      },
    ],
    seeAlso: ['guides/evals/propose-a-change'],
  },
  'proposal-invalid-state-transition': {
    description:
      "The proposal's status doesn't allow this action, or it changed while the request ran. Read the proposal again and retry if it still applies.",
    details: [
      {
        key: 'proposalId',
        meaning: 'the proposal id',
      },
      {
        key: 'status',
        meaning: 'the proposal status that refused the action; absent when it changed mid-request',
      },
    ],
  },
  'proposal-needs-pin': {
    description:
      'The agent has no live version for the whole tenant, so a new version would serve every scope nothing is pinned for. Promote its current version tenant-wide, then retry.',
    details: [],
  },
  'improve-unsupported': {
    description: "This runtime doesn't run improvement passes.",
    details: [],
  },
  'improvement-pass-not-found': {
    description: "The improvement pass doesn't exist, or your key can't read its agent.",
    details: [
      {
        key: 'passId',
        meaning: 'the pass id that was looked up',
      },
    ],
    seeAlso: ['POST /v1/improvement-passes/{passId}/cancel'],
  },
  'improvement-pass-finished': {
    description: 'The improvement pass has already ended, so there is nothing to cancel.',
    details: [
      {
        key: 'passId',
        meaning: 'the pass id',
      },
      {
        key: 'status',
        meaning: 'the status the pass ended with',
      },
    ],
  },
  'version-already-exists': {
    description: "The API doesn't send this code.",
    details: [],
    seeAlso: ['guides/evals/propose-a-change'],
  },
  'supervisor-header-missing': {
    description: "The API doesn't send this code.",
    details: [],
    seeAlso: ['concepts/architecture'],
  },
  'blob-not-found': {
    description:
      "No artifact with that id exists in the tenant, or it's in a project your key can't read.",
    details: [
      {
        key: 'blobId',
        meaning: 'the artifact id that was looked up',
      },
    ],
  },
  'blob-hash-mismatch': {
    description:
      "The uploaded bytes don't match the `expectedHash` you sent. Nothing is stored; recompute the hash or resend the bytes.",
    details: [
      {
        key: 'expected',
        meaning: 'the hash you declared',
      },
      {
        key: 'actual',
        meaning: 'the hash of the bytes received',
      },
    ],
    seeAlso: ['POST /v1/artifacts'],
  },
  'blob-size-mismatch': {
    description:
      "The uploaded bytes aren't the size you declared. Nothing is stored; send the right `size` or the full body.",
    details: [
      {
        key: 'declared',
        meaning: 'the size you declared',
      },
      {
        key: 'actual',
        meaning: 'the size of the bytes received',
      },
    ],
    seeAlso: ['guides/runs/keep-files-with-a-run'],
  },
  'blob-storage-error': {
    description:
      "The runtime's artifact storage failed while reading or writing the bytes. Retry; contact the operator if it persists.",
    details: [],
    seeAlso: ['guides/runs/keep-files-with-a-run'],
  },
  'capability-not-found': {
    description: 'No capability is registered with that id in the tenant.',
    details: [
      {
        key: 'capabilityId',
        meaning: 'the capability id that was looked up',
      },
    ],
    seeAlso: ['GET /v1/capabilities/{capabilityId}'],
  },
  'provider-not-found': {
    description: 'No model provider is registered with that id in the tenant.',
    details: [
      {
        key: 'providerId',
        meaning: 'the provider id that was looked up',
      },
    ],
    seeAlso: ['GET /v1/providers/{providerId}', 'GET /v1/providers/{providerId}/check'],
  },
  'provider-already-registered': {
    description: 'A provider with that id is already registered in the tenant.',
    details: [
      {
        key: 'providerId',
        meaning: 'the provider id that is taken',
      },
    ],
    seeAlso: ['POST /v1/providers'],
  },
  'invalid-provider': {
    description:
      "The provider's metadata is invalid, for example an empty id, an empty region or no models. The message says which.",
    details: [
      {
        key: 'reason',
        meaning: 'short code for the problem, such as empty-id or empty-region',
      },
      {
        key: 'providerId',
        meaning: 'the provider id; present on a registry refusal',
      },
    ],
    seeAlso: ['POST /v1/providers'],
  },
  'provider-config-invalid': {
    description:
      "The provider registration is refused: `send_traceparent` isn't a boolean, or the provider's adapter rejects its `adapter_config`, metadata or `secret_ref`.",
    details: [
      {
        key: 'issues',
        meaning: 'list of problems, each with a JSON-pointer path and a message',
      },
    ],
  },
  'cost-record-not-found': {
    description: 'No cost record exists with that id in the tenant.',
    details: [
      {
        key: 'recordId',
        meaning: 'the cost record id that was looked up',
      },
    ],
    seeAlso: ['GET /v1/cost/records/{recordId}'],
  },
  'adapter-not-found': {
    description: 'No adapter is registered with that id in the tenant.',
    details: [
      {
        key: 'adapterId',
        meaning: 'the adapter id that was looked up',
      },
    ],
    seeAlso: ['GET /v1/adapters/{adapterId}'],
  },
  'policy-not-found': {
    description: 'No policy exists with that id (or that version) in the tenant.',
    details: [
      {
        key: 'policyId',
        meaning: 'the policy id',
      },
    ],
    seeAlso: ['GET /v1/policies/{policyId}', 'GET /v1/policies/{policyId}/versions'],
  },
  'policy-already-registered': {
    description:
      'That policy id and version are already registered; policy versions never change, so publish a new version.',
    details: [
      {
        key: 'policyId',
        meaning: 'the policy id',
      },
      {
        key: 'version',
        meaning: 'the version that exists',
      },
    ],
  },
  'policy-scope-taken': {
    description:
      'Another policy already holds the scope this one would cover, for example the retention domain. Publish a new version of that policy, or unregister it first.',
    details: [
      {
        key: 'policyId',
        meaning: 'the policy being published or reinstated',
      },
      {
        key: 'version',
        meaning: 'its version',
      },
      {
        key: 'policyKind',
        meaning: 'the policy kind',
      },
      {
        key: 'scope',
        meaning: 'the scope requested',
      },
      {
        key: 'heldBy',
        meaning: 'the policy that holds the scope',
      },
    ],
  },
  'policy-scope-changed': {
    description:
      'The policy version would move the policy to another scope, but a policy keeps one scope across versions. Publish it under a new id.',
    details: [
      {
        key: 'policyId',
        meaning: 'the policy id',
      },
      {
        key: 'version',
        meaning: 'the version',
      },
      {
        key: 'policyKind',
        meaning: 'the policy kind',
      },
      {
        key: 'scope',
        meaning: 'the scope the version covers',
      },
      {
        key: 'previousScope',
        meaning: 'the scope the policy already holds',
      },
    ],
  },
  'block-not-found': {
    description:
      "No block exists with that id (or that version), or it's in a project your key can't read.",
    details: [
      {
        key: 'blockId',
        meaning: 'the block id',
      },
      {
        key: 'version',
        meaning: 'the version looked up; present only when a version was requested',
      },
    ],
  },
  'block-already-registered': {
    description:
      'That block version is already published; versions never change, so publish a new version.',
    details: [
      {
        key: 'blockId',
        meaning: 'the block id',
      },
      {
        key: 'version',
        meaning: 'the version that exists',
      },
    ],
  },
  'block-project-mismatch': {
    description:
      'The block belongs to another project. Publish its versions in the project that owns it.',
    details: [
      {
        key: 'blockId',
        meaning: 'the block id',
      },
    ],
  },
  'eval-suite-not-found': {
    description: 'No eval suite is registered with that id.',
    details: [
      {
        key: 'suiteId',
        meaning: 'the suite id that was looked up',
      },
    ],
    seeAlso: ['GET /v1/eval-suites/{suiteId}'],
  },
  'eval-suite-already-registered': {
    description:
      'That eval suite id and version are already registered; versions never change, so publish a new version.',
    details: [
      {
        key: 'suiteId',
        meaning: 'the suite id',
      },
      {
        key: 'version',
        meaning: 'the version that exists',
      },
    ],
  },
  'eval-suite-project-mismatch': {
    description:
      'The eval suite belongs to another project and suites never move. Publish or build its versions in the project that owns it.',
    details: [
      {
        key: 'suiteId',
        meaning: 'the suite id',
      },
    ],
  },
  'eval-run-not-found': {
    description: 'No eval run exists with that id in the tenant.',
    details: [
      {
        key: 'runId',
        meaning: 'the run id that was looked up',
      },
    ],
    seeAlso: ['guides/evals/compare-an-agent-version'],
  },
  'eval-run-not-rescorable': {
    description:
      "Only a completed comparison of a test set can be rescored; this eval run is of another kind or hasn't completed.",
    details: [
      {
        key: 'runId',
        meaning: 'the run id',
      },
    ],
  },
  'judgment-not-found': {
    description:
      "No judgment exists with that id, or it's in a project your key can't read. Unregistering also needs it to be live.",
    details: [],
    seeAlso: ['guides/evals/judge-a-runs-output'],
  },
  'judge-class-not-found': {
    description: 'No live judge class exists with that id.',
    details: [],
  },
  'judging-rule-not-found': {
    description: 'The project has no judging rule with that id.',
    details: [],
  },
  'judging-item-not-found': {
    description: "The run isn't in the project's judging queue.",
    details: [],
  },
  'judging-item-not-open': {
    description:
      "The queue item isn't in the state this action needs: dismiss needs it open, and reopen needs it dismissed.",
    details: [],
  },
  'judge-class-name-taken': {
    description: 'A judge class with that name already exists in this scope. Pick another name.',
    details: [],
  },
  'judge-class-not-applicable': {
    description:
      "The judge class you named doesn't exist, or doesn't apply to this run's project or agent.",
    details: [],
  },
  'judge-class-not-allowed': {
    description:
      "The judge class limits who may assert it, and your key or role isn't one of them, so you can't record a judgment as that class.",
    details: [
      {
        key: 'action',
        meaning: 'the action that was refused',
      },
      {
        key: 'resource',
        meaning: 'the resource it was refused on',
      },
      {
        key: 'reason',
        meaning: 'why the caller was refused',
      },
    ],
  },
  'agent-version-not-found': {
    description:
      "The agent has no active version with that number: it was never registered or has since been unregistered. Pick a version from the agent's version list.",
    details: [],
  },
  'promotion-not-found': {
    description: 'No promotion with that id exists for this agent.',
    details: [],
    seeAlso: ['guides/evals/release-an-agent-version'],
  },
  'nothing-to-roll-back': {
    description:
      "The scope's live version has no earlier version to go back to. Unpin the scope to fall back to the scope above, or name a version to roll back to.",
    details: [],
  },
  'not-pinned': {
    description:
      "The scope has no live version of its own, so there's nothing to roll back or unpin. Pin a version for the scope first.",
    details: [],
  },
  'gate-failed': {
    description:
      'A gate policy refused the promotion because one or more of its checks failed. The refusal is recorded; read the failing checks and fix what they name.',
    details: [
      {
        key: 'promotionId',
        meaning: 'the recorded refused promotion',
      },
      {
        key: 'policy',
        meaning: 'the gate policy that applied (id and version), or null',
      },
      {
        key: 'checks',
        meaning: 'every check the gate ran, with whether each passed',
      },
      {
        key: 'proposalId',
        meaning: 'the proposal, when the request came through a proposal',
      },
    ],
  },
  'promotion-superseded': {
    description:
      "The scope's live version changed while the gate was running, so the check no longer applies. Check the promotion again against the new live version.",
    details: [],
  },
  'promotion-gate-unsupported': {
    description:
      "A gate policy applies to this promotion, and the deployment can't record a gated promotion, so the promotion is refused.",
    details: [],
  },
  'separate-approver-required': {
    description:
      'The approval requires a different person from the one who requested it, and you asked for it. Ask another reviewer to approve.',
    details: [
      {
        key: 'approvalId',
        meaning: 'the approval that needs another approver',
      },
    ],
    seeAlso: ['guides/approvals/decide-an-approval'],
  },
  'gate-policy-not-found': {
    description: 'No gate policy with that id exists, or it has no version with that number.',
    details: [
      {
        key: 'policyId',
        meaning: 'the policy id that was looked up',
      },
    ],
    seeAlso: ['POST /v1/gate-policies'],
  },
  'gate-policy-already-registered': {
    description:
      'The gate policy already has a version with that number. Publish with a new version number.',
    details: [],
  },
  'gate-policy-scope-taken': {
    description:
      'Another gate policy already gates this agent for the same scope. Publish a new version of that policy instead, or unregister it first.',
    details: [
      {
        key: 'heldBy',
        meaning: 'id of the policy that holds the scope',
      },
    ],
  },
  'gate-policy-scope-changed': {
    description:
      "A new version of a gate policy can't change the agent or the scope the policy gates. Create a new policy for the other agent or scope.",
    details: [],
  },
  'gate-policy-scope-unpinned': {
    description:
      'The scope has no live version of its own, so the gate policy would not take effect. Pin a version for the scope first.',
    details: [],
  },
  'gate-policy-needs-pin': {
    description:
      "The scope has a gate policy, and a gated scope keeps its own live version, so it can't be unpinned. Unregister the gate policy first, or roll back instead.",
    details: [],
  },
  'gate-policy-descendant-unpinned': {
    description:
      'The change would also move a narrower scope that a gate policy applies to and that has no live version of its own, bypassing its gate. Pin that scope at its current version first.',
    details: [],
  },
  'principal-not-found': {
    description:
      "The person or service account the key is for doesn't exist in this tenant or has been unregistered, or the request names none. Name an existing one with `for`.",
    details: [],
  },
  'role-exceeds-principal': {
    description:
      "An admin key was requested for a principal that isn't a tenant admin. Mint a member key instead.",
    details: [],
  },
  'key-project-mismatch': {
    description:
      'Your key is limited to one project, and the request names another project, or asks to mint a key not limited to your project. Use the project the key is limited to.',
    details: [
      {
        key: 'keyProjectId',
        meaning: 'the project your key is limited to',
      },
      {
        key: 'projectId',
        meaning: 'the project the request names',
      },
      {
        key: 'action',
        meaning: 'the action that was refused',
      },
      {
        key: 'resource',
        meaning: 'the resource it was refused on',
      },
      {
        key: 'reason',
        meaning: 'why the caller was refused',
      },
    ],
  },
  'token-expiry-exceeds-minter': {
    description:
      "The new key would outlive the key minting it. Give it an `expiresAt` no later than the minting key's expiry.",
    details: [
      {
        key: 'latestExpiresAt',
        meaning: 'the latest expiry the new key may have',
      },
      {
        key: 'action',
        meaning: 'the action that was refused',
      },
      {
        key: 'resource',
        meaning: 'the resource it was refused on',
      },
      {
        key: 'reason',
        meaning: 'why the caller was refused',
      },
    ],
  },
  'service-account-not-found': {
    description: 'No service account with that id exists in this tenant.',
    details: [],
  },
  'service-account-name-taken': {
    description:
      'An active service account in this tenant already has that name. Choose another name.',
    details: [],
  },
  'service-account-unregistered': {
    description: "The service account has been unregistered, so it can't be granted anything.",
    details: [],
  },
  'identity-user-email-taken': {
    description: 'Another person in this tenant already has that email address.',
    details: [
      {
        key: 'userId',
        meaning: 'the existing person who has the email',
      },
    ],
  },
  'last-tenant-admin': {
    description:
      "This person is the only tenant admin, so they can't be unregistered or lose the admin grant. Make someone else a tenant admin first.",
    details: [
      {
        key: 'reason',
        meaning: "on unregister: 'last-tenant-admin'",
      },
      {
        key: 'userId',
        meaning: 'on unregister: the person',
      },
    ],
  },
  'seed-user-admin': {
    description:
      "The person is the seed user, whom the runtime makes tenant admin at every start, so the admin grant can't be removed while that setting stands. Unset the seed user and restart first.",
    details: [],
  },
  'identity-user-unregister-refused': {
    description: "You can't unregister yourself or the seed user. Ask another tenant admin.",
    details: [
      {
        key: 'reason',
        meaning: "why it was refused: 'yourself' or 'seed-user'",
      },
      {
        key: 'userId',
        meaning: 'the person who was to be unregistered',
      },
    ],
  },
  'identity-user-unregistered': {
    description: "The person was removed from the tenant, so they can't be granted anything.",
    details: [],
  },
  'person-grants-unsupported': {
    description:
      "The runtime runs without an authorization store, so it can't read or change a person's grants.",
    details: [],
  },
  'permissions-unsupported': {
    description:
      "The runtime runs without an authorization store, so it can't say what the caller may do. Read whoami's `tenantAdmin` and `reviewerRole` instead.",
    details: [],
  },
  'agent-version-live': {
    description:
      "The version is live in one or more scopes, so it can't be unregistered. Roll back, unpin or promote another version there first.",
    details: [
      {
        key: 'agentId',
        meaning: 'the agent',
      },
      {
        key: 'version',
        meaning: 'the version',
      },
      {
        key: 'scopes',
        meaning: 'the scopes where it is live',
      },
    ],
  },
  'artifact-too-large': {
    description: 'The uploaded artifact is larger than the upload cap. Upload a smaller file.',
    details: [
      {
        key: 'maxBytes',
        meaning: 'the largest accepted size, in bytes',
      },
    ],
  },
  'run-not-finished': {
    description:
      "The run hasn't completed with an output, so there's nothing to judge. Wait until it completes.",
    details: [],
  },
  'item-not-found': {
    description: "The pointer in `item` resolves to nothing in the run's output. Fix the pointer.",
    details: [],
  },
  'test-sets-not-supported': {
    description:
      "This deployment can't list judged runs, so it can't build test sets from judgments.",
    details: [],
  },
  'run-failures-not-supported': {
    description: "This deployment can't group failed runs by cause.",
    details: [],
  },
  'memory-operation-unsupported': {
    description:
      "This runtime's memory doesn't support the operation: listing fact history, deleting facts or verifying facts.",
    details: [],
  },
  'conversation-unregister-unsupported': {
    description: "This runtime can't unregister conversations.",
    details: [],
  },
  'authz-membership-unsupported': {
    description:
      "Authorization is enforced, and the runtime can't change a team or membership together with its permissions, so it refuses and changes nothing.",
    details: [
      {
        key: 'method',
        meaning: "the missing operation in the runtime's tenant-hierarchy binding",
      },
    ],
  },
  'guardrail-outcomes-not-supported': {
    description: "This deployment doesn't record guardrail outcomes.",
    details: [],
  },
  'eval-run-already-terminal': {
    description:
      "The eval run has already finished, failed or been cancelled, so it can't be cancelled.",
    details: [
      {
        key: 'runId',
        meaning: 'the eval run',
      },
      {
        key: 'status',
        meaning: 'its final status',
      },
    ],
    seeAlso: ['guides/evals/compare-an-agent-version'],
  },
  'dispatcher-not-registered': {
    description:
      "The runtime has no eval-run dispatcher for the suite's kind, so it can't start a run of that suite.",
    details: [
      {
        key: 'evalKind',
        meaning: 'the suite kind with no dispatcher',
      },
    ],
    seeAlso: ['guides/evals/compare-an-agent-version'],
  },
  'dispatcher-input-invalid': {
    description:
      "The eval run's input doesn't fit the suite's kind: neither an agent nor a flow reference was given, or the kind's validation rejected the target or comparison.",
    details: [],
  },
  'mcp-endpoint-not-found': {
    description: 'No MCP endpoint is registered with that id.',
    details: [
      {
        key: 'endpointId',
        meaning: 'the endpoint id that was looked up',
      },
    ],
    seeAlso: ['GET /v1/mcp/endpoints/{endpointId}', 'GET /v1/mcp/endpoints/{endpointId}/resources'],
  },
  'mcp-endpoint-already-registered': {
    description:
      'An MCP endpoint with that id is already registered. Use another id or unregister the existing one.',
    details: [
      {
        key: 'endpointId',
        meaning: 'the endpoint id',
      },
    ],
    seeAlso: ['POST /v1/mcp/endpoints'],
  },
  'invalid-mcp-endpoint': {
    description:
      "The body of `POST /v1/mcp/endpoints` isn't a valid MCP endpoint registration: an unknown field, a missing or empty id or name, an unknown transport, or a config that doesn't match its transport.",
    details: [
      {
        key: 'reason',
        meaning:
          'short machine-readable reason, such as `unknown-field`, `empty-endpoint-id`, `unknown-transport`, `missing-config`, `config-transport-mismatch` or `invalid-secret-ref`',
      },
    ],
  },
  'mcp-resource-not-found': {
    description: 'The MCP endpoint is registered, but it has no resource at the URI you asked for.',
    details: [
      {
        key: 'endpointId',
        meaning: 'id of the MCP endpoint',
      },
      {
        key: 'uri',
        meaning: "the resource URI that wasn't found",
      },
    ],
    seeAlso: ['GET /v1/mcp/endpoints/{endpointId}/resources/{uri}'],
  },
  'mcp-prompt-not-found': {
    description:
      'The MCP endpoint is registered, but it has no prompt with the name you asked for.',
    details: [
      {
        key: 'endpointId',
        meaning: 'id of the MCP endpoint',
      },
      {
        key: 'promptName',
        meaning: "the prompt name that wasn't found",
      },
    ],
    seeAlso: ['POST /v1/mcp/endpoints/{endpointId}/prompts/{name}'],
  },
  'mcp-resource-read-failed': {
    description:
      'The runtime reached the MCP endpoint but listing or reading its resources failed, for example because the remote server answered with a protocol error. Retry later or check the endpoint.',
    details: [
      {
        key: 'endpointId',
        meaning: 'id of the MCP endpoint',
      },
      {
        key: 'uri',
        meaning: 'the resource URI being read; present when reading one resource, not when listing',
      },
    ],
    seeAlso: [
      'GET /v1/mcp/endpoints/{endpointId}/resources',
      'GET /v1/mcp/endpoints/{endpointId}/resources/{uri}',
    ],
  },
  'mcp-prompt-get-failed': {
    description:
      'The runtime reached the MCP endpoint but listing its prompts or fetching the named prompt failed, for example because the remote server answered with a protocol error.',
    details: [
      {
        key: 'endpointId',
        meaning: 'id of the MCP endpoint',
      },
      {
        key: 'promptName',
        meaning: 'the prompt being fetched; present when fetching one prompt, not when listing',
      },
    ],
    seeAlso: [
      'GET /v1/mcp/endpoints/{endpointId}/prompts',
      'POST /v1/mcp/endpoints/{endpointId}/prompts/{name}',
    ],
  },
  'session-not-found': {
    description:
      '`POST /v1/auth/refresh` was called with a session that has been revoked or no longer exists. Sign in again to get a new session.',
    details: [
      {
        key: 'sessionId',
        meaning: 'id of the session that no longer exists',
      },
    ],
    seeAlso: ['guides/sso/sessions'],
  },
  'session-revoked': {
    description:
      "The API doesn't send this code. A revoked session is answered `auth-revoked`, or `session-not-found` by `POST /v1/auth/refresh`.",
    details: [],
    seeAlso: ['#auth-revoked', 'guides/sso/sessions'],
  },
  'session-expired': {
    description:
      "A session token's absolute lifetime has ended. Sign in again to get a new session.",
    details: [],
    seeAlso: ['guides/sso/sessions'],
  },
  'session-inactive': {
    description:
      "A session token has been idle longer than the deployment's inactivity timeout, so it's refused. Sign in again.",
    details: [],
    seeAlso: ['guides/sso/sessions'],
  },
  'identity-provider-not-found': {
    description: 'No identity provider with that id is registered for the tenant.',
    details: [
      {
        key: 'providerId',
        meaning: "the provider id that wasn't found",
      },
    ],
    seeAlso: ['guides/sso/index'],
  },
  'identity-provider-already-registered': {
    description:
      'An identity provider with that id is already registered for the tenant. Use a different id, or change the existing provider with a patch.',
    details: [
      {
        key: 'providerId',
        meaning: 'the id that is already taken',
      },
    ],
    seeAlso: ['guides/sso/index'],
  },
  'identity-provider-invalid': {
    description:
      "The deployment couldn't use the provider's configuration (for example, its issuer discovery failed or its SAML metadata didn't parse), or `kind` is `oauth2`, which sign-in doesn't use.",
    details: [
      {
        key: 'providerId',
        meaning:
          'id of the provider being registered or changed; may be absent for an `oauth2` body without one',
      },
    ],
  },
  'identity-providers-operator-managed': {
    description:
      "The deployment's operator manages sign-in, so changing identity providers needs the deployment's own token; a tenant admin's key is refused.",
    details: [],
  },
  'license-operator-only': {
    description:
      "`GET /v1/license` is for the deployment's own token, or for an admin of the tenant when the deployment serves a single tenant. Other callers are refused.",
    details: [],
  },
  'invalid-provider-config': {
    description:
      "The identity provider body is invalid: a field is missing, has the wrong type, isn't a valid URL, is a plaintext secret, or can't be changed. The message names the field.",
    details: [],
    seeAlso: ['guides/sso/index'],
  },
  'auth-not-session-token': {
    description:
      "`POST /v1/auth/refresh` or `POST /v1/auth/logout` was called with a token that isn't a session token (`kgi_sk_*`). Bearer API tokens are managed through `/v1/tokens`.",
    details: [],
    seeAlso: ['guides/sso/sessions'],
  },
  'cookie-session-not-refreshable': {
    description:
      "`POST /v1/auth/refresh` was called with a browser (cookie) session. These sessions aren't refreshed; sign in again when the session ends.",
    details: [],
    seeAlso: ['guides/sso/sessions'],
  },
  'token-sign-in-needs-an-api-token': {
    description:
      "`POST /v1/auth/token-sign-in` was called while signed in by a session. It takes an API token in the Authorization header, so there's nothing to exchange.",
    details: [],
  },
  'redirect-uri-not-allowed': {
    description: "The API doesn't send this code.",
    details: [],
    seeAlso: ['guides/sso/sign-in'],
  },
  'redirect-uri-mismatch': {
    description: "The API doesn't send this code.",
    details: [],
    seeAlso: ['guides/sso/sign-in'],
  },
  'refresh-token-invalid': {
    description:
      'The session token was rotated by a refresh and is no longer valid. Retry with the fresh token from the last refresh.',
    details: [],
    seeAlso: ['guides/sso/sessions'],
  },
  'identity-user-not-found': {
    description:
      "No user with that id exists under this tenant (or the person named isn't a member of it).",
    details: [
      {
        key: 'userId',
        meaning: "the user id that wasn't found",
      },
    ],
  },
  'identity-revoke-failed': {
    description:
      "Revoking all of a user's sessions failed on the server. Retry; if it persists, contact the operator.",
    details: [
      {
        key: 'userId',
        meaning: 'the user whose sessions were being revoked',
      },
    ],
    seeAlso: ['POST /v1/identity/users/{userId}/revoke-sessions'],
  },
  'signature-invalid': {
    description:
      "The deployment's signature isn't valid: it isn't base64, can't be verified, or doesn't match the signed envelope of image digest, version, index hash, tenant and publish time.",
    details: [],
  },
  'signer-not-trusted': {
    description:
      "The key that signed the deployment isn't on the tenant's trust list. Trust the key, then deploy again.",
    details: [
      {
        key: 'signerKeyId',
        meaning: "id of the signing key that isn't trusted",
      },
    ],
  },
  'image-unverifiable': {
    description:
      "The runtime couldn't verify the deployment's image: the registry probe failed, or the registry's digest differs from the digest in the image reference.",
    details: [
      {
        key: 'imageRef',
        meaning: 'the image reference that was checked',
      },
    ],
    seeAlso: ['POST /v1/deployments'],
  },
  'deployment-validation-failed': {
    description:
      "The deployment's manifest has invalid definitions, or a tool names a model provider's key. Each problem is listed in `details.issues`; fix them and deploy again.",
    details: [
      {
        key: 'issues',
        meaning: 'list of problems, each naming the primitive, its index, id, path and message',
      },
    ],
  },
  'deployment-not-found': {
    description: 'No deployment with that id exists under the tenant.',
    details: [
      {
        key: 'deploymentId',
        meaning: "the deployment id that wasn't found",
      },
    ],
    seeAlso: ['GET /v1/deployments/{deploymentId}', 'POST /v1/deployments/{deploymentId}/secrets'],
  },
  'compliance-evidence-not-found': {
    description: 'No exportable compliance evidence record with that id exists under the tenant.',
    details: [
      {
        key: 'evidenceId',
        meaning: "the evidence id that wasn't found",
      },
    ],
    seeAlso: ['GET /v1/compliance/evidence/{evidenceId}'],
  },
  'compliance-export-failed': {
    description:
      'Signing the compliance evidence export failed on the server. Retry; if it persists, contact the operator.',
    details: [],
    seeAlso: ['POST /v1/compliance/evidence/export'],
  },
  'org-not-found': {
    description:
      "The org doesn't exist in the tenant: it never existed or was deleted. Also returned when creating or changing a project or team with an unknown `orgId`.",
    details: [
      {
        key: 'orgId',
        meaning: "the org id that wasn't found",
      },
    ],
    seeAlso: ['GET /v1/orgs/{orgId}'],
  },
  'team-not-found': {
    description: 'No team with that id exists under the tenant.',
    details: [
      {
        key: 'teamId',
        meaning: "the team id that wasn't found",
      },
    ],
  },
  'project-not-found': {
    description:
      "The project doesn't exist in the tenant, or your key can't see it. For `GET /v1/projects/default`, the tenant has no Default project.",
    details: [
      {
        key: 'projectId',
        meaning: "the project id that wasn't found; absent for the missing Default project",
      },
    ],
  },
  'team-membership-not-found': {
    description: "The user isn't a member of the team.",
    details: [
      {
        key: 'teamId',
        meaning: 'the team',
      },
      {
        key: 'userId',
        meaning: "the user who isn't a member",
      },
    ],
    seeAlso: ['PATCH /v1/teams/{teamId}/memberships/{userId}'],
  },
  'project-membership-not-found': {
    description: "The user isn't a member of the project.",
    details: [
      {
        key: 'projectId',
        meaning: 'the project',
      },
      {
        key: 'userId',
        meaning: "the user who isn't a member",
      },
    ],
    seeAlso: ['PATCH /v1/projects/{projectId}/memberships/{userId}'],
  },
  'membership-exists': {
    description:
      'The user is already a member with another role. Their existing role is kept; change it with a role update instead.',
    details: [
      {
        key: 'role',
        meaning: 'the role they already hold',
      },
    ],
  },
  'team-grant-not-found': {
    description: 'The team has no role on that project.',
    details: [],
  },
  'team-grant-exists': {
    description:
      'The team already holds another role on the project. Change the role instead of adding it again.',
    details: [
      {
        key: 'role',
        meaning: 'the role the team already holds',
      },
    ],
  },
  'project-access-unsupported': {
    description:
      "The runtime has no authorization store, so it can't say who has access to the project.",
    details: [],
  },
  'provider-key-refused': {
    description:
      "The request names a model provider's key as a secret for something that isn't that provider, such as a tool, an MCP endpoint or a webhook endpoint. Store the key under its own name and use that name.",
    details: [
      {
        key: 'secret',
        meaning: "name of the secret that is a model provider's key",
      },
      {
        key: 'providerId',
        meaning: 'id of the provider that owns that key',
      },
    ],
  },
  'provider-key-in-use': {
    description:
      'The `secret_ref` of the provider being registered names a secret already used by a tool, MCP endpoint, webhook endpoint or webhook trigger. Give each a key of its own.',
    details: [
      {
        key: 'secret',
        meaning: 'name of the secret',
      },
      {
        key: 'usedBy',
        meaning: 'list of the things using it, each with kind and id',
      },
    ],
  },
  'slug-conflict': {
    description:
      'The slug is taken: another org, team or project in the tenant already has it, or a project in the same org. Choose another slug.',
    details: [
      {
        key: 'resource',
        meaning: 'kind of thing that conflicts: `org`, `team` or `project`',
      },
      {
        key: 'slug',
        meaning: 'the taken slug; on org delete, `slugs` lists them instead',
      },
    ],
    seeAlso: ['POST /v1/orgs'],
  },
  'project-default-already-exists': {
    description: "The tenant already has a Default project, so a second one can't be created.",
    details: [],
    seeAlso: ['POST /v1/projects'],
  },
  'tenant-not-found': {
    description: "The tenant your key belongs to doesn't exist.",
    details: [
      {
        key: 'tenantId',
        meaning: "the tenant id that wasn't found",
      },
    ],
    seeAlso: ['GET /v1/tenant'],
  },
  'tenant-config-not-found': {
    description: "The API doesn't send this code.",
    details: [],
    seeAlso: ['deploy/operate'],
  },
  'tenant-config-revision-conflict': {
    description:
      'The tenant config entry changed since the revision you sent in `ifRevision`, so the write is refused. Read the entry again and retry with its current revision.',
    details: [
      {
        key: 'currentRevision',
        meaning: 'the revision stored now',
      },
    ],
    seeAlso: ['PATCH /v1/tenant/config'],
  },
  'authz-denied': {
    description:
      "The API doesn't send this code. A refused action is answered `permission-denied`.",
    details: [],
  },
  'authz-backend-unavailable': {
    description:
      "The store that holds permissions couldn't be read, so the runtime can't tell what the caller may do. Try the request again shortly.",
    details: [],
  },
  'tenant-policy-unavailable': {
    description:
      "A tenant policy that an agent turn must apply couldn't be loaded or evaluated, so the turn fails instead of running without it.",
    details: [
      {
        key: 'policyKind',
        meaning: 'the kind of policy that failed, for example `hitl`',
      },
    ],
    seeAlso: ['deploy/operate'],
  },
  'env-not-found': {
    description:
      "The env entry named in the path doesn't exist in the scope and environment you asked for.",
    details: [
      {
        key: 'name',
        meaning: 'the env entry name that was not found',
      },
    ],
    seeAlso: ['GET /v1/env/{name}'],
  },
  'secret-not-found': {
    description:
      "The secret doesn't exist in the scope and environment you named, or it was revoked. A deployment that references a missing secret gets the same answer.",
    details: [
      {
        key: 'name',
        meaning: 'the secret name that was not found',
      },
    ],
  },
  'secret-revoked': {
    description: "The secret was revoked, so its value can't be read or rotated.",
    details: [
      {
        key: 'name',
        meaning: 'the revoked secret name (in binding results)',
      },
    ],
  },
  'secret-version-not-found': {
    description: 'The secret exists but has no version with the number you asked for.',
    details: [
      {
        key: 'name',
        meaning: 'the secret name',
      },
      {
        key: 'versionId',
        meaning: 'the version number that was not found',
      },
    ],
    seeAlso: ['GET /v1/secrets/{name}/versions/{versionId}'],
  },
  'scope-kind-required': {
    description:
      "A secrets or env request leaves out the scope: `scopeKind` is missing from the query, or the body's `scope` is missing or has a `kind` other than `tenant`, `org` or `project`.",
    details: [],
    seeAlso: ['DELETE /v1/env/{name}', 'DELETE /v1/secrets/{name}'],
  },
  'scope-mismatch': {
    description:
      "Two scopes in one request disagree: the body `scope` differs from the query `scopeKind`/`scopeId`, or the body `scope.tenantId` isn't your tenant.",
    details: [],
    seeAlso: ['DELETE /v1/secrets/{name}', 'PUT /v1/env/{name}'],
  },
  'env-name-required': {
    description:
      "The `envName` query parameter is missing, or isn't a valid environment name (lowercase letters, digits and hyphens, starting with a letter, up to 63 characters).",
    details: [],
    seeAlso: ['DELETE /v1/env/{name}'],
  },
  'env-name-mismatch': {
    description:
      'The `envName` in the body differs from the `envName` in the query string. Send one, or make them equal.',
    details: [],
    seeAlso: ['POST /v1/secrets/{name}/rotate', 'PUT /v1/env/{name}'],
  },
  'env-cross-scope': {
    description: "The API doesn't send this code.",
    details: [],
    seeAlso: ['guides/secrets/per-environment-values'],
  },
  'reserved-name-prefix': {
    description:
      "The name starts with the prefix reserved for the runtime's own secrets, so you can't write it.",
    details: [],
    seeAlso: ['guides/secrets/store-a-secret'],
  },
  'secret-value-too-large': {
    description: 'The secret value is larger than the size limit the secrets store accepts.',
    details: [],
    seeAlso: ['guides/secrets/store-a-secret'],
  },
  'secret-write-conflict': {
    description:
      'The secret write collides with what is stored: you used `create-new` for a name that already exists, or the version you based a write on is no longer current.',
    details: [
      {
        key: 'currentVersion',
        meaning: 'the version stored now (present when the secret already exists)',
      },
    ],
  },
  'env-write-conflict': {
    description:
      'The env entry changed since the revision you based the write on. Read the entry again and retry with the current revision.',
    details: [
      {
        key: 'currentRevision',
        meaning: 'the revision stored now',
      },
    ],
    seeAlso: ['PUT /v1/env/{name}'],
  },
  'secret-encryption-failed': {
    description:
      "The runtime couldn't encrypt the secret value (the key service refused to produce a data key), so nothing was stored.",
    details: [],
    seeAlso: ['guides/secrets/store-a-secret', 'deploy/secret-manager'],
  },
  'secret-decryption-failed': {
    description:
      "The runtime couldn't decrypt a stored secret value (the key service failed to unwrap its key).",
    details: [],
    seeAlso: ['guides/secrets/store-a-secret', 'deploy/secret-manager'],
  },
  'secret-provider-unavailable': {
    description:
      "The external secret provider can't be reached, or the active secrets store can't do provider-driven rotation, so send the new value yourself.",
    details: [],
  },
  'secret-provider-unauthorized': {
    description:
      "The external secret provider rejected the runtime's credentials, so the secret can't be read or written. Ask an admin to fix the provider access.",
    details: [],
    seeAlso: ['deploy/secret-manager'],
  },
  'secret-provider-rate-limited': {
    description: 'The external secret provider is rate limiting the runtime. Wait and retry.',
    details: [
      {
        key: 'retryAfterMs',
        meaning:
          'how long the provider asked to wait, in milliseconds, when it said (in binding results)',
      },
    ],
    seeAlso: ['deploy/secret-manager'],
  },
  'secret-store-error': {
    description:
      "The secrets store failed in a way the other secret codes don't cover, such as a database error, an invalid name for the store, or a provider feature it doesn't support.",
    details: [],
    seeAlso: ['guides/secrets/store-a-secret'],
  },
  'secret-operation-unsupported': {
    description:
      "The secrets store doesn't support this operation. Under `kindgi dev` secrets live in env files and have no versions or revocation, so edit or remove the name there.",
    details: [],
  },
  'env-store-error': {
    description:
      "The env store failed, for example a database error, so the entry wasn't read or written.",
    details: [],
    seeAlso: ['guides/secrets/per-environment-values'],
  },
  'trigger-not-found': {
    description:
      'No trigger (schedule, webhook trigger or event trigger) with that id exists for your tenant, or the id belongs to a trigger of another kind.',
    details: [
      {
        key: 'triggerId',
        meaning: 'the trigger id that was not found',
      },
    ],
    seeAlso: ['POST /v1/schedules/{triggerId}/owner'],
  },
  'trigger-invalid-config': {
    description:
      "The trigger's schedule settings are invalid, for example a cron expression that doesn't parse or fires more often than the minimum interval.",
    details: [
      {
        key: 'triggerId',
        meaning: 'the trigger being updated (updates only)',
      },
    ],
    seeAlso: ['guides/runs/run-on-a-schedule'],
  },
  'trigger-webhook-id-conflict': {
    description:
      'A webhook trigger with that `webhookId` is already registered for your tenant. Pick another id.',
    details: [],
    seeAlso: ['guides/webhooks/start-runs-from-webhooks'],
  },
  'trigger-already-in-state': {
    description:
      'The trigger is already in the state you asked for, such as pausing a paused trigger or resuming one that is running.',
    details: [
      {
        key: 'triggerId',
        meaning: 'the trigger id',
      },
    ],
    seeAlso: ['guides/runs/run-on-a-schedule'],
  },
  'trigger-register-failed': {
    description: "The runtime couldn't save the new trigger because of a storage error.",
    details: [],
    seeAlso: ['guides/runs/run-on-a-schedule'],
  },
  'trigger-update-failed': {
    description: "The runtime couldn't update the trigger because of a storage error.",
    details: [
      {
        key: 'triggerId',
        meaning: 'the trigger id',
      },
    ],
    seeAlso: ['guides/runs/run-on-a-schedule'],
  },
  'trigger-lifecycle-failed': {
    description:
      "The runtime couldn't pause, resume or fire the trigger because of a storage error.",
    details: [
      {
        key: 'triggerId',
        meaning: 'the trigger id',
      },
    ],
    seeAlso: ['guides/runs/run-on-a-schedule'],
  },
  'trigger-operation-unsupported': {
    description:
      "This deployment doesn't support the operation on triggers, such as listing a schedule's fire history or running it now.",
    details: [],
  },
  'webhook-refused': {
    description:
      "The inbound webhook request doesn't prove who sent it. The answer is the same whatever the reason, so nothing about the trigger leaks.",
    details: [],
  },
  'webhook-gone': {
    description:
      'The webhook trigger the request is addressed to was unregistered. Only a sender that signs correctly learns this.',
    details: [],
  },
  'webhook-body-too-large': {
    description:
      "The request body is larger than the receiver takes: the receiver's overall cap, or the trigger's own `bodyLimitBytes`.",
    details: [],
  },
  'webhook-body-not-json': {
    description: "The request says its content type is JSON, but the body doesn't parse as JSON.",
    details: [],
  },
  'webhook-endpoint-not-found': {
    description: 'No outbound webhook endpoint with that id exists in your tenant.',
    details: [
      {
        key: 'endpointId',
        meaning: 'the endpoint id that was not found',
      },
    ],
    seeAlso: ['POST /v1/webhook-endpoints/{endpointId}/test'],
  },
  'webhook-delivery-not-found': {
    description: 'The endpoint has no delivery with that id.',
    details: [
      {
        key: 'deliveryId',
        meaning: 'the delivery id that was not found',
      },
    ],
    seeAlso: ['POST /v1/webhook-endpoints/{endpointId}/test'],
  },
  'webhook-url-refused': {
    description:
      'The deployment refuses the endpoint URL, for example because of where it points. The message says why.',
    details: [
      {
        key: 'reason',
        meaning: 'why the URL was refused',
      },
    ],
  },
  'webhook-secret-not-found': {
    description:
      "The secret the endpoint references doesn't exist. Store the secret first, then register the endpoint.",
    details: [
      {
        key: 'secretRef',
        meaning: 'the secret reference that was not found (name and environment)',
      },
    ],
  },
  'webhook-secret-too-weak': {
    description:
      'The signing secret is too weak: it must be `whsec_` followed by base64 of at least 24 random bytes. `POST /v1/webhook-endpoints/generate-secret` makes a valid one.',
    details: [
      {
        key: 'secretRef',
        meaning: 'the secret reference that was too weak (name and environment)',
      },
    ],
  },
  'token-mint-failed': {
    description:
      "The runtime couldn't sign a public run token, for example because it has no usable signing key. Report it to an admin of the deployment.",
    details: [],
    seeAlso: ['POST /v1/tokens/public'],
  },
  stuck: {
    description:
      "A flow run reached a point where no step is ready and no branch is left to decide, so the run fails. Check the flow's edges and their conditions.",
    details: [
      {
        key: 'runId',
        meaning: 'the run that failed',
      },
    ],
    seeAlso: ['guides/flows/branch-a-flow', 'guides/flows/dry-run-a-flow'],
  },
};

/** Codes a response can carry that aren't in the API's map, each with its own status. */
export const OUTSIDE_THE_MAP = [
  {
    code: 'tarball-hash-missing',
    status: 400,
    description:
      'A request to the build service (the `build` endpoint `kindgi build` and `kindgi deploy` send packs to) has no `X-Content-SHA256` header. `kindgi build` sends it for you.',
    seeAlso: ['reference/cli/build'],
  },
  {
    code: 'tarball-hash-invalid',
    status: 400,
    description:
      "The build request's `X-Content-SHA256` header isn't `sha256:` followed by 64 hex digits, or 64 hex digits alone.",
    seeAlso: ['reference/cli/build'],
  },
  {
    code: 'tarball-too-large',
    status: 413,
    description:
      'The pack sent to the build service is larger than 512 MiB. Leave build output and dependencies out of the pack.',
    seeAlso: ['reference/cli/build'],
  },
  {
    code: 'tarball-hash-mismatch',
    status: 400,
    description:
      "The pack the build service received doesn't hash to the `X-Content-SHA256` the request named, so it was changed or cut short on the way. Send it again.",
    seeAlso: ['reference/cli/build'],
  },
  {
    code: 'build-job-not-found',
    status: 404,
    description: 'The build service has no build job with that id.',
    seeAlso: ['reference/cli/build'],
  },
  {
    code: 'build-job-gone',
    status: 410,
    description:
      'The build job ended longer ago than the build service keeps jobs, so its status and output are gone. Build again.',
    seeAlso: ['reference/cli/build'],
  },
  {
    code: 'forbidden',
    status: 403,
    description:
      'Under `kindgi dev`, the runtime gives the console its sign-in token only on the same machine (localhost, `127.0.0.1` or `[::1]`). Open the console from that machine.',
    seeAlso: ['reference/cli/dev', 'reference/cli/console'],
  },
  {
    code: 'sign-in-unavailable',
    status: 500,
    description:
      "Signing in failed on the server, for example because its database didn't answer. Nothing about the cause is sent to the browser; a sign-in page shows the code instead of JSON. Try again.",
    seeAlso: ['deploy/sign-in'],
  },
];

/** access.kindgi.com's errors, which come in its own shape: `{ error, message }`. */
export const ACCESS_ERRORS = {
  intro:
    "`kindgi license renew` renews a deployment's license key at access.kindgi.com (`POST https://access.kindgi.com/v1/renew`). A refusal comes in that service's own shape, with no `code` wrapper and no `requestId`; the `message` says what to do, and the CLI prints it.",
  errors: [
    {
      error: 'bad-request',
      status: 400,
      description:
        "The body isn't a renewal request. A body over the size limit is answered the same way, with status `413`.",
      seeAlso: ['deploy/renew-the-license-key'],
    },
    {
      error: 'unauthorized',
      status: 401,
      description:
        "No renewer has this deployment's key, or the request's signature doesn't verify. Enroll the deployment with `kindgi license enroll`, then add it at access.kindgi.com.",
      seeAlso: ['deploy/renew-the-license-key', 'reference/cli/license'],
    },
    {
      error: 'stale-request',
      status: 401,
      description:
        "The request's time is more than 5 minutes off. Check the clock of the machine that sent it.",
      seeAlso: ['deploy/renew-the-license-key'],
    },
    {
      error: 'replayed',
      status: 401,
      description: 'This exact request was used before. Send a new one.',
      seeAlso: ['deploy/renew-the-license-key'],
    },
    {
      error: 'rate-limited',
      status: 429,
      description: 'Too many renewals for this key. The next one can go an hour later.',
      seeAlso: ['deploy/renew-the-license-key'],
    },
    {
      error: 'renewer-stopped',
      status: 403,
      description:
        "This deployment's renewal was stopped. Enroll it again with `kindgi license enroll`, or sign in at access.kindgi.com for a key.",
      seeAlso: ['deploy/renew-the-license-key', 'reference/cli/license'],
    },
    {
      error: 'denied',
      status: 403,
      description: "Dev access isn't available for this account. Write to contact@kindgi.com.",
      seeAlso: ['deploy/renew-the-license-key'],
    },
    {
      error: 'key-revoked',
      status: 403,
      description: "The account's license key was revoked. Write to contact@kindgi.com.",
      seeAlso: ['deploy/renew-the-license-key'],
    },
    {
      error: 'not-entitled',
      status: 403,
      description:
        "The license has no contract term on record, so access.kindgi.com doesn't renew it. Write to contact@kindgi.com.",
      seeAlso: ['deploy/renew-the-license-key'],
    },
    {
      error: 'term-ended',
      status: 403,
      description:
        "The license's contract term has ended, so it isn't renewed. The key you have runs until its own date. Write to contact@kindgi.com to extend the term.",
      seeAlso: ['deploy/renew-the-license-key'],
    },
    {
      error: 'unavailable',
      status: 503,
      description:
        'No key could be issued: the service failed to store or sign it. Try again later.',
      seeAlso: ['deploy/renew-the-license-key'],
    },
  ],
};
