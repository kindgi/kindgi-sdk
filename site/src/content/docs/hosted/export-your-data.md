---
title: Export your data
description: Export what your Kindgi Cloud workspace holds as files with `kindgi exports create`, while your account is open and for 30 days after it closes.
sidebar:
  order: 5
---

`kindgi exports create` writes what your workspace holds into a folder, as
files: every kind of record the API reads, every artifact's file, and the
records Kindgi Cloud signs. You can run it while your account is open, and
for 30 days after it closes, with the workspace's own API keys.

Secret values are never exported: they can't be read back, by design. Their
names and versions are.

## Before you start

- **Kindgi 0.2's CLI,** which runs from any folder as
  `npx --yes @kindgi/cli@0.2` ([Install](../../start/install/)).
- **A tenant admin's API key.** Some kinds only a tenant admin reads, such as
  the workspace's people, its API keys, its environments and its sign-ins. In
  the console, open **API keys** and **Create a key**, and under **How far it
  goes**, choose **Admin**. With another key, the command stops and names
  those kinds. With `--yes`, it exports the rest and skips them, and the env
  values and secrets with them, since those are read per environment.
- **A reviewer's role, for the approvals' audit bundles.** A tenant admin
  reads every approval, but only a registered reviewer gets an approval's
  signed audit bundle. Register yourself as an `admin` reviewer while your
  account is open:

  ```sh
  npx --yes @kindgi/cli@0.2 reviewers register --spec='{"role":"admin"}'
  ```

- **The address and the key:**

  ```sh
  export KINDGI_API_URL=https://platform.kindgi.com
  read -rs KINDGI_API_TOKEN && export KINDGI_API_TOKEN
  ```

  Paste the key at the prompt, which doesn't echo it, so it stays out of
  your shell's history.

## Export everything

Name a new or empty folder:

```sh
npx --yes @kindgi/cli@0.2 exports create --out ./acme-export
```

It prints a line for each kind as it's written, and ends by saying how many
kinds it wrote, skipped and failed, and which failed. A large workspace
takes a while: each run's journal, each conversation's messages and each
signed record is a request of its own.

A kind that fails doesn't stop the others, and the command then exits with
`1`. If you stop it part way (Ctrl-C), it exits with `130`. Either way, run
it again with `--resume`. It keeps the kinds already written and reads the
others again, skipped ones included:

```sh
npx --yes @kindgi/cli@0.2 exports create --out ./acme-export --resume
```

`--resume` reads the folder's `manifest.json`, and refuses a folder that
holds another workspace's export, or another server's
([`kindgi exports`](../../reference/cli/exports/)).

## What's in the folder

- **`manifest.json`:** each kind's file and outcome: `ok` with its count of
  records and when it was read (`at`), `skipped` and why, or `failed` with
  the error. A record deleted between the list and its own read is counted
  as `gone`. A kind the server doesn't serve is skipped, not failed. The
  manifest also names the CLI's version, the server and the workspace, says
  when the export started and finished and whether its files agree with
  each other (`consistency`), and lists what's never exported.
- **`<kind>.jsonl`:** one file per kind, such as `agents.jsonl`, `runs.jsonl`
  or `users.jsonl`, with one record per line, as the API answers it. A kind
  read for each record of another, such as `run-journals.jsonl` or
  `conversation-messages.jsonl`, has `{ "parent": { … }, "item": { … } }` on
  each line: `parent` names the record it belongs to.
- **`artifacts/`:** each artifact's file, named by its blob id.
  `artifacts.jsonl` lists them.
