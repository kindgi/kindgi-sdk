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
      "The request body is well-formed JSON but fails validation, for example an agent, flow, tool, policy or test set definition that breaks the rules, or a version pin that can't be resolved. Fix the entries in `details.issues` and resend. On `POST /v1/improve-runs`, a version with nothing for the Improve run to work on is refused with no issues, and `details.reason` says what it lacks.",
    details: [
      {
        key: 'issues',
        meaning: 'list of problems, each with a path to the offending field and a message',
      },
      {
        key: 'reason',
        meaning:
          "on `POST /v1/improve-runs`, why the version has nothing for the Improve run to work on: `no-tunable-keys`, or `no-pinned-prompt-block` for a run on the agent's instructions (the `prompt` tier); other refusals leave it out",
      },
    ],
  },
  'reference-out-of-scope': {
    description:
      "A request names an item its project can't reach: a tool, agent, flow, guardrail, data block, check or test set that isn't registered in the project, its org or the tenant, or a version of an agent, flow or test set that the project doesn't run, such as one made in an earlier environment and not yet promoted. Nothing is written. Register the item where the project reaches it, use it from the project that has it, or promote the version first.",
    details: [
      {
        key: 'issues',
        meaning:
          'list of the references refused, each with the `path` it was named at, its `kind` and `id`, and a message',
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
      "The request is malformed: the body isn't valid JSON or isn't an object, a JSON body nests objects and arrays deeper than the limit, a field has the wrong type or value, a `projectId` isn't a UUID, or a `cursor` wasn't issued by this list. Fix the input named in the message.",
    details: [
      {
        key: 'maxDepth',
        meaning: 'the most levels a JSON body may nest, when it nests deeper',
      },
    ],
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
      "Your key or session isn't allowed to do this on this resource, or lacks a capability the route needs, which the message names. For a permission, ask an admin for it. A key carries only the capabilities it was made with, and only ones the person who made it holds: use a key made with that capability.",
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
  'participant-not-allowed': {
    description:
      "A turn would run as a participant, and you may not read that participant's memory. A turn reads and keeps its participant's memory, so running as one takes what the memory API takes: you're the participant yourself (that user, with their session or their own API key, never a service account's key), or you hold `write` on the turn's project. When the turn's project isn't known, only the participant may. It's checked wherever a turn gets a participant: `input.participantId` on `POST /v1/runs`, `participantId` on `POST /v1/conversations`, and a conversation's own participant when you post a turn into it, whatever the body names. Into a conversation you can't read, the refusal answers `404 conversation-not-found` instead. Nothing was started or opened. Use a key or role with `write` on the turn's project, or have the participant run it.",
    details: [
      {
        key: 'action',
        meaning: 'the action that was refused: `write`',
      },
      {
        key: 'resource',
        meaning:
          "what it was refused on, as type:id: `conversation:<id>` when you posted into a conversation (never its participant or project), else `project:<id>`, the turn's project, or `tenant:<id>` when that isn't known",
      },
      {
        key: 'reason',
        meaning:
          "why it was refused; when you posted into a conversation, it names neither the conversation's participant nor its project",
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
  'second-factor-required': {
    description:
      "The workspace requires a second factor at sign-in. Signing in to the console with an API token is refused, since a token can't give one: sign in another way, with your second factor. Taking your own second factor off is refused too: replace it (`POST /v1/identity/me/second-factor` with a code), or ask a tenant admin to remove it.",
    details: [
      {
        key: 'action',
        meaning: 'the action that was refused (token sign-in only)',
      },
      {
        key: 'resource',
        meaning: 'the resource it was refused on, as type:id (token sign-in only)',
      },
      {
        key: 'reason',
        meaning: 'why the check refused it (token sign-in only)',
      },
    ],
    seeAlso: ['deploy/self-hosted/sign-in'],
  },
  'second-factor-invalid': {
    description:
      "The code from the authenticator app, or the recovery code, isn't right: try the code the app shows now. Replacing a second factor that's set up takes a code from it. Too many wrong codes lock it for a while (`second-factor-locked`).",
    details: [],
    seeAlso: ['deploy/self-hosted/sign-in'],
  },
  'second-factor-locked': {
    description:
      'Too many wrong codes lately for this person: no code is checked until the `Retry-After` header says. Nothing changed.',
    details: [],
    seeAlso: ['deploy/self-hosted/sign-in'],
  },
  'second-factor-unusable': {
    description:
      "The person's authenticator key can't be opened any more: the deployment's sign-in secret changed, and the previous one isn't configured. A recovery code still works, and so does setting the second factor up again with one; otherwise a tenant admin removes it.",
    details: [],
    seeAlso: ['deploy/self-hosted/sign-in'],
  },
  'second-factor-enroll-first': {
    description:
      'Requiring a second factor from a session made without one would end that session at its next request. Set up your own second factor and sign in again with it, then require one. An API key may change the setting.',
    details: [],
    seeAlso: ['deploy/self-hosted/sign-in'],
  },
  'second-factor-not-set-up': {
    description:
      'The person has no second factor set up: there are no recovery codes to replace, and nothing to take off. Set one up with `POST /v1/identity/me/second-factor`.',
    details: [],
    seeAlso: ['deploy/self-hosted/sign-in'],
  },
  'second-factor-not-started': {
    description:
      'There is no new key to confirm, or the one given is over an hour old. Start again with `POST /v1/identity/me/second-factor`, and confirm with a code from the new key.',
    details: [],
    seeAlso: ['deploy/self-hosted/sign-in'],
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
    description:
      "The conversation doesn't exist in your tenant, or you can't read it: one you can't read answers as if it weren't there when you read it or its messages, or are refused closing it, unregistering it or adding a turn. Check the conversation id, and that your key or role can read its project.",
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
      "The API doesn't send this code. Cancelling a test run that has finished is answered `test-run-already-terminal`.",
    details: [],
    seeAlso: ['#test-run-already-terminal'],
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
  'run-held-by-parent': {
    description:
      "The run is a subflow's child run, left for its parent run's next resume, which resumes it too. Only the parent's resume resumes it, so a resume of the child itself is refused.",
    details: [
      {
        key: 'runId',
        meaning: 'the run',
      },
      {
        key: 'parentRunId',
        meaning: 'its parent run, whose resume resumes it',
      },
    ],
    seeAlso: ['concepts/runs'],
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
  'idempotency-store-unavailable': {
    description:
      "A write sent with an Idempotency-Key couldn't be checked against its key, because the store that keeps the keys couldn't be read, so the write didn't run and changed nothing. Retry with the same key after the `Retry-After` header.",
    details: [],
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
        meaning: 'the conversation',
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
      "An erasure cleared the run's content (a person's words were removed), so there is nothing to correct or replay.",
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
  'test-set-gone': {
    description:
      'The test set has no active versions left; it exists but every version is unregistered. Reinstate a version or publish a new one.',
    details: [
      {
        key: 'testSetId',
        meaning: 'the test set id',
      },
    ],
    seeAlso: ['GET /v1/test-sets/{testSetId}'],
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
      "The tool id and version you're publishing already exist. Published versions are immutable, so publish under a new version number. On a deployment, the runtime holds a version of the pack's tool, active or unregistered, with another definition: give the tool a new version in the pack. The message names the fields that differ.",
    details: [
      {
        key: 'toolId',
        meaning: "the tool's id (single publish)",
      },
      {
        key: 'version',
        meaning: 'the version that is already registered (single publish)',
      },
      {
        key: 'primitive',
        meaning: 'on a deployment: the kind of item refused (`tool`)',
      },
      {
        key: 'id',
        meaning: 'on a deployment: the refused tool, as `id@version`',
      },
      {
        key: 'fields',
        meaning:
          "on a deployment: the fields of the tool's definition that differ: the manifest's top-level fields, and `modulePath` for where its code lives in the pack",
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
  'tool-kind-mismatch': {
    description:
      "A tool's active versions are all one kind: an MCP endpoint's tool, which the runtime registers from the endpoint's listing, or tools published here. This version is the other kind, so nothing was written. Publish or deploy it under another id, or unregister the endpoint (or the other kind's versions) first.",
    details: [
      {
        key: 'toolId',
        meaning: "the tool's id (single publish or reinstate)",
      },
      {
        key: 'version',
        meaning: 'the version refused (single publish or reinstate)',
      },
      {
        key: 'endpointId',
        meaning: "when the id is an MCP endpoint's tool: that endpoint's id",
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
  'environment-takes-promotions': {
    description:
      "The project you named (or the Default project, when you named none) is a later environment of an environment order, and a later environment takes builds only by promotion from the one before it. Deploy into the order's first environment and promote the build from there. A publish through the API into a later environment is refused the same way, and so is an edited version of an agent that names one: new versions are made in the first environment. A tool's pin for a later environment is refused too: a tool's pin acts when an agent or flow version is made, which is in the first environment, so pin the tool there. Nothing is written.",
    details: [
      {
        key: 'firstProjectId',
        meaning:
          "the order's first environment, where builds and new versions go; present when you can read that project",
      },
      {
        key: 'position',
        meaning: "the project's place in the order, from 0 (the first)",
      },
    ],
  },
  'promotion-not-next-environment': {
    description:
      "A deployment is promoted only to the next environment of its environment order, one environment at a time. The project named isn't that one, or the deployment is in the order's last environment, or in no order. `kindgi environments list` shows the order. Nothing is written.",
    details: [
      {
        key: 'position',
        meaning:
          "the next environment's place in the order, from 0 (the first); absent when there's none",
      },
      {
        key: 'nextProjectId',
        meaning: "the next environment's project; present when you can read it",
      },
    ],
    seeAlso: ['POST /v1/deployments/{deploymentId}/promotions'],
  },
  'promotion-values-not-ready': {
    description:
      "Values the build needs in the target environment aren't ready there: a secret, env value or model key set nowhere a run there looks; one revoked where a run reads it; a pack env name set only as a secret, or both as a secret and as a plain value; or no model provider registered for an agent that runs on any provider. Each one is in `details.values`: set them in the target, then promote again. The promotion check lists the same, writing nothing. Nothing is written.",
    details: [
      {
        key: 'values',
        meaning:
          'each value not ready: its `name`, `kind`, what needs it (`neededBy`), where a run finds it (`foundAt`, when it is set) and why it is not ready (`problem`); never a value',
      },
    ],
    seeAlso: [
      'POST /v1/deployments/{deploymentId}/promotions',
      'POST /v1/deployments/{deploymentId}/promotions/check',
    ],
  },
  'deployment-superseded': {
    description:
      'A deployment is promoted only while it serves. With `details.environment` `source`: newer deployments in its environment serve every tool version it ships, so it no longer serves there; promote the newer one. With `target`: the target environment has this build already, superseded there; promote the newer build from the environment before it. Nothing is written.',
    details: [
      {
        key: 'environment',
        meaning: '`source` (the deployment promoted) or `target` (the environment it goes to)',
      },
      {
        key: 'newerDeploymentId',
        meaning:
          'the newest deployment there that serves every tool version this one ships; present when there is one',
      },
    ],
    seeAlso: ['POST /v1/deployments/{deploymentId}/promotions'],
  },
  'promotions-unsupported': {
    description:
      "This runtime can't promote deployments: it has nowhere to write a promotion. The promotion check still answers. Nothing is written.",
    details: [],
    seeAlso: ['POST /v1/deployments/{deploymentId}/promotions'],
  },
  'pin-scope-spans-environments': {
    description:
      "A flow or tool with a project in an environment order is pinned one project at a time: a pin for the whole tenant or an organization would act in every environment of the order at once. Pin a flow in each environment's project, and a tool in the order's first environment, where agent and flow versions are made.",
    details: [],
  },
  'tool-not-pinnable': {
    description:
      "The tool follows its server (a tool an MCP endpoint's catalog lists: its metadata has the catalog's `kindgi.mcp` key) or the runtime (a tool the runtime ships), so a pin couldn't keep it still. Reference it with a version range instead.",
    details: [
      {
        key: 'toolId',
        meaning: 'the tool',
      },
    ],
  },
  'live-scope-spans-environments': {
    description:
      "An agent with a project in an environment order is made live one project at a time, whether one project serves it or several. A live change for the whole tenant or an organization would reach every environment of the order at once, so it's refused. Name a project in the change's scope, or a segment of it. To take a build from one environment to the next and make it live there, promote it (`kindgi promote --make-live`). Nothing is changed.",
    details: [],
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
  'conversation-project-mismatch': {
    description:
      "The run names a project other than the conversation's. A conversation belongs to one project, and its turns run there. Name its project, or omit `projectId` to continue it in its own.",
    details: [
      {
        key: 'conversationId',
        meaning: 'the conversation the turn was posted into',
      },
      {
        key: 'projectId',
        meaning: 'the project the run named',
      },
      {
        key: 'conversationProjectId',
        meaning: "the conversation's own project",
      },
    ],
    seeAlso: ['POST /v1/runs', 'guides/agents/conversations'],
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
      "A blocking guardrail stopped the agent's turn, a halting guardrail's check couldn't run, or a `retry` guardrail's attempts ran out: at the final answer it sends each answer it fails back to the model for a new one, and in the agent loop it refuses a call, withholds a result or sends a reply back, until it has failed `retry.maxAttempts` answers or replies. The run fails; the violations say which guardrails fired, and `point` says where in the turn.",
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
        key: 'attempts',
        meaning:
          "the attempts the turn had when a `retry` guardrail's ran out, the first one included: its answers at the final answer, or in the agent loop its replies the guardrail sent back or refused or withheld a call of; absent when a `halt` guardrail stopped it",
      },
      {
        key: 'point',
        meaning:
          'where in the turn the guardrails stopped it: `before-tool`, `after-tool` or `model-step`; absent at the final answer',
      },
      {
        key: 'callId',
        meaning: "at `before-tool` and `after-tool`: the model's id for the call",
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
        meaning:
          "the cap reached: the agent's own, or, for steps, 32 when its `maxSteps` is higher, since a turn makes at most 32 model calls",
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
      "The model provider call failed, for example it refused the key or was rate limited, or the model's reply can't be used (for example, two of its tool calls share an id). When the call failed, the message carries the provider's own words.",
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
  'block-unresolvable': {
    description:
      "A data block the agent uses (its prompt, settings or model settings) can't be loaded: no published version matches its version range, the pinned version is gone, it's the other kind of block, or the runtime serves no blocks. Under `kindgi dev`, blocks come only from the pack's files: add the block under the pack's blocks folder, at a version the range takes.",
    details: [
      {
        key: 'blockId',
        meaning: 'the block',
      },
      {
        key: 'requestedRange',
        meaning: 'the version range or pin the agent asked for',
      },
      {
        key: 'runId',
        meaning: 'the run that failed',
      },
    ],
    seeAlso: ['guides/evals/change-a-prompt-or-setting'],
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
      "No model provider could take the agent's call: the agent declares no capabilities, or no provider meets them under your policy, or the pinned route is no longer allowed, or a provider registered for the tenant can't be set up on this runtime (the message says why; `GET /v1/providers/{providerId}/check` gives the adapter's words).",
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
      "Resuming a run at this waitpoint through `POST /v1/runs/{runId}/resume` isn't available. Only a run paused until another system answers (a `pause:` waitpoint) resumes there, on a server that pauses runs. A run waiting for an approval continues when a reviewer decides it.",
    details: [],
  },
  'wait-token-not-found': {
    description:
      "No open wait matches: the link's token is unknown (a wrong or mistyped link answers the same), or the run doesn't wait at the `waitpointId` you named. A run's open waits are in `waitingFor.tokens` on `GET /v1/runs/{runId}`.",
    details: [],
  },
  'wait-token-closed': {
    description:
      'The wait is over, so it takes no other answer: it already took a different answer, its time passed, its run was cancelled, or its tool call answered without waiting or was retried and waits on a new link. Sending the answer it took again is accepted, not refused.',
    details: [
      {
        key: 'state',
        meaning:
          'why the wait is over: `answered` or `completed` (it took a different answer), `timed-out`, `cancelled` or `unused`',
      },
    ],
  },
  'wait-token-output-invalid': {
    description:
      "The answer doesn't fit the output schema of the tool that waits for it. Nothing is taken and the wait stays open: fix the answer and send it again before the wait times out.",
    details: [
      {
        key: 'issues',
        meaning: 'list of problems, each with a path to the offending field and a message',
      },
    ],
  },
  'unsupported-media-type': {
    description:
      "The body isn't JSON where the route takes JSON alone: an answer to a wait (`POST /v1/wait-tokens/{token}/complete`) is sent with `Content-Type: application/json`, or with no body at all.",
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
      "You sent too many requests, or a tenant reached one of its limits: a webhook trigger got more deliveries than its per-minute limit, a client sent too many refused webhook requests, too many sign-in lookups came from one source, a client sent wait tokens' links more than 600 requests in a minute, or the tenant reached its limit on API requests or webhook deliveries a minute, or on runs waiting to start. A tenant's API requests to `/v1` and `/s3` count together; on `/s3`, its limit answers as S3 does, with `503 SlowDown` and `Retry-After`, not with this code. On a server with budgets kept per tenant (Kindgi Cloud), it's also the answer when the tenant's schemas took their budget compiling, or its instructions templates rendering, in the last 60 seconds; an agent's turn refused this way fails its run with this code. A deploy is refused with it too when the tenant's image reads unpacked as much as they may in an hour. Retry after the `Retry-After` header; a refusal by the limit on runs waiting to start has none: retry once some have started.",
    details: [
      {
        key: 'limit',
        meaning:
          "the tenant's limit that was reached: `api-requests`, `webhook-receives`, `runs-pending`, a budget, `schema-compile-time` or `template-render-time`, or `tenant-unpack-hour`, its image reads in the last hour. Absent when the limit isn't the tenant's",
      },
      {
        key: 'runsPending',
        meaning:
          "the tenant's limit on runs waiting to start, on a `runs-pending` refusal; absent when the server doesn't name it",
      },
      {
        key: 'budgetMs',
        meaning:
          "for a budget, the milliseconds the tenant's work of that kind may take in 60 seconds",
      },
      {
        key: 'runId',
        meaning: "when a budget refused an agent's turn, the run the turn belongs to",
      },
    ],
  },
  'approvals-pending-limit': {
    description:
      "A gate asked for an approval while the tenant's approvals waiting for a decision were at its limit (set by whoever runs the server). Nothing waits for an approval nobody can see: the step fails, naming the limit. `POST /v1/runs` answers `429` when the call waits for its run; with `options.wait: false` it answers `202`, and the run fails with this code. A request to make a version live whose release gate policy wants an approval is refused with it. Once some of the approvals waiting are decided, try again.",
    details: [
      {
        key: 'approvalsPending',
        meaning:
          "the tenant's limit on approvals waiting for a decision; absent when the server doesn't name it",
      },
    ],
  },
  'invite-capped': {
    description:
      "Too many invitations sent: to this person, from the tenant, or from the whole deployment. The limits are the server's. Nothing changed and nothing was sent. Try again after the `Retry-After` header, or, if their invitation hasn't expired, tell them to sign in.",
    details: [
      {
        key: 'userId',
        meaning: 'the person whose invitation was to be sent again',
      },
    ],
  },
  'turn-memory-limit-reached': {
    description:
      "The runtime's agent turns hold more memory than its limit leaves this turn: the tenant's share (`KINDGI_TURN_MEMORY_PER_TENANT_MIB`) or the runtime's whole (`KINDGI_TURN_MEMORY_MIB`). The turn's run fails, and every tool call it finished is in the conversation, so a new turn there doesn't call it again. Retry later, or use a smaller conversation.",
    details: [
      {
        key: 'limit',
        meaning: '`tenant` or `server`: which limit refused the turn',
      },
      {
        key: 'heldBytes',
        meaning: "what that limit's turns held, in bytes",
      },
      {
        key: 'limitBytes',
        meaning: 'the limit, in bytes',
      },
      {
        key: 'runId',
        meaning: 'the run that failed',
      },
    ],
    seeAlso: ['GET /v1/runs/{runId}', 'reference/env-vars'],
  },
  'internal-server-error': {
    description:
      'The server hit an unexpected error while handling the request. Retry; if it persists, contact support with the `requestId`.',
    details: [],
    seeAlso: ['GET /v1/deployments'],
  },
  'database-busy': {
    description:
      "The database was too busy to answer the read in time: a lock held by other work or a query past the database's time limit ended it, or no database connection came free within the server's wait. Only a `GET` or `HEAD` answers it. Retry after the `Retry-After` header. A request with any other method that the database was too busy for answers a 500 (`internal-server-error`, or the code of what failed, such as `persistence-error`), since it may have saved part of its work: check what it changed before you send it again.",
    details: [],
    seeAlso: ['GET /v1/runs', 'reference/env-vars'],
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
      "Signing the export with the deployment's export key failed. The reason is in the runtime's log, not the message.",
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
      {
        key: 'recordState',
        meaning:
          "why the run has no record yet: `being-written` while it's being written, after a flow run ends; `failed` when writing it failed. Absent when the run has no record at all. More states may come",
      },
      {
        key: 'reason',
        meaning:
          "with `recordState: failed`, why: `read-failed` (its journal couldn't be read), `build-failed` (the record couldn't be built from it) or `write-failed` (it couldn't be saved). More codes may come",
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
  'suggested-change-not-found': {
    description:
      "The suggested change doesn't exist in the tenant, or your key can't see its agent.",
    details: [
      {
        key: 'suggestedChangeId',
        meaning: 'the suggested change id that was looked up',
      },
    ],
    seeAlso: ['guides/evals/propose-a-change'],
  },
  'suggested-change-invalid-state-transition': {
    description:
      "The suggested change's status doesn't allow this action, or it changed while the request ran. Read the suggested change again and retry if it still applies.",
    details: [
      {
        key: 'suggestedChangeId',
        meaning: 'the suggested change id',
      },
      {
        key: 'status',
        meaning:
          'the suggested change status that refused the action; absent when it changed mid-request',
      },
    ],
  },
  'suggested-change-needs-pin': {
    description:
      'The agent has no live version for the whole tenant, so a new version would serve every scope nothing is pinned for. Make its current version live tenant-wide, then retry.',
    details: [],
  },
  'improve-unsupported': {
    description: "This runtime doesn't run Improve.",
    details: [],
  },
  'improve-run-not-found': {
    description: "The Improve run doesn't exist, or your key can't read its agent.",
    details: [
      {
        key: 'improveRunId',
        meaning: 'the Improve run id that was looked up',
      },
    ],
    seeAlso: ['POST /v1/improve-runs/{improveRunId}/cancel'],
  },
  'improve-run-finished': {
    description: 'The Improve run has already ended, so there is nothing to cancel.',
    details: [
      {
        key: 'improveRunId',
        meaning: 'the Improve run id',
      },
      {
        key: 'status',
        meaning: 'the status the Improve run ended with',
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
  'retention-over-limit': {
    description:
      "The retention policy keeps its domain's records longer than this server's limit for that domain, or holds them (`graceSeconds: -1`). Publish it with a `graceSeconds` at or under the limit. A version over the limit stays retired: reinstating it is refused the same way. A `*` policy isn't refused: in a limited domain, the server keeps records no longer than the limit.",
    details: [
      {
        key: 'domain',
        meaning: "the policy's retention domain",
      },
      {
        key: 'graceSeconds',
        meaning: "the policy's grace, in seconds (`-1`: a hold)",
      },
      {
        key: 'limitSeconds',
        meaning: "this server's limit for the domain, in seconds",
      },
      {
        key: 'policyId',
        meaning: 'the policy id (on a reinstate)',
      },
      {
        key: 'version',
        meaning: 'the version (on a reinstate)',
      },
    ],
    seeAlso: ['deploy/retention'],
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
      "That block version is already published; versions never change, so publish a new version. On a deployment, the runtime holds a version of the pack's block with other content, or unregistered: give the block a new version in the pack, or reinstate the unregistered one (`kindgi blocks reinstate`). The message names each one.",
    details: [
      {
        key: 'blockId',
        meaning: 'the block id (single publish)',
      },
      {
        key: 'version',
        meaning: 'the version that exists (single publish)',
      },
      {
        key: 'primitive',
        meaning: 'on a deployment: the kind of item refused (`block`)',
      },
      {
        key: 'id',
        meaning: 'on a deployment: the refused block, as `id@version`',
      },
    ],
  },
  'block-project-mismatch': {
    description:
      'The block belongs to another project. Publish its versions, or deploy the pack that brings it, in the project that owns it.',
    details: [
      {
        key: 'blockId',
        meaning: 'the block id (single publish)',
      },
      {
        key: 'primitive',
        meaning: 'on a deployment: the kind of item refused (`block`)',
      },
      {
        key: 'id',
        meaning: 'on a deployment: the refused block, as `id@version`',
      },
    ],
  },
  'test-set-not-found': {
    description: 'No test set is registered with that id.',
    details: [
      {
        key: 'testSetId',
        meaning: 'the test set id that was looked up',
      },
    ],
    seeAlso: ['GET /v1/test-sets/{testSetId}'],
  },
  'test-set-already-registered': {
    description:
      'That test set id and version are already registered; versions never change, so publish a new version.',
    details: [
      {
        key: 'testSetId',
        meaning: 'the test set id',
      },
      {
        key: 'version',
        meaning: 'the version that exists',
      },
    ],
  },
  'test-set-project-mismatch': {
    description:
      'The test set belongs to another project and test sets never move. Publish or build its versions in the project that owns it.',
    details: [
      {
        key: 'testSetId',
        meaning: 'the test set id',
      },
    ],
  },
  'test-run-not-found': {
    description: 'No test run exists with that id in the tenant.',
    details: [
      {
        key: 'runId',
        meaning: 'the run id that was looked up',
      },
    ],
    seeAlso: ['guides/evals/compare-an-agent-version'],
  },
  'test-run-not-rescorable': {
    description:
      "Only a completed run on the test cases can be rescored; this test run is of another kind or hasn't completed.",
    details: [
      {
        key: 'runId',
        meaning: 'the run id',
      },
    ],
  },
  'correction-not-found': {
    description:
      "No correction exists with that id, or it's in a project your key can't read. Removing one also needs it to be live.",
    details: [],
    seeAlso: ['guides/evals/judge-a-runs-output'],
  },
  'correction-status-change-not-allowed': {
    description:
      "The change isn't allowed from the correction's status: re-sorting only from `open`, `being-fixed` or `with-owner`; `being-fixed` only from `open` or `with-owner`; `open` only from `being-fixed` or `wont-fix`; `wont-fix` from anything but `removed`. `fixed` is set only by a pin or a deploy.",
    details: [
      { key: 'from', meaning: "the correction's status" },
      { key: 'to', meaning: 'the status the change would have set' },
    ],
  },
  'corrector-group-not-found': {
    description: 'No live corrector group exists with that id.',
    details: [],
  },
  'queue-rule-not-found': {
    description: 'The project has no queue rule with that id.',
    details: [],
  },
  'expert-queue-item-not-found': {
    description: "The run isn't in the project's To correct list.",
    details: [],
  },
  'expert-queue-item-not-open': {
    description:
      "The queue item isn't in the state this action needs: dismiss needs it open, and reopen needs it dismissed.",
    details: [],
  },
  'corrector-group-name-taken': {
    description:
      'A corrector group with that name already exists in this scope. Pick another name.',
    details: [],
  },
  'corrector-group-not-applicable': {
    description:
      "The corrector group you named doesn't exist, or doesn't apply to this run's project or agent.",
    details: [],
  },
  'corrector-group-not-allowed': {
    description:
      "The corrector group limits who may assert it, and your key or role isn't one of them, so you can't record a correction as that class.",
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
    description: "No entry with that id exists in this agent's go-live history.",
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
      "The scope has no pin of its own (for an agent, no live version of its own), so there's nothing to roll back or unpin. Pin a version for the scope first.",
    details: [],
  },
  'gate-failed': {
    description:
      'A release gate policy refused making the version live because one or more of its checks failed. The refusal is recorded; read the failing checks and fix what they name.',
    details: [
      {
        key: 'promotionId',
        meaning: 'the recorded refused request to make it live',
      },
      {
        key: 'policy',
        meaning: 'the release gate policy that applied (id and version), or null',
      },
      {
        key: 'checks',
        meaning: 'every check the release gate policy ran, with whether each passed',
      },
      {
        key: 'suggestedChangeId',
        meaning: 'the suggested change, when the request came through a suggested change',
      },
    ],
  },
  'promotion-superseded': {
    description:
      "The scope's live version changed while the release gate policy was being checked, so the check no longer applies. Check the go-live again against the new live version.",
    details: [],
  },
  'promotion-gate-unsupported': {
    description:
      "A release gate policy applies to this go-live, and the deployment can't record a gated go-live, so the go-live is refused.",
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
  'named-approver-required': {
    description:
      "The approval is addressed to one person: the call it gates acts with that person's own connection, so only they decide it. You can read it, but not decide it.",
    details: [
      {
        key: 'approvalId',
        meaning: 'the approval only its approver decides',
      },
    ],
    seeAlso: ['guides/approvals/decide-an-approval'],
  },
  'gate-policy-not-found': {
    description:
      'No release gate policy with that id exists, or it has no version with that number.',
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
      'The release gate policy already has a version with that number. Publish with a new version number.',
    details: [],
  },
  'gate-policy-scope-taken': {
    description:
      'Another release gate policy already gates this agent for the same scope. Publish a new version of that policy instead, or unregister it first.',
    details: [
      {
        key: 'heldBy',
        meaning: 'id of the policy that holds the scope',
      },
    ],
  },
  'gate-policy-scope-changed': {
    description:
      "A new version of a release gate policy can't change the agent or the scope the policy gates. Create a new policy for the other agent or scope.",
    details: [],
  },
  'gate-policy-scope-unpinned': {
    description:
      'The scope has no live version of its own, so the release gate policy would not take effect. Pin a version for the scope first.',
    details: [],
  },
  'gate-policy-needs-pin': {
    description:
      "The scope has a release gate policy, and a gated scope keeps its own live version, so it can't be unpinned. Unregister the release gate policy first, or roll back instead.",
    details: [],
  },
  'gate-policy-descendant-unpinned': {
    description:
      'The change would also move a narrower scope that a release gate policy applies to and that has no live version of its own, bypassing that policy. Pin that scope at its current version first.',
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
      "Your key is limited to one project, and the request names another project, or asks to mint a key not limited to your project. Use the project the key is limited to. A promotion reads one project and writes another, so a key or session limited to a project can't promote, or check a promotion.",
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
  'capability-not-mintable': {
    description:
      "A tenant's key can't carry a system capability (`system:*`, or `kindgi:system` on a runtime serving many tenants): those are system keys' alone. Mint the key without them, or mint a system key with `POST /v1/system/keys`.",
    details: [
      {
        key: 'capabilities',
        meaning: "the capabilities asked for that a tenant's key can't carry",
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
    seeAlso: ['POST /v1/tokens', 'POST /v1/system/keys'],
  },
  'system-key-on-tenant-route': {
    description:
      "A system key was sent to a route it can't use. A system key acts in no tenant, so it reaches `/v1/system/*`, `GET /v1/license` and `GET /v1/license/usage` only: use one of the tenant's keys.",
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
    seeAlso: ['GET /v1/system/whoami'],
  },
  'system-principal-required': {
    description:
      "The route is a system route (`/v1/system/*`), and it was called with a tenant's key or a session. Call it with a system key (`kgi_sy_…`).",
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
  'system-scope-missing': {
    description:
      "The system key doesn't hold the scope this request takes, which `scope` names: the route's own, or more for what the request asks (creating a tenant without `firstAdmin`, for one). Every `/v1/system/keys` route takes the full system capability, which a scoped key doesn't hold. A deployment's secret values (`secrets=values` on its pack env) take a key holding `system:pack-env` itself: `kindgi:system` doesn't stand in for it. On a runtime serving one tenant, a system key reaches no `/v1/system/*` route, and `scope` is `kindgi:system`: the system keys take the deployment's own token there.",
    details: [
      {
        key: 'scope',
        meaning: 'the scope the request takes',
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
  'system-key-scope-not-served': {
    description:
      "The runtime serves one tenant, where a system key holds `system:license` alone, and this key holds anything else, which `scopes` names: it was minted while the runtime served many tenants, say. It's refused on every route. Mint one holding `system:license` with the deployment's own token, and revoke this one.",
    details: [
      {
        key: 'scopes',
        meaning: 'the scopes the key holds',
      },
      {
        key: 'served',
        meaning: 'the scopes a system key may hold on this runtime',
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
    seeAlso: ['POST /v1/system/keys', 'POST /v1/system/keys/{keyId}/revoke'],
  },
  'system-key-not-found': {
    description: 'No system key has that id.',
    details: [],
  },
  'system-key-expiry-required': {
    description:
      "A full system key minted by another system key must expire: set `expiresAt`. Only the deployment's own token mints one that never expires.",
    details: [],
  },
  'access-record-unavailable': {
    description:
      "The record of the operator's requests couldn't be written, so a system key's request did nothing. Retry after the `Retry-After` header.",
    details: [],
  },
  'tenant-closing': {
    description:
      "The tenant is closing. Its own keys and sessions can read and export it until it's deleted, but not change it: deletes, revocations, erasures, signing in and out, and the signed exports still work. A delivery to one of its webhook triggers that proves its sender is refused the same way, and nothing is recorded for it. So is an answer to one of its runs' waits through the wait token's link, and nothing is taken. A schedule's or webhook trigger's fire whose run starts as the tenant starts closing is recorded `skipped`, with `tenant-closing` in its `detail`, and doesn't count toward a schedule's auto-pause. A test run or an Improve run going as it starts closing stops at its next case: it ends `cancelled`, with `tenant-closing` in its `cancelReason`. The system routes that change its settings, limits, image prefix, a suspension or a deployment's endpoint refuse a closing tenant; clearing its deployments' endpoints, which retires its pack services, still works. On the S3-compatible surface, the same refusal is S3's `403 AllAccessDisabled`.",
    details: [
      {
        key: 'state',
        meaning: '`closing`',
      },
      {
        key: 'tenantId',
        meaning: 'the tenant; from a system route, or from renaming one',
      },
    ],
  },
  'tenant-suspended': {
    description:
      "The tenant is suspended. Its own keys and sessions can read and export it, but not change it until it's restored: deletes, revocations, erasures, signing in and out, and the signed exports still work. A delivery to one of its webhook triggers isn't refused: one that proves its sender is answered `202` with `skipped: tenant-suspended`, and nothing is recorded or kept for it. A sender that can redeliver by hand can resend it once the tenant is restored, and a restore is seen within 5 seconds. An answer to one of its runs' waits through the wait token's link is refused with this code, and nothing is taken: a suspension cancels the tenant's runs, paused ones included. Its schedules don't fire while it's suspended, and nothing is caught up: at the restore, a schedule's or webhook trigger's fire whose run or Improve run hadn't started is recorded `skipped`, with `tenant-suspended` in its `detail`, and a schedule that's on fires next at its first occurrence after the restore, whatever its `catchUp`. A test run or an Improve run going as it's suspended stops at its next case: it ends `cancelled`, with `tenant-suspended` in its `cancelReason`. A fire whose run was starting as the tenant was suspended is recorded `skipped` right away, with `tenant-suspended` in its `detail`. None of it counts toward a schedule's auto-pause. Setting a deployment's endpoint (`PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/endpoint`) refuses a suspended tenant too. On the S3-compatible surface, the same refusal is S3's `403 AllAccessDisabled`.",
    details: [
      {
        key: 'state',
        meaning: '`suspended`',
      },
      {
        key: 'tenantId',
        meaning: 'the tenant; from a system route only',
      },
    ],
  },
  'tenant-slug-mismatch': {
    description:
      "A purge's `confirm` isn't the tenant's slug, the second check on its id. Nothing was changed: send its slug, as `GET /v1/system/tenants/{tenantId}` gives it.",
    details: [
      {
        key: 'tenantId',
        meaning: 'the tenant',
      },
    ],
  },
  'tenant-not-closing': {
    description:
      'A purge of a tenant that is active or suspended. Only a closing tenant is purged, once its 30-day export window has passed: close it first (`POST /v1/system/tenants/{tenantId}/close`). Nothing was changed.',
    details: [
      {
        key: 'tenantId',
        meaning: 'the tenant',
      },
      {
        key: 'state',
        meaning: '`active` or `suspended`',
      },
    ],
  },
  'tenant-export-window-open': {
    description:
      "A purge of a closing tenant whose 30-day export window hasn't passed: its own keys and sessions can still read and export it. Purge it once `windowEndsAt` has passed. Nothing was changed.",
    details: [
      {
        key: 'tenantId',
        meaning: 'the tenant',
      },
      {
        key: 'windowEndsAt',
        meaning: 'when its export window ends',
      },
    ],
  },
  'purge-record-unset': {
    description:
      "A purge on a runtime with nowhere set to keep purge records (`KINDGI_TENANT_PURGE_RECORD`). Without a record, a restore from a backup older than the purge would bring the tenant back. Set it on the runtime's servers, then purge. Nothing was changed.",
    details: [
      {
        key: 'tenantId',
        meaning: 'the tenant',
      },
    ],
  },
  'purge-setting-missing': {
    description:
      "A purge of a tenant holding something the runtime has no setting to reach: artifacts with no artifacts' store set (`KINDGI_ARTIFACTS`), or an authorization store with no OpenFGA set (`KINDGI_OPENFGA_API_URL`). The message says which. Nothing was changed.",
    details: [
      {
        key: 'tenantId',
        meaning: 'the tenant',
      },
    ],
  },
  'authz-store-delete-failed': {
    description:
      "A purge's delete of the tenant's authorization store failed; the message gives OpenFGA's answer, if it gave one, and what that left. A tenant's rows go only after its store, so a failure before then leaves every row, though its artifacts' bytes may be deleted. Run the purge again once OpenFGA answers.",
    details: [
      {
        key: 'tenantId',
        meaning: 'the tenant',
      },
    ],
  },
  'tenant-purge-unsupported': {
    description: "This runtime doesn't purge tenants through the API.",
    details: [],
  },
  'tenant-slug-taken': {
    description:
      'Another tenant has that slug, creating a tenant or renaming one. A purged tenant keeps its slug. Choose another.',
    details: [
      {
        key: 'slug',
        meaning: 'the slug that is taken',
      },
    ],
  },
  'tenant-slug-in-config': {
    description:
      "A tenant's slug can't change while the server's `KINDGI_AUTH_VERIFIED_DOMAINS` names a tenant by it. When it names this tenant by its current slug, the server would find no tenant by it when it next starts: the server's operator names the tenant there by its id instead and restarts the server, and then it can be renamed. When it names the new slug, the server's next start would give those domains to this tenant: choose another slug.",
    details: [
      {
        key: 'slug',
        meaning: 'the slug the setting names: the current one, or the new one',
      },
      {
        key: 'domains',
        meaning:
          'the domains that name this tenant by its current slug; absent when the setting names the new one',
      },
    ],
    seeAlso: ['PATCH /v1/tenant'],
  },
  'tenant-setup-pending': {
    description:
      "The tenant's setup hasn't finished, so it can't be renamed yet. Sending the request that created it again finishes it.",
    details: [
      {
        key: 'tenantId',
        meaning: 'the tenant',
      },
    ],
  },
  'image-not-allowed': {
    description:
      "The deployment's image is outside the tenant's image repository: a tenant deploys only images at or under its image prefix.",
    details: [
      {
        key: 'imagePrefix',
        meaning: "the tenant's image prefix; from `POST /v1/deployments` only",
      },
    ],
  },
  'image-prefix-unset': {
    description:
      "The tenant has no image repository set, so it can't register a deployment yet. Its operator sets one with `PUT /v1/system/tenants/{tenantId}/image-prefix`.",
    details: [],
  },
  'image-prefix-taken': {
    description:
      "The image prefix equals, holds or sits inside another tenant's. Each tenant's repository is its own: choose a prefix that doesn't overlap another tenant's.",
    details: [],
  },
  'tenant-state-unavailable': {
    description:
      "The tenant's state couldn't be read, so the request changed nothing. Retry after the `Retry-After` header. On the S3-compatible surface, the same answer is S3's `503 ServiceUnavailable`.",
    details: [],
    seeAlso: ['GET /v1/tenant'],
  },
  'service-account-not-found': {
    description: 'No service account with that id exists in this tenant.',
    details: [],
  },
  'service-account-name-taken': {
    description:
      "An active service account in this tenant already has that name. Choose another name. With `runAsProject`, an active account someone made already has the project account's name, `project-<projectId>`: a tenant admin can unregister it.",
    details: [],
  },
  'service-account-unregistered': {
    description: "The service account has been unregistered, so it can't be granted anything.",
    details: [],
  },
  'trigger-owner-cannot-run-target': {
    description:
      "A trigger's owner can't run what the trigger starts: `execute` on the agent or flow, or `publish` on the agent for an improvement schedule. Checked only with an authorization store, at two points. When a schedule, webhook or mail trigger names a service account to run as (`runAsServiceAccountId`), on create or take-over: give the account the editor role on the target's project, or name another account. When it's to run as the project's own account (`runAsProject`), which runs only what the project's editors can: run it as a service account that can, or own it yourself. And when a schedule's or mail trigger's target changes, since its owner stays: the owner, a service account or a person, must be able to run the new one (not checked when you're the owner, or when the owner was unregistered or removed). A tenant admin can give an account the role (not the project's own account, whose role is fixed), or a project admin can take the trigger over first. The message names the owner and the target.",
    details: [],
  },
  'service-account-project-owned': {
    description:
      "The service account is a project's own account, the account a trigger with `runAsProject` runs as. It has no keys, so none can be minted `for` it. Its grant is fixed, so it can't be granted or ungranted anything. A trigger can't name it in `runAsServiceAccountId`: name it with `runAsProject: true` instead. An app that needs keys needs a service account of its own.",
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
  'identity-user-not-invited': {
    description:
      'The person has no invitation to send again: they have signed in already, were added before invitations, or have no email. Nothing changed.',
    details: [
      {
        key: 'userId',
        meaning: 'the person',
      },
    ],
  },
  'person-grants-unsupported': {
    description:
      "The runtime runs without an authorization store, so it can't read or change a person's grants.",
    details: [],
  },
  'agent-owner-unsupported': {
    description:
      "The runtime's agent store doesn't keep an owner, so an agent's owner can't be set. Nothing changed.",
    details: [],
  },
  'permissions-unsupported': {
    description:
      "The runtime runs without an authorization store, so it can't say what the caller may do. Read whoami's `tenantAdmin` and `reviewerRole` instead.",
    details: [],
  },
  'agent-version-live': {
    description:
      "The version is live in one or more scopes, so it can't be unregistered. Roll back, unpin or make another version live there first.",
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
  'flow-version-pinned': {
    description:
      "The flow version is pinned in one or more scopes, so it can't be unregistered, and the flow can't be deleted while any of its versions is. Move the pin to another version, or unpin it, first.",
    details: [
      {
        key: 'flowId',
        meaning: 'the flow',
      },
      {
        key: 'version',
        meaning: 'the version',
      },
      {
        key: 'scopes',
        meaning: 'the scopes where it is pinned',
      },
    ],
  },
  'tool-version-pinned': {
    description:
      "The tool version is pinned in one or more scopes, so it can't be unregistered, and the tool can't be deleted while any of its versions is. Move the pin to another version, or unpin it, first.",
    details: [
      {
        key: 'toolId',
        meaning: 'the tool',
      },
      {
        key: 'version',
        meaning: 'the version',
      },
      {
        key: 'scopes',
        meaning: 'the scopes where it is pinned',
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
  'request-too-large': {
    description:
      "The request body is larger than the API's limit. Send a smaller body. An artifact upload and a webhook delivery have limits of their own (`artifact-too-large`, `webhook-body-too-large`).",
    details: [
      {
        key: 'maxBytes',
        meaning: 'the largest accepted body, in bytes',
      },
    ],
  },
  'run-not-finished': {
    description:
      "The run hasn't completed with an output, so there's nothing to correct. Wait until it completes.",
    details: [],
  },
  'item-not-found': {
    description: "The pointer in `item` resolves to nothing in the run's output. Fix the pointer.",
    details: [],
  },
  'test-sets-not-supported': {
    description:
      "This deployment can't list corrected runs, so it can't build test cases from corrections.",
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
  'pinned-versions-not-supported': {
    description: "This deployment can't list a project's pinned versions.",
    details: [],
  },
  'test-run-already-terminal': {
    description:
      "The test run has already finished, failed or been cancelled, so it can't be cancelled.",
    details: [
      {
        key: 'runId',
        meaning: 'the test run',
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
      "The runtime has no test-run dispatcher for the test set's kind, so it can't start a run of that test set.",
    details: [
      {
        key: 'evalKind',
        meaning: 'the test set kind with no dispatcher',
      },
    ],
    seeAlso: ['guides/evals/compare-an-agent-version'],
  },
  'dispatcher-input-invalid': {
    description:
      "The test run's input doesn't fit the test set's kind: neither an agent nor a flow reference was given, or the kind's validation rejected the target or comparison.",
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
      "The body of `POST /v1/mcp/endpoints` isn't a valid MCP endpoint registration: an unknown field, a missing or empty id or name, an id with a `.`, an unknown transport, or a config that doesn't match its transport.",
    details: [
      {
        key: 'reason',
        meaning:
          'short machine-readable reason, such as `unknown-field`, `empty-endpoint-id`, `dot-in-endpoint-id`, `unknown-transport`, `missing-config`, `config-transport-mismatch` or `invalid-secret-ref`',
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
  'identity-providers-need-secrets-store': {
    description:
      "The deployment has no secrets store (`KINDGI_SECRETS_BACKEND` is `none`), and an identity provider's client secret and keys are references into one, so no provider is added or changed until the operator sets one up. Removing a provider still works. Continue with Google, Microsoft or GitHub and the emailed link don't need a store.",
    details: [
      {
        key: 'providerId',
        meaning: 'the provider that was being added or changed',
      },
    ],
    seeAlso: ['deploy/self-hosted/sign-in', 'deploy/self-hosted/secret-manager'],
  },
  'license-operator-only': {
    description:
      "`GET /v1/license` and `GET /v1/license/usage` are for the deployment's own token, or a system key holding `system:license`. Where the deployment is set up to serve one tenant (without `KINDGI_TENANCY=multi`) and its database holds only that one, that tenant's admins also read the license's countdown, never its use. Other callers are refused, and the refusal recorded.",
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
  'limited-session-not-refreshable': {
    description:
      "`POST /v1/auth/refresh` was called with a session limited to a project or a role. Such a session isn't refreshed, so no copy of it can come back without its limits. Get a new one where you got this one.",
    details: [],
  },
  'limited-session-cannot-mint': {
    description:
      "`POST /v1/tokens` was called by a session limited to a project or a role. A limited session mints no keys: a key would outlive whatever ends the session. Mint the key with an API key, or with a session that isn't limited.",
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
  'site-not-found': {
    description:
      "No site with that id in the project the path names, or, revoking a key, no key with that id on the site. `GET /v1/projects/{projectId}/sites` lists the project's sites.",
    details: [],
  },
  'site-invalid': {
    description:
      "A site's settings were refused. Registering one needs a `displayName`, an `origin` and an `approvalsUrl`, and a setting the API doesn't know is refused. An `origin` is `https://` with no path, query, fragment or credentials (`http://` only on a loopback host); an `approvalsUrl` is on that origin, with `{approvalId}` in it; `allowedRoles` holds 1 to 20 role names of up to 64 characters (a-z, 0-9, `_` and `-`); a `roleMap` names only roles in `allowedRoles`, and its reviewer roles are `standard` or `senior`, never above `reviewerCeiling`; a `displayName` is 1 to 100 characters, with no control, format or invisible characters; `peopleCap` is a whole number from 1 to 10,000, and `newPeoplePerDay` from 1 to 1,000. The message says the rule that was broken.",
    details: [
      {
        key: 'field',
        meaning: 'the setting that was refused',
      },
    ],
  },
  'site-enrollment-refused': {
    description:
      '`POST /v1/auth/sites/enroll` was refused: the enrollment code is wrong, used or expired, or its site is paused or unregistered. Each of these gets the same answer. Ask a tenant admin for a new enrollment code.',
    details: [],
  },
  'site-key-invalid': {
    description:
      "The key a site posts to `POST /v1/auth/sites/enroll` isn't an Ed25519 public JWK: `kty` `OKP`, `crv` `Ed25519`, `x` the 32-byte public key in base64url, and a `kid` of 1 to 64 letters, digits, `.`, `_` and `-`. A JWK with a private part (`d`) is refused too: post the public half only. The message says which part is wrong.",
    details: [],
  },
  'site-sign-in-refused': {
    description:
      "`POST /v1/auth/site-sign-in` refused the site's statement about a person. Until the statement's signature checks out, every refusal has the reason `not-verified`, so a caller learns nothing about the site. After it, the reason is the check that refused it: `site-paused`, `site-not-vouching`, `wrong-audience`, `expired`, `issued-in-the-future`, `too-long-lived`, `replayed`, `role-not-allowed`, `person-removed` or `people-cap`.",
    details: [
      {
        key: 'reason',
        meaning:
          "why: `not-verified` until the statement's signature checks out, then the check that refused it",
      },
    ],
  },
  'site-request-too-large': {
    description:
      'A body sent to `POST /v1/auth/sites/enroll` or `POST /v1/auth/site-sign-in` is over 4096 bytes. Those routes take a few small fields: send only those.',
    details: [],
  },
  'site-person-grants-managed': {
    description:
      "The request would change what a person a site signs in may do: give them or take away a grant, a tenant role, a project or team membership or its role, or a reviewer role, or mint them a key. Such a person holds only what their site's sign-in writes: their next sign-in would undo a change, and a key would outlive a paused or unregistered site. Change their role on the site, remove the person, or pause the site instead.",
    details: [],
  },
  'site-person-not-found': {
    description:
      'The site has no link to that person: they never signed in through it. Only the people a site signs in are let back in through it. Find their id with `kindgi people list --include-removed`.',
    details: [
      {
        key: 'userId',
        meaning: 'the person who was to be let back in',
      },
    ],
  },
  'site-person-restore-refused': {
    description:
      "The site's person wasn't let back in, and nothing changed. `not-removed`: they're in the tenant and their site still knows them, so there's nothing to undo. `left`: their site said they left it. A site forgets a person who leaves, so if they come back, it signs them in as a new person. `linked-elsewhere`: they also sign in another way (through another site, or the tenant's own sign-in), and letting them back in would let them in there too: add them again instead, as a new person.",
    details: [
      {
        key: 'reason',
        meaning: "why it was refused: 'not-removed', 'left' or 'linked-elsewhere'",
      },
      {
        key: 'userId',
        meaning: 'the person who was to be let back in',
      },
    ],
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
      "The deployment's signature isn't valid: it isn't base64, can't be verified, or doesn't match the signed envelope of image digest, version, index hash, tenant and publish time. A promotion checks the signature again, over the fields the deployment keeps, and is refused the same way.",
    details: [],
  },
  'signer-not-trusted': {
    description:
      "The key that signed the deployment isn't on the tenant's trust list. Trust the key, then deploy again. A promotion is refused the same way when the key that signed the build is no longer trusted: the build isn't promoted.",
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
      {
        key: 'cause',
        meaning:
          "when a registry read failed, why: `image-not-found`, `image-file-not-found`, `image-registry-unreachable`, `image-registry-unauthorized`, `image-unreadable` (a layer that isn't an archive the runtime can read), or `image-limit-exceeded` (the image is past one of the runtime's bounds on reading an image). Absent when the read succeeded and the check after it failed",
      },
      {
        key: 'limit',
        meaning:
          "with `image-limit-exceeded`, the bound: `manifest`, `file`, `layer`, `read` or `unpack`, the image's own, so the same image is refused again. The tenant's hour of image reads is never this code: reaching it answers `rate-limit-exceeded` with `limit` `tenant-unpack-hour` and `Retry-After`",
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
    description:
      "No deployment with that id exists under the tenant. A promotion of a deployment in a project you can't read is answered the same way.",
    details: [
      {
        key: 'deploymentId',
        meaning: "the deployment id that wasn't found",
      },
    ],
    seeAlso: [
      'GET /v1/deployments/{deploymentId}',
      'POST /v1/deployments/{deploymentId}/secrets',
      'POST /v1/deployments/{deploymentId}/promotions',
      'POST /v1/deployments/{deploymentId}/promotions/check',
    ],
  },
  'project-suspended': {
    description:
      "The project is suspended, so nothing new starts in it until it's restored: a deploy into it (the named project, or the Default for a tenant-wide deploy), a run or a turn started in it, an answer to one of its runs' waits (through the wait token's link or `POST /v1/runs/{runId}/resume`; a suspension cancels its runs, paused ones included), a test run started in it, an Improve run for one of its agents, or the operator setting the pack service of one of its deployments. What's already deployed stays. A test run or an Improve run already going stops at its next case: it ends `cancelled`, with `project-suspended` in its `cancelReason`. A delivery to one of its webhook triggers isn't refused: one that proves its sender is answered `202` with `skipped: project-suspended`, and nothing is recorded or kept for it. A schedule's fire on it starts no run or Improve run: it's recorded `skipped`, with `project-suspended` in its `detail`, and doesn't count toward the schedule's auto-pause, so the schedule stays on and fires again once the project is restored. A webhook delivery taken before the suspension whose run hadn't started is recorded `skipped` the same way, and its event is dropped. Ask the operator to restore the project. A promotion from it or into it is refused too: `details.environment` says which.",
    details: [
      {
        key: 'environment',
        meaning:
          'from a promotion: `source` (the deployment promoted) or `target` (the environment it goes to)',
      },
    ],
    seeAlso: [
      'POST /v1/deployments',
      'POST /v1/test-sets/{testSetId}/runs',
      'POST /v1/improve-runs',
      'PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/endpoint',
      'POST /v1/deployments/{deploymentId}/promotions',
    ],
  },
  'pack-suspended': {
    description:
      "The operator suspended this deployment's pack, so its pack service can't be set. Lift the suspension first. A promotion of its builds from or into an environment where it's suspended is refused too: `details.environment` says which.",
    details: [
      {
        key: 'environment',
        meaning:
          'from a promotion: `source` (the deployment promoted) or `target` (the environment it goes to)',
      },
    ],
    seeAlso: [
      'PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/suspended',
      'PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/endpoint',
      'POST /v1/deployments/{deploymentId}/promotions',
    ],
  },
  'endpoint-url-invalid': {
    description:
      "The pack service URL the operator set for a deployment isn't `https://<host>`: it isn't https, or it has user info, a path, a query or a fragment. The message says which. Send the service's origin only. The refusal is recorded as the deployment's `endpoint.problem`.",
    details: [],
    seeAlso: ['PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/endpoint'],
  },
  'endpoint-host-not-allowed': {
    description:
      "The pack service's host isn't on the operator's allowlist of pack hosts (`KINDGI_PACK_ENDPOINT_HOSTS`). Use a host the allowlist covers. The refusal is recorded as the deployment's `endpoint.problem`.",
    details: [],
    seeAlso: ['PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/endpoint'],
  },
  'endpoint-name-mismatch': {
    description:
      "The pack service's host doesn't name this deployment's own service. Each deployment's pack service runs under its own name, `packServiceName` in `@kindgi/api`. The refusal is recorded as the deployment's `endpoint.problem`.",
    details: [
      {
        key: 'expected',
        meaning: "the deployment's pack service name, which the host must carry",
      },
    ],
    seeAlso: ['PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/endpoint'],
  },
  'endpoint-unreachable': {
    description:
      "The pack service didn't answer `GET /v1/info` as this deployment's service. Check that it runs and that the runtime can reach it, then set it again. The refusal is recorded as the deployment's `endpoint.problem`.",
    details: [],
    seeAlso: ['PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/endpoint'],
  },
  'endpoint-info-mismatch': {
    description:
      "The pack service answered `GET /v1/info` as another pack or version, so it doesn't serve this deployment's image. The refusal is recorded as the deployment's `endpoint.problem`.",
    details: [
      {
        key: 'differs',
        meaning:
          "the names of the `/v1/info` fields that differed from the deployment's, never their values",
      },
    ],
    seeAlso: ['PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/endpoint'],
  },
  'endpoint-not-pending': {
    description:
      "A problem was sent for a deployment that isn't waiting for a pack service. A problem goes with a `pending` one, or a `cleared` one listed as needing a pack service again (`waiting`, once a suspension is lifted).",
    details: [
      {
        key: 'status',
        meaning: "the deployment's endpoint status now: `ready`, or `cleared` and not `waiting`",
      },
    ],
    seeAlso: ['PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/endpoint/problem'],
  },
  'endpoint-not-ready': {
    description:
      "What a deployment's pack service runs was recorded for a service that isn't `ready`. A new service's revision goes with its endpoint (`packEnvRevision`); record one for a `ready` service only.",
    details: [
      {
        key: 'status',
        meaning: "the deployment's endpoint status now: `pending` or `cleared`",
      },
    ],
    seeAlso: [
      'PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/pack-env',
      'PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/endpoint',
    ],
  },
  'endpoint-retired': {
    description:
      "The env of a deployment whose pack service was retired was asked for: it isn't given out. A retired deployment's service is listed to go (`GET /v1/system/deployments?endpoint=retire`).",
    details: [
      {
        key: 'retired',
        meaning: 'why its pack service was retired, as the retire list gives it',
      },
    ],
    seeAlso: ['GET /v1/system/tenants/{tenantId}/deployments/{deploymentId}/pack-env'],
  },
  'pack-env-conflict': {
    description:
      "What a pack service runs was recorded against a revision that's no longer the one recorded: another record came first. Read the deployment's pack env again, and record against what's there now.",
    details: [
      {
        key: 'appliedRevision',
        meaning: 'the revision the service is recorded as running now, when there is one',
      },
    ],
    seeAlso: ['PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/pack-env'],
  },
  'pack-env-unsupported': {
    description:
      "This server doesn't give a pack service its declared env: its pack services take theirs from how they're run. The system pack env routes answer this on a server that doesn't run a pack service per deployment.",
    details: [],
    seeAlso: [
      'GET /v1/system/pack-env',
      'GET /v1/system/tenants/{tenantId}/deployments/{deploymentId}/pack-env',
      'PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/pack-env',
    ],
  },
  'pack-env-not-served': {
    description:
      "This server doesn't give a deployment's pack service the env its pack declares, so it lists none of its names: its pack services take theirs from how they're run. `kindgi env plan` lists the names a pack reads.",
    details: [],
    seeAlso: ['GET /v1/deployments/{deploymentId}/pack-env'],
  },
  'pack-env-unavailable': {
    description:
      "A deployment's pack env can't be given just now: its secret store failed or is rate-limited, a secret changed while it was read (twice), or the audit rows for its secrets weren't written. No value is given, and the message says which. Ask again; there's nothing for the pack's owner to do.",
    details: [],
    seeAlso: ['GET /v1/system/tenants/{tenantId}/deployments/{deploymentId}/pack-env'],
  },
  'pack-env-secrets-unaudited': {
    description:
      "A deployment's secret values were asked for (`secrets=values`) on a server with nowhere to audit them, so none is read or given. The server's operator sets up its audit store. A request without `secrets=values` isn't refused for this. A pack service held for this shows it as its deployment's problem: the platform's to fix, with nothing for the pack's owner to do.",
    details: [],
    seeAlso: ['GET /v1/system/tenants/{tenantId}/deployments/{deploymentId}/pack-env'],
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
  'org-has-environment-order': {
    description:
      "An org can't be deleted while it's the parent of an environment order, because deleting it would orphan the order. A tenant admin clears the order first (PUT /v1/environment-orders/orgs/{orgId} with []), then deletes the org.",
    details: [
      {
        key: 'orderId',
        meaning: 'the environment order the org is the parent of',
      },
    ],
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
  'production-not-allowed': {
    description:
      "You put a project in production while the tenant isn't allowed to: the server gates production (`KINDGI_PRODUCTION_GATE=on`), and the tenant's `productionAllowed` is `false`. Projects already in production stay so, and staging keeps working. Go where `details.next` says, when the server names a place, or ask whoever runs it; then put the project in production again.",
    details: [
      {
        key: 'projectId',
        meaning: "the project that wasn't put in production",
      },
      {
        key: 'next',
        meaning:
          'where to go to be allowed, for example a billing page (`KINDGI_PRODUCTION_NEXT_URL`); absent when the server names none',
      },
    ],
  },
  'production-limit-reached': {
    description:
      "You put a project in production while the tenant already had as many projects in production as its limit allows, or more (`projectsInProduction`, set by whoever runs the server). Nothing changed. A project already in production isn't counted again, and taking one out is never refused. Take a project out of production, or go where `details.next` says when the server names a place, or ask whoever runs it to raise the limit; then put the project in production again.",
    details: [
      {
        key: 'projectId',
        meaning: "the project that wasn't put in production",
      },
      {
        key: 'limit',
        meaning: 'which limit: `projects-in-production`',
      },
      {
        key: 'projectsInProduction',
        meaning: "the tenant's limit on projects in production",
      },
      {
        key: 'inProduction',
        meaning:
          "how many of the tenant's projects are in production; over the limit when the limit was lowered below it",
      },
      {
        key: 'next',
        meaning:
          'where to go for a higher limit, for example a billing page (`KINDGI_PRODUCTION_NEXT_URL`); absent when the server names none',
      },
    ],
  },
  'production-unsupported': {
    description:
      "This server's projects can't be put in production: its project store has no production setting. Every run there is a staging run.",
    details: [],
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
  'environments-unsupported': {
    description:
      "The runtime's env store or secrets store can't list the env names it holds, so the tenant's environments can't be listed whole. The message names the store.",
    details: [],
  },
  'project-in-another-order': {
    description:
      'A project in the request already belongs to another environment order. A project is in at most one order: set the other order without it, or clear that order, first.',
    details: [
      {
        key: 'projectId',
        meaning: 'the project already in another order',
      },
    ],
  },
  'project-in-environment-order': {
    description:
      "A project can't be deleted, or moved to another parent, while it's a member of an environment order. Clear it from the order first, then delete or move it.",
    details: [
      {
        key: 'orderId',
        meaning: 'the environment order the project belongs to',
      },
    ],
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
    seeAlso: ['deploy/self-hosted/operate'],
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
        meaning: 'the kind of policy that failed: `hitl`, `model-routing` or `tool-errors`',
      },
    ],
    seeAlso: ['deploy/self-hosted/operate'],
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
  'env-not-served': {
    description:
      'This runtime keeps every value under the one env it serves (`KINDGI_REFUSE_OTHER_ENVS`), and the request would store a value under another, where it would never be read: a secret or env value written under another env, or a model provider, MCP endpoint or webhook endpoint naming its secret under another. Nothing is stored. Use the env the runtime serves; `GET /v1/identity/whoami` names it (`servedEnv`). Reads and deletes under any env still work.',
    details: [
      {
        key: 'envName',
        meaning: 'the env the request named',
      },
      {
        key: 'servedEnv',
        meaning: 'the env this runtime serves, to use instead',
      },
    ],
    seeAlso: ['POST /v1/secrets', 'PUT /v1/env/{name}', 'POST /v1/providers'],
  },
  'env-cross-scope': {
    description: "The API doesn't send this code.",
    details: [],
    seeAlso: ['guides/secrets/per-environment-values'],
  },
  'reserved-name-prefix': {
    description:
      "The name starts with `kindgi.`, the prefix reserved for the runtime's own secrets. You can't store, rotate or revoke such a secret, or name one in a registration: a tool, an MCP endpoint, a webhook endpoint, a webhook trigger or a connection app.",
    details: [{ key: 'secret', meaning: 'on a registration, the reserved name it names' }],
    seeAlso: ['guides/secrets/store-a-secret'],
  },
  'secret-name-invalid': {
    description:
      "The name isn't one a new secret can have. A new secret's name is 1 to 255 ASCII letters, digits, `.`, `-` and `_`, starting with a letter, digit or `_`, not ending with `.` and with no two `.` in a row, and a secrets store can narrow that. Under `kindgi dev`, a secret is a key in your env files, so its name is capital letters, digits and underscores, not starting with a digit (`ACME_WOO_ORDERS`, not `acme-woo-orders`), and never `KINDGI_*`, the runtime's own configuration. The message says the rule, and under `kindgi dev` a name that works.",
    details: [],
    seeAlso: ['guides/secrets/store-a-secret'],
  },
  'secret-value-too-large': {
    description: 'The secret value is larger than the size limit the secrets store accepts.',
    details: [],
    seeAlso: ['guides/secrets/store-a-secret'],
  },
  'secret-value-invalid': {
    description:
      "The secrets store can't hold this value as given. Under `kindgi dev`, a secret is a key in your env files, and no env-file quoting holds a value that has a double quote, or a backslash followed by `n` or `r`, together with a carriage return or with both a single quote and a backtick. Store the value encoded (base64, say), or without one of those characters. The message says why, and never repeats the value.",
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
    seeAlso: ['guides/secrets/store-a-secret', 'deploy/self-hosted/secret-manager'],
  },
  'secret-decryption-failed': {
    description:
      "The runtime couldn't decrypt a stored secret value (the key service failed to unwrap its key).",
    details: [],
    seeAlso: ['guides/secrets/store-a-secret', 'deploy/self-hosted/secret-manager'],
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
    seeAlso: ['deploy/self-hosted/secret-manager'],
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
    seeAlso: ['deploy/self-hosted/secret-manager'],
  },
  'secret-store-error': {
    description:
      "The secrets store failed in a way the other secret codes don't cover, such as a database error, an invalid name for the store, or a provider feature it doesn't support. With your own secret manager, it's also the answer for a secret stored under a name outside the rule for new names: store its value again under a name that fits.",
    details: [],
    seeAlso: ['guides/secrets/store-a-secret', 'deploy/self-hosted/secret-manager'],
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
  'trigger-version-not-found': {
    description:
      'The trigger exists, but has no version with the number you asked for. Versions count from 1, one more for each change to the trigger.',
    details: [
      {
        key: 'triggerId',
        meaning: 'the trigger',
      },
      {
        key: 'version',
        meaning: 'the version number that was not found',
      },
    ],
    seeAlso: [
      'GET /v1/schedules/{triggerId}/versions/{version}',
      'GET /v1/webhooks/{triggerId}/versions/{version}',
      'GET /v1/mail-triggers/{triggerId}/versions/{version}',
    ],
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
      "The inbound webhook request doesn't prove who sent it: an unknown address, a missing, wrong or too old signature, or a secret that can't be read. The answer is the same for every reason; the reason is in the trigger's fires and the access audit.",
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
  'connection-app-not-found': {
    description:
      'No app registration with that id in the tenant, or it was removed. On a connect, no registration of the app is set up, or none serves the project: a tenant admin adds one. A connect request whose registration has been removed since answers it too: start a new connect once a tenant admin sets the app up again. `GET /v1/connection-apps` lists the registrations.',
    details: [
      {
        key: 'appId',
        meaning: 'the registration id that was not found, when the call named it in its path',
      },
      {
        key: 'field',
        meaning:
          'on a connect, the field that names the app (`app`, or `appId` when it named a registration)',
      },
    ],
  },
  'connection-not-found': {
    description:
      "No connection with that id that the caller can reach. A person's connection is reachable by that person and a tenant admin; the company's, by a tenant admin. It may have been disconnected.",
    details: [
      {
        key: 'connectionId',
        meaning: 'the connection id that was not found',
      },
    ],
  },
  'connection-request-not-found': {
    description:
      "No connect request with that id that the caller can act on, or none for the sign-in that came back from the app. A person's connect request is that person's alone; the company's, a tenant admin's. Start a new connect.",
    details: [
      {
        key: 'requestId',
        meaning: 'the connect request id that was not found, when the call named one',
      },
      {
        key: 'field',
        meaning: '`state`, when the sign-in came back with no state',
      },
    ],
  },
  'connection-app-invalid': {
    description:
      "An app registration that doesn't fit its app's entry, or no registration that fits a connect. A project uses one registration of an app, so a registration that would serve a project another registration of the app serves answers it too (field `projects`). So does changing a registration's client (its client id, its directory, or its GitHub App) while it has live connections: disconnect them first, then change it and connect again. The message says what's wrong.",
    details: [
      {
        key: 'field',
        meaning: 'the input field at fault, when there is one',
      },
    ],
  },
  'connection-app-unknown-entry': {
    description:
      'A registration or a connect names an app this server has no entry for, or no longer has. `GET /v1/connection-entries` lists the apps it knows.',
    details: [
      {
        key: 'field',
        meaning: 'the input field that names the app (`app`)',
      },
    ],
  },
  'connection-app-in-use': {
    description:
      'Removing an app registration that still has live connections. Remove it with `withConnections=true` to remove those connections too, or disconnect them first.',
    details: [],
  },
  'connection-not-yours': {
    description:
      'Finishing a connect that someone else started: only whoever started it can finish it, signed in as themselves.',
    details: [],
  },
  'connection-installation-unreachable': {
    description:
      "A GitHub App's connect whose person's GitHub account doesn't reach the installation, or any installation of the app. Start that request again with `newInstallation` to install the app on an account they manage, or ask an owner of the account it's installed on.",
    details: [
      {
        key: 'connectRequestId',
        meaning: 'the connect request to start again',
      },
    ],
  },
  'connection-request-expired': {
    description: 'The connect request expired before it was used. Start a new connect.',
    details: [],
  },
  'connection-request-used': {
    description:
      'The connect request was finished already: each one is used once. Start a new connect to connect again.',
    details: [],
  },
  'connection-state-expired': {
    description:
      'The sign-in at the app took longer than its state lives. Start the connect again.',
    details: [],
  },
  'connection-account-mismatch': {
    description:
      "A reconnect signed in to an account other than the connection's. Sign in with the same account; to connect another account instead, disconnect, then connect again.",
    details: [],
  },
  'connection-removing': {
    description:
      "A connect, or its finish, for a connection that's still being disconnected: an earlier disconnect didn't get to the end. Disconnect it again to finish, then connect.",
    details: [],
  },
  'connection-app-refused': {
    description:
      "The app refused or failed a call the connect needed, or didn't give what a connection needs (a refresh token, or which account signed in). Often the registration's client id, client secret or redirect URL doesn't match the app's settings. On GitHub, an install still waiting for an owner's approval is refused too, until an owner approves it. Start the connect again.",
    details: [],
  },
  'connection-store-failed': {
    description:
      "The server couldn't read or write its connections (registrations, connect requests, connections or their tokens) just now. Try again; if it keeps failing, an operator checks the database and the secrets store.",
    details: [],
  },
  'connection-notice-invalid': {
    description:
      "An app's notice to `POST /v1/connection-notices/{tenantId}/{appId}` wasn't accepted. It's one answer for every reason, such as a signature or token that doesn't check out, so the sender learns nothing from it.",
    details: [],
  },
  'connection-notice-unavailable': {
    description: "The server couldn't handle an app's notice just now. The app sends it again.",
    details: [],
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
      "Signing in failed on the server: its database didn't answer, say, or an identity provider's settings can't start a sign-in, or a SAML response the provider's page posted was refused. Nothing about the cause is sent to the browser; a sign-in page shows the code instead of JSON. The runtime's log says why, as an `sso` warning: `sign-in request failed: <reason>`, `sign-in with provider <id> didn't start: <reason>`, or `a SAML response for provider <id> was refused: <status> <code>: <message>`. Try again; when it keeps failing, the warning says what to fix.",
    seeAlso: ['deploy/self-hosted/sign-in'],
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
      seeAlso: ['deploy/self-hosted/renew-the-license-key'],
    },
    {
      error: 'unauthorized',
      status: 401,
      description:
        "No renewer has this deployment's key, or the request's signature doesn't verify. Enroll the deployment with `kindgi license enroll`, then add it at access.kindgi.com.",
      seeAlso: ['deploy/self-hosted/renew-the-license-key', 'reference/cli/license'],
    },
    {
      error: 'stale-request',
      status: 401,
      description:
        "The request's time is more than 5 minutes off. Check the clock of the machine that sent it.",
      seeAlso: ['deploy/self-hosted/renew-the-license-key'],
    },
    {
      error: 'replayed',
      status: 401,
      description: 'This exact request was used before. Send a new one.',
      seeAlso: ['deploy/self-hosted/renew-the-license-key'],
    },
    {
      error: 'rate-limited',
      status: 429,
      description: 'Too many renewals for this key. The next one can go an hour later.',
      seeAlso: ['deploy/self-hosted/renew-the-license-key'],
    },
    {
      error: 'renewer-stopped',
      status: 403,
      description:
        "This deployment's renewal was stopped. Enroll it again with `kindgi license enroll`, or sign in at access.kindgi.com for a key.",
      seeAlso: ['deploy/self-hosted/renew-the-license-key', 'reference/cli/license'],
    },
    {
      error: 'denied',
      status: 403,
      description: "Dev access isn't available for this account. Write to contact@kindgi.com.",
      seeAlso: ['deploy/self-hosted/renew-the-license-key'],
    },
    {
      error: 'key-revoked',
      status: 403,
      description: "The account's license key was revoked. Write to contact@kindgi.com.",
      seeAlso: ['deploy/self-hosted/renew-the-license-key'],
    },
    {
      error: 'not-entitled',
      status: 403,
      description:
        "The license has no contract term on record, so access.kindgi.com doesn't renew it. Write to contact@kindgi.com.",
      seeAlso: ['deploy/self-hosted/renew-the-license-key'],
    },
    {
      error: 'term-ended',
      status: 403,
      description:
        "The license's contract term has ended, so it isn't renewed. The key you have runs until its own date. Write to contact@kindgi.com to extend the term.",
      seeAlso: ['deploy/self-hosted/renew-the-license-key'],
    },
    {
      error: 'held-for-review',
      status: 403,
      description:
        "This renewal's counts (`kindgi license renew --runtime`) are above what a non-production key covers, so it got no new key: write to contact@kindgi.com about a production license. Kindgi can release the deployment after a review, and its renewals then aren't held until a date. The key you have runs until its own date. A renewal before the key is due gets the same key back.",
      seeAlso: ['deploy/self-hosted/renew-the-license-key'],
    },
    {
      error: 'unavailable',
      status: 503,
      description:
        'No key could be issued: the service failed to store or sign it. Try again later.',
      seeAlso: ['deploy/self-hosted/renew-the-license-key'],
    },
  ],
};
