---
title: Keep and purge deleted data
description: How long Kindgi keeps what you delete, the retention policies that purge it, sweeps, and keeping records for good.
sidebar:
  order: 4
---

Most deletes in Kindgi are soft. A deleted record drops out of lists and reads
at once, and stays in the database, marked deleted, until a **retention
policy** says to purge it and a **sweep** does. Without a policy, it stays for
good.

## What a policy covers

A retention policy names one **domain**: a kind of record. The console calls
each one by the name in the second column.

| Domain | In the console | What it purges |
| --- | --- | --- |
| `agent` | Deleted agents | unregistered agent versions |
| `flow` | Deleted flows | unregistered flow versions |
| `tool` | Deleted tools | unregistered tool versions |
| `eval_suite` | Deleted eval suites | unregistered versions of test sets and other eval suites |
| `guardrail` | Deleted guardrails | unregistered guardrails |
| `mcp_endpoint` | Removed MCP servers | unregistered MCP endpoints |
| `env` | Deleted environment values | deleted environment values |
| `secret` | Deleted secrets | revoked secrets |
| `run` | Deleted runs | **finished runs**, counted from when they finished |
| `policy` | Retired policy versions | unregistered policy versions |
| `judgment` | Removed judgments | removed judgments |
| `judge_class` | Retired judge classes | retired judge classes |
| `org` | Deleted orgs | deleted orgs, once their environments' and MCP endpoints' records are purged |
| `provider` | Removed model providers | unregistered model providers |
| `*` | All deleted records | every domain that has no policy of its own |

:::caution[`run` and `*` purge finished runs]
Runs aren't deleted first: a policy on `run`, or a `*` policy, purges every
finished run once its grace has passed since the run finished. To keep runs
while purging the rest, give `run` a policy of its own.
:::

## Set a policy

A retention policy is a policy of kind `retention`, whose `spec` is
`{ domain, graceSeconds, mode: "purge" }`. `graceSeconds` counts from the
delete: `0` purges at the next sweep, and `-1` keeps records for good.
Publishing a policy takes `admin` on the tenant.

```ts
// retention-policy.ts
import { createClient } from '@kindgi/sdk/client';
import type { PolicyId } from '@kindgi/sdk/types';

const kindgi = createClient(); // KINDGI_API_URL, KINDGI_API_TOKEN, or the running kindgi dev

// Removed model providers are kept 7 days, then the next sweep purges them.
const published = await kindgi.policies.author({
  id: 'acme.keep-providers' as PolicyId,
  version: '1.0.0',
  kind: 'retention',
  spec: { domain: 'provider', graceSeconds: 7 * 86_400, mode: 'purge' },
});
console.log(published);
```

```python
# retention_policy.py
from kindgi.client import Kindgi

kindgi = Kindgi()  # KINDGI_API_URL, KINDGI_API_TOKEN, or the running kindgi dev

# Removed model providers are purged at the next sweep: no grace.
published = kindgi.policies.publish(
    id="acme.keep-providers",
    version="1.0.1",
    kind="retention",
    spec={"domain": "provider", "graceSeconds": 0, "mode": "purge"},
)
print(published)
```

```text
{ policyId: 'acme.keep-providers', version: '1.0.0' }
policy_id='acme.keep-providers' version='1.0.1'
```

- **Keep one policy per domain,** plus an optional `*` default, and change it
  by publishing its next version, as the Python example does.
- **Only `purge` and the domains above apply.** After publishing, the
  console's Policies list says in a sentence what each policy does.

## See what will be purged

`GET /v1/retention/scheduled` lists each deleted record a policy will purge,
and when. It takes `admin` on the tenant, as do the sweeps.

```sh
curl "$KINDGI_API_URL/v1/retention/scheduled" -H "Authorization: Bearer $KINDGI_API_TOKEN"
```

```json
{
  "data": [
    {
      "domain": "provider",
      "id": "4b8cfaf3-c18a-4afd-b0e4-1574984fa45f",
      "unregisteredAt": "2026-10-06T11:23:45.358Z",
      "purgeAt": "2026-10-13T11:23:45.358Z",
      "pastGrace": false,
      "policyId": "acme.keep-providers",
      "policyVersion": "1.0.0",
      "graceSeconds": 604800
    }
  ],
  "domainsMissingAdapter": [],
  "unpolicedDomains": ["agent", "flow", "tool", …]
}
```

- **`?domain=provider`** narrows it to one domain, and
  **`?pastGraceOnly=true`** to what a sweep would purge now.
- **`unpolicedDomains`** lists the domains no policy covers: their deleted
  records are kept.

## Purge

Kindgi purges only when you sweep. `POST /v1/retention/sweep` purges every
deleted record past its grace; `POST /v1/retention/sweep/<domain>`, one
domain's:

```sh
curl -X POST "$KINDGI_API_URL/v1/retention/sweep/provider" -H "Authorization: Bearer $KINDGI_API_TOKEN"
```

```json
{
  "perDomain": [{ "domain": "provider", "purged": 1, "remaining": 0, "policyId": "acme.keep-providers" }],
  "totalPurged": 1
}
```

A purged record is gone for good. To purge on a schedule, call the sweep from
a cron job. Sweeping again purges nothing new until more records pass their
grace.

## Keep records for good

A policy with `graceSeconds: -1` keeps a domain's deleted records, and sweeps
skip it. With `"domain": "*"`, nothing is purged except in the domains that
have a policy of their own:

```json
{ "id": "acme.keep-everything", "version": "1.0.0", "kind": "retention",
  "spec": { "domain": "*", "graceSeconds": -1, "mode": "purge" } }
```

Records kept for good aren't listed by `GET /v1/retention/scheduled`, since
nothing will purge them.

## In the console

- **Policies → Publish policy → Deleted data** sets a policy: which records,
  how long to keep them ("Purge right away" to "Keep forever"), and the
  sentence it will publish, such as "Deleted records are purged for good
  after 30 days."
- **Deleted data** lists each deleted record with when it was deleted, when
  it will be purged and the policy that decides it, and has **Purge what's
  due now**, the same sweep as the API.
