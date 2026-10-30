// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * The hand-written parts of the CLI reference (`../cli.mjs`). Everything
 * else comes from the CLI's own definitions and the guides.
 *
 * `scripts/check-reference.mjs` fails the docs build when a command or a
 * flag the CLI has isn't covered here, or when an entry names one it no
 * longer has.
 */

/**
 * Each string flag's default, by command path and flag name, as the
 * reference shows it: a value in backticks, or words ("none", "required",
 * "the tenant's Default project"). A boolean flag is `off` unless it's
 * listed.
 */
export const CLI_DEFAULTS = {
  'auth registry': {
    'key-from': 'none',
    registry: "`registry.kindgi.com`, the runtime image's registry",
    username:
      '`kindgi` on `registry.kindgi.com`; required on another registry (except with `--check`)',
  },
  init: {
    'pack-id': "derived from the existing app's name",
    path: '`<pack-name>` (its last dot segment) under the current directory; in an existing app, the current directory',
    template: '`minimal`',
  },
  upgrade: {
    path: 'the current directory',
    to: "this CLI's version",
  },
  dev: {
    'database-url':
      "`KINDGI_DATABASE_URL` (the shell's, then the env files'), else the bundled Postgres",
    'dev-token': "the previous run's (from `.kindgirc.json`), else a new one",
    log: 'none',
    'log-format': '`pretty`',
    'log-level':
      "`KINDGI_LOG_LEVEL` (the shell's, then the env files'), else info; with `--quiet`, warn",
    path: 'the current directory',
    port: "`4000`, or the next free port when it's taken",
    'runtime-image': 'the image this CLI release pins',
    'runtime-url': 'none',
    tenant:
      "the project database's tenant if any, else the previous run's (from `.kindgirc.json`), else a new one",
    watch: 'on',
  },
  build: {
    'artifact-version': 'the build time, as `YYYYMMDD.HHMMSS` (UTC)',
    endpoint:
      "the env block's `build`; required when there is none (not used with `--local` or `--hosted`, which builds at the CLI's API URL under `/cloud`)",
    env: '`staging`',
    out: '`.kindgi/build` under the pack root',
    path: 'the current directory (the pack root is resolved from it)',
    platform: "with `--local`: `linux/amd64` when pushing, else this machine's",
    project: 'none: the build carries no project label (with `--hosted` only)',
    'published-at': 'the build time',
    push: "none; a bare `--push` uses the env block's `registry` + `/<packId>`",
    'registry-push-creds': 'none',
    'signer-key-id': "the env block's `signerKeyId`, else the key file's name",
    'signing-key': "the env block's `signingKey`; required to sign (unless `--skip-sign`)",
    target: "the env block's `buildTarget`, else the env name",
    tenant:
      "the env block's `tenantId`, else `KINDGI_TENANT_ID`, else with `--hosted` the API key's own tenant; required unless `--local` without `--push`",
  },
  deploy: {
    'artifact-version': 'for an inline build: the build time, as `YYYYMMDD.HHMMSS` (UTC)',
    'build-endpoint': "for an inline build: the env block's `build`",
    endpoint:
      "the env block's `endpoint`, else the CLI's API URL (`--url`, `KINDGI_API_URL`, config files); required when none. A stored API key goes only to the address stored with it, and the key stored with the endpoint's address is the one used (`--token` or `KINDGI_API_TOKEN` gives another server's key); with `--hosted`, the endpoint can only be the CLI's API URL, and the `.kindgirc.json` that `kindgi dev` writes isn't read",
    env: '`staging`',
    'from-envelope': '`deploy-envelope.json` in `--out`; an inline build runs when it is missing',
    'idempotency-key': 'a hash of the request body',
    out: '`.kindgi/build` under the pack root',
    path: 'the current directory',
    project: "none: a tenant-wide deploy, into the tenant's Default project",
    'published-at': 'for an inline build: the build time',
    'registry-push-creds': 'none',
    'signer-key-id': "for an inline build: the env block's `signerKeyId`, else the key file's name",
    'signing-key': "for an inline build: the env block's `signingKey`",
    target: "for an inline build: the env block's `buildTarget`, else the env name",
    tenant:
      "none (no check); an inline build takes the env block's `tenantId`, else `KINDGI_TENANT_ID`",
  },
  'deployments list': {
    cursor: 'none',
    'image-ref-prefix': 'none',
    limit: '`25` (at most `100`)',
    pack: 'none: every pack',
    project: 'none: every project',
    'signer-key-id': 'none',
  },
  test: {
    path: 'the current directory',
    reporter: "vitest's own reporter",
  },
  'env list': {
    env: '`staging`',
    path: 'the current directory',
    scope: 'none (reads the local env files)',
  },
  'env set': {
    env: '`staging`',
    path: 'the current directory',
    scope: 'none (writes `.env.<env>`)',
  },
  'env unset': {
    env: '`staging`',
    path: 'the current directory',
    scope: 'none (edits `.env.<env>`)',
  },
  'env pull': {
    env: '`staging`',
    path: 'the current directory',
    scope: 'required',
  },
  'env init': {
    kms: 'none (asked for when the postgres backend needs it; an error with `--non-interactive`)',
    'non-interactive': 'off (prompts when stdin is a terminal)',
    out: '`.env.example` in the current directory',
    'secrets-backend': 'required (asked for on a terminal)',
    'secrets-manager':
      'none (asked for when the secret-manager backend needs it; an error with `--non-interactive`)',
  },
  'env plan': {
    env: '`staging`',
    format: '`terraform`',
    path: 'the current directory',
  },
  'environments list': {
    org: "none (the tenant's order)",
    path: 'the current directory',
  },
  'environments set': {
    org: "none (the tenant's order)",
    path: 'the current directory',
    projects: 'none (the environment names are used, resolved through the pack config)',
  },
  'environments clear': {
    org: "none (the tenant's order)",
  },
  promote: {
    from: 'required',
    to: 'required',
    deployment: 'none (the one deployment serving in `--from`; in a pack, of this pack)',
    reason: 'none',
    path: 'the current directory',
    wait: 'off; a bare `--wait` waits at most `1h`',
  },
  'secrets list': {
    cursor: 'none',
    env: 'required',
    limit: '`25` (at most `100`)',
    'name-prefix': 'none',
    scope: 'required',
  },
  'secrets get': {
    env: 'required',
    scope: 'required',
  },
  'secrets set': {
    env: 'required',
    'from-file': 'none (prompts for the value on a terminal)',
    'from-stdin': 'off (prompts for the value on a terminal)',
    'if-version': 'none',
    'rotation-due-at': 'none',
    scope: 'required',
    'write-mode': '`create-new`',
  },
  'secrets rotate': {
    env: 'required',
    'from-file':
      'none (the secret store rotates the value itself unless `--new-value` or `--from-stdin`)',
    'no-wait': 'off (waits for an asynchronous rotation to finish)',
    'revoke-old-after': 'none (the old version stays valid)',
    scope: 'required',
  },
  'secrets revoke': {
    env: 'required',
    hard: 'off (soft revoke, keeps an audit tombstone)',
    reason: 'none',
    scope: 'required',
  },
  'secrets pull': {
    env: 'required',
    path: 'the current directory',
    scope: 'required',
  },
  'sso providers start': {
    idp: 'none',
    kind: "none: the `--idp` preset's kind if given, else the registered provider's own (required before it's registered)",
  },
  'sso providers finish': {
    'client-id': 'none',
    'client-secret-ref': 'none',
    domains: 'required',
    'idp-metadata': 'none',
    issuer: 'none',
    kind: 'required',
    name: 'none',
    'sp-signing-key-ref': 'none',
    spec: 'none',
  },
  'sso providers update': {
    'client-id': 'none',
    'client-secret-ref': 'none',
    domains: 'none',
    'idp-metadata': 'none',
    issuer: 'none',
    kind: 'none',
    name: 'none',
    remove: 'none',
    'sp-signing-key-ref': 'none',
    spec: 'none',
  },
  'sso providers test': {
    email: "`someone@` the provider's first domain",
  },
  'key create': {
    env: 'none',
    home: '`$HOME` (then the context home, then the OS home directory)',
  },
  'key export': {
    format: '`pem`',
    home: '`$HOME` (then the context home, then the OS home directory)',
  },
  'key list': {
    home: '`$HOME` (then the context home, then the OS home directory)',
  },
  'key trust': {
    home: '`$HOME` (then the context home, then the OS home directory)',
    label: 'none',
  },
  'key revoke': {
    reason: 'none',
  },
  'license enroll': {
    'access-url': '`https://access.kindgi.com`',
    for: 'required',
    renewer: 'required',
  },
  'license renew': {
    'access-url': '`https://access.kindgi.com`',
    'env-file': 'none (give this or `--key`)',
    key: 'none (give this or `--env-file`)',
    renewer: 'required',
    runtime: 'none: the renewal carries no counts (give it with `--runtime-token`)',
    'runtime-token': 'none (give it with `--runtime`)',
  },
  'mcp add': {
    env: '`local`',
    path: 'the current directory',
    scope: '`tenant`',
    secret: 'required',
    'server-name':
      'derived from `--secret` (lowercased, trailing `_url`/`_key`/`_token` etc. stripped)',
  },
  'mcp list': {
    path: 'the current directory',
  },
  'mcp remove': {
    path: 'the current directory',
  },
  'projects list': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
  },
  'projects create': {
    description: 'none',
    name: 'required',
    org: 'none (a project in no org)',
    slug: 'the name as a slug: lowercase letters and digits, accents dropped, each run of anything else `-`, at most 63 characters (`Support bot` is `support-bot`, `Café` is `cafe`)',
  },
  'projects rename': {
    name: 'unchanged',
    slug: 'unchanged',
  },
  'tenant rename': {
    name: 'unchanged',
    slug: 'unchanged',
  },
  'runs list': {
    agent: 'none',
    cursor: 'none',
    'test-run': 'none',
    limit: '`25` (at most `100`)',
    replays: '`exclude`; with `--test-run`, `include`',
    trigger: 'none',
  },
  'runs journal': {
    cursor: 'none',
    limit: 'none: the whole journal',
    since: 'none',
  },
  'runs start': {
    agent: 'required: one of `--agent`, `--flow`',
    'agent-version': "the agent's latest version",
    flow: 'required: one of `--agent`, `--flow`',
    'flow-version': "the flow's latest version",
    'idempotency-key': 'none',
    input: 'required',
    'no-wait': 'off (the command waits for the run to finish or wait on an approval)',
    project: "the tenant's Default project",
    segment: 'none',
  },
  'runs resume': {
    output: 'none: the command only says what the run waits for',
    waitpoint: "the run's only wait for another system's answer (only with `--output`)",
  },
  'agents list': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
    name: 'none',
  },
  'agents publish': {
    project: "the tenant's Default project",
    spec: 'required',
  },
  'agents derive': {
    from: 'required',
    label: 'none',
    project: 'none',
    prompt: 'none (at least one `--prompt` or `--setting` is required)',
    setting: 'none (at least one `--prompt` or `--setting` is required)',
  },
  'agents versions': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
  },
  'agents live': {
    project: 'none',
    segment: 'none',
  },
  'agents promote': {
    'test-run': 'none',
    'idempotency-key': 'none',
    tenant: 'required: one of `--tenant`, `--org`, `--project`',
    org: 'required: one of `--tenant`, `--org`, `--project`',
    project: 'required: one of `--tenant`, `--org`, `--project`',
    segment: 'none',
    reason: 'none',
    wait: 'off; a bare `--wait` waits at most `1h`',
  },
  'agents gate-policy': {
    tenant: 'required: one of `--tenant`, `--org`, `--project`',
    org: 'required: one of `--tenant`, `--org`, `--project`',
    project: 'required: one of `--tenant`, `--org`, `--project`',
    segment: 'none',
  },
  'agents rollback': {
    tenant: 'required: one of `--tenant`, `--org`, `--project`',
    org: 'required: one of `--tenant`, `--org`, `--project`',
    project: 'required: one of `--tenant`, `--org`, `--project`',
    segment: 'none',
    'idempotency-key': 'none',
    reason: 'none',
    to: 'the previous live version',
  },
  'agents unpin': {
    tenant: 'required: one of `--tenant`, `--org`, `--project`',
    org: 'required: one of `--tenant`, `--org`, `--project`',
    project: 'required: one of `--tenant`, `--org`, `--project`',
    segment: 'none',
    'idempotency-key': 'none',
    reason: 'none',
  },
  'agents promotions list': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
    tenant: 'none (no scope given: the history of every scope)',
    org: 'none (no scope given: the history of every scope)',
    project: 'none (no scope given: the history of every scope)',
    segment: 'none',
  },
  'conversations list': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
    'opened-by': 'none (whoever opened them)',
    replays: '`exclude`',
    status: 'none',
  },
  'conversations open': {
    participant: 'none',
    project: "the tenant's Default project",
    title: '`Untitled conversation`',
  },
  'conversations messages': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
  },
  'tools list': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
    name: 'none',
  },
  'tools publish': {
    manifest: 'required',
    project: "the tenant's Default project",
  },
  'tools versions': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
  },
  'guardrails list': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
    name: 'none',
  },
  'guardrails register': {
    project: "the tenant's Default project",
    spec: 'required',
  },
  'memory facts list': {
    'as-of': 'none',
    cursor: 'none',
    limit: '`25` (at most `100`)',
    scope: 'none',
    type: 'none',
  },
  'memory facts get': {
    'as-of': 'none',
    revision: 'none',
  },
  'memory facts write': {
    input: 'required',
  },
  'memory facts supersede': {
    'expect-version': 'none',
    input: 'required',
  },
  'memory facts delete': {
    'expect-version': 'none',
  },
  'memory facts verify': {
    'expect-version': 'none',
  },
  'memory facts retrieve': {
    query: 'required',
  },
  'memory erasures create': {
    conversation: 'none',
    external: 'none',
    fact: 'none',
    participant: 'none',
  },
  'memory erasures list': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
  },
  'memory erasures export': {
    out: 'standard output',
  },
  'suggested-changes list': {
    agent: 'none',
    cursor: 'none',
    limit: '`25` (at most `100`)',
    project: 'none',
    status: 'none',
  },
  'suggested-changes draft': {
    agent: 'required',
    block: 'required',
    correction: 'none',
    project: 'required',
    why: 'required',
    'idempotency-key': 'none',
    template: 'none',
    values: 'none',
  },
  'suggested-changes evaluate': {
    'idempotency-key': 'none',
  },
  'suggested-changes request': {
    'idempotency-key': 'none',
    reason: 'none',
  },
  'suggested-changes withdraw': {
    'idempotency-key': 'none',
    reason: 'required',
  },
  'improve runs start': {
    agent: 'required',
    'group-weights':
      "none (counts everyone until the test cases' project, its tenant, or the agent improved there has an expert group, then only those)",
    drafts: '`3` (`1` to `5`; with `--tier=prompt` only)',
    'from-version': 'the version serving the scope',
    'idempotency-key': 'none',
    'max-candidates': '`30`',
    'max-cost': '`5` (US dollars)',
    model: 'none (needed with `--tier=prompt`, with `--provider`)',
    objective: '`weightedYesShare`',
    org: 'none',
    'run-project': "the scope's project, else the agent version's",
    project: 'none',
    provider: 'none (needed with `--tier=prompt`, with `--model`)',
    segment: 'none',
    'test-set': 'required',
    tier: '`settings`',
  },
  'improve runs list': {
    agent: 'none',
    cursor: 'none',
    limit: '`25` (at most `100`)',
  },
  'improve runs cancel': {
    'idempotency-key': 'none',
  },
  'provenance list': {
    agent: 'none',
    'created-after': 'none',
    cursor: 'none',
    flow: 'none',
    limit: '`25` (at most `100`)',
    org: 'none',
    project: 'none',
    run: 'none',
  },
  'provenance export': {
    'signing-key': "the deployment's active key",
  },
  'exports create': {
    out: 'required: a new or empty folder, or, with `--resume`, the folder an export stopped in',
  },
  'exports verify': {
    trust: "none (checks against the export's own key only)",
  },
  'artifacts list': {
    'content-type': 'none',
    cursor: 'none',
    limit: '`25` (at most `100`)',
    project: 'none',
    run: 'none',
  },
  'artifacts upload': {
    'content-type': '`application/octet-stream`',
    name: "the file's name",
    project: "with `--run`, the run's project; else the tenant's Default project",
    run: 'none',
    tag: 'none',
  },
  'artifacts download': {
    o: "the artifact's own name, in the current directory",
  },
  'flows list': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
    name: 'none',
  },
  'flows publish': {
    project: "the tenant's Default project",
    spec: 'required',
  },
  'flows versions': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
  },
  'schedules list': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
    project: 'none',
    status: 'none',
  },
  'schedules get': {
    upcoming: 'none',
  },
  'schedules create': {
    agent: 'none',
    'agent-version': 'none',
    'allow-unattended': 'none (a tool that waits for a person still waits)',
    'catch-up': '`latest`',
    cron: 'required',
    flow: 'none',
    'flow-version': 'none',
    improve: 'none',
    input: '`{}`',
    label: 'none',
    overlap: '`skip`',
    project: "the tenant's Default project",
    'run-as': 'none (you own the schedule)',
    segment: 'none',
    'starting-deadline': '`600` (seconds)',
    timezone: '`UTC`',
  },
  'schedules take-ownership': {
    'run-as': 'none (you own the schedule)',
  },
  'schedules update': {
    agent: 'unchanged',
    'agent-version': 'unchanged',
    'allow-unattended':
      'unchanged; a schedule that has a list and moves to another flow or agent must name it again, or `none`',
    'catch-up': 'unchanged',
    cron: 'unchanged',
    flow: 'unchanged',
    'flow-version': 'unchanged',
    improve: 'unchanged',
    input: 'unchanged',
    label: 'unchanged',
    overlap: 'unchanged',
    project: 'unchanged',
    segment: 'none',
    'starting-deadline': 'unchanged',
    timezone: 'unchanged',
  },
  'schedules fires': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
  },
  'schedules versions': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
  },
  'webhooks register': {
    'allow-unattended': 'none (a tool that waits for a person still waits)',
    'body-limit': '`262144` bytes (256 KiB)',
    'delivery-id-header': 'none, or the header the preset sets',
    flow: 'required',
    'flow-version': 'required',
    'generate-secret': 'none',
    input: 'none (the flow gets the event)',
    label: 'none',
    preset: 'none (with no `--signature-header` either: a hex HMAC-SHA256 in `X-Kindgi-Signature`)',
    project: "the tenant's Default project",
    'rate-limit': '`600` a minute',
    'run-as': 'none (you own the trigger)',
    secret: 'required',
    'signature-encoding': 'required with `--signature-header`',
    'signature-header': 'none',
    'signature-prefix': 'none',
  },
  'webhooks list': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
    project: 'none',
    status: 'none (both active and paused)',
  },
  'webhooks update': {
    'allow-unattended': 'unchanged',
    'body-limit': 'unchanged',
    'delivery-id-header': 'unchanged',
    'flow-version': 'unchanged',
    input: 'unchanged',
    label: 'unchanged',
    preset: 'unchanged',
    'rate-limit': 'unchanged',
    secret: 'unchanged',
    'signature-encoding': 'required with `--signature-header`',
    'signature-header': 'unchanged',
    'signature-prefix': 'none',
  },
  'webhooks fires': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
  },
  'webhooks versions': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
  },
  'webhooks take-ownership': {
    'run-as': 'none (you own the trigger)',
  },
  'mail-triggers list': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
    project: 'none',
    status: 'none (both active and paused)',
  },
  'mail-triggers create': {
    agent: 'none',
    'agent-version': 'none (its live version, else the latest)',
    'allow-unattended': 'none (a tool that waits for a person still waits)',
    as: '`person` (your own mailbox)',
    flow: 'none',
    'flow-version': 'required with `--flow`',
    folder: 'none (the inbox)',
    label: 'none',
    mailbox: 'required',
    poll: '`60` (seconds)',
    project: "the tenant's Default project",
    'run-as': 'none (you own the trigger)',
    'runs-per-hour': '`60`',
  },
  'mail-triggers update': {
    agent: 'unchanged',
    'agent-version': 'unchanged',
    'allow-unattended':
      'unchanged; a trigger that has a list and moves to another flow, agent or mailbox must name it again, or `none`',
    as: 'unchanged (given with `--mailbox`)',
    flow: 'unchanged',
    'flow-version': 'unchanged',
    folder: 'unchanged',
    label: 'unchanged',
    mailbox: 'unchanged (given with `--as`)',
    poll: 'unchanged',
    'runs-per-hour': 'unchanged',
  },
  'mail-triggers fires': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
  },
  'mail-triggers versions': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
  },
  'mail-triggers take-ownership': {
    'run-as': 'none (you own the trigger)',
  },
  'sites register': {
    'allowed-role': '`administrator` and `shop_manager`',
    'approvals-url': 'required',
    name: 'required',
    'new-people-per-day': '`20`',
    origin: 'required',
    'people-cap': '`50`',
    project: "the tenant's Default project",
    'reviewer-ceiling': '`standard`',
    'role-map':
      'both default roles may ask, and decide as `standard` reviewers; with `--allowed-role` alone, the entries of the roles it allows',
    vouching: '`on`',
  },
  'sites code': {
    project: "the tenant's Default project",
  },
  'sites list': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
    project: "the tenant's Default project",
  },
  'sites get': {
    project: "the tenant's Default project",
  },
  'sites update': {
    'allowed-role': 'unchanged',
    'approvals-url': 'unchanged',
    name: 'unchanged',
    'new-people-per-day': 'unchanged',
    origin: 'unchanged',
    'people-cap': 'unchanged',
    project: "the tenant's Default project",
    'reviewer-ceiling': 'unchanged',
    'role-map': 'unchanged; with `--allowed-role` alone, the entries of the roles still allowed',
    vouching: 'unchanged',
  },
  'sites pause': {
    project: "the tenant's Default project",
  },
  'sites resume': {
    project: "the tenant's Default project",
  },
  'sites revoke-key': {
    project: "the tenant's Default project",
  },
  'sites restore-person': {
    project: "the tenant's Default project",
  },
  'sites unregister': {
    project: "the tenant's Default project",
  },
  'approvals list': {
    'assigned-to': 'none (all approvals your role can see)',
    cursor: 'none',
    'decided-by': 'none (whoever decided them)',
    limit: '`25` (at most `100`)',
    order: '`desc` (newest first)',
    status: 'none (every status)',
  },
  'approvals complete': {
    decision: 'required',
    rationale: 'none',
  },
  'approvals export': {
    'include-messages': 'none',
    'signing-key': "the deployment's active key",
  },
  'reviewers list': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
  },
  'reviewers register': {
    spec: 'required',
  },
  'corrections add': {
    group: 'none (the correction is ungrouped)',
    correction: 'none (an ordinary correction, without what the agent should have done)',
    item: 'required',
    no: 'off (exactly one of `--yes` or `--no` is required)',
    participant: 'none',
    pointer: 'none (item recorded without a pointer)',
    rank: 'none',
    reason: 'none',
    run: 'required',
    yes: 'off (exactly one of `--yes` or `--no` is required)',
  },
  'corrections list': {
    agent: 'none',
    'agent-version': 'none',
    group: 'none',
    cursor: 'none',
    flow: 'none',
    limit: '`25` (at most `100`)',
    participant: 'none',
    project: 'none',
    run: 'none',
    verdict: 'none',
  },
  'corrector-groups list': {
    agent: 'none',
    cursor: 'none',
    limit: '`25` (at most `100`)',
    project: 'none',
    tenant: 'off (with no scope flag, no scope filter is sent)',
  },
  'corrector-groups add': {
    agent: 'none',
    description: 'none',
    'min-reviewer-role': 'none (anyone who may correct the run may assert)',
    name: 'required',
    'principal-id': 'none (no restriction)',
    'principal-kind': 'none (no restriction)',
    project: 'none',
    tenant: 'off (a scope is required: `--tenant`, `--project`, or `--agent` with `--project`)',
    weight: 'required',
  },
  'corrector-groups set': {
    description: 'unchanged',
    'min-reviewer-role': 'unchanged',
    'principal-id': 'unchanged',
    'principal-kind': 'unchanged',
    weight: 'unchanged',
  },
  'queue-rules create': {
    project: "the tenant's Default project",
    name: 'required',
    agent: 'none (runs of any agent)',
    flow: 'none (runs of any flow)',
    'agent-version': 'none (any version)',
    status: '`completed` (only completed runs match)',
    sample: '`1` (every matching run)',
    'max-open': 'none (no cap)',
    group: 'none (any correction closes an item)',
    'queue-last':
      'none (nothing is queued on create unless `--queue-last` or `--queue-since` is given)',
    'queue-since': 'none',
  },
  'queue-rules list': {
    project: "the tenant's Default project",
    limit: '`25` (at most `100`)',
    cursor: 'none',
  },
  'queue-rules show': {
    project: "the tenant's Default project",
  },
  'queue-rules update': {
    project: "the tenant's Default project",
    name: 'unchanged',
    agent: 'unchanged (any match flag replaces `when` whole)',
    flow: 'unchanged (any match flag replaces `when` whole)',
    'agent-version': 'unchanged (any match flag replaces `when` whole)',
    status: 'unchanged (any match flag replaces `when` whole)',
    sample: 'unchanged',
    'max-open': 'unchanged',
    group: 'unchanged',
  },
  'queue-rules remove': {
    project: "the tenant's Default project",
  },
  'queue-rules versions': {
    project: "the tenant's Default project",
    limit: '`25` (at most `100`)',
    cursor: 'none',
  },
  'queue-rules results': {
    project: "the tenant's Default project",
    since: 'none (every result)',
  },
  'queue-rules preview': {
    project: "the tenant's Default project",
    agent: 'none (runs of any agent)',
    flow: 'none (runs of any flow)',
    'agent-version': 'none (any version)',
    status: '`completed` (only completed runs match)',
    sample: '`1` (every matching run)',
    last: '`100` (1 to 500)',
    rule: 'none (preview the given flags, not an existing rule)',
  },
  'queue-rules queue-recent': {
    project: "the tenant's Default project",
    last: 'none (give `--last` and/or `--since`)',
    since: 'none (give `--last` and/or `--since`)',
  },
  'expert-queue list': {
    project: "the tenant's Default project",
    state: 'none (every state)',
    agent: 'none',
    rule: 'none',
    group: 'none',
    'added-after': 'none',
    'closed-after': 'none',
    limit: '`25` (at most `100`)',
    cursor: 'none',
  },
  'expert-queue dismiss': {
    project: "the tenant's Default project",
    reason: 'none',
  },
  'expert-queue reopen': {
    project: "the tenant's Default project",
  },
  'test-runs start': {
    project: 'required',
    agent: 'required: one of `--agent`, `--flow`',
    'agent-version': 'the latest version',
    flow: 'required: one of `--agent`, `--flow`',
    'flow-version': 'the latest version',
    with: 'none',
    baseline: '`recorded`',
    'baseline-project': 'none',
    'baseline-segment': 'none',
    reads: '`recorded`',
    repetitions: '`1`',
    k: '`10`',
    'group-weights': '`as-recorded`',
  },
  'test-runs list': {
    agent: 'none',
    cursor: 'none',
    limit: '`25` (at most `100`)',
    status: 'none',
    'test-set': 'none',
  },
  'test-runs rescore': {
    project: 'none',
  },
  'test-sets list': {
    cursor: 'none',
    kind: 'none',
    limit: '`25` (at most `100`)',
    project: 'none',
  },
  'test-sets show': {
    'test-set-version': 'the latest version',
  },
  'test-sets from-corrections': {
    agent: 'required: one of `--agent`, `--flow`',
    'agent-version': 'none',
    group: 'none',
    description: 'none',
    flow: 'required: one of `--agent`, `--flow`',
    'min-corrections': '`1`',
    project: 'required',
    segment: 'none',
    since: 'none',
    'test-set-version': 'required',
    until: 'none',
  },
  'test-sets cases': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
    'test-set-version': 'required',
  },
  'blocks list': {
    cursor: 'none',
    kind: 'none',
    limit: '`25` (at most `100`)',
    name: 'none',
    project: 'none',
  },
  'blocks show': {
    'block-version': 'the latest version',
  },
  'blocks versions': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
  },
  'blocks publish': {
    'block-version': 'required',
    description: 'none',
    project: 'required',
    prompt: 'none',
    schema: 'none',
    settings: 'none',
  },
  'blocks unregister': {
    'block-version': 'required',
  },
  'blocks reinstate': {
    'block-version': 'required',
  },
  'gate-policies list': {
    agent: 'none',
    cursor: 'none',
    limit: '`25` (at most `100`)',
    org: 'none',
    project: 'none',
    segment: 'none',
  },
  'gate-policies publish': {
    agent: 'required',
    description: 'none',
    org: 'required: one of `--tenant`, `--org`, `--project`',
    'policy-version': 'required',
    project: 'required: one of `--tenant`, `--org`, `--project`',
    segment: 'none',
    spec: 'required',
    tenant: 'required: one of `--tenant`, `--org`, `--project`',
  },
  'tokens create': {
    capability: 'none',
    expires: 'none',
    for: 'none: the key is for you',
    label: 'none',
    project: 'none',
    role: '`member`',
  },
  'tokens list': {
    cursor: 'none',
    for: 'none',
    limit: '`25` (at most `100`)',
  },
  'service-accounts create': {
    description: 'none',
    project: 'none',
  },
  'service-accounts list': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
  },
  'service-accounts grant': {
    project: 'none',
    role: 'required with `--project`',
  },
  'service-accounts ungrant': {
    project: 'none',
  },
  'connections list': {
    app: 'none',
    cursor: 'none',
    limit: '`25` (at most `100`)',
    project: 'none',
  },
  'connections connect': {
    'app-id': "none: the app's one registration",
    permissions:
      "none picked: at a terminal it asks about each one the app's entry offers; required without one",
    project: 'none',
  },
  'connection-apps list': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
  },
  'connection-apps add': {
    'client-id': 'required',
    'client-secret-ref': 'required',
    'github-app-id': 'required for `github`',
    'private-key-ref': 'required for `github`',
    projects: 'none: every project',
    slug: 'required for `github`',
    tenant: "none: required where the app's entry names no default (`microsoft`)",
    'webhook-secret-ref': 'required for `github`',
  },
  'people add': {
    email: 'none',
    name: 'required',
  },
  'sign-in settings': {
    'require-second-factor': 'unchanged: the settings are read',
  },
  'people list': {
    cursor: 'none',
    limit: '`25` (at most `100`)',
    query: 'none',
  },
  'capabilities list': {
    cursor: 'none',
    feature: 'none',
    limit: '`25` (at most `100`)',
  },
  'providers list': {
    cursor: 'none',
    feature: 'none',
    limit: '`25` (at most `100`)',
  },
  'providers register': {
    deployments: 'required with the azure-openai preset',
    env: '`local`',
    'max-output-tokens': "the preset's own value for each model",
    models: "all of the preset's models",
    preset: 'none',
    project: 'required with the gemini preset',
    region: 'required with the bedrock preset',
    'resource-name': 'required with the azure-openai preset',
    secret: "the preset's own secret name",
    spec: 'none',
  },
  'adapters prepare': {
    model: 'none',
    params: 'none',
  },
  'skills sync': {
    path: 'the current directory',
  },
  'feedback write': {
    'authored-by': '`human`',
    body: 'none',
    interactive:
      'on when neither `--body` nor `--body-stdin` is given (opens `$EDITOR`, else VISUAL, else vi)',
    kind: 'required',
    path: 'the current directory',
    severity: '`medium`',
    title: 'required',
  },
  'feedback submit': {
    'access-url': '`https://access.kindgi.com`',
    path: 'the current directory',
    yes: 'none: at a terminal it asks; with no terminal, nothing is sent',
  },
  'feedback status': {
    'access-url': '`https://access.kindgi.com`',
    path: 'the current directory',
  },
  'feedback withdraw': {
    'access-url': '`https://access.kindgi.com`',
    path: 'the current directory',
  },
  doctor: {
    path: 'the current directory',
  },
  usage: {
    month: 'the current calendar month, in UTC',
    from: 'none; with `--to` it sets a window instead of a month',
    to: 'none; the window ends here (exclusive), at most 92 days after `--from`',
    project: 'none: every project you can read',
    'group-by': '`project,kind`',
    kind: 'none: every kind',
    class: 'none: every run class',
    state: 'none: every state',
    limit: '`1000` (`1` to `10000`)',
    cursor: 'none: the first page',
  },
};

