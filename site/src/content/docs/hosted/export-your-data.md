---
title: Export your data
description: Export what your Kindgi Cloud workspace holds as files, with the API or the CLI, while your account is open and for 30 days after it closes.
sidebar:
  order: 20
---

Your workspace's data can be read at any time through the API, as JSON, and
saved as files; most of it with the CLI too. After your account closes, it
can still be read for 30 days, signed in as before or with the workspace's
own API keys.

Secret values are never exported: they can't be read back, by design. Their
names and metadata are.

## Before you start

- **A tenant admin's API key.** Some lists are for tenant admins only: the
  people in the workspace, and the audit trail.
- **A reviewer's role, for approvals.** Approvals are listed to registered
  reviewers, up to their role. Register yourself as an `admin` reviewer while
  your account is open:

  ```sh
  kindgi reviewers register --spec='{"role":"admin"}'
  ```

- **The address and the key,** for the CLI and the Python client:

  ```sh
  export KINDGI_API_URL=https://platform.kindgi.com
  export KINDGI_API_TOKEN=<the API key>
  ```

## Export everything with the Python client

The Python client (`kindgi` on PyPI) has `paginate`, which reads a list page
after page. This script writes what the workspace holds into
`kindgi-export/`: one JSON Lines file per kind, with every version of each
agent, tool and flow, every conversation's messages, every run's journal and
every artifact's file.

```python
# export_workspace.py
from pathlib import Path

from kindgi.client import Kindgi, paginate

kindgi = Kindgi()  # KINDGI_API_URL and KINDGI_API_TOKEN
out = Path("kindgi-export")
ENVIRONMENTS = ["prod"]  # the environment Kindgi Cloud serves


def save(name, items):
    path = out / f"{name}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as f:
        for item in items:
            f.write(item.model_dump_json(by_alias=True) + "\n")


def every(list_method, *args, **filters):
    return paginate(list_method, *args, limit=100, **filters)


def journal(run_id):
    since = None
    while True:
        page = kindgi.runs.journal(run_id, since=since)
        yield from page.data
        if not page.has_more or not page.data:
            return
        since = page.data[-1].sequence


lists = {
    "people": kindgi.identity.users.list,
    "teams": kindgi.teams.list,
    "orgs": kindgi.orgs.list,
    "projects": kindgi.projects.list,
    "service-accounts": kindgi.service_accounts.list,
    "api-keys": kindgi.tokens.list,
    "blocks": kindgi.blocks.list,
    "guardrails": kindgi.guardrails.list,
    "policies": kindgi.policies.list,
    "gate-policies": kindgi.gate_policies.list,
    "memory-facts": kindgi.memory.list_facts,
    "memory-erasures": kindgi.memory.list_erasures,
    "approvals": kindgi.approvals.list,
    "reviewers": kindgi.approvals.reviewers.list,
    "schedules": kindgi.schedules.list,
    "webhooks": kindgi.webhooks.list,
    "webhook-endpoints": kindgi.webhook_endpoints.list,
    "mcp-endpoints": kindgi.mcp.endpoints.list,
    "model-providers": kindgi.providers.list,
    "eval-suites": kindgi.eval_suites.list,
    "eval-runs": kindgi.eval_runs.list,
    "judgments": kindgi.judgments.list,
    "judge-classes": kindgi.judge_classes.list,
    "proposals": kindgi.proposals.list,
    "improvement-passes": kindgi.improvement_passes.list,
    "observations": kindgi.observations.list,
    "provenance": kindgi.provenance.list,
    "cost-records": kindgi.cost.records.list,
    "deployments": kindgi.deployments.list,
    "tenant-settings": kindgi.tenant.config.list,
    "signing-keys": kindgi.signing_keys.list,
    "audit-access-decisions": kindgi.audit.authz.list,
    "audit-sign-ins": kindgi.audit.sign_ins.list,
}
for name, list_method in lists.items():
    save(name, every(list_method))
save("identity-providers", kindgi.auth.providers.list().data)

# Agents, tools and flows: every version, retired ones too.
for kind, resource in {"agents": kindgi.agents, "tools": kindgi.tools, "flows": kindgi.flows}.items():
    for item in every(resource.list, include_retired=True):
        save(f"{kind}/{item.id}", every(resource.list_versions, item.id, include_tombstoned=True))

# Runs with their output and journal, replays too.
runs = list(every(kindgi.runs.list, include="output", replays="include"))
save("runs", runs)
for run in runs:
    save(f"journals/{run.id}", journal(run.id))

# Conversations with their messages, replays too.
conversations = list(every(kindgi.conversations.list, replays="include"))
save("conversations", conversations)
for conversation in conversations:
    save(f"messages/{conversation.id}", every(kindgi.conversations.messages, conversation.id))

# Artifacts: the list, then each file.
artifacts = list(every(kindgi.artifacts.list))
save("artifacts", artifacts)
for artifact in artifacts:
    path = out / "artifact-files" / artifact.blob_id
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(kindgi.artifacts.download(artifact.blob_id))

# Secrets (names and metadata, never values) and env values, in each scope.
scopes = [("tenant", None)]
scopes += [("org", org.id) for org in every(kindgi.orgs.list)]
scopes += [("project", project.id) for project in every(kindgi.projects.list)]
for env in ENVIRONMENTS:
    for kind, scope_id in scopes:
        where = f"{env}/{kind}" + (f"-{scope_id}" if scope_id else "")
        filters = {"env_name": env, "scope_kind": kind, "scope_id": scope_id}
        save(f"secrets/{where}", every(kindgi.secrets.list, **filters))
        save(f"env/{where}", every(kindgi.env.list, **filters))
```

