# @kindgi/sdk

The **public developer surface** for Kindgi.

One package with five sub-paths — `/define` for pack authoring, `/client`
for callsite HTTP and following runs, `/types` for branded identifiers,
`/webhooks` for receiving Kindgi's webhooks (server only), `/build` for a
pack image's build extensions (`kindgi.config`'s `image`) — plus a flat
barrel for callers who prefer a single import. An application lists
`@kindgi/sdk` and `@kindgi/cli` (dev); it needs no other `@kindgi/*`
package. Zero behavior of its own: this
package is a re-export facade over the individual `@kindgi/*` packages,
with every name preserved verbatim.

Framework contributors can import from the individual packages directly
(`@kindgi/tools`, `@kindgi/agents`, `@kindgi/guardrails`, `@kindgi/flow`,
`@kindgi/client`, `@kindgi/types`, `@kindgi/schema`). Application code
(packs, deploy tooling, external callers) should import from
`@kindgi/sdk` — the recommended public surface.

## Sub-paths

### `@kindgi/sdk/define` — pack authoring

```ts
import { defineTool, defineCheck, defineAgent } from '@kindgi/sdk/define';
import type { Tool, Agent, DefinedTool, DefineCheckSpec } from '@kindgi/sdk/define';
```

Re-exports:

| Symbol | Source | Kind |
|---|---|---|
| `defineTool`, `defineToolAsync`, `invokeTool`, `registerToolSpecSynthesizer` | `@kindgi/tools` | value |
| `Tool`, `ToolManifest`, `ToolContext`, `DefineToolSpec`, `DefinedTool`, `InferInput`, `InferOutput`, `ToolSpec`, `ToolSpecSynthesizer`, `ToolSecretRef`, `HttpToolSpec`, `HttpAuthSpec`, `HttpHeaderSpec`, `HttpMethod`, `HttpRequestBodySpec` | `@kindgi/tools` | type |
| `defineCheck` | `@kindgi/guardrails` | value |
| `DefineCheckSpec`, `DefinedCheck`, `InferCheckConfig` | `@kindgi/guardrails` | type |
| `defineAgent` | `@kindgi/agents` | value |
| `Agent`, `DefineAgentSpec` | `@kindgi/agents` | type |
| `defineFlow` | `@kindgi/flow` | value |
| `Flow`, `FlowSpec`, `LoopNode`, `FanoutNode`, `SubflowNode`, `EdgePolicy` | `@kindgi/flow` | type |
| `isZodSchema`, `toJSONSchema` | `@kindgi/schema` | value |
| `AnySchema`, `ZodLikeSchema` | `@kindgi/schema` | type |

`defineFlow` mirrors `defineTool` / `defineCheck` / `defineAgent` — a
thin wrapper over `loadFlow` that runs the same validation gauntlet and
returns `Result<Flow, FlowError>`. Pack authors reach for
`defineFlow` in TypeScript; `loadFlow` remains the wire-form entry
point for JSON coming off disk / network.

### `@kindgi/sdk/client` — client callsites

```ts
import { createClient } from '@kindgi/sdk/client';
import type { AgentId } from '@kindgi/sdk/types';

const client = createClient();

const run = await client.runs.start({
  agent: 'acme.drafting' as AgentId,
  input: { contractText },
});
```

`createClient()` finds the runtime by itself. Every option is optional:

- `apiUrl` and `auth` come from `KINDGI_API_URL` and `KINDGI_API_TOKEN`;
- in development, when those aren't set, from the running `kindgi dev`
  (the nearest `.kindgirc.json`), with a one-time warning to put them in
  your env file (`.env` / `.env.local`);
- a token that doesn't match the running `kindgi dev`'s for the same URL
  (after `kindgi dev --reset`) is warned about once.

Production (`NODE_ENV` or `KINDGI_ENV` = `production`) never reads
`.kindgirc.json`: the env or explicit options must say. Explicit options
always win, field by field:

```ts
const client = createClient({
  apiUrl: 'https://kindgi.internal.acme.com',
  auth: { kind: 'apiToken', token: await secrets.get('kindgi-api-token') },
});
```

In a browser, pass `apiUrl` and `auth` to `@kindgi/client`'s `createClient`
(the explicit client underneath).

Exports:

- `createClient` (above), `KindgiClient`.
- Every resource client type — `AgentsClient`, `RunsClient`, `ToolsClient`,
  `ApprovalsClient`, `SupervisorClient`, `ProposalsClient`, `ObservationsClient`,
  `FlowsClient`, `GuardrailsClient`, `ConversationsClient`, `MemoryClient`,
  `ProvenanceClient`, `TenantClient`, `CostClient`, `CapabilitiesClient`,
  `AdaptersClient`, `PoliciesClient`, `UsersClient`, `TeamsClient`, `OrgsClient`,
  `PacksClient`, `TokensClient`, `McpClient`, `EventsClient`, `ArtifactsClient`,
  `WebhooksClient`, plus each resource's per-method input types.