/** The global flags' defaults, as `CLI_DEFAULTS`. */
export const GLOBAL_FLAG_DEFAULTS = {
  hosted:
    "off, unless the env the command acts in has `build: 'hosted'` in `kindgi.config.ts` (`--env`, else `staging` for `kindgi build` and `kindgi deploy`)",
  json: 'on when no format flag is given: pretty JSON (commands for people, such as `kindgi dev`, print JSON only when asked)',
  table: 'off; a command with no table prints JSON',
  token:
    "`KINDGI_API_TOKEN`, then a stored key: `./.kindgirc.json`'s, then `~/.kindgi/config.json`'s, and when those are for different addresses, the one stored with the API URL. A stored key goes only to the address stored with it: a command that would send it elsewhere is refused before it sends anything. With `--hosted`, a `kindgi dev` runtime's `./.kindgirc.json` isn't read. None of them set: a command that calls the API fails",
  url: "`KINDGI_API_URL`, then `./.kindgirc.json`, then `~/.kindgi/config.json`; with `--hosted`, a `kindgi dev` runtime's `./.kindgirc.json` isn't read. None of them set: a command that calls the API fails",
};

/**
 * Examples for the commands no guide runs, by command path: what it does,
 * then the line. The guides' own lines are added after these.
 */
export const CLI_EXAMPLES = {
  'auth login': [
    {
      purpose:
        'Save the API URL, and the API token exported as `KINDGI_API_TOKEN`, to ~/.kindgi/config.json.',
      line: 'kindgi auth login --url=https://kindgi.acme.example',
    },
  ],
  'auth whoami': [
    {
      purpose: 'Check that the saved token works against the API.',
      line: 'kindgi auth whoami',
    },
  ],
  'auth registry': [
    {
      purpose:
        'Log Docker in to registry.kindgi.com with your license key, then check the pull; the key is prompted for.',
      line: 'kindgi auth registry',
    },
    {
      purpose: 'Log in in a script, reading the license key from stdin.',
      line: 'kindgi auth registry --password-stdin < kindgi-license-key.txt',
    },
    {
      purpose:
        'Log in to registry.kindgi.com with the license key a deployment already keeps, so it never passes through your shell.',
      line: 'kindgi auth registry --key-from env-file:kindgi.env#KINDGI_LICENSE_KEY',
    },
    {
      purpose: 'Check that Docker can already pull the image, without logging in.',
      line: 'kindgi auth registry --check',
    },
    {
      purpose:
        "Log in to a mirror of the image instead, with that registry's own username and token; the check then looks for the image there.",
      line: 'kindgi auth registry --registry=registry.acme.example --username=acme-ci --password-stdin < mirror-token.txt',
    },
  ],
  upgrade: [
    {
      purpose: "Move a Java or Scala pack to this CLI's version.",
      line: 'kindgi upgrade',
    },
    {
      purpose: 'Pin a specific version in a pack in another folder.',
      line: 'kindgi upgrade --to=<version> --path=./acme-order-desk',
    },
  ],
  console: [
    {
      purpose: 'Open the console of the runtime the CLI points at.',
      line: 'kindgi console',
    },
    {
      purpose: 'Print the console URL of a given runtime without opening a browser.',
      line: 'kindgi console --no-open --url=http://127.0.0.1:4000',
    },
  ],
  'deployments get': [
    {
      purpose:
        "See a deployment's pack service now: when it runs on the values it was last given, why, and the command that sets what's missing.",
      line: 'kindgi deployments get <deployment-id>',
    },
    {
      purpose: 'The deployment as the API answers it, with its pack service in `endpoint`.',
      line: 'kindgi deployments get <deployment-id> --json',
    },
  ],
  'deployments list': [
    {
      purpose:
        "Find a deployment's id, with each one's pack service: ready, held on its last values (with the code), pending or cleared.",
      line: 'kindgi deployments list --table',
    },
    {
      purpose:
        "One environment's deployments, by its project's slug or id. The Default project's include the deployments that name no project.",
      line: 'kindgi deployments list --project=staging --table',
    },
  ],
  'env unset': [
    {
      purpose: 'Remove a key from the staging env file.',
      line: 'kindgi env unset ORDERS_API_URL --env=staging',
    },
    {
      purpose: "Remove a key from the runtime's tenant-wide values.",
      line: 'kindgi env unset ORDERS_REGION --scope=tenant --env=local',
    },
  ],
  'env pull': [
    {
      purpose: "Pull a project's env values into .env.staging, skipping keys already set.",
      line: 'kindgi env pull --env=staging --scope=project:<project-id>',
    },
    {
      purpose: "Pull the tenant's values and replace keys the file already sets.",
      line: 'kindgi env pull --env=staging --scope=tenant --overwrite-existing',
    },
  ],
  'env init': [
    {
      purpose: 'Scaffold .env.example for a Postgres backend with Google Cloud KMS.',
      line: 'kindgi env init --secrets-backend=postgres --kms=gcp --non-interactive',
    },
    {
      purpose: 'Scaffold it for a cloud secret manager, writing to a chosen file.',
      line: 'kindgi env init --secrets-backend=secret-manager --secrets-manager=gcp --out=.env.production.example',
    },
  ],
  'environments list': [
    {
      purpose: 'Show the order projects go live through, as a table.',
      line: 'kindgi environments list --table',
    },
    {
      purpose: "List an org's own order instead of the tenant's.",
      line: 'kindgi environments list --org=<org-id>',
    },
  ],
  'environments set': [
    {
      purpose: 'Put staging before prod, naming the environments from the pack config.',
      line: 'kindgi environments set staging prod',
    },
    {
      purpose: 'Set the order by project id or slug, outside a pack.',
      line: 'kindgi environments set --projects=staging,default',
    },
  ],
  'environments clear': [
    {
      purpose: 'Clear the order; projects then take builds directly again.',
      line: 'kindgi environments clear',
    },
  ],
  promote: [
    {
      purpose: 'Promote the build serving in staging to prod, saying why.',
      line: 'kindgi promote --from=staging --to=prod --reason="release 12"',
    },
    {
      purpose:
        'Promote to prod and make each agent the build carries live there, each through its release gate policy.',
      line: 'kindgi promote --from=staging --to=prod --make-live --reason="release 12"',
    },
    {
      purpose: 'See what would move to prod and which values it lacks, changing nothing.',
      line: 'kindgi promote --from=staging --to=prod --check',
    },
    {
      purpose: 'Outside a pack, name the two environments by project slug or id.',
      line: 'kindgi promote --from=acme-staging --to=acme-prod',
    },
  ],
  'secrets list': [
    {
      purpose: "List the tenant's secrets for the local env.",
      line: 'kindgi secrets list --env=local --scope=tenant',
    },
    {
      purpose: 'Page through the secrets whose names start with ACME_.',
      line: 'kindgi secrets list --env=production --scope=tenant --name-prefix=ACME_ --limit=10',
    },
    {
      purpose: 'List revoked secrets too, with when and why each was revoked.',
      line: 'kindgi secrets list --env=production --scope=tenant --include-revoked',
    },
  ],
  'secrets rotate': [
    {
      purpose: 'Rotate a secret, entering the new value at a prompt.',
      line: 'kindgi secrets rotate ACME_WEBHOOK_SECRET --env=production --scope=tenant --new-value',
    },
    {
      purpose: 'Rotate from stdin and revoke the old version after an hour.',
      line: 'kindgi secrets rotate ACME_WEBHOOK_SECRET --env=production --scope=tenant --from-stdin --revoke-old-after=3600000',
    },
  ],
  'secrets revoke': [
    {
      purpose: 'Revoke a secret, keeping an audit tombstone.',
      line: 'kindgi secrets revoke ACME_WEBHOOK_SECRET --env=production --scope=tenant --reason="rotated after a leak"',
    },
    {
      purpose: "Erase a secret's value for good.",
      line: 'kindgi secrets revoke ACME_OLD_KEY --env=production --scope=tenant --hard',
    },
  ],
  'secrets pull': [
    {
      purpose: "Write the tenant's secret metadata to .secrets/production/manifest.json.",
      line: 'kindgi secrets pull --env=production --scope=tenant',
    },
    {
      purpose: 'Write the manifest under another pack directory.',
      line: 'kindgi secrets pull --env=staging --scope=project:<project-id> --path=./acme-ops',
    },
  ],
  'sso providers update': [
    {
      purpose: 'Point a provider at a rotated client secret.',
      line: 'kindgi sso providers update acme-okta --client-secret-ref=ACME_OKTA_SECRET_V2',
    },
    {
      purpose: 'Add a second sign-in domain and drop the display name.',
      line: 'kindgi sso providers update acme-okta --domains=acme.com,acme-ops.com --remove=displayName',
    },
  ],
  'sso providers get': [
    {
      purpose: 'Show a provider and the URLs to give your identity provider.',
      line: 'kindgi sso providers get acme-okta',
    },
  ],
  'sso providers remove': [
    {
      purpose: 'Stop signing in with a provider.',
      line: 'kindgi sso providers remove acme-okta',
    },
  ],
  'key export': [
    {
      purpose: "Print a key's public half as PEM.",
      line: 'kindgi key export acme-selfhost',
    },
    {
      purpose: 'Print it as base64.',
      line: 'kindgi key export acme-selfhost --format=base64',
    },
  ],
  'key list': [
    {
      purpose: 'List the local signing keys.',
      line: 'kindgi key list',
    },
  ],
  'mcp list': [
    {
      purpose: "List the servers in the current pack's .mcp.json.",
      line: 'kindgi mcp list',
    },
    {
      purpose: 'List the servers of a pack in another directory.',
      line: 'kindgi mcp list --path=./acme-pack',
    },
  ],
  'mcp remove': [
    {
      purpose: 'Remove a server entry from .mcp.json.',
      line: 'kindgi mcp remove my_db',
    },
    {
      purpose: 'Remove an entry from a pack in another directory.',
      line: 'kindgi mcp remove my_db --path=./acme-pack',
    },
  ],
  'mcp-launch': [
    {
      purpose:
        'The command an MCP client runs from .mcp.json: start the Postgres server with its connection string read from a secret (written by `kindgi mcp add`, not typed by hand).',
      line: 'kindgi mcp-launch -- --runtime=npx --package=@modelcontextprotocol/server-postgres --env-map=DATABASE_URL=secret:MY_DB_URL@local:tenant',
    },
  ],
  'projects list': [
    {
      purpose: "List the tenant's projects.",
      line: 'kindgi projects list',
    },
    {
      purpose: 'Page through them, 10 at a time.',
      line: 'kindgi projects list --limit=10 --cursor=<cursor>',
    },
  ],
  'projects get-default': [
    {
      purpose: "Show the tenant's Default project, the one used when no --project is given.",
      line: 'kindgi projects get-default',
    },
  ],
  'projects get': [
    {
      purpose: 'Show one project by id.',
      line: 'kindgi projects get <project-id>',
    },
  ],
  'projects create': [
    {
      purpose: 'Make a project, with the slug `support-bot`, and print it with its id.',
      line: 'kindgi projects create --name="Support bot"',
    },
    {
      purpose: 'Make a project in an org, with a slug of your own.',
      line: 'kindgi projects create --name=Support --slug=support --org=<org-id> --description="Answers the support inbox"',
    },
  ],
  'projects rename': [
    {
      purpose: "Change a project's name; its slug stays.",
      line: 'kindgi projects rename <project-id> --name=Storefront',
    },
    {
      purpose: 'Change its name and its slug.',
      line: 'kindgi projects rename <project-id> --name=Storefront --slug=storefront',
    },
  ],
  'tenant get': [
    {
      purpose: 'Print your workspace: its id, name and slug.',
      line: 'kindgi tenant get',
    },
  ],
  'tenant rename': [
    {
      purpose: "Change your workspace's name; its slug, and the console's addresses, stay.",
      line: 'kindgi tenant rename --name="Acme Store"',
    },
    {
      purpose: 'Change its slug too. Links to the console with the old slug stop opening it.',
      line: 'kindgi tenant rename --name="Acme Store" --slug=acme-store',
    },
  ],
  'agents list': [
    {
      purpose: 'List the registered agents.',
      line: 'kindgi agents list',
    },
    {
      purpose: 'List agents whose id starts with a prefix, including retired ones.',
      line: 'kindgi agents list --name=acme-ops. --include-retired',
    },
  ],
  'agents get': [
    {
      purpose: "Show an agent's latest version.",
      line: 'kindgi agents get acme-ops.reply-drafter',
    },
    {
      purpose: 'Show one specific version.',
      line: 'kindgi agents get acme-ops.reply-drafter 1.2.0',
    },
  ],
  'agents publish': [
    {
      purpose: 'Register an agent definition from a file.',
      line: 'kindgi agents publish --spec=@agent.json',
    },
    {
      purpose: 'Register it in a named project.',
      line: 'kindgi agents publish --spec=@agent.json --project=<project-id>',
    },
  ],
  'agents unregister': [
    {
      purpose: 'Unregister one version of an agent, so runs stop using it.',
      line: 'kindgi agents unregister acme-ops.reply-drafter 1.2.0',
    },
  ],
  'agents versions': [
    {
      purpose: "List an agent's registered versions.",
      line: 'kindgi agents versions acme-ops.reply-drafter',
    },
    {
      purpose: 'Include unregistered versions too.',
      line: 'kindgi agents versions acme-ops.reply-drafter --include-unregistered',
    },
  ],
  'agents live-versions': [
    {
      purpose: 'List every scope with a live version of the agent.',
      line: 'kindgi agents live-versions acme.order-desk',
    },
  ],
  'agents gate-policy': [
    {
      purpose: 'Show the release gate policy for the whole tenant.',
      line: 'kindgi agents gate-policy acme.order-desk --tenant',
    },
    {
      purpose: 'Show the policy for a segment of a project.',
      line: 'kindgi agents gate-policy acme.order-desk --project=<project-id> --segment=company:acme',
    },
  ],
  'agents promotions get': [
    {
      purpose: "Show one entry of an agent's go-live history.",
      line: 'kindgi agents promotions get acme.order-desk <promotion-id>',
    },
  ],
  'conversations list': [
    {
      purpose: 'List the open conversations.',
      line: 'kindgi conversations list --status=open',
    },
    {
      purpose: 'List only the replays of runs on the test cases, a page at a time.',
      line: 'kindgi conversations list --replays=only --limit=10',
    },
  ],
  'tools publish': [
    {
      purpose: 'Register a tool from a manifest file in the default project.',
      line: 'kindgi tools publish --manifest=@tools/acme.stock-level.json',
    },
  ],
  'tools unregister': [
    {
      purpose: 'Unregister one version of a tool.',
      line: 'kindgi tools unregister acme.stock-level 0.1.0',
    },
  ],
  'tools versions': [
    {
      purpose: "List a tool's versions, unregistered ones too.",
      line: 'kindgi tools versions acme.stock-level --include-unregistered',
    },
  ],
  'tools get-version': [
    {
      purpose: 'Fetch one exact version of a tool.',
      line: 'kindgi tools get-version acme.stock-level 0.1.0',
    },
  ],
  'tools reinstate': [
    {
      purpose: 'Bring back an unregistered tool version.',
      line: 'kindgi tools reinstate acme.stock-level 0.1.0',
    },
  ],
  'guardrails list': [
    {
      purpose: 'List the guardrails whose id starts with a prefix.',
      line: 'kindgi guardrails list --name=acme.',
    },
  ],
  'guardrails register': [
    {
      purpose: 'Register a guardrail from a file in a given project.',
      line: 'kindgi guardrails register --spec=@guardrails/acme.no-refunds.json --project=<project-id>',
    },
  ],
  'guardrails unregister': [
    {
      purpose: 'Unregister a guardrail.',
      line: 'kindgi guardrails unregister acme.no-refunds',
    },
  ],
  'exports create': [
    {
      purpose: 'Export the whole workspace to a new folder, as a tenant admin.',
      line: 'kindgi exports create --out ./acme-export',
    },
    {
      purpose: 'Finish an export that stopped part way: the kinds already written are kept.',
      line: 'kindgi exports create --out ./acme-export --resume',
    },
  ],
  'memory facts retrieve': [
    {
      purpose: 'Search facts by keyword.',
      line: 'kindgi memory facts retrieve --query=\'{"mode":"keyword","query":"delivery window","limit":5}\'',
    },
    {
      purpose: 'Run a retrieval whose query is kept in a file.',
      line: 'kindgi memory facts retrieve --query=@query.json',
    },
  ],
  'flows list': [
    {
      purpose: 'List registered flows, retired ones too.',
      line: 'kindgi flows list --include-retired',
    },
  ],
  'flows get': [
    {
      purpose: "Fetch a flow's latest version.",
      line: 'kindgi flows get acme.nightly-digest',
    },
    {
      purpose: 'Fetch one version of a flow.',
      line: 'kindgi flows get acme.nightly-digest 0.1.0',
    },
  ],
  'flows publish': [
    {
      purpose: 'Register a flow definition from a file.',
      line: 'kindgi flows publish --spec=@flows/acme.nightly-digest.json',
    },
  ],
  'flows unregister': [
    {
      purpose: 'Unregister a flow version: new runs of it are refused.',
      line: 'kindgi flows unregister acme.nightly-digest 0.1.0',
    },
  ],
  'flows versions': [
    {
      purpose: "List a flow's versions, unregistered ones too.",
      line: 'kindgi flows versions acme.nightly-digest --include-unregistered',
    },
  ],
  'flows reinstate': [
    {
      purpose: 'Bring back an unregistered flow version.',
      line: 'kindgi flows reinstate acme.nightly-digest 0.1.0',
    },
  ],
  'schedules get': [
    {
      purpose: 'Fetch a schedule with its next five run times.',
      line: 'kindgi schedules get <schedule-id> --upcoming=5',
    },
    {
      purpose: 'Fetch version 2 of a schedule: what it ran, as whom, and when.',
      line: 'kindgi schedules get <schedule-id> 2',
    },
  ],
  'schedules versions': [
    {
      purpose: "List a schedule's versions as a table: when each was made, by whom, and why.",
      line: 'kindgi schedules versions <schedule-id> --table',
    },
  ],
  'schedules update': [
    {
      purpose: 'Move a schedule to 08:00 on weekdays.',
      line: 'kindgi schedules update <schedule-id> --cron="0 8 * * 1-5"',
    },
    {
      purpose: 'Run an agent version on a schedule, and skip overlapping runs.',
      line: 'kindgi schedules update <schedule-id> --agent=acme.order-desk --agent-version=0.2.0 --overlap=skip',
    },
  ],
  'schedules pause': [
    {
      purpose: 'Pause a schedule.',
      line: 'kindgi schedules pause <schedule-id>',
    },
  ],
  'schedules resume': [
    {
      purpose: 'Resume a paused schedule.',
      line: 'kindgi schedules resume <schedule-id>',
    },
  ],
  'schedules run-now': [
    {
      purpose: 'Run a schedule now, outside its times.',
      line: 'kindgi schedules run-now <schedule-id>',
    },
  ],
  'schedules take-ownership': [
    {
      purpose: 'Take over a schedule whose owner left.',
      line: 'kindgi schedules take-ownership <schedule-id>',
    },
  ],
  'schedules unregister': [
    {
      purpose: 'Remove a schedule.',
      line: 'kindgi schedules unregister <schedule-id>',
    },
  ],
  'webhooks list': [
    {
      purpose: 'List the webhook triggers in a project.',
      line: 'kindgi webhooks list --project=<project-id>',
    },
    {
      purpose: 'List only the paused triggers, as a table.',
      line: 'kindgi webhooks list --status=paused --table',
    },
  ],
  'webhooks get': [
    {
      purpose: 'Show a trigger and the URL its sender posts to.',
      line: 'kindgi webhooks get <trigger-id>',
    },
    {
      purpose: 'Fetch version 2 of a trigger: what it ran, and how it checked its sender.',
      line: 'kindgi webhooks get <trigger-id> 2',
    },
  ],
  'webhooks versions': [
    {
      purpose: "List a trigger's versions as a table: when each was made, by whom, and why.",
      line: 'kindgi webhooks versions <trigger-id> --table',
    },
  ],
  'webhooks update': [
    {
      purpose: 'Point a trigger at a newer flow version.',
      line: 'kindgi webhooks update <trigger-id> --flow-version=0.2.0',
    },
    {
      purpose: "Switch the sender's scheme to the GitHub preset and raise the rate limit.",
      line: 'kindgi webhooks update <trigger-id> --preset=github --rate-limit=1200',
    },
  ],
  'webhooks pause': [
    {
      purpose: 'Pause a trigger so deliveries start nothing.',
      line: 'kindgi webhooks pause <trigger-id>',
    },
  ],
  'webhooks resume': [
    {
      purpose: 'Resume a paused trigger.',
      line: 'kindgi webhooks resume <trigger-id>',
    },
  ],
  'webhooks take-ownership': [
    {
      purpose: 'Make its runs act as you.',
      line: 'kindgi webhooks take-ownership <trigger-id>',
    },
  ],
  'webhooks unregister': [
    {
      purpose: 'Remove a trigger; its sender gets 410 from then on.',
      line: 'kindgi webhooks unregister <trigger-id>',
    },
  ],
  'mail-triggers list': [
    {
      purpose: 'List the mail triggers in a project.',
      line: 'kindgi mail-triggers list --project=<project-id>',
    },
    {
      purpose: 'List only the paused ones, as a table, with why each is paused.',
      line: 'kindgi mail-triggers list --status=paused --table',
    },
  ],
  'mail-triggers get': [
    {
      purpose: 'Fetch a mail trigger: what it runs, its mailbox and folder, and its status.',
      line: 'kindgi mail-triggers get <trigger-id>',
    },
    {
      purpose: 'Fetch version 2 of a mail trigger: what it ran, and which mailbox it watched.',
      line: 'kindgi mail-triggers get <trigger-id> 2',
    },
  ],
  'mail-triggers versions': [
    {
      purpose: "List a mail trigger's versions as a table: when each was made, by whom, and why.",
      line: 'kindgi mail-triggers versions <trigger-id> --table',
    },
  ],
  'mail-triggers create': [
    {
      purpose: 'Run an agent for each new mail in your own Gmail inbox.',
      line: 'kindgi mail-triggers create --agent=acme.order-desk --mailbox=google',
    },
    {
      purpose:
        "Run a flow for each new mail in a folder of the company's Outlook mailbox, looking every two minutes.",
      line: 'kindgi mail-triggers create --flow=acme.triage --flow-version=1.0.0 --mailbox=microsoft --as=company --folder=<folder-id> --poll=120',
    },
  ],
  'mail-triggers update': [
    {
      purpose: 'Look for new mail every five minutes, and start at most 30 runs an hour.',
      line: 'kindgi mail-triggers update <trigger-id> --poll=300 --runs-per-hour=30',
    },
    {
      purpose: 'Watch the inbox again, on a trigger of your own Gmail.',
      line: 'kindgi mail-triggers update <trigger-id> --folder=INBOX',
    },
  ],
  'mail-triggers pause': [
    {
      purpose: 'Pause a mail trigger: it stops looking for new mail.',
      line: 'kindgi mail-triggers pause <trigger-id>',
    },
  ],
  'mail-triggers resume': [
    {
      purpose:
        "Resume a paused mail trigger; mail that came while it was paused doesn't start runs.",
      line: 'kindgi mail-triggers resume <trigger-id>',
    },
  ],
  'mail-triggers fires': [
    {
      purpose: 'See the run each new mail started, or why it waits or was skipped, as a table.',
      line: 'kindgi mail-triggers fires <trigger-id> --table',
    },
  ],
  'mail-triggers take-ownership': [
    {
      purpose: 'Take over a trigger whose owner left, so its runs act as you.',
      line: 'kindgi mail-triggers take-ownership <trigger-id>',
    },
  ],
  'mail-triggers unregister': [
    {
      purpose: 'Remove a mail trigger: it stops looking for new mail.',
      line: 'kindgi mail-triggers unregister <trigger-id>',
    },
  ],
  'sites register': [
    {
      purpose:
        'Register a WordPress store on the Default project, with the origin and the approvals URL its Kindgi → Settings page shows; the one-time code is shown once.',
      line: "kindgi sites register --name='Acme store' --origin=https://acme-store.example --approvals-url='https://acme-store.example/wp-admin/admin.php?page=kindgi&approval={approvalId}'",
    },
    {
      purpose: 'Let only shop managers sign in, as senior reviewers.',
      line: `kindgi sites register --name='Acme store' --origin=https://acme-store.example --approvals-url='https://acme-store.example/wp-admin/admin.php?page=kindgi&approval={approvalId}' --allowed-role=shop_manager --reviewer-ceiling=senior --role-map='{"shop_manager": {"ask": true, "reviewer": "senior"}}'`,
    },
  ],
  'sites code': [
    {
      purpose: 'A new one-time code: to connect the site again, or to replace its key.',
      line: 'kindgi sites code <site-id>',
    },
  ],
  'sites list': [
    {
      purpose: "The Default project's sites, with their state and keys.",
      line: 'kindgi sites list --table',
    },
  ],
  'sites get': [
    {
      purpose: "A site's settings, and its keys' thumbprints to compare with the plugin's.",
      line: 'kindgi sites get <site-id>',
    },
  ],
  'sites update': [
    {
      purpose: 'Allow more people from the site.',
      line: 'kindgi sites update <site-id> --people-cap=100 --new-people-per-day=40',
    },
    {
      purpose:
        "Stop the site's administrators signing in; shop managers keep what the role map gives them.",
      line: 'kindgi sites update <site-id> --allowed-role=shop_manager',
    },
  ],
  'sites pause': [
    {
      purpose: "Stop a site's sign-ins and end its people's sessions now.",
      line: 'kindgi sites pause <site-id>',
    },
  ],
  'sites resume': [
    {
      purpose: "Let a paused site's people sign in again.",
      line: 'kindgi sites resume <site-id>',
    },
  ],
  'sites revoke-key': [
    {
      purpose: "Refuse what a site's key signs from now on.",
      line: 'kindgi sites revoke-key <site-id> <kid>',
    },
  ],
  'sites restore-person': [
    {
      purpose:
        'Let a person removed in Kindgi back in through their site: the same person, with their history.',
      line: 'kindgi sites restore-person <site-id> <user-id>',
    },
  ],
  'sites unregister': [
    {
      purpose: 'Remove a site; the people it signed in stay, with their records.',
      line: 'kindgi sites unregister <site-id>',
    },
  ],
  'reviewers get': [
    {
      purpose: 'Show one reviewer.',
      line: 'kindgi reviewers get <reviewer-id>',
    },
  ],
  'reviewers unregister': [
    {
      purpose: 'Stop sending new approvals to a reviewer.',
      line: 'kindgi reviewers unregister <reviewer-id>',
    },
  ],
  'corrector-groups list': [
    {
      purpose: 'List the corrector groups of the whole tenant.',
      line: 'kindgi corrector-groups list --tenant',
    },
    {
      purpose: 'List the groups of one agent in a project.',
      line: 'kindgi corrector-groups list --agent=acme-ops.reply-drafter --project=<project-id>',
    },
  ],
  'corrector-groups set': [
    {
      purpose: "Change a group's weight.",
      line: 'kindgi corrector-groups set <corrector-group-id> --weight=5',
    },
    {
      purpose: 'Limit who may assert the group to senior reviewers.',
      line: 'kindgi corrector-groups set <corrector-group-id> --min-reviewer-role=senior',
    },
    {
      purpose: 'Lift the restriction.',
      line: 'kindgi corrector-groups set <corrector-group-id> --unrestricted',
    },
  ],
  'corrector-groups remove': [
    {
      purpose: 'Retire a corrector group.',
      line: 'kindgi corrector-groups remove <corrector-group-id>',
    },
  ],
  'queue-rules create': [
    {
      purpose: "Queue a quarter of an agent's completed runs for correction.",
      line: 'kindgi queue-rules create --name="refund tone" --agent=acme.refunds --sample=0.25',
    },
    {
      purpose: 'Create a rule and catch it up at once on the last 500 finished runs.',
      line: 'kindgi queue-rules create --name="all refunds" --agent=acme.refunds --queue-last=500',
    },
  ],
  'queue-rules list': [
    {
      purpose: "List a project's queue rules.",
      line: 'kindgi queue-rules list --project=<project-id>',
    },
  ],
  'queue-rules show': [
    {
      purpose: "Show a rule's latest version.",
      line: 'kindgi queue-rules show <rule-id>',
    },
  ],
  'queue-rules update': [
    {
      purpose: "Raise a rule's open-items cap and enable it.",
      line: 'kindgi queue-rules update <rule-id> --max-open=50 --enable',
    },
    {
      purpose: 'Replace what the rule matches and drop its cap.',
      line: 'kindgi queue-rules update <rule-id> --agent=acme.refunds --clear-max-open',
    },
  ],
  'queue-rules remove': [
    {
      purpose: 'Unregister a rule so it queues nothing more; its queued items stay.',
      line: 'kindgi queue-rules remove <rule-id>',
    },
  ],
  'queue-rules versions': [
    {
      purpose: 'List every version of a rule, newest first.',
      line: 'kindgi queue-rules versions <rule-id>',
    },
  ],
  'queue-rules results': [
    {
      purpose:
        "Show a rule's results for runs queued since a date, by the rule's version and the agent's.",
      line: 'kindgi queue-rules results <rule-id> --since=2026-10-01',
    },
  ],
  'queue-rules preview': [
    {
      purpose: 'See how many of the last 200 runs a rule would queue, changing nothing.',
      line: 'kindgi queue-rules preview --agent=acme.refunds --last=200',
    },
    {
      purpose: 'Preview exactly what an existing rule would take.',
      line: 'kindgi queue-rules preview --rule=<rule-id>',
    },
  ],
  'queue-rules queue-recent': [
    {
      purpose: 'Catch a rule up on the last 1,000 finished runs.',
      line: 'kindgi queue-rules queue-recent <rule-id> --last=1000',
    },
    {
      purpose: 'Queue its matches among runs finished on or after a date.',
      line: 'kindgi queue-rules queue-recent <rule-id> --since=2026-10-01',
    },
  ],
  'expert-queue list': [
    {
      purpose: 'List the runs waiting for a correction, as a table.',
      line: 'kindgi expert-queue list --state=open --table',
    },
    {
      purpose: 'List the open items one of your corrections would close.',
      line: 'kindgi expert-queue list --state=open --for-me',
    },
  ],
  'expert-queue dismiss': [
    {
      purpose: 'Dismiss a queued run that needs no correction.',
      line: 'kindgi expert-queue dismiss <run-id> --reason="not a refund"',
    },
  ],
  'expert-queue reopen': [
    {
      purpose: 'Reopen a dismissed item so it waits for a correction again.',
      line: 'kindgi expert-queue reopen <run-id>',
    },
  ],
  'test-runs list': [
    {
      purpose: 'List the newest test runs of one test set.',
      line: 'kindgi test-runs list --test-set=acme.article-picks',
    },
    {
      purpose: 'List failed runs of an agent, ten at a time.',
      line: 'kindgi test-runs list --agent=acme-ops.article-picker --status=failed --limit=10',
    },
  ],
  'test-runs cancel': [
    {
      purpose: 'Cancel a pending or running test run.',
      line: 'kindgi test-runs cancel <run-id>',
    },
  ],
  'test-runs rescore': [
    {
      purpose: 'Rescore a completed run on the test cases and wait for the new run.',
      line: 'kindgi test-runs rescore <run-id> --wait',
    },
    {
      purpose: 'Rescore against a runtime that does not record the project on the run.',
      line: 'kindgi test-runs rescore <run-id> --project=<project-id>',
    },
  ],
  'test-sets list': [
    {
      purpose: 'List the corrections test sets of a project.',
      line: 'kindgi test-sets list --project=<project-id> --kind=corrections',
    },
    {
      purpose: 'List test sets including retired ones.',
      line: 'kindgi test-sets list --include-retired',
    },
  ],
  'test-sets show': [
    {
      purpose: "Show a test set's latest version.",
      line: 'kindgi test-sets show acme.article-picks',
    },
    {
      purpose: 'Show one version of a test set.',
      line: 'kindgi test-sets show acme.article-picks --test-set-version=1.0.0',
    },
  ],
  'test-sets cases': [
    {
      purpose: 'List the first page of the test cases.',
      line: 'kindgi test-sets cases acme.article-picks --test-set-version=1.0.0',
    },
    {
      purpose: 'Fetch the next page of cases.',
      line: 'kindgi test-sets cases acme.article-picks --test-set-version=1.0.0 --limit=50 --cursor=<cursor>',
    },
  ],
  'blocks list': [
    {
      purpose: "List a project's instructions (its prompt blocks).",
      line: 'kindgi blocks list --project=<project-id> --kind=prompt',
    },
    {
      purpose: 'List blocks whose ids start with a prefix.',
      line: 'kindgi blocks list --name=acme.reply',
    },
  ],
  'blocks show': [
    {
      purpose: "Show a block's latest version.",
      line: 'kindgi blocks show acme.reply-style',
    },
    {
      purpose: 'Show one version of a block.',
      line: 'kindgi blocks show acme.reply-style --block-version=1.0.0',
    },
  ],
  'blocks versions': [
    {
      purpose: "List a block's versions, newest first.",
      line: 'kindgi blocks versions acme.reply-style',
    },
    {
      purpose: 'Include unregistered versions.',
      line: 'kindgi blocks versions acme.reply-style --include-unregistered',
    },
  ],
  'blocks unregister': [
    {
      purpose: 'Unregister a block version so no range picks it.',
      line: 'kindgi blocks unregister acme.reply-style --block-version=1.0.0',
    },
  ],
  'blocks reinstate': [
    {
      purpose: 'Reinstate an unregistered block version.',
      line: 'kindgi blocks reinstate acme.reply-style --block-version=1.0.0',
    },
  ],
  'gate-policies list': [
    {
      purpose: 'List the release gate policies of one agent.',
      line: 'kindgi gate-policies list --agent=acme.order-desk --table',
    },
    {
      purpose: 'List the policies set for the whole tenant.',
      line: 'kindgi gate-policies list --tenant',
    },
  ],
  'gate-policies show': [
    {
      purpose: "Show a policy's latest active version.",
      line: 'kindgi gate-policies show acme.order-desk-release',
    },
    {
      purpose: 'Show one version of a policy.',
      line: 'kindgi gate-policies show acme.order-desk-release 1.0.0',
    },
  ],
  'gate-policies versions': [
    {
      purpose: "List a policy's versions, unregistered ones too.",
      line: 'kindgi gate-policies versions acme.order-desk-release --table',
    },
  ],
  'gate-policies unregister': [
    {
      purpose: 'Unregister a release gate policy version.',
      line: 'kindgi gate-policies unregister acme.order-desk-release 1.0.0',
    },
  ],
  'gate-policies reinstate': [
    {
      purpose: 'Reinstate an unregistered release gate policy version.',
      line: 'kindgi gate-policies reinstate acme.order-desk-release 1.0.0',
    },
  ],
  'tokens get': [
    {
      purpose: 'Show one API key, without its secret.',
      line: 'kindgi tokens get <token-id>',
    },
  ],
  'tokens revoke': [
    {
      purpose: 'Revoke an API key.',
      line: 'kindgi tokens revoke <token-id>',
    },
  ],
  'service-accounts list': [
    {
      purpose: 'List every service account, including unregistered ones, as a table.',
      line: 'kindgi service-accounts list --all --table',
    },
    {
      purpose: 'Read the next page of 20.',
      line: 'kindgi service-accounts list --limit=20 --cursor=<cursor>',
    },
  ],
  'service-accounts get': [
    {
      purpose: 'Show one service account with its grants.',
      line: 'kindgi service-accounts get <service-account-id>',
    },
  ],
  'service-accounts grant': [
    {
      purpose: 'Give a service account the editor role on a project.',
      line: 'kindgi service-accounts grant <service-account-id> --project=<project-id> --role=editor',
    },
    {
      purpose: "Let a service account read the tenant's settings.",
      line: 'kindgi service-accounts grant <service-account-id> --tenant-member',
    },
  ],
  'service-accounts ungrant': [
    {
      purpose: "Remove a service account's role on a project.",
      line: 'kindgi service-accounts ungrant <service-account-id> --project=<project-id>',
    },
    {
      purpose: 'Take tenant member away from a service account.',
      line: 'kindgi service-accounts ungrant <service-account-id> --tenant-member',
    },
  ],
  'service-accounts unregister': [
    {
      purpose: 'Unregister a service account and revoke its keys.',
      line: 'kindgi service-accounts unregister <service-account-id>',
    },
  ],
  'connections list': [
    {
      purpose: 'List your own connections to Google, as a table.',
      line: 'kindgi connections list --app=google --mine --table',
    },
    {
      purpose: "List the connections a project's registrations allow.",
      line: 'kindgi connections list --project=<project-id>',
    },
    {
      purpose: 'List connections, removed ones too, as a table.',
      line: 'kindgi connections list --include-removed --table',
    },
  ],
  'connections get': [
    {
      purpose: 'Show one connection: whose account, its permissions and its state.',
      line: 'kindgi connections get <connection-id>',
    },
  ],
  'connections connect': [
    {
      purpose: 'Connect your Google account to send email; open the link it prints.',
      line: 'kindgi connections connect google --permissions=gmail.send',
    },
    {
      purpose: "Connect the company's GitHub installation for a project (tenant admins).",
      line: 'kindgi connections connect github --project=<project-id> --for-company',
    },
  ],
  'connections disconnect': [
    {
      purpose: 'Disconnect a connection without being asked (for scripts).',
      line: 'kindgi connections disconnect <connection-id> --yes',
    },
  ],
  'connection-apps list': [
    {
      purpose: "List the tenant's registrations, as a table.",
      line: 'kindgi connection-apps list --table',
    },
    {
      purpose: 'List every registration, removed ones too, as a table.',
      line: 'kindgi connection-apps list --include-removed --table',
    },
  ],
  'connection-apps get': [
    {
      purpose: 'Show a registration, with the redirect and notices addresses to give the app.',
      line: 'kindgi connection-apps get <app-id>',
    },
  ],
  'connection-apps add': [
    {
      purpose:
        "Register the company's Google client, its secret stored first with `kindgi secrets set`.",
      line: 'kindgi connection-apps add google --client-id=<client-id> --client-secret-ref=production/ACME_GOOGLE_CONNECT_SECRET',
    },
    {
      purpose:
        "Register the company's Microsoft Entra app, a single-tenant one, at its own directory.",
      line: 'kindgi connection-apps add microsoft --client-id=<client-id> --client-secret-ref=production/ACME_MICROSOFT_CONNECT_SECRET --tenant=<tenant-id>',
    },
    {
      purpose: "Register the company's GitHub App.",
      line: 'kindgi connection-apps add github --github-app-id=<n> --slug=<slug> --client-id=<client-id> --client-secret-ref=production/ACME_GITHUB_CLIENT_SECRET --private-key-ref=production/ACME_GITHUB_PRIVATE_KEY --webhook-secret-ref=production/ACME_GITHUB_WEBHOOK_SECRET',
    },
    {
      purpose: "Register the company's LinkedIn app.",
      line: 'kindgi connection-apps add linkedin --client-id=<client-id> --client-secret-ref=production/ACME_LINKEDIN_CONNECT_SECRET',
    },
  ],
  'connection-apps remove': [
    {
      purpose: 'Remove a registration and disconnect every connection through it.',
      line: 'kindgi connection-apps remove <app-id> --with-connections',
    },
  ],
  'people add': [
    {
      purpose: 'Add a person and email them their invitation.',
      line: 'kindgi people add --name="Sam Lee" --email=sam@acme.example',
    },
    {
      purpose: 'Add a person without emailing the invitation: you tell them.',
      line: 'kindgi people add --name="Sam Lee" --email=sam@acme.example --no-invite',
    },
  ],
  'people invite': [
    {
      purpose: "Send a person's invitation again, with a new expiry.",
      line: 'kindgi people invite <user-id>',
    },
  ],
  'people second-factor': [
    {
      purpose:
        'See whether a person has a second factor set up, and how many recovery codes are left.',
      line: 'kindgi people second-factor <user-id>',
    },
  ],
  'people reset-second-factor': [
    {
      purpose:
        'Remove the second factor of a person who lost their phone: they set one up again at their next sign-in.',
      line: 'kindgi people reset-second-factor <user-id>',
    },
  ],
  'sign-in settings': [
    {
      purpose: 'See whether signing in takes a second factor.',
      line: 'kindgi sign-in settings',
    },
    {
      purpose: 'Require a second factor at sign-in (set up your own first).',
      line: 'kindgi sign-in settings --require-second-factor=on',
    },
  ],
  'people list': [
    {
      purpose: 'Find people whose name starts with Sam.',
      line: 'kindgi people list --query=Sam',
    },
    {
      purpose: "List the people invited who haven't signed in yet.",
      line: 'kindgi people list --pending --table',
    },
    {
      purpose: 'List everyone, removed people too, as a table.',
      line: 'kindgi people list --include-removed --table',
    },
  ],
  'people get': [
    {
      purpose: 'Show one person.',
      line: 'kindgi people get <user-id>',
    },
  ],
  'people grants': [
    {
      purpose: 'Show what a person may do, as a table.',
      line: 'kindgi people grants <user-id> --table',
    },
  ],
  'capabilities list': [
    {
      purpose: 'List every feature an agent can require.',
      line: 'kindgi capabilities list --table',
    },
    {
      purpose: 'List only the features starting with tool.',
      line: 'kindgi capabilities list --feature=tool',
    },
  ],
  'capabilities get': [
    {
      purpose: 'Show one capability and the models of yours that have it.',
      line: 'kindgi capabilities get feature:tool-use',
    },
  ],
  'adapters prepare': [
    {
      purpose: 'Pre-warm an adapter after registering its provider.',
      line: 'kindgi adapters prepare <adapter-id>',
    },
    {
      purpose: 'Prepare one model of an adapter by key.',
      line: 'kindgi adapters prepare <adapter-id> --model=<model-key>',
    },
    {
      purpose: "Pass the adapter's prepare settings as JSON.",
      line: 'kindgi adapters prepare <adapter-id> --params=\'{"model":"<model-key>"}\'',
    },
  ],
  'feedback write': [
    {
      purpose: 'Record a bug found while working, body from a file.',
      line: 'kindgi feedback write --kind=bug --title="Run list ignores --limit" --severity=high --body=@notes.md',
    },
    {
      purpose: 'Record friction from a coding agent, body piped in.',
      line: 'kindgi feedback write --kind=friction --title="Unclear error on missing key" --authored-by=claude-code --body-stdin',
    },
  ],
  'feedback submit': [
    {
      purpose:
        'Print exactly what would be sent, after redaction, with its digest. Nothing is sent.',
      line: 'kindgi feedback submit --preview',
    },
    {
      purpose: 'After the person says yes to that preview, send exactly it.',
      line: 'kindgi feedback submit --yes=<digest>',
    },
    {
      purpose: 'Preview one entry by its id, to send it (again) on its own.',
      line: 'kindgi feedback submit 2026-10-15.1 --preview',
    },
  ],
  'feedback status': [
    {
      purpose: 'Ask what became of the reports sent: at most once a day each.',
      line: 'kindgi feedback status',
    },
    {
      purpose: "Ask about one now, by its entry's id or its report id.",
      line: 'kindgi feedback status 2026-10-15.1',
    },
  ],
  'feedback withdraw': [
    {
      purpose: 'Take a report back: the intake clears its text at once.',
      line: 'kindgi feedback withdraw 2026-10-15.1',
    },
  ],
  egress: [
    {
      purpose:
        "Print the addresses this deployment's calls come from, to admit them on a site that admits only known addresses.",
      line: 'kindgi egress',
    },
    {
      purpose: "Both lists as JSON, for a script that writes the site's firewall rule.",
      line: 'kindgi egress --json',
    },
  ],
  health: [
    {
      purpose: 'Check that the API server answers.',
      line: 'kindgi health',
    },
  ],
  version: [
    {
      purpose: "Print the CLI and SDK versions, and the API's if reachable.",
      line: 'kindgi version',
    },
  ],
  usage: [
    {
      purpose: "This month's usage so far, grouped by project and kind (the default).",
      line: 'kindgi usage',
    },
    {
      purpose: 'A past month, broken down by agent and kind, as a table.',
      line: 'kindgi usage --month=2026-09 --group-by=agent,kind --table',
    },
  ],
};

