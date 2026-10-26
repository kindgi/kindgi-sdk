---
name: kindgi-authoring-tools
description: >
  Covers writing tools for a Kindgi pack with @kindgi/sdk:
  defining tools via defineTool with either an imperative handler or a
  declarative HTTP spec, choosing between Zod v4 and JSON Schema for
  input/output, tool id naming conventions, handling the Result return
  shape, and how tools reach agents via ToolRef versioning. Load this
  whenever you are authoring or editing code inside a pack's tools/
  directory, defining a tool, or wiring a tool onto an agent. Getting
  started with a new pack is covered by kindgi-getting-started;
  authoring agents is covered by kindgi-authoring-agents.
type: core
library: "@kindgi/sdk"
version: "0.4.15"
sdk_version: "0.0.0"
pack_languages: [node]
sources:
  - packages/tools/src/types.ts
  - packages/tools/src/define.ts
---

# Authoring Kindgi tools

> **Running `kindgi`:** the CLI is a devDependency of the project (`@kindgi/cli`),
> not a global command. Run it through the project's package manager —
> `pnpm exec kindgi …`, `npx --no -- kindgi …` (npm), `yarn kindgi …` or
> `bun run kindgi …`. Commands below are written `kindgi …` for brevity.

A **tool** is a callable unit of work an agent invokes: a function with a
typed input, a typed output, and either author-written logic or a
declarative spec the framework synthesizes into logic. Tools live at
`tools/<name>/index.ts` inside a pack; the pack indexer discovers
them by folder convention.

Before writing a tool, establish what it should DO — its purpose,
inputs, outputs, and whether it extends an existing tool or is fresh.
Requests like "add a tool" without a purpose are conversation openers,
not tickets. Ask what it should compute or fetch, what shape the caller
provides, what shape it returns. The pack's existing tools are examples
that prove the framework runs end-to-end — they are NOT the shape you
imitate unless the user explicitly asks for that.

## Two authoring modes

Both use `defineTool` from `@kindgi/sdk/define`. Pick based on where the
logic lives:

- **`handler`** — imperative TS function. Use when the tool computes,
  transforms, calls a proprietary library, or has non-trivial logic
  that lives in the pack's source.
- **`spec`** — declarative descriptor. Use when the tool is a
  straightforward remote call. `spec: {kind: 'http', ...}` is the kind
  that ships with the framework; other kinds can be added with
  `registerToolSpecSynthesizer`. The framework synthesizes the handler
  from the spec — URL substitution, timeout, abort propagation, secret
  resolution and the status check are handled for you (there is no
  automatic retry).

`handler` and `spec` are MUTUALLY EXCLUSIVE. Setting both (or neither)
makes `defineTool` return an `invalid-tool-definition` error.

## Imperative handler

```ts
// tools/verify-citation/index.ts
import { defineTool } from '@kindgi/sdk/define';
import type { ToolId } from '@kindgi/sdk/types';
import { z } from 'zod';

const Input = z.object({
  citation: z.string().min(1),
  jurisdiction: z.enum(['US', 'UK', 'EU']),
});

const Output = z.object({
  found: z.boolean(),
  canonicalCite: z.string().optional(),
});

const defined = defineTool({
  id: 'acme.verify-citation' as ToolId,
  description:
    'Verify a legal citation against the jurisdictional citator. Returns whether the citation resolves and the canonical form.',
  version: '0.1.0',
  input: Input,
  output: Output,
  effects: [],
  mutating: false,
  handler: async (input, ctx) => {
    // ctx.tenantId, ctx.abortSignal, ctx.secrets (what needsSpec declares) available;
    // in a run, ctx.projectId and ctx.orgId (set from the run, never from the input)
    // Return type MUST match Output schema (validated at invoke time)
    return { found: true, canonicalCite: '...' };
  },
});

if (defined.kind === 'err') {
  throw new Error(`acme.verify-citation failed to compile: ${defined.error.message}`);
}

export default defined.value;
```

