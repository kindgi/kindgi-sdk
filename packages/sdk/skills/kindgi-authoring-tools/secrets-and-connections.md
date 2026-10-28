# Configuration, secrets and connections

## Configuration and secrets

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

## Connections to other apps

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