- **`signed/`:** the records Kindgi Cloud signs: each decided approval's audit
  bundle (`signed/approvals/`), each run's provenance (`signed/provenance/`)
  and the compliance evidence (`signed/compliance-evidence.json`).
  `kindgi exports verify` checks one
  ([Check an export](../../guides/observability/export-signed-evidence/#check-an-export)).
  Each is recorded as an `export-signed` event in the workspace's audit
  trail. A bundle too large to fetch whole is fetched again without its
  messages, and the manifest counts it (`withoutMessages`). `--no-signed`
  leaves the signed records out, and so does a server that has no export
  signing key.

While your account is open, records can change as the export reads them, so
each kind is as it stood when it was read (its `at` in the manifest). Once
your account is closed or suspended, nothing in the workspace changes but
deletes, revocations and erasures, so the files agree with each other,
except where one of those was made while the export ran. The manifest's
`consistency` says which applies.

## Secrets and env values

Secrets and env values are kept per environment and scope (the tenant, an
org or a project). The command reads them in each of the workspace's
environments (on Kindgi Cloud, `prod`) and each scope. A secret's entry has
its name, its versions, its tags and its dates, never its value
([Store a secret](../../guides/secrets/store-a-secret/)).

## What each file holds

Each file is a route's answer, so you can read any kind through the API too.
The export also asks for what a list leaves out by default, so ask for it the
same way:

- **Retired agents, flows, tools, blocks, policies, release gates and test
  sets:** `?includeRetired=true`.
- **Test sets built from corrections:** `?kind=corrections`, read as well as
  the rest.
- **An agent's retired test set cases:** `?include=retired`.
- **Removed versions** of agents, flows, tools, blocks, policies and test
  sets: `?includeTombstoned=true`.
- **Removed sites, people, service accounts, schedules, webhook triggers and
  mail triggers:** `?includeUnregistered=true`, on a removed trigger's
  versions and fires too.
- **Removed connection apps, connections and connection choices:**
  `?includeRemoved=true`.
- **Revoked signing keys and secrets:** `?includeRevoked=true`.
- **Replays among runs and conversations:** `?replays=include`.
- **A scope's own env values and secrets,** without what it inherits:
  `?inherit=false`.

A list that pages answers a page at a time: `?limit=` (at most 100), and
`?cursor=` with the page before's `nextCursor`.

| Kind | Files | API |
| --- | --- | --- |
| The workspace, its orgs and projects, and the projects' members and sites | `tenant.jsonl`, `orgs.jsonl`, `projects.jsonl`, `project-memberships.jsonl`, `sites.jsonl` | `GET /v1/tenant`, `/v1/orgs`, `/v1/projects`, `…/{projectId}/memberships`, `…/{projectId}/sites` |
| People, their grants, sessions and second factors | `users.jsonl`, `user-sessions.jsonl`, `user-second-factors.jsonl` | `GET /v1/identity/users?include=grants`, `…/{userId}/sessions`, `…/{userId}/second-factor` |
| Teams, their people and project grants | `teams.jsonl`, `team-memberships.jsonl`, `team-project-grants.jsonl` | `GET /v1/teams`, `…/{teamId}/memberships`, `…/{teamId}/project-grants` |
| Service accounts | `service-accounts.jsonl` | `GET /v1/service-accounts` |
| API keys (never the key itself) | `api-keys.jsonl` | `GET /v1/tokens` |
| Connection apps and connections (never a token), and each project's connection choices | `connection-apps.jsonl`, `connections.jsonl`, `connection-choices.jsonl` | `GET /v1/connection-apps`, `/v1/connections`, `/v1/connection-choices?projectId=` |
| Agents: every version, the pinned versions and their history, the projects each serves, and each one's test set cases | `agents.jsonl`, `agent-versions.jsonl`, `agent-pinned-versions.jsonl`, `agent-pin-history.jsonl`, `agent-projects.jsonl`, `agent-test-set-cases.jsonl` | `GET /v1/agents`, `…/{agentId}/versions`, `…/pinned-versions`, `…/pin-history`, `…/projects`, `…/test-set/cases?projectId=` |
| Tools and flows: every version, the pinned versions and their history | `tools.jsonl`, `tool-versions.jsonl`, `tool-pinned-versions.jsonl`, `tool-pin-history.jsonl`, and the same four for flows (`flows.jsonl`, …) | `GET /v1/tools`, `/v1/flows`, each with `…/versions`, `…/pinned-versions`, `…/pin-history` |
| Blocks, every version | `blocks.jsonl`, `block-versions.jsonl` | `GET /v1/blocks`, `…/{blockId}/versions` |
| Guardrails | `guardrails.jsonl` | `GET /v1/guardrails` |
| Policies, every version | `policies.jsonl`, `policy-versions.jsonl` | `GET /v1/policies`, `…/{policyId}/versions` |
| Release gates, every version | `release-gates.jsonl`, `release-gate-versions.jsonl` | `GET /v1/release-gates`, `…/{releaseGateId}/versions` |
| Runs: the record, the output, the journal | `runs.jsonl`, `run-journals.jsonl` | `GET /v1/runs?include=output`, `…/{runId}/journal` |
| Conversations and their messages | `conversations.jsonl`, `conversation-messages.jsonl` | `GET /v1/conversations`, `…/{conversationId}/messages` |
| Memory facts and their revisions | `memory-facts.jsonl`, `memory-fact-revisions.jsonl` | `GET /v1/memory/facts`, `…/{factId}/revisions` |
| Memory erasures and their ledger | `memory-erasures.jsonl`, `memory-erasure-ledger.jsonl` | `GET /v1/memory/erasures`, `…/export` |
| Approvals and their decisions; reviewers | `approvals.jsonl`, `reviewers.jsonl` | `GET /v1/approvals`, `/v1/approvals/reviewers` |
| Approvals' audit bundles | `signed/approvals/` | `POST /v1/approvals/{approvalId}/audit-bundle` |
| Artifacts, and each file | `artifacts.jsonl`, `artifacts/` | `GET /v1/artifacts`, `…/{blobId}` |
| Environments, their order, and env values | `environments.jsonl`, `environment-orders.jsonl`, `env.jsonl` | `GET /v1/environments`, `/v1/environment-orders`, `/v1/env` |
| Secrets: names and versions, never values | `secrets.jsonl`, `secret-versions.jsonl` | `GET /v1/secrets`, `…/{name}/versions` |
| Workspace settings and sign-in settings | `tenant-config.jsonl`, `sign-in-settings.jsonl` | `GET /v1/tenant/config`, `/v1/auth/settings` |
| Schedules, removed ones too: every version, and when they fired | `schedules.jsonl`, `schedule-versions.jsonl`, `schedule-fires.jsonl` | `GET /v1/schedules`, `…/{triggerId}/versions`, `…/{triggerId}/fires` |
| Webhook triggers, removed ones too: every version, and when they fired | `webhooks.jsonl`, `webhook-versions.jsonl`, `webhook-fires.jsonl` | `GET /v1/webhooks`, `…/{triggerId}/versions`, `…/{triggerId}/fires` |
| Mail triggers, removed ones too: every version, and when they fired | `mail-triggers.jsonl`, `mail-trigger-versions.jsonl`, `mail-trigger-fires.jsonl` | `GET /v1/mail-triggers`, `…/{triggerId}/versions`, `…/{triggerId}/fires` |
| Webhook endpoints, and their deliveries | `webhook-endpoints.jsonl`, `webhook-deliveries.jsonl` | `GET /v1/webhook-endpoints`, `…/{endpointId}/deliveries` |
| MCP endpoints | `mcp-endpoints.jsonl` | `GET /v1/mcp/endpoints` |
| Capabilities | `capabilities.jsonl` | `GET /v1/capabilities` |
| Model providers and their capabilities; identity providers | `providers.jsonl`, `provider-capabilities.jsonl`, `identity-providers.jsonl` | `GET /v1/providers`, `…/{providerId}/capabilities`, `/v1/auth/providers` |
| Test sets: every version and its cases; test runs | `test-sets.jsonl`, `test-set-versions.jsonl`, `eval-cases.jsonl`, `test-runs.jsonl` | `GET /v1/test-sets`, `…/{testSetId}/versions`, `…/{version}/cases`, `/v1/test-runs` |
| Corrections, and the corrector groups | `corrections.jsonl`, `corrector-groups.jsonl` | `GET /v1/corrections/{correctionId}` for each one `/v1/corrections` lists, `/v1/corrector-groups` |
| Queue rules, every version, and each project's expert queue | `queue-rules.jsonl`, `queue-rule-versions.jsonl`, `expert-queue.jsonl` | `GET /v1/projects/{projectId}/queue-rules`, `…/{ruleId}/versions`, `/v1/projects/{projectId}/expert-queue` |
| Suggested changes and improve runs | `suggested-changes.jsonl`, `improve-runs.jsonl` | `GET /v1/suggested-changes`, `/v1/improve-runs` |
| Observations | `observations.jsonl` | `GET /v1/observations` |
| Provenance, and each run's signed provenance | `provenance.jsonl`, `signed/provenance/` | `GET /v1/provenance/{runId}` for each one `/v1/provenance` lists, `POST /v1/provenance/{runId}/export` |
| Cost records | `cost-records.jsonl` | `GET /v1/cost/records?include=rawUsage` |
| Deployments | `deployments.jsonl` | `GET /v1/deployments` |
| Signing keys and export signing keys (public keys) | `signing-keys.jsonl`, `export-signing-keys.jsonl` | `GET /v1/signing-keys`, `/v1/export-signing-keys` |
| Compliance evidence, and its signed export | `compliance-evidence.jsonl`, `signed/compliance-evidence.json` | `GET /v1/compliance/evidence`, `POST …/export` |
| The audit trail: access decisions and sign-ins | `access-decisions.jsonl`, `sign-ins.jsonl` | `GET /v1/audit/authz`, `/v1/audit/sign-ins` |

## What isn't exported

- **Secret values.** They can't be read back, by design.
- **Your packs' built images.** Your pack's source is yours: build them again
  from it.
- **Your packs' logs, and the service's logs of your runs.** They're
  operational records, kept for 30 days and not exported.