/** "See also" for a command group that no guide runs: page slugs. */
export const CLI_GROUP_SEE_ALSO = {
  auth: ['start/install', 'deploy/people-and-keys'],
  upgrade: ['start/quickstart-java', 'start/quickstart-scala'],
  console: ['deploy/self-hosted/sign-in', 'start/introduction'],
  sites: ['deploy/self-hosted/sign-in', 'sites/wordpress'],
  'sign-in': ['deploy/self-hosted/sign-in', 'deploy/people-and-keys'],
  'mcp-launch': ['guides/tools/mcp-servers'],
  deployments: ['hosted/deploy-your-agent', 'guides/secrets/pack-env'],
  projects: ['guides/projects/organize-by-org-and-project'],
  connections: ['deploy/people-and-keys'],
  'connection-apps': ['guides/secrets/store-a-secret', 'deploy/people-and-keys'],
  tenant: ['guides/projects/organize-by-org-and-project'],
  environments: ['guides/projects/organize-by-org-and-project'],
  promote: ['guides/projects/organize-by-org-and-project'],
  flows: ['guides/flows/write-a-flow', 'guides/flows/index'],
  capabilities: ['guides/agents/choose-a-model'],
  adapters: ['guides/models/index', 'guides/models/serve-your-own-model'],
  feedback: ['start/coding-agents'],
  egress: ['deploy/self-hosted/egress-addresses'],
  health: ['deploy/self-hosted/operate'],
  version: ['start/install'],
  usage: ['guides/observability/cost-per-run', 'guides/projects/organize-by-org-and-project'],
  'queue-rules': ['guides/evals/judge-a-runs-output', 'guides/evals/expert-queue-reference'],
  'expert-queue': ['guides/evals/judge-a-runs-output', 'guides/evals/expert-queue-reference'],
};
