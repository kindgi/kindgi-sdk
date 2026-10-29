# @kindgi/bounds

## 0.3.0-rc.0

No changes in this release.

## 0.2.0

No changes in this release.

## 0.2.0-rc.1

No changes in this release.

## 0.2.0-rc.0

No changes in this release.

## 0.1.10

No changes in this release.

## 0.1.10-rc.1

No changes in this release.

## 0.1.10-rc.0

No changes in this release.

## 0.1.9

### Patch Changes

- ffeecb2: **A turn can render its agent's instructions in a child process, off the thread that runs it.** `InvokeAgentBindings` takes an optional `templateRenderer` (`TemplateRenderer`). The render-prompt step awaits it, with the same checks before the render and the same result or error after it as `renderInstructions`. Without one, the turn renders in-process, as before.
  - New subpath `@kindgi/agents/render-worker` (Node only): `createWorkerTemplateRenderer({ workers, maxOldSpaceMb? })` renders in child processes — a thread would share the server's heap, so a template that exhausts it would take the whole server down; a child has its own.
    - A render past `liquid.renderLimitMs` has its worker stopped, wherever the render is, so a template can't hold up the server's own thread.
    - A render past the worker's heap cap (`maxOldSpaceMb`, Node's `--max-old-space-size`) fails with the memory limit's message.
    - The fork is explicit: the child gets an empty environment (never the server's database URLs, KMS settings or tokens, beside untrusted templates), its flags are the heap cap alone, and no file descriptors beyond the IPC channel.
    - A stopped worker is replaced, and waiting tenants take turns.
    - `close()` lets the renders it took finish, then stops the workers.
  - `TemplateRenderError` (`missing-parameter` or `render-failure`) is what a renderer rejects with for the template's own failure.
  - `TenantTimeBudget.admit(tenant)` (`@kindgi/bounds`) is for work that runs off the thread that admits it (a child process, say). It checks the tenant's budget now and returns a `TenantWork`, whose `start()` and `end()` charge the time between them. A worker's render counts toward the tenant's render budget from when a worker takes it.

## 0.1.9-rc.1

No changes in this release.

## 0.1.9-rc.0

### Patch Changes

- ffeecb2: **A turn can render its agent's instructions in a child process, off the thread that runs it.** `InvokeAgentBindings` takes an optional `templateRenderer` (`TemplateRenderer`). The render-prompt step awaits it, with the same checks before the render and the same result or error after it as `renderInstructions`. Without one, the turn renders in-process, as before.
  - New subpath `@kindgi/agents/render-worker` (Node only): `createWorkerTemplateRenderer({ workers, maxOldSpaceMb? })` renders in child processes — a thread would share the server's heap, so a template that exhausts it would take the whole server down; a child has its own.
    - A render past `liquid.renderLimitMs` has its worker stopped, wherever the render is, so a template can't hold up the server's own thread.
    - A render past the worker's heap cap (`maxOldSpaceMb`, Node's `--max-old-space-size`) fails with the memory limit's message.
    - The fork is explicit: the child gets an empty environment (never the server's database URLs, KMS settings or tokens, beside untrusted templates), its flags are the heap cap alone, and no file descriptors beyond the IPC channel.
    - A stopped worker is replaced, and waiting tenants take turns.
    - `close()` lets the renders it took finish, then stops the workers.
  - `TemplateRenderError` (`missing-parameter` or `render-failure`) is what a renderer rejects with for the template's own failure.
  - `TenantTimeBudget.admit(tenant)` (`@kindgi/bounds`) is for work that runs off the thread that admits it (a child process, say). It checks the tenant's budget now and returns a `TenantWork`, whose `start()` and `end()` charge the time between them. A worker's render counts toward the tenant's render budget from when a worker takes it.

## 0.1.8

### Patch Changes

- cd84814: **New package: `@kindgi/bounds`,** the limits a Kindgi server puts on what a tenant sends it, so that one tenant's input can't stall the server for the others: a pattern's length and engine, how many citations a `must-cite` guardrail may ask for, a schema's size and depth (and how many compiled ones are kept), a template's limits, the size and idle time of a body read from an endpoint a tenant names, and a request body's size and JSON depth.
  - `TenantInputBounds`, `SELF_HOSTED_BOUNDS` (today's behaviour, with generous caps) and `HOSTED_BOUNDS` (patterns on linear-time RE2, and tight limits).
  - `configureTenantInputBounds(bounds)` sets the process's bounds once, at boot; a second call throws. `tenantInputBounds()` reads them; self-hosted until set.
  - `@kindgi/bounds/testing`'s `overrideTenantInputBounds` runs a test with other bounds.
  - `compileTenantPattern(source, flags)` compiles a tenant's pattern under the bounds: on V8's engine, or on RE2 (the re2js port), length-checked. Under RE2 it accepts only what `RegExp` accepts (a pattern V8 refuses is refused in V8's words), and refuses by name what RE2 lacks (backreferences, lookahead and lookbehind, `\u` escapes) and what it would read otherwise (`[]`, `[^]`, `[:` in a class, and without the `u` flag `\p`, `\P`, `\A`, `\z`, `\Q`, `\a` and `\x{`). The README lists the flags and what reads differently.
- 3a3f233: Request bodies have a size limit and a depth limit, from the tenant input bounds.
  
  - A request body over `requestMaxBytes` (2 MiB on hosted, 10 MiB on a self-hosted server) is refused with `413 request-too-large`, with `details.maxBytes`, before more of it is read. Every operation with a body declares that answer, except the two routes that keep a limit of their own: an artifact upload (`413 artifact-too-large`, checked once the caller is known) and the webhook receiver (`413 webhook-body-too-large`).
  - A JSON body nested more than `requestJsonMaxDepth` levels (128) is refused with `400 bad-input`, with `details.maxDepth`.
  - A webhook delivery whose JSON nests deeper than that is refused the same way and starts no run. The trigger's fires record it as `body-too-deep`.
  - `HOSTED_BOUNDS.requestJsonMaxDepth` is 128 (it was 64), the same as self-hosted, so a schema as deep as `schemaMaxDepth` fits inside the body that carries it.
  - `kindgi deploy` says what to make smaller when a deployment is over the server's limit.
- ebf405d: **`compileJsonSchema` and `compileInlineSchema` compile under the process's bounds (`@kindgi/bounds`),** and compile each schema once.
  - A `$ref` is compiled once, where its target is, not copied into each place that uses it (Ajv's `inlineRefs: false`), so the code a schema compiles to grows with its JSON.
  - A schema nested deeper than `schemaMaxDepth`, or larger than `schemaMaxBytes` as JSON, is refused before it's compiled, naming the limit: 64 levels and 1 MiB unless the server sets other bounds.
  - Validators are kept by the schema's JSON as written and the options it was compiled with, the least recently used dropped once `schemaCacheEntries` are kept or their schemas' JSON passes `schemaCacheMaxBytes`. A schema that didn't compile throws the same error again. The cache is all that keeps a compiled schema: `compileInlineSchema`'s result keeps the schema's cache key, not its validator, and compiles it again on `validate` once the cache has dropped it. New `holdJsonSchema` does the same for `compileJsonSchema`, and a tool holds its validators through it. A schema JSON can't carry (a key whose value is `undefined`, say) is never cached, so it's held as compiled.
  - Each tenant's compiles share a budget, `schemaCompileBudgetMs` in any 60 seconds (hosted 2 s, self-hosted none). `runAsTenant` (new in `@kindgi/bounds`) says whose compile it is and which count: by default only a schema compiled again after the cache dropped it; with `{ compiles: 'all' }`, every compile. Past the budget, a compile that counts throws `SchemaCompileBudgetError` with `retryAfterMs`, from `compileInlineSchema` too; `defineTool`, `validateToolManifest` and a guardrail's config check pass it on rather than report the schema as invalid, and `compileInlineSchema`'s `validate` throws it when it compiles again. A tenant that compiled nothing for an hour is forgotten: its next compiles are first ones again, as after a restart. `runOutsideTenant` (new) runs Kindgi's own work, started inside a tenant's scope, outside it.
  - Under the hosted profile, every check a schema makes of the data runs in time linear in the data (`uniqueItems`: in its size times its depth). Patterns (`pattern`, `patternProperties`, `propertyNames`) run on RE2 through `compileTenantPattern`, and a schema with one RE2 can't run doesn't compile. Formats are ajv-formats' `fast` ones (looser in places: `date` accepts `2026-02-30`), with `regex` a pattern whose syntax `compileTenantPattern` accepts, checked without building RE2's program (`tenantPatternSyntaxProblem`, new in `@kindgi/bounds`; a pattern RE2 refuses only as it builds the program, for its size or a few escapes, passes), and `url` written without its backtracking. `uniqueItems` finds a repeat by a key for each item, with Ajv's verdict and error.
  - `createSpecRegistry` and `loadSpecRegistry` run the patterns of Kindgi's own schemas on V8.
  - A guardrail's config is checked against its check's schema through `compileJsonSchema`, so the same bounds apply.
- 3a3f233: Template renders on a self-hosted server and under `kindgi dev` now have a memory limit: `SELF_HOSTED_BOUNDS.liquid.memoryLimit` is 16,777,216, where it had none. A render past it fails, saying so.
- ebf405d: **An agent turn whose work its tenant's budget refuses fails with `rate-limit-exceeded`, not `model-invocation-failed`,** on a server with budgets kept per tenant (Kindgi Cloud). The error names the budget in `details.limit` (`template-render-time` or `schema-compile-time`), with `details.budgetMs`, and says when the tenant is under it again. `POST /v1/runs` answers it as `429`, with `Retry-After` and `details.runId`, and the run reads as failed with that code. The OpenAPI document lists the 429 on `POST /v1/runs`.
  - New: the tenant input bounds' `templateRenderBudgetMs`, the time a tenant's instructions templates may spend rendering in any 60 seconds. Once a tenant has spent it, its next render is refused before it starts. A self-hosted server has none.
  - `TenantBudgetError` (`@kindgi/bounds`) is what each budget's refusal is: `SchemaCompileBudgetError` and the new `TemplateRenderBudgetError` (`@kindgi/agents`) extend it, with `limit`, `budgetMs` and `retryAfterMs`. The API answers any of them thrown from a route as `429 rate-limit-exceeded`.
  - A guardrail check, or a tenant's approval policy, whose schema compile the budget refuses no longer fails as `check-failed` or `tenant-policy-unavailable`: the turn fails as above.
  - A failed run's `failure` has `details` for a code that has them. For `rate-limit-exceeded` that's `limit` and `budgetMs`, never the wait, which is stale once read back. The `run.finished` webhook's run can carry `failure` beside `failureMessage`. It's absent from a runtime that doesn't send it yet. `parseEvent` (`@kindgi/sdk/webhooks`) reads it, and reads a failure's `cause` as any JSON value.

## 0.1.8-rc.0

### Patch Changes

- cd84814: **New package: `@kindgi/bounds`,** the limits a Kindgi server puts on what a tenant sends it, so that one tenant's input can't stall the server for the others: a pattern's length and engine, how many citations a `must-cite` guardrail may ask for, a schema's size and depth (and how many compiled ones are kept), a template's limits, the size and idle time of a body read from an endpoint a tenant names, and a request body's size and JSON depth.
  - `TenantInputBounds`, `SELF_HOSTED_BOUNDS` (today's behaviour, with generous caps) and `HOSTED_BOUNDS` (patterns on linear-time RE2, and tight limits).
  - `configureTenantInputBounds(bounds)` sets the process's bounds once, at boot; a second call throws. `tenantInputBounds()` reads them; self-hosted until set.
  - `@kindgi/bounds/testing`'s `overrideTenantInputBounds` runs a test with other bounds.
  - `compileTenantPattern(source, flags)` compiles a tenant's pattern under the bounds: on V8's engine, or on RE2 (the re2js port), length-checked. Under RE2 it accepts only what `RegExp` accepts (a pattern V8 refuses is refused in V8's words), and refuses by name what RE2 lacks (backreferences, lookahead and lookbehind, `\u` escapes) and what it would read otherwise (`[]`, `[^]`, `[:` in a class, and without the `u` flag `\p`, `\P`, `\A`, `\z`, `\Q`, `\a` and `\x{`). The README lists the flags and what reads differently.
- 3a3f233: Request bodies have a size limit and a depth limit, from the tenant input bounds.
  
  - A request body over `requestMaxBytes` (2 MiB on hosted, 10 MiB on a self-hosted server) is refused with `413 request-too-large`, with `details.maxBytes`, before more of it is read. Every operation with a body declares that answer, except the two routes that keep a limit of their own: an artifact upload (`413 artifact-too-large`, checked once the caller is known) and the webhook receiver (`413 webhook-body-too-large`).
  - A JSON body nested more than `requestJsonMaxDepth` levels (128) is refused with `400 bad-input`, with `details.maxDepth`.
  - A webhook delivery whose JSON nests deeper than that is refused the same way and starts no run. The trigger's fires record it as `body-too-deep`.
  - `HOSTED_BOUNDS.requestJsonMaxDepth` is 128 (it was 64), the same as self-hosted, so a schema as deep as `schemaMaxDepth` fits inside the body that carries it.
  - `kindgi deploy` says what to make smaller when a deployment is over the server's limit.
- ebf405d: **`compileJsonSchema` and `compileInlineSchema` compile under the process's bounds (`@kindgi/bounds`),** and compile each schema once.
  - A `$ref` is compiled once, where its target is, not copied into each place that uses it (Ajv's `inlineRefs: false`), so the code a schema compiles to grows with its JSON.
  - A schema nested deeper than `schemaMaxDepth`, or larger than `schemaMaxBytes` as JSON, is refused before it's compiled, naming the limit: 64 levels and 1 MiB unless the server sets other bounds.
  - Validators are kept by the schema's JSON as written and the options it was compiled with, the least recently used dropped once `schemaCacheEntries` are kept or their schemas' JSON passes `schemaCacheMaxBytes`. A schema that didn't compile throws the same error again. The cache is all that keeps a compiled schema: `compileInlineSchema`'s result keeps the schema's cache key, not its validator, and compiles it again on `validate` once the cache has dropped it. New `holdJsonSchema` does the same for `compileJsonSchema`, and a tool holds its validators through it. A schema JSON can't carry (a key whose value is `undefined`, say) is never cached, so it's held as compiled.
  - Each tenant's compiles share a budget, `schemaCompileBudgetMs` in any 60 seconds (hosted 2 s, self-hosted none). `runAsTenant` (new in `@kindgi/bounds`) says whose compile it is and which count: by default only a schema compiled again after the cache dropped it; with `{ compiles: 'all' }`, every compile. Past the budget, a compile that counts throws `SchemaCompileBudgetError` with `retryAfterMs`, from `compileInlineSchema` too; `defineTool`, `validateToolManifest` and a guardrail's config check pass it on rather than report the schema as invalid, and `compileInlineSchema`'s `validate` throws it when it compiles again. A tenant that compiled nothing for an hour is forgotten: its next compiles are first ones again, as after a restart. `runOutsideTenant` (new) runs Kindgi's own work, started inside a tenant's scope, outside it.
  - Under the hosted profile, every check a schema makes of the data runs in time linear in the data (`uniqueItems`: in its size times its depth). Patterns (`pattern`, `patternProperties`, `propertyNames`) run on RE2 through `compileTenantPattern`, and a schema with one RE2 can't run doesn't compile. Formats are ajv-formats' `fast` ones (looser in places: `date` accepts `2026-02-30`), with `regex` a pattern whose syntax `compileTenantPattern` accepts, checked without building RE2's program (`tenantPatternSyntaxProblem`, new in `@kindgi/bounds`; a pattern RE2 refuses only as it builds the program, for its size or a few escapes, passes), and `url` written without its backtracking. `uniqueItems` finds a repeat by a key for each item, with Ajv's verdict and error.
  - `createSpecRegistry` and `loadSpecRegistry` run the patterns of Kindgi's own schemas on V8.
  - A guardrail's config is checked against its check's schema through `compileJsonSchema`, so the same bounds apply.
- 3a3f233: Template renders on a self-hosted server and under `kindgi dev` now have a memory limit: `SELF_HOSTED_BOUNDS.liquid.memoryLimit` is 16,777,216, where it had none. A render past it fails, saying so.
- ebf405d: **An agent turn whose work its tenant's budget refuses fails with `rate-limit-exceeded`, not `model-invocation-failed`,** on a server with budgets kept per tenant (Kindgi Cloud). The error names the budget in `details.limit` (`template-render-time` or `schema-compile-time`), with `details.budgetMs`, and says when the tenant is under it again. `POST /v1/runs` answers it as `429`, with `Retry-After` and `details.runId`, and the run reads as failed with that code. The OpenAPI document lists the 429 on `POST /v1/runs`.
  - New: the tenant input bounds' `templateRenderBudgetMs`, the time a tenant's instructions templates may spend rendering in any 60 seconds. Once a tenant has spent it, its next render is refused before it starts. A self-hosted server has none.
  - `TenantBudgetError` (`@kindgi/bounds`) is what each budget's refusal is: `SchemaCompileBudgetError` and the new `TemplateRenderBudgetError` (`@kindgi/agents`) extend it, with `limit`, `budgetMs` and `retryAfterMs`. The API answers any of them thrown from a route as `429 rate-limit-exceeded`.
  - A guardrail check, or a tenant's approval policy, whose schema compile the budget refuses no longer fails as `check-failed` or `tenant-policy-unavailable`: the turn fails as above.
  - A failed run's `failure` has `details` for a code that has them. For `rate-limit-exceeded` that's `limit` and `budgetMs`, never the wait, which is stale once read back. The `run.finished` webhook's run can carry `failure` beside `failureMessage`. It's absent from a runtime that doesn't send it yet. `parseEvent` (`@kindgi/sdk/webhooks`) reads it, and reads a failure's `cause` as any JSON value.