A handler must return a Promise; one with nothing to `await` can return `Promise.resolve({ … })` instead of being `async`, which keeps lint rules like `require-await` quiet.

### What the handler receives

The handler gets the **parsed** input, typed `z.infer` of `input` (Zod's output type):

- **Defaults.** A `.default()` field is optional to the caller, the model included. The tool's advertised schema doesn't list it as required, and the handler always gets a value.
- **Transforms and refinements.** `.transform()` results and `.refine()` checks apply before the handler runs. A failed refinement comes back as `input-validation-failed`.
- **Extra keys.** A plain `z.object` accepts them and strips them. Use `z.strictObject` to reject them.
- **JSON-Schema-authored tools** get each property's `default` filled in the same way.
- **Unions of scalars** (`z.union([z.string(), z.number()])`, `type: ['string', 'number']` on the wire) compile and validate. A schema Kindgi's strict schema check still refuses (an open tuple, an unknown keyword) says so at `defineTool`; for a field that may hold any JSON value, `z.json()` compiles.

The output side is the reverse: the advertised output schema requires every field, defaulted ones included. Return them all.

### Logging from the handler

`ctx.log` is a logger bound to the call: its records carry the run's ids, the tool's id and the trace id. It has `info`, `warn`, `error`, `debug` and `trace`, each `(message, fields?)`. The pack service sets it; a context your own code builds (a test's) may not, so write `ctx.log?.`:

```ts
ctx.log?.info('refund issued', { orderId, amountCents });
```

Put values in `fields`, never in the message. Log ids, amounts and outcomes, never what a person typed (a refund's reason, a message, an address): the log is read by whoever operates the runtime, not only by the person the data is about. Docs: https://docs.kindgi.com/v0.1/guides/tools/write-a-tool/#log-from-a-tool

### Configuration and secrets

A secret that belongs to the tenant — an API key a customer gives you — is declared, and read from `ctx.secrets`:

```ts
const defined = defineTool({
  // …id, description, version, input, output, effects…
  needsSpec: { secrets: { CITATOR_KEY: { type: 'string', minLength: 20 } } },
  handler: async (input, ctx) => {
    const key = ctx.secrets?.CITATOR_KEY;
    // …
  },
});
```

The runtime resolves every declared secret on every call, for the call's tenant, in its env (`KINDGI_ENV`; in `kindgi dev`, `local`: the pack's `.env` and `.env.local`, then Kindgi's own `.kindgi/secrets.env`, where `kindgi secrets set` writes). It checks each value against its schema, and fails the call, naming the secret, when one is missing or doesn't match. A declared secret is required, so in a runtime call `ctx.secrets` holds it; it's optional in the type because a unit test builds its own context and passes `secrets: { CITATOR_KEY: '…' }`. **An optional secret** has a schema that names `null` (`{ type: ['string', 'null'] }`; an unconstrained `{}` stays required): one never stored, or empty, is left out of `ctx.secrets`, and the call goes on, its log line naming it. One revoked, or gone at its provider though mapped, still fails the call. Optional secrets need runtime 0.1.6 or later; an older runtime requires them.

A value that differs per tenant, org or project but isn't secret (a base URL, a region, an account id) is an **env value**: declared in `needsSpec.env`, read from `ctx.env`:

```ts
const defined = defineTool({
  // …id, description, version, input, output, effects…
  needsSpec: {
    env: {
      ORDERS_BASE_URL: { type: 'string', pattern: '^https://' },
      ORDERS_REGION: { type: 'string', enum: ['eu', 'us'], default: 'eu' },
    },
  },
  handler: async ({ orderId }, ctx) => ({
    url: `${ctx.env?.ORDERS_BASE_URL}/${ctx.env?.ORDERS_REGION}/orders/${orderId}`,
  }),
});
```

- **Which value a call gets:** its project's, else its org's, else the tenant's, in the runtime's env; a schema `default` makes a name optional. The values a call used are recorded with it, so a retry or a resume sees the same ones.
- **Setting them:** `kindgi env set ORDERS_REGION us --scope=project:<project-id> --env=local` (or `--scope=tenant`, for every project). Changing a value that's already set takes `--force`.
- **A declared value nobody set** stops the call before the tool runs. For a tool `acme-orders.needs-account` that declares `ACME_ACCOUNT_ID`, the message reads:
  ```text
  precondition-failed: Tool "acme-orders.needs-account" was not run: env-value-missing: tool "acme-orders.needs-account" needs env value "ACME_ACCOUNT_ID" in env "local", and none is set for project e889c1f5-eae7-45dc-8669-5bd029a5d85c, its org, or the tenant. Set it: kindgi env set ACME_ACCOUNT_ID <value> --scope=project:e889c1f5-eae7-45dc-8669-5bd029a5d85c --env=local (or --scope=tenant, for every project)
  ```
- **Not secret:** env values are recorded with each run that uses them and shown in its journal. A credential is a secret (`needsSpec.secrets`), never an env value.
- **Schemas compile strictly:** each `needsSpec` schema must compile as the runtime compiles it (an unknown keyword is refused), and an env `default` is a string; otherwise `defineTool` returns `invalid-tool-definition`, and a deploy fails with `deployment-validation-failed`.
- **In a unit test:** call it with `invokeToolForTest(tool, input, { env: { … } })` (`@kindgi/sdk/define`). It decides the values as a run does: a name you don't set takes its schema's `default`, each value is checked, and the handler sees the declared names only. A missing or invalid one is `precondition-failed` (`env-value-missing`, `env-value-invalid`). Plain `invokeTool` passes `ctx.env` as given (the runtime decides a pack tool's env itself).

Everything else comes from the process environment: `process.env.CITATOR_URL`. The pack service runs with the pack's env files in `kindgi dev` (less any secret stored with `kindgi secrets set`, which a tool declares and reads from `ctx.secrets`, and any model provider's key, which no tool gets), and with the container's environment in an image. Declare the names your code reads in `kindgi.config.ts`, `env: { required: ['CITATOR_URL'], optional: [...] }`: a deployment injects exactly those, a pack service missing a required one isn't ready and says which, and `kindgi dev` warns about it. In an image the pack service also drops every variable the pack doesn't declare before your code loads (`kindgi dev` keeps them), so an undeclared name works locally and is unset once deployed: declare every name the code reads. Values per environment go in `environments.<name>.env`, secrets only as references.

### Connections to other apps

A tool that acts in another app as a person or as the company (sending mail, opening an issue) declares a **connection**, never a secret holding someone's token, and reads the call's short-lived token from `ctx.connections` (runtime 0.2.0 or later):

```ts
import { ConnectionRejectedError, defineTool } from '@kindgi/sdk/define';

const defined = defineTool({
  // …id, description, version, input, output, effects…
  needsSpec: {
    connections: { mail: { app: 'google', permissions: ['gmail.send'], as: 'person' } },
  },
  handler: async (input, ctx) => {
    const mail = ctx.connections?.mail;
    const res = await fetch(url, { headers: { authorization: `Bearer ${mail?.accessToken}` } });
    if (res.status === 401) throw new ConnectionRejectedError('mail');
    // …
  },
});
```

- **Whose connection:** `as: 'person'` is the connection of the person the run acts as (whoever started it, or the owner of the schedule or webhook that did); `as: 'company'` is the company's. The runtime picks it from the run, never from the input or the model. A run that acts as nobody (a service account's, an event's) fails a `'person'` call with `connection-needs-a-person`.
- **The token:** `accessToken` is current for this call only. Never keep, print, log or return it; it never reaches the journal. `account.label` says whose account it is (`ana@acme.com`).
- **A 401 from the app:** throw `new ConnectionRejectedError('mail')`, with the connection's name (a second argument can say what the app answered, never the token), or your own error with it as its `cause`. The runtime renews the token once and runs the call again; refused again, the call fails with `connection-rejected`.
- **An HTTP tool** sends the token with no code: `authorization: { kind: 'connection', connection: 'mail' }`.
- **Ready-made tools:** for Gmail, Outlook, GitHub and LinkedIn, include one from `@kindgi/connections` instead of writing it. Each is a factory, and the pack names its id; there's no default, because a tool id is the tenant's, filed under the first project that publishes it. A tool folder's `index.ts` is one line, `export default gmailSend({ id: 'acme.gmail.send' })` (`@kindgi/connections/google/tools`, with `gmailMessagesList`, `gmailMessageGet` and `gmailReply`); `githubIssuesList`, `githubLabelsList` and `githubIssuesAddLabels` come from `@kindgi/connections/github/tools`, `outlookSend`, `outlookMessagesList`, `outlookMessageGet` and `outlookReply` from `@kindgi/connections/microsoft/tools`, and `linkedinPost` from `@kindgi/connections/linkedin/tools`. Agents and approval settings use the pack's id. A mail tool acts in the person's own mailbox; `as: 'company'` makes it use the company's. `as` is part of what the tool declares, so an id you've published keeps its `as`: give a company mailbox its own tool id.
- **Your own calls to an app's API:** `appFetch(ctx, { entry, connection, toolId, url, method, headers, body })` from `@kindgi/connections/app-fetch` sends the connection's token as the only `Authorization`, paces calls by the entry's `rateLimits` (`toolId` is what its `costs` charge; 1 when not listed), tries a busy answer again, and throws a 401 as `ConnectionRejectedError`.
- **Unattended runs:** in a run no person started, a tool that uses an `as: 'person'` connection waits for that person's yes, reads included: `mutating: false` doesn't lift it. The agent's `conversationPolicy.hitl` can't lift it; only a trigger's `toolsAllowedUnattended` can, which a project admin sets, as for `needsApprovalWhenUnattended` (below). In a run a new mail started, the mail is a stranger's text, so two more calls wait: a call of a tool that isn't `mutating: false`, and, when the trigger reads the company's mailbox, a read with the company's connection to that app. The mail trigger's `toolsAllowedUnattended` lifts these too.
- **In a unit test:** `ctx.connections` is optional in the type; build a context with `toolContextForTest({ connections: { mail: { accessToken: 'test', account: { id: '1', label: 'ana@acme.com' }, … } } })` (`@kindgi/sdk/define`).

Docs: https://docs.kindgi.com/v0.1/guides/connections/use-a-connection/

## Declarative HTTP spec

```ts
// tools/fetch-order/index.ts
import { defineTool } from '@kindgi/sdk/define';
import type { ToolId } from '@kindgi/sdk/types';
import { z } from 'zod';

const defined = defineTool({
  id: 'shop.fetch-order' as ToolId,
  description: 'Fetch an order by id from the storefront API.',
  version: '0.1.0',
  input: z.object({ orderId: z.string() }),
  output: z.object({ id: z.string(), status: z.string(), total: z.number() }),
  effects: [],
  mutating: false,
  spec: {
    kind: 'http',
    method: 'GET',
    urlTemplate: 'https://api.shop.example/orders/{orderId}',
    // Every {placeholder} MUST be a key on the input schema
    authorization: {
      kind: 'bearer',
      secretRef: { envName: 'production', name: 'shop-api-token' },
    },
    successStatus: { min: 200, max: 299 },
  },
});

if (defined.kind === 'err') throw new Error(defined.error.message);
export default defined.value;
```

`timeoutMs` (default 30 seconds) covers the whole call, reading the response included, and so does a run's cancel. A response body over 10 MiB, counted after it's decompressed, fails the call. So point a tool at an endpoint that pages or filters, not one that returns everything.

## Read-only tools: `mutating`

`mutating: false` declares that the tool changes nothing outside Kindgi; it only reads. Leaving `mutating` out counts as mutating, the same as `true`. It decides four things, in both authoring modes:

- **Dry runs.** `kindgi runs start --dry-run` runs a tool only if it's `mutating: false` and its `effects` declare no `writes`, `deletes`, `spawns-run`, `emits-event` or `external-side-effect`. The first other tool stops the run with `dry-run-effectful-tool`.
- **Approval gates.** When an agent turns tool gates on (`conversationPolicy.hitl.tools`) and sets neither an override for the tool nor a `default`, a `mutating: false` tool runs straight through, and any other tool asks for approval on its first use.
- **Running together.** When a model step asks for several calls at once, an agent runs calls to read-only tools (`mutating: false`, no changing effect) that come one after another at the same time, up to 8 of them, and a call to any other tool on its own, in the order the model asked. A call that may wait, for another system's answer or for the person who started the run to connect an app, runs on its own too. Once a call needs an approval, the step's calls that haven't started run one at a time. The results reach the conversation and the model in the model's order either way. An agent with `parallelToolCalls: false` runs every call on its own.
- **Runs a new mail started.** A call of a tool that isn't `mutating: false` waits for a person's yes, unless the mail trigger's `toolsAllowedUnattended` lists it.

So declare `mutating: false` on every tool that only reads, and never on one that writes.

A tool that writes also says what it writes, in `effects`, beside `mutating: true`:

```ts
  effects: [{ kind: 'writes', resource: 'acme:refunds' }],
  mutating: true,
```

The kinds are `reads`, `writes`, `deletes`, `network`, `spawns-run`, `emits-event`, `external-side-effect` and `sensitive-data-egress` (`EFFECT_KINDS` in `@kindgi/tools`); `defineTool` refuses any other. `resource` is free text naming what the tool touches. A read-only tool keeps `effects: []`.

## A person's yes when no one is watching: `needsApprovalWhenUnattended`

`needsApprovalWhenUnattended: true` declares that a person must say yes to every call of the tool in a run no person started: one a schedule, a webhook, a new mail, an event or a service account's key started. In such a run:

- **An agent's call waits** for a person's yes, whatever the agent's `conversationPolicy.hitl.tools` says. The agent's rules can't lift it: agents are reused, and the tool's author knows what it does.
- **A flow's tool step that calls it is refused.** Put the tool behind an agent step instead, whose call waits.
- **A trigger can lift both, for its own runs only.** A project admin names the tool in a webhook trigger's, a schedule's or a mail trigger's `toolsAllowedUnattended` (`--allow-unattended=<tool-id>` on `kindgi webhooks`, `kindgi schedules` and `kindgi mail-triggers`). In that trigger's runs, the tool is then as in a run a person started. The tenant's approval rules still apply.

In a run a person started (signed in, or with their own API key), the agent's rules decide, as for any tool. Absent means `false`. Declare it on a tool that moves money or changes something people rely on:

```ts
  effects: [{ kind: 'writes', resource: 'acme:refunds' }],
  mutating: true,
  needsApprovalWhenUnattended: true,
```

Docs: https://docs.kindgi.com/v0.1/guides/approvals/ask-before-a-tool-runs/#when-no-person-started-the-run

A step can run more than once (resumed after an approval, retried after a failure, run again after a crash), so a tool that writes uses `ctx.idempotencyKey`: the same every time this call runs, different for every other call. Pass it to the system you write to (an `Idempotency-Key` header, a client reference, a unique column) or look for it there first, and a refund never goes out twice. Not `ctx.requestId`: a model's call id is only unique within one of its answers. The key is absent outside a run and from a runtime before 0.1.6. Docs: https://docs.kindgi.com/v0.1/guides/tools/write-a-tool/#make-a-side-effect-happen-once

## Results that are text from outside: `resultIsOutsideData`

`resultIsOutsideData: true` says the tool's results are text from outside that nobody checked, such as a mail someone sent or a page a search found. An agent reads each result of the tool as data, not instructions, in that turn and in every later turn's history. It changes what the model is told, not what the tool may do: pair it with approvals for anything an agent could do with what it read. Absent means `false`.

## Tool id convention

`<pack-id>.<tool-name>` — kebab-case, dot-namespaced. The `<pack-id>`
prefix scopes the tool to its pack; `<tool-name>` names the operation.
Enforced by `defineTool` at author time. Examples:
`acme.verify-citation`, `shop.fetch-order`, `demo.echo`.

## Iterating on a tool

Edit the source file (`tools/<tool>/index.ts`), save. The next
`kindgi runs start` sees the change — new input/output schema, new
description, new handler behavior. No version bump, no restart, no
re-registration ceremony. Source is truth in dev.

The `version` field is a **semver contract for humans** — it declares
what callers can rely on. Bump it because the *contract with
downstream callers* changed (removed a field, tightened a type,
narrowed enum values), not because you saved the file. If you're
iterating in dev and the shape isn't finalized, leave `version`
alone.

**When version matters:** `kindgi deploy` publishes to a durable
production registry that enforces the immutable `(id, version)`
contract — a re-publish of the same version with different bytes
gets rejected. That's when semver discipline kicks in. The deploy
tooling surfaces the check; you don't have to think about it while
authoring.

**Downstream callers still pin ranges.** An agent's `tools: [{id,
version: '^0.1.0'}]` picks the highest active version matching the
range at run start. Compatible tool updates (patch, minor) reach the
agent without editing agent source; breaking updates (major) require
the agent-author to opt in.

## Testing a tool

Put a tool's tests beside it, `tools/<tool>/index.test.ts`. Discovery skips `*.test.*` and `*.spec.*` files (`.ts`, `.js`, `.mjs`, `.cjs`), so the indexer never loads a test as a primitive: don't move tests elsewhere to keep them out. `invokeTool(tool, input, ctx)` from `@kindgi/sdk/define` calls the tool the way Kindgi does, schemas included, and returns a `Result`. `toolContextForTest()` builds its `ctx` (tenant `tenant-test`, run `run-test`, an abort signal) and takes what to change: `env`, `secrets`, `projectId`.

```ts
import { invokeTool, toolContextForTest } from '@kindgi/sdk/define';

const result = await invokeTool(lookupOrder, { orderId: 'ord_1001' }, toolContextForTest());
// a tool with env values: invokeToolForTest(tool, input, { env: { STORE_URL: '…' } })
```

`kindgi test` runs the pack's tests with vitest (`vitest run`; `--watch` keeps watching). In an app Kindgi was added to, `kindgi init` wrote the vitest config (`vitest.config.mts`, or `.ts` in a `"type": "module"` app): it runs `kindgi/**/*.test.ts`, and its `resolve.alias` copies `tsconfig.json`'s `paths`, which vitest doesn't read. A test that can't resolve an alias the app's code uses (`@/…`) means the two differ: update the config's alias, not the import.

## Shared code

Code several tools share (schemas, a client, helpers) goes outside `tools/`, for example in `lib/` beside it. Discovery loads every `.ts`, `.js` and `.mjs` file under `tools/` (tests aside) as a primitive, so a helper there fails the index. Don't put it in the app's own source either: import the app's functions from where they are (unless their module imports `server-only`: see mistake 12; for a CommonJS package's default import, see mistake 13), and keep what's Kindgi's in the pack's folder.

## Wiring the tool onto an agent

Agents reference tools via `ToolRef[]`, NOT `string[]`. Each entry is
`{id, version}` where `version` is an npm-style semver **range**:

```ts
// agents/brief-writer/index.ts
tools: [
  { id: 'acme.verify-citation' as ToolId, version: '^0.1.0' },
  { id: 'acme.fetch-precedent' as ToolId, version: '~0.2.0' },
],
```

The resolver picks the highest active version matching the range at
run start via `semver.maxSatisfying`. No implicit `:latest`.

## Common mistakes

1. **Copying another tool's shape without user intent.** The pack may
   ship `tools/echo/` as a starter example. Copying its skeleton to
   make `tools/lookup/` produces plausible-looking code that solves
   the wrong problem. Ask the user what the new tool should DO first.

2. **Passing bare strings to `agent.tools`.** `tools: ['acme.verify-citation']`
   doesn't type-check (`tools` is `ToolRef[]`), and `defineAgent`
   returns `invalid-agent` for a bare string that slips through. Use
   `[{id: 'acme.verify-citation', version: '^0.1.0'}]`.

3. **Forgetting the `Result` unwrap.** `defineTool` returns
   `Result<DefinedTool, ToolError>` — a bad schema doesn't throw at import
   time unless you check `defined.kind === 'err'`. Always unwrap at
   module load so a broken pack fails LOUDLY, not on first invocation.

4. **`handler` and `spec` together.** Mutually exclusive.
   `defineTool` returns `invalid-tool-definition` with both set.

5. **`{placeholder}` in `urlTemplate` without a matching input key.**
   HTTP tools substitute placeholders from the input at invoke time.
   Missing keys throw a clear error at invoke time — check both sides
   line up.

6. **An HTTP tool's `secretRef` in the wrong env.** The runtime
   resolves `authorization.secretRef` itself, on every call, in the env
   the ref names: `{ envName: 'local', … }` is the pack's `.env` /
   `.env.local` under `kindgi dev`, while `'production'` reads
   `.env.production`. A secret it can't find fails the call with
   `secret-unavailable`, naming it. Only a harness of your own that
   calls `invokeTool` directly has to pass `ctx.resolveSecret`.
7. **Reading a secret from `process.env` in a tool that runs for many
   tenants.** The pack service's environment is one for all of them.
   Declare the secret in `needsSpec.secrets` and read `ctx.secrets`.

8. **Bumping `version` on every dev save.** Old habit from
   frameworks that stored manifests immutably by `(id, version)`.
   Kindgi's dev mode reads tool manifests directly from source —
   version doesn't gate iteration. Bump it when the *contract*
   changes (breaking schema shape, semantic behavior), not when you
   save. See the "Iterating on a tool" section above.

9. **A package a tool imports, listed only in `devDependencies`.** The
   deployed pack installs the app's production dependencies only, so the
   import works under `kindgi dev` and fails in the image. When a tool
   imports a new package (an ORM client such as `@prisma/client`, an API
   SDK), check that the app's `package.json` lists it under
   `dependencies`. Build-time tools (the `prisma` CLI, `typescript`) stay
   in `devDependencies`. `kindgi dev` warns as soon as a tool imports one
   ("⚠ The pack imports @prisma/client (in kindgi/tools/…), which
   package.json lists only in devDependencies: …"), and `kindgi build`
   refuses the pack until it moves.
10. **A tool that needs the app's install scripts in the image.** The
    image installs with scripts off, so the app's `postinstall` /
    `prepare` (`prisma generate`, husky) don't run there; `kindgi build`
    lists them ("✓ The app's own install scripts don't run in the image:
    …"). A tool that uses Prisma's client then fails the build ("@prisma/client
    did not initialize yet"). Add `prisma({ schema: 'prisma/schema.prisma' })`
    (from `@kindgi/sdk/build`; add `config: 'prisma.config.ts'` when the app
    has one) to `image.extensions` in `kindgi.config.ts`. Other generate
    steps: `defineBuildExtension({ name, contextFiles, postInstall: [{ bin, args }] })`.
    Debian packages: `image.systemPackages`. Placeholder env for those steps:
    `image.buildEnv` (never secrets).

11. **Turning the dev sandbox off for a file the tool needs.** Under `kindgi dev`
    the tool's code runs sandboxed: it can't read outside the app (the home
    folder, `~/.aws`) or any `.env*` file, and gets `EPERM` there. A tool that
    needs a path names it in `kindgi.config.ts`: `dev: { sandbox: { allowRead: ['~/.aws'] } }`.
    Never set `KINDGI_DEV_SANDBOX=off` or `dev.sandbox: false` to get past it
    (https://docs.kindgi.com/v0.1/guides/secrets/dev-sandbox/).

12. **Importing a Next.js module that has `import 'server-only'`.** Outside
    Next.js that line stops the module from loading, so the tool fails
    `kindgi test`, `kindgi dev` and `kindgi build`. When the app doesn't
    install the package (Next.js doesn't need it), `kindgi test` fails with
    `Cannot find package 'server-only'`, and `kindgi dev` and `kindgi build`
    with `Could not resolve "server-only"`. When it does, all three fail
    with the package's own "This module cannot be imported from a Client
    Component module". Don't remove the line, and don't alias `server-only`
    away in the vitest config: the build still fails. Move the code the tool
    needs, as it is, to a module without the line (`lib/orders-core.ts`).
    The guarded module keeps the line and re-exports it
    (`import 'server-only'; export * from './orders-core';`), so the app's
    own imports don't change, and the tool imports the new module. Nothing
    guards it, so only the app's server code and the pack should import it.

13. **A default import of a package that ships only CommonJS.** A pack's
    code runs as ES modules: `kindgi build` bundles it into `.mjs` files,
    leaving out the packages from `node_modules`, and `kindgi dev` and the
    deployed pack load it with Node's own `import()`. Node gives
    `import OrdersClient from '@acme/orders-client'` the package's whole
    `module.exports`; when the package puts its class on `exports.default`
    (TypeScript's CommonJS output for `export default`), the class is on its
    `default`. Vitest, Next.js, and tsx in an app without `"type": "module"`
    give the class itself. So the tool passes `kindgi test`, and app code it
    imports works in the app, but under `kindgi dev` and once deployed it
    fails with `TypeError: OrdersClient is not a constructor`. With
    `"moduleResolution": "NodeNext"` (a new pack's `tsconfig.json`),
    TypeScript already refuses `new OrdersClient()`; with `"bundler"`
    (Next.js apps) it compiles. This is Node's own behavior, and Kindgi keeps
    it: take the class either way.

    ```ts
    import OrdersClientExport from '@acme/orders-client';

    type DefaultOf<T> = T extends { default: infer C } ? C : T;

    function defaultOf<T>(loaded: T): DefaultOf<T> {
      const value = typeof loaded === 'function' ? loaded : (loaded as { default: unknown }).default;
      return value as DefaultOf<T>;
    }

    const OrdersClient = defaultOf(OrdersClientExport);
    ```

    A dynamic import is the same: `(await import('@acme/orders-client')).default`
    is the class under Vitest and the whole `module.exports` under Node, so
    take it with `defaultOf((await import('@acme/orders-client')).default)`.

## References

- Type surface: `hover any @kindgi/sdk/define export` in your editor
  for full JSDoc — every field on `DefineToolSpec` / `ToolManifest`
  documents purpose, when to set it, and gotchas.
- API reference: https://docs.kindgi.com/v0.1/reference/typescript/sdk/kindgi/sdk/define/ (every `define*` spec, field by field).
- Common patterns: check the `sample` template (`kindgi init
  --template=sample`) for working examples of both authoring modes.

## When the framework itself is the problem

If you diagnose that the bug lives in Kindgi/`@kindgi/sdk` itself (SDK
type drift, wire schema silently dropping a field, indexer allowlist
gap, misleading error, CLI friction) — not in the pack's own code —
load the `kindgi-framework-feedback` skill and file a structured report
with `kindgi feedback write`. That diagnostic is high-signal input the
maintainers can act on; don't let it disappear into the transcript.