- `Transport`, `TransportRequest`, `ClientOptions`.
- Error surface — `KindgiApiError` (value), `fromWire`, `notImplementedInPreview`,
  `notYetWired`, plus `KindgiError`, `AuthError`, `ConflictError`,
  `GuardrailViolationError`, `GuardrailViolation`, `InvalidRequestError`,
  `NetworkError`, `NotFoundError`, `RateLimitedError`, `ServerError`,
  `NotImplementedInPreviewError`, `NotYetWiredError` types.
- Streaming — `readSse`, `unwrapSseData` (values), `SseEvent`, `SseReadOptions` (types).
- Following a run — `subscribeToRun` (a browser page follows a run with a
  public run token, reconnecting by itself), `followRun`, and
  `SubscribeToRunOptions`, `FollowRunOptions`, `RunProgressEvent`,
  `RunProgress`. Browser-safe, like the rest of this sub-path.

This sub-path deliberately does NOT re-export the branded ID types
(`AgentId`, `RunId`, etc.) that `@kindgi/client` also happens to
surface — those live in `@kindgi/sdk/types` so the flat barrel is
collision-free.

### `@kindgi/sdk/types` — branded identifiers + primitives

```ts
import type { RunId, AgentId, Result, Cursor } from '@kindgi/sdk/types';
```

Re-exports every branded `…Id` type from `@kindgi/types` (41 IDs incl.
`TenantId`, `RunId`, `AgentId`, `ToolId`, `PackId`, `SigningKeyId`, …),
the `Result<T, E>` envelope + `OkOf` / `ErrOf` narrowing helpers, `Brand`,
pagination (`Filter`, `Page`, `Cursor`), refs (`BlobRef`, `DatasetRef`,
`VersionedRef`), temporal (`Timestamp`, `DurationMs`, `IsoDuration`),
version + hash (`SchemaMajor`, `Semver`, `ContentHash`, `SignatureValue`).

`ConversationId` is one of them. `@kindgi/agents` also re-exports
`ConversationId`; import it from `@kindgi/sdk/types` (or `@kindgi/types`
directly).

### `@kindgi/sdk/webhooks` — receiving Kindgi's webhooks (server only)

```ts
import { verifyWebhook } from '@kindgi/sdk/webhooks';

const result = verifyWebhook({ secret, headers: request.headers, body: rawBody });
if (result.kind !== 'ok') return new Response(null, { status: 401 });
```

Re-exports the Standard Webhooks helpers from `@kindgi/crypto`:
`verifyWebhook` (and its `VerifyWebhookInput` / `VerifyWebhookResult` /
`VerifyWebhookFailure` / `WebhookRequestHeaders` types),
`generateWebhookSecret` and `isStrongWebhookSecret` for the secret an app
registers by name, `signWebhook` / `webhookHeaders` to test a receiver, and
the constants `WEBHOOK_HEADERS`, `WEBHOOK_SECRET_PREFIX`,
`WEBHOOK_SECRET_MIN_BYTES`, `DEFAULT_WEBHOOK_TOLERANCE_SECONDS`. It uses
`node:crypto`, so it is not in the flat barrel.

### `@kindgi/sdk/build` — a pack image's build extensions

```ts
import { prisma, defineBuildExtension } from '@kindgi/sdk/build';
import type { BuildExtension, ImageConfig } from '@kindgi/sdk/build';
```

For `image` in `kindgi.config.*`: `systemPackages`, `extensions` (`prisma()`, or your own with `defineBuildExtension()`), and `buildEnv`. These are data only, and `kindgi build` renders them into the image. They're re-exported from `@kindgi/handler-runtime/build-extensions`. The flat barrel doesn't include them: only a config imports them.

### Flat barrel — `@kindgi/sdk`

```ts
import { defineTool, createClient } from '@kindgi/sdk';
import type { RunId, DefinedTool } from '@kindgi/sdk';
```

Convenience alias. Every symbol from `/define`, `/client` and `/types` is
re-exported here; names are disjoint across the three so there is no
collision. `/webhooks` is server only and stays out of the barrel.

## Design decisions

- **A facade, not a replacement.** `@kindgi/client` (`sdks/typescript/`)
  stays its own package; the facade re-exports from it.
- **Every re-export preserves the source name.** No renaming at the
  facade boundary. Symbols in this package's docs match the source
  package's docs exactly.
- **`@kindgi/sdk` is recommended, not enforced.** The individual
  packages remain importable for framework contributors and for
  consumers that need a specific primitive without pulling the full
  facade dep tree.
- **Sub-paths are primary; the barrel is a convenience.** Applications
  that only need pack authoring can `import from '@kindgi/sdk/define'`
  and never pay for the client resource-type surface at build time
  (tree-shaken).

## Cross-references

- `packages/tools/README.md` — `defineTool` Zod-optional authoring.
- `packages/guardrails/README.md` — `defineCheck` Zod-optional authoring.