Run it with `python export_workspace.py`. A large workspace takes a while:
each run's journal is a request of its own.

## What each kind is

Every list answers a page at a time: `--limit` (at most 100) and `--cursor`
with the page before's `nextCursor` (`?limit=` and `?cursor=` in the API).
The CLI prints JSON, so `kindgi runs list --limit=100 > runs-1.json` saves a
page. Kinds marked "API" have no CLI command.

| Kind | CLI | API |
| --- | --- | --- |
| People, their grants and sessions | `kindgi people list`, `get`, `grants` (sessions: API) | `GET /v1/identity/users`, `…/{userId}/grants`, `…/{userId}/sessions` |
| Teams, their people and project grants | API | `GET /v1/teams`, `…/{teamId}/memberships`, `…/{teamId}/project-grants` |
| Orgs | API | `GET /v1/orgs` |
| Projects, their access, members and team grants | `kindgi projects list`, `get` | `GET /v1/projects`, `…/{projectId}/access`, `…/memberships`, `…/team-grants` |
| Service accounts | `kindgi service-accounts list`, `get` | `GET /v1/service-accounts` |
| API keys (never the key itself) | `kindgi tokens list`, `get` | `GET /v1/tokens` |
| Agents, every version | `kindgi agents list`, `versions` | `GET /v1/agents`, `…/{agentId}/versions` |
| Tools, flows and blocks, every version | `kindgi tools …`, `kindgi flows …`, `kindgi blocks …` | `GET /v1/tools`, `/v1/flows`, `/v1/blocks`, each with `…/versions` |
| Guardrails, and what they found | `kindgi guardrails list`, `get` (outcomes: API) | `GET /v1/guardrails`, `…/{guardrailId}/outcomes` |
| Policies and gate policies | `kindgi gate-policies …` (policies: API) | `GET /v1/policies`, `/v1/gate-policies` |
| Runs: the record, the output, the journal | `kindgi runs list`, `get`, `journal` | `GET /v1/runs?include=output`, `…/{runId}/journal` |
| Conversations and their messages | `kindgi conversations list`, `messages` | `GET /v1/conversations`, `…/{conversationId}/messages` |
| Memory facts and their revisions | `kindgi memory facts list`, `revisions` | `GET /v1/memory/facts`, `…/{factId}/revisions` |
| Memory erasures | `kindgi memory erasures list`, `export` | `GET /v1/memory/erasures`, `…/export` |
| Approvals and their decisions; reviewers | `kindgi approvals list`, `get`; `kindgi reviewers list` | `GET /v1/approvals`, `/v1/approvals/reviewers` |
| Artifacts, and each file | `kindgi artifacts list`, `download` | `GET /v1/artifacts`, `…/{blobId}` |
| Secrets: names and metadata, never values | `kindgi secrets list` | `GET /v1/secrets` |
| Env values | `kindgi env list` | `GET /v1/env` |
| Schedules, and when they fired | `kindgi schedules list`, `fires` | `GET /v1/schedules`, `…/{triggerId}/fires` |
| Webhook triggers, and when they fired | `kindgi webhooks list`, `fires` | `GET /v1/webhooks`, `…/{triggerId}/fires` |
| Webhook endpoints, and their deliveries | API | `GET /v1/webhook-endpoints`, `…/{endpointId}/deliveries` |
| MCP endpoints | `kindgi mcp list` | `GET /v1/mcp/endpoints` |
| Model providers and identity providers | `kindgi providers list`; `kindgi sso list` | `GET /v1/providers`, `/v1/auth/providers` |
| Evals: test sets, eval runs, judgments | `kindgi eval-suites …`, `kindgi eval-runs list`, `kindgi judgments list`, `kindgi judge-classes list` | `GET /v1/eval-suites`, `/v1/eval-runs`, `/v1/judgments`, `/v1/judge-classes` |
| Judging rules, queue and results | API | `GET /v1/projects/{projectId}/judging-rules`, `…/judging-queue` |
| Proposals and improvement passes | `kindgi proposals list`, `kindgi proposals passes list` | `GET /v1/proposals`, `/v1/improvement-passes` |
| Observations | `kindgi observations list` | `GET /v1/observations` |
| Provenance | `kindgi provenance list`, `get` | `GET /v1/provenance` |
| Cost records | API | `GET /v1/cost/records` |
| Deployments | API | `GET /v1/deployments` |
| Tenant settings | API | `GET /v1/tenant/config` |
| Signing keys (public keys) | API | `GET /v1/signing-keys` |
| The audit trail: access decisions and sign-ins | API | `GET /v1/audit/authz`, `/v1/audit/sign-ins` |

## Secrets and env values

Secrets and env values are kept per environment and scope (the tenant, an
org or a project). On Kindgi Cloud, your tools read them in the `prod`
environment, so the script lists `prod` in every scope. A secret's entry has
its name, its current version, its tags and its dates, never its value
([Store a secret](../../guides/secrets/store-a-secret/)).

## What isn't exported

- **Secret values.** They can't be read back, by design.
- **Your packs' built images.** Your pack's source is yours, and the images
  built from it aren't exported.
- **Your packs' logs.** They're operational records, kept for 30 days and
  not exported.
