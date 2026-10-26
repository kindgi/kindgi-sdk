---
title: Export your data
description: Export what your Kindgi Cloud workspace holds as files with `kindgi exports create`, while your account is open and for 30 days after it closes.
sidebar:
  order: 20
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
  records, `skipped` and why, or `failed` with the error. It also lists what's
  never exported.
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
  messages. `--no-signed` leaves the signed records out, and so does a
  server that has no export signing key.

While your account is open, records can change as the export reads them, so
each kind is as it stood when it was read (its `at` in the manifest). After
your account closes, nothing in the workspace changes but deletes and
erasures, so the files agree with each other.

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

- **Retired agents, flows, tools and test sets:** `?includeRetired=true`.
- **Removed versions** of agents, flows, tools, blocks, policies and test
  sets: `?includeTombstoned=true`.
- **Removed sites, people and service accounts:** `?includeUnregistered=true`.
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
| Agents: every version, the live versions and the promotions | `agents.jsonl`, `agent-versions.jsonl`, `agent-live-versions.jsonl`, `agent-promotions.jsonl` | `GET /v1/agents`, `…/{agentId}/versions`, `…/live-versions`, `…/promotions` |
| Tools, flows and blocks, every version | `tools.jsonl`, `tool-versions.jsonl`, `flows.jsonl`, `flow-versions.jsonl`, `blocks.jsonl`, `block-versions.jsonl` | `GET /v1/tools`, `/v1/flows`, `/v1/blocks`, each with `…/versions` |
| Guardrails | `guardrails.jsonl` | `GET /v1/guardrails` |
| Policies and gate policies, every version | `policies.jsonl`, `policy-versions.jsonl`, `gate-policies.jsonl`, `gate-policy-versions.jsonl` | `GET /v1/policies`, `/v1/gate-policies`, each with `…/versions` |
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
| Schedules, and when they fired | `schedules.jsonl`, `schedule-fires.jsonl` | `GET /v1/schedules`, `…/{triggerId}/fires` |
| Webhook triggers, and when they fired | `webhooks.jsonl`, `webhook-fires.jsonl` | `GET /v1/webhooks`, `…/{triggerId}/fires` |
| Webhook endpoints, and their deliveries | `webhook-endpoints.jsonl`, `webhook-deliveries.jsonl` | `GET /v1/webhook-endpoints`, `…/{endpointId}/deliveries` |
| MCP endpoints | `mcp-endpoints.jsonl` | `GET /v1/mcp/endpoints` |
| Capabilities | `capabilities.jsonl` | `GET /v1/capabilities` |
| Model providers and their capabilities; identity providers | `providers.jsonl`, `provider-capabilities.jsonl`, `identity-providers.jsonl` | `GET /v1/providers`, `…/{providerId}/capabilities`, `/v1/auth/providers` |
| Evals: test sets and their cases, eval runs, judgments, judge classes | `eval-suites.jsonl`, `eval-suite-versions.jsonl`, `eval-cases.jsonl`, `eval-runs.jsonl`, `judgments.jsonl`, `judge-classes.jsonl` | `GET /v1/eval-suites`, `…/{suiteId}/versions`, `…/{version}/cases`, `/v1/eval-runs`, `/v1/judgments`, `/v1/judge-classes` |
| Judging rules, every version, and the queue | `judging-rules.jsonl`, `judging-rule-versions.jsonl`, `judging-queue.jsonl` | `GET /v1/projects/{projectId}/judging-rules`, `…/{ruleId}/versions`, `…/judging-queue` |
| Proposals and improvement passes | `proposals.jsonl`, `improvement-passes.jsonl` | `GET /v1/proposals`, `/v1/improvement-passes` |
| Observations | `observations.jsonl` | `GET /v1/observations` |
| Provenance, and each run's signed provenance | `provenance.jsonl`, `signed/provenance/` | `GET /v1/provenance`, `POST /v1/provenance/{runId}/export` |
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
