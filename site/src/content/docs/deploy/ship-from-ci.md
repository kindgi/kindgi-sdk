---
title: Ship a pack from CI
description: Test a pack on every pull request, deploy it to staging from main, and promote the same signed build to prod through its release gate, with keys that reach only what each step needs.
sidebar:
  order: 5.3
---

When you finish this page, every pull request runs your pack's tests, and
every merge to main deploys the pack to staging. Prod then takes the same
signed build once it passes your test cases and a reviewer approves. Each
key CI holds reaches only what its step needs.

The example uses GitHub Actions and a TypeScript pack.
[Python, Java and Scala packs](#python-java-and-scala-packs) and
[Other CI systems](#other-ci-systems) say what changes.

:::note[On Kindgi Cloud]
Kindgi Cloud builds the image, so CI needs no Docker and no registry login.
The build and deploy steps take `--hosted`, and both get the deploy key. A
hosted build takes a tenant admin's key, so on Kindgi Cloud the deploy key
is one. It reaches prod too, so main's own protection is what guards prod
there ([The deploy key](#the-deploy-key)). Everything else is the same.
:::

## What CI ships, and what you set up once

CI ships what's in your pack: its agents, tools, flows, blocks and
guardrails, built into one image and signed. Git is where they're kept. A
change made on the runtime comes back to git as a pull request
([Changes made on the runtime](#changes-made-on-the-runtime)).

A person sets up the rest once, not CI: the environment order, trusting
CI's signing key, providers, release gates, test cases and
triggers. [Projects, packs and values](../../concepts/projects-packs-values/)
has how a pack, its projects and its values fit together.

## Environments in order

One runtime holds a project for each environment, in an order: staging, then
prod. Each environment is in the pack's `kindgi.config.ts`, under
`environments`, with its endpoint and its project. A tenant admin sets the
order once, by the pack's environment names:

```sh
pnpm exec kindgi environments set staging prod
```

Only the first environment takes a deploy. Each later one takes a promotion
of the build already in the one before it, so prod runs exactly what ran in
staging:

```sh
pnpm exec kindgi promote --from=staging --to=prod --check
pnpm exec kindgi promote --from=staging --to=prod --reason="Passed in staging"
```

- `--check` says what would move, and which values the build needs aren't
  set in prod. It changes nothing.
- Without it, the build moves to prod, with its agents' and flows' versions.
  Runs of each agent in prod keep the version Pinned for it there, until you
  pin the new one ([Make the new version Pinned in prod](#make-the-new-version-pinned-in-prod)).
- While a value isn't set in prod, both exit 1 and nothing moves. Set it,
  then promote again.

These are the steps CI runs, and without CI a person runs them the same
way. [`kindgi environments`](../../reference/cli/environments/) and
[`kindgi promote`](../../reference/cli/promote/) have every flag.

## Set up each environment once

A person does these, with a key of their own:

- **Trust CI's signing key,** once for the tenant, with a key that may trust
  signing keys. The command is `kindgi key trust <key-id>`, as
  [Trust your key and deploy](../self-hosted/self-host/#7-trust-your-key-and-deploy)
  shows; on Kindgi Cloud, [Sign the pack](../../hosted/deploy-your-agent/#sign-the-pack).
  CI never holds a key that trusts signing keys.
- **Register the providers** each environment's agents call
  ([`kindgi providers`](../../reference/cli/providers/)).
- **In prod, pin a version of each agent, and publish its release gate**
  ([Gate a pin](../../guides/improve/release-an-agent-version/#gate-a-pin)).
  A scope with a release gate needs a Pinned version of its own.
  Without one, prod's runs take each agent's latest version.
- **Build the test cases** that prod's test run uses, in prod's project
  ([Build test cases from corrections](../../guides/improve/build-a-test-set/)).
- **Create the triggers:** schedules, webhooks and mail triggers.

Registering a provider again under its id, publishing a release gate's
version again, or making a test set of test cases again under its id and
version is refused, as already registered. A trigger has no name to
match, so a second `create` of a schedule or a mail trigger, or a second
`register` of a webhook, makes a second trigger. A script that sets these up
checks first with each kind's `list`, and tells its triggers apart by
`--label`.

## The keys CI uses

Make each key for a service account of its own, made for that one key and
given nothing else. A key reaches whatever its account may. So an account
with other grants, or one key used for two environments, reaches all of
them.

Each key expires in 90 days. To rotate one, make the new key, put it in CI,
then revoke the old one with `kindgi tokens revoke <token-id>`.
[Service accounts](../people-and-keys/#service-accounts) has the rest about
them.

### The deploy key

The deploy key is for the first environment:

```sh
pnpm exec kindgi service-accounts create acme-ci-deploy --description="Deploys to staging from CI" --project=<staging-project-id>:admin
pnpm exec kindgi tokens create --for=sa:<service-account-id> --project=<staging-project-id> --label=ci-deploy --expires=90d
```

- A deploy into a project takes `admin` on it. The pack's `staging`
  environment names its project, so the account needs admin on that project,
  not on the tenant.
- `--project` limits the key to staging.
- Add `--capability=secrets:write` to the key only when CI sets secrets with
  `kindgi deploy --sync-secrets`.

On Kindgi Cloud, a hosted build takes a tenant admin's key, so the deploy
key is one. Make its service account a tenant admin, and its key an admin
key with no `--project`:

```sh
pnpm exec kindgi service-accounts create acme-ci-deploy --description="Builds and deploys to staging from CI" --tenant-admin
pnpm exec kindgi tokens create --for=sa:<service-account-id> --role=admin --label=ci-deploy --expires=90d
```

That key reaches the whole tenant, prod included. Even with no capability,
it can change the environment order, replace prod's release gate,
promote to prod, and make service accounts, tenant admins among them, and
keys for them. So on Kindgi Cloud, prod's required reviewers don't guard
prod from a job that holds it. Main's own protection does: a required review
of each pull request before it merges.

- **It's a secret of the `staging` environment only,** and that environment
  takes only main.
- **If it leaks,** revoke it, then look for the keys and accounts it made
  with `kindgi tokens list` and `kindgi service-accounts list`, and revoke
  those too. Revoking doesn't undo what it changed, so check that
  `kindgi environments list` and `kindgi release-gates list` still show the
  order and the release gates you set.

### A promote key for each later environment

```sh
pnpm exec kindgi service-accounts create acme-ci-promote-prod --description="Promotes staging to prod from CI" --tenant-member --project=<staging-project-id>:viewer --project=<prod-project-id>:admin
pnpm exec kindgi tokens create --for=sa:<service-account-id> --label=ci-promote-prod --expires=90d
```

- **The key has no `--project`.** A key limited to a project is refused on
  every promotion, because a promotion reads one project and writes another.
  This key reaches what its account may: read on staging, and admin on prod.
- **`--tenant-member`,** because `kindgi promote` lists staging's
  deployments, and that read takes `read` on the tenant.
- **Admin on prod doesn't let it skip staging.** Prod comes later in the
  order, so it refuses a deploy. That's why the order is set first.
- **It can't approve its own promotion.** A service account's key has no
  reviewer role.
- **It's an admin of prod** in everything except changing env values and
  secrets, which take capabilities it doesn't have. That includes reading
  prod's conversations. So its job waits for GitHub's required reviewers,
  and the key expires in 90 days.

### Where the keys live

- **Each key, and the signing key, is a secret of its own GitHub
  environment,** `staging` or `prod`, never of the repository.
- **Each environment takes only main,** with its deployment branches set to
  main, and `prod` has required reviewers
  ([Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).
- **The signing key is the pipeline's most valuable secret.** It's trusted
  across the tenant, so a build it signs passes the signature check in
  every project. Whoever holds it can sign a build of any code, not only
  main's, and any key that can deploy then deploys it there. If it leaks,
  rotate it at once
  ([Rotate a signing key](../self-hosted/rotate-keys/#rotate-a-signing-key)).
- **`KINDGI_API_TOKEN` is set on the `kindgi` steps only,** never on the
  job, so no key is in the environment of `pnpm install` or of the install
  scripts it runs.
- **What's installed is what you reviewed.** A job's steps share one
  machine, so a process an install script leaves running could read what
  later steps write, such as the signing key's file. `--frozen-lockfile`
  installs only what the lockfile, reviewed in each pull request, names.
  pnpm runs a dependency's install script only when `allowBuilds` in
  `pnpm-workspace.yaml` allows it, and a pack `kindgi init` makes allows
  none.
- **Each action is pinned to a commit,** with its version in a comment. A
  tag can move to other code, and a commit can't. That holds in `test` too:
  it writes the pnpm cache that the jobs holding a key install from.

### The signing key

CI signs each build with an Ed25519 key of its own. Make it once, on your
machine:

```sh
pnpm exec kindgi key create acme-ci
```

It writes the private key to `~/.kindgi/keys/acme-ci.pem`. Put that file's
contents in the `staging` environment's `KINDGI_SIGNING_KEY` secret, and
trust the key as [Set up each environment once](#set-up-each-environment-once)
says.

In CI, the job writes the secret to a file for `kindgi build`. The signature
names its key by the file's name without its extension, so the file is named
after the key the tenant trusts: `acme-ci.pem` for `acme-ci`.

To replace the key, follow
[Rotate a signing key](../self-hosted/rotate-keys/#rotate-a-signing-key),
then put the new key in the secret, and name the file the job writes after
the new key.

## The pipeline

- **On a pull request:** `kindgi test` runs the pack's tests. It needs no
  runtime and no Kindgi key. A test that calls a model provider needs that
  provider's key as a secret of the job. Make it a key of its own, with a
  spending limit, not the one your runtime uses: a pull request from any
  branch of the repository can read it before anyone reviews it.
- **On a merge to main:** build and sign the image, then deploy it to
  staging.
- **Then prod,** once GitHub's required reviewers let its job start:
  promote the build, run the test cases on the new version in prod, and make
  it Pinned there through its release gate.

### Exit codes

Every step that asks a question exits 3 when the answer is no, so the job
stops on it, and 1 when it couldn't ask:

| Command | 0 | 3 | 1 |
|---|---|---|---|
| `kindgi promote --from --to`, and with `--check` | it moved, or would | never | a value the build needs isn't set in the target, or an error |
| `kindgi test-runs start --wait` | the run completed | it failed or was cancelled | it's still running after 30 minutes, or an error |
| `kindgi agents pin --wait` | the version is Pinned | the release gate refused it, its approval was rejected or expired, the request was superseded, or the wait ran out | an error, or 3 reads of the pin in a row failed |
| `kindgi promote --pin --wait` | every version it carries is Pinned | one isn't | an error, or 3 reads of a promotion in a row failed |

A usage error exits 2.

### The example

The pack's `kindgi.config.ts` has `environments.staging` and
`environments.prod`, each with its endpoint, its project, its registry and
its tenant id. The CLI is a dev dependency of the pack, and `package.json`
pins its pnpm version (`packageManager`), as `kindgi init` sets it.

```yaml excerpt
name: ship-pack
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read # every job's GITHUB_TOKEN only reads the repository

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { persist-credentials: false }
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec kindgi test

  deploy-staging:
    needs: test
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    environment: staging # its own secrets; deployment branches: main
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { persist-credentials: false }
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - uses: docker/login-action@81c6f93d4bc991e510b342a00b419b3bb4efc5c6 # v4.7.0
        with:
          registry: registry.acme.example # the staging environment's registry
          username: ${{ secrets.REGISTRY_USERNAME }}
          password: ${{ secrets.REGISTRY_PASSWORD }}
      - name: Signing key to a file
        env:
          SIGNING_KEY: ${{ secrets.KINDGI_SIGNING_KEY }}
        run: |
          umask 077
          printf '%s\n' "$SIGNING_KEY" > "$RUNNER_TEMP/acme-ci.pem"
      - run: pnpm exec kindgi build --local --push --env staging --signing-key "$RUNNER_TEMP/acme-ci.pem"
      - run: pnpm exec kindgi deploy --env staging --from-envelope .kindgi/build/deploy-envelope.json
        env:
          KINDGI_API_TOKEN: ${{ secrets.KINDGI_DEPLOY_KEY }}

  promote-prod:
    needs: deploy-staging
    runs-on: ubuntu-latest
    environment: prod # required reviewers; deployment branches: main
    timeout-minutes: 120 # longer than the steps' own waits
    env:
      AGENT: acme.order-desk
      TEST_SET: acme.order-checks # the test cases, in prod's project
      PROD_PROJECT: <prod-project-id>
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { persist-credentials: false }
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - id: promoted
        env:
          KINDGI_API_TOKEN: ${{ secrets.KINDGI_PROMOTE_KEY }}
        run: |
          pnpm exec kindgi promote --from=staging --to=prod --reason="${{ github.sha }} passed in staging" --json > promoted.json
          echo "version=$(jq -r --arg agent "$AGENT" '.promotion.moved.agents[] | select(.id == $agent and .carried != true) | .version' promoted.json)" >> "$GITHUB_OUTPUT"
      - id: tested
        if: steps.promoted.outputs.version != ''
        env:
          KINDGI_API_TOKEN: ${{ secrets.KINDGI_PROMOTE_KEY }}
          VERSION: ${{ steps.promoted.outputs.version }}
        run: |
          pnpm exec kindgi test-runs start "$TEST_SET" --project="$PROD_PROJECT" --agent="$AGENT" --agent-version="$VERSION" --wait > run.json
          echo "run=$(jq -r .testRunId run.json)" >> "$GITHUB_OUTPUT"
      - if: steps.promoted.outputs.version != ''
        env:
          KINDGI_API_TOKEN: ${{ secrets.KINDGI_PROMOTE_KEY }}
          VERSION: ${{ steps.promoted.outputs.version }}
          RUN: ${{ steps.tested.outputs.run }}
        run: pnpm exec kindgi agents pin "$AGENT" "$VERSION" --project="$PROD_PROJECT" --test-run="$RUN" --reason="${{ github.sha }} passed its test cases" --wait=1h
```

### Make the new version Pinned in prod

The last three steps of `promote-prod` do it for one agent:

1. **`promote` moves the build to prod.** `jq` reads, from its JSON, the
   version of `acme.order-desk` the build ships. When the build carries it
   unchanged, the next two steps skip.
2. **`test-runs start --wait` runs the test cases on that version in prod.**
   The job stops when the run fails, and `jq` reads its id.
3. **`agents pin --wait` asks prod's release gate,** with that
   run. When the gate asks for an approval, the step prints the approval's
   id and the command that approves it, then waits for a reviewer, up to an
   hour. It exits 0 once the version is Pinned.

- **A step that waits ends before the CI system ends it.** `test-runs start
  --wait` waits up to 30 minutes, and exits 1 when the run is still going
  then. `agents pin --wait=1h` waits up to an hour: when it runs out, it
  exits 3, and when 3 reads of the pin in a row fail, it exits 1.
  Either way the approval stays open: once a reviewer approves it, the
  version is Pinned. Keep the job's `timeout-minutes` longer than the two
  waits together, as the example's 120 is.
- **A carried agent the workflow doesn't name** stays on the version Pinned
  for it in prod. Name each agent that should go further, with its own test
  run and `agents pin` steps.
- **When prod's release gate asks only for an approval,** with no
  test run, `kindgi promote --from=staging --to=prod --pin --wait` does
  the whole step for every agent the build carries. `--pin` can't name
  a test run, so a release gate that needs one holds every version it carries.

[Gate a pin](../../guides/improve/release-an-agent-version/#gate-a-pin)
has what a release gate checks, and how a reviewer approves.
[`kindgi agents`](../../reference/cli/agents/) and
[`kindgi test-runs`](../../reference/cli/test-runs/) have every flag.

## Versions in git

- **Bump an agent's or a flow's version in git when you change it.**
- **When its content changed under the same version,** a deploy registers
  the next free version, and says so for each agent and flow
  ([Deploys make the new version for you](../../guides/agents/agent-and-tool-versions/#deploys-make-the-new-version-for-you)).
- **A tool whose definition changed under the same version is refused,**
  with `409 tool-already-registered`, naming what differs. Give the tool a
  new version.

## When a release goes wrong

- **Unpin an agent in prod:** one step, with no release gate in
  the way
  ([Unpin](../../guides/improve/release-an-agent-version/#unpin)).
- **For anything else, revert the change in git** and let the pipeline ship
  it. That rolls forward: each agent and flow whose content changed gets a
  new version.
- **A tool goes back with the agent version that pins it.**

## Changes made on the runtime

Improve, suggested changes and edits in the console change the runtime, not git, so
the next deploy from git doesn't have them. Bring each one back as a pull
request: copy the change into the pack's files, and open the pull request.
[Improve an agent](../../guides/improve/improve-an-agent/) has what Improve
changes.

## Separate runtimes

There's no promotion between runtimes. A signed build names its tenant, and
a runtime checks the signature against its own tenant. So build and sign
from the same commit for each runtime, and deploy each build to its
runtime's first environment. Set up each runtime once: its trusted signing
key, providers, release gates, test cases and triggers.

## Python, Java and Scala packs

The jobs are the same. What changes is how each job sets up the pack and
runs the CLI:

- **Python:** set up uv in place of pnpm and Node, and run `uv sync
  --locked`. Run the tests with `uv run pytest`, and `uv run kindgi` where
  this page runs `pnpm exec kindgi`.
- **Java:** set up a JDK 17 or later. Run the tests with `./mvnw test`, and
  `./kindgiw` where this page runs `pnpm exec kindgi`.
- **Scala:** set up a JDK 17 or later and sbt. Run the tests with
  `sbt test`, and `./kindgiw` where this page runs `pnpm exec kindgi`.

## Other CI systems

Any CI system runs the same jobs. Keep each key in a secret that only main's
protected jobs read, and set `KINDGI_API_TOKEN` on the `kindgi` steps only.

## Next

- [People, API keys and service accounts](../people-and-keys/): the service
  accounts and keys CI uses, and how to revoke one.
- [Release an agent version](../../guides/improve/release-an-agent-version/):
  pin, unpin and gate a release by hand.
