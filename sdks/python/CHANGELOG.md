# Kindgi Python packages

`kindgi` (the Python SDK) and `kindgi-cli` (the Kindgi CLI for Python
developers) have one version, the same as the npm packages', spelled as PyPI
spells it: `0.1.8rc0` for npm's `0.1.8-rc.0`. Each user-visible change adds
its line under **Unreleased** in the pull request that makes it. A release
turns that heading into its version. From 0.2.0 on, a release after release
candidates lists their changes too, so its section has every change since
the release before. An earlier release's section has only what came after
its candidates, and theirs are just below it. `kindgi-cli` carries
`@kindgi/cli` of the same version, and the CLI's own changes are in
[`@kindgi/cli`'s changelog](../../packages/cli/CHANGELOG.md).

## Unreleased

- `kindgi`: **a `retry` guardrail sends a failed answer back to the model,
  for a new one**, until it has failed `maxAttempts` answers (2 when left
  out), and then the turn fails with `guardrail-violation`.
  `GuardrailViolationError.attempts` says how many answers the turn had
  (`None` when a `halt` guardrail stopped it). The `@guardrail` docstring
  says what `retry` does.
- `kindgi`: **a trigger's versions.** `client.schedules.list_versions(trigger_id)` pages a schedule's versions, newest first (`GET /v1/schedules/{triggerId}/versions`), and `get_version(trigger_id, version)` reads one; `client.webhooks` and `client.mail_triggers` have the same. Each says when it was made (`created_at`), by whom (`created_by`), why (`cause`) and what the trigger was then (`definition`). A trigger's `version` names its newest, and a fire's and a run's `trigger.version` the one its run used; all three are absent from an older runtime. A version the trigger doesn't have is `404 trigger-version-not-found`.
- `kindgi`: **`client.agents.projects(agent_id)` lists the projects an agent runs in** (`GET /v1/agents/{agentId}/projects`): the project it was first published in, then each project a deployment that isn't retired shipped a version of it into, such as the next environment `kindgi promote` carried its build to, among those the caller can read. A retired agent still answers.
- `kindgi`: **`Agent(parallel_tool_calls=False)` runs every tool call a model
  step asks for on its own.** By default an agent now runs a step's calls to
  read-only tools (`mutating=False`, no changing effect) that come one after
  another at the same time, up to 8 at once, and any other call on its own, in
  the order the model asked; the results reach the conversation in that order
  either way. A call that may wait, for another system's answer or for the
  person who started the run to connect an app, runs on its own too. The
  indexer writes it as the agent's `parallelToolCalls`, and `Agent` refuses a
  value that isn't `True` or `False`. The client's `Agent` and
  `PublishAgentBody` models gain `parallel_tool_calls`. `mutating`'s
  description says it decides what runs together.
- `kindgi`: **A union's members are named by the value that tells them
  apart.** The members of five inline unions in `kindgi.client.models` had
  numbered names, and four other models' numbered names would have shifted
  into the freed ones. These names change, and no old name is kept:
  - **A union's members, by their discriminator:**
    - `Config`, `Config1`, `Config2` (an MCP endpoint's config: stdio,
      http-sse, streamable-http): `MCPEndpointConfigStdio`,
      `MCPEndpointConfigHttpSse`, `MCPEndpointConfigStreamableHttp`.
    - `Config3` to `5` (the same, in a registration's body):
      `RegisterMCPEndpointBodyConfigStdio`,
      `RegisterMCPEndpointBodyConfigHttpSse`,
      `RegisterMCPEndpointBodyConfigStreamableHttp`.
    - `Content2`, `Content3` (an MCP prompt message's content: text, image):
      `MCPPromptMessageContentText`, `MCPPromptMessageContentImage`.
    - `Resume`, `Resume1` (how completing an approval resumed its run: ok,
      failed): `CompleteApprovalResultResumeOk`,
      `CompleteApprovalResultResumeFailed`.
    - `Baseline`, `Baseline1` (what a judged comparison compared with:
      recorded runs, a version): `JudgedComparisonSummaryBaselineRecorded`,
      `JudgedComparisonSummaryBaselineVersion`.
  - **Named after their field, so no freed name passes to them:**
    - `Config6`, `Config7` (a schedule's config, registering and patching):
      `RegisterScheduleBodyConfig`, `PatchScheduleBodyConfig`.
    - `Config8` (a webhook trigger's config, in both bodies): now one class
      per body, `RegisterWebhookTriggerBodyConfig` and
      `PatchWebhookTriggerBodyConfig`. A mapping works for either; an
      instance of one isn't taken by the other.
    - `Baseline2` (a compared case's baseline score):
      `ComparisonCaseResultBaseline`.

  Code that imports an old name fails at the import, and an `isinstance` or
  `match` on one needs the new name. The client's generation now keeps a
  dropped name dropped, so no later model takes `Config` or `Baseline` with
  another meaning. (#938)
- `kindgi`: **An error inside a field is logged like `err`, and a value that
  raises when read never fails the log call.** An error nested in a field (in a
  mapping or a list) was written as its scrubbed `str()`, so its `name`, `code`
  and causes were lost. It's now written as `err` is — its `name` (its class's),
  scrubbed `message` and `code`, and its causes — without its stack at any
  level. The message is written as the error gives it, with known secret shapes
  masked; a database driver's message can itself quote the statement and the
  values it was bound to (SQLAlchemy appends `[SQL: …]` and `[parameters: …]`
  unless the engine has `hide_parameters=True`, and libpq keeps a `DETAIL:`
  line), so when that matters log a field such as the SQLSTATE rather than the
  error. None of the error's other attributes are written. An attribute that
  raises when read counts as missing (a message that can't be read is empty), a
  value that raises when read is `[unreadable]`, and fields whose keys can't be
  listed are left out; the record is still written.
- `kindgi`: **a guardrail the client reads or registers carries where in the
  agent's turn it runs.** `at` is `"before-tool"`, `"after-tool"`,
  `"model-step"` or `"final-answer"` (left out, the final answer); `sees` is
  `"turn"` or `"conversation"`; and the scope's `tools` names the tools a
  guardrail at a tool point checks. Registering one at a point its check
  doesn't run at answers `guardrail-config-invalid`. The Python pack's
  `@guardrail` doesn't take them yet.

## 0.2.0

- `kindgi`: **`@tool` and `http_tool` take `result_is_outside_data`.** `True`
  says the tool's results are text from outside that nobody checked, such as a
  mail someone sent or a page a search found. An agent reads each result of the
  tool as data, not instructions, in that turn and in every later turn's
  history. It changes what the model is told, not what the tool may do: pair it
  with approvals for anything an agent could do with what it read. The pack's
  index carries it as `resultIsOutsideData`; left out, nothing changes.
- `kindgi`: **a tool's schema derived from a model or a type is checked as
  the runtime compiles it, as one given as a dict is.** `@tool` and
  `http_tool` raise `DefinitionError` for a derived input or output schema
  the runtime would refuse when it registers or deploys the tool: a keyword
  `json_schema_extra` adds (`strict mode: unknown keyword: "x-acme-unit"`), a
  `format` pydantic writes that the runtime doesn't know (`"format": "path"`
  for a `pathlib.Path` field; `UUID4`, `IPvAnyAddress`, `FilePath`,
  `Base64Bytes`, `PostgresDsn`, `MongoDsn` and `NatsDsn` write one too), or
  a schema that isn't valid Draft 2020-12. Before, only a derived schema's
  patterns were checked, and the deploy refused the rest. For such a field, a
  plain `uuid.UUID` or `str`, or pydantic's `WithJsonSchema`, gives a schema
  the runtime compiles. A pattern only JavaScript and pydantic read, such as
  `\p{L}`, still passes, since pydantic checks the data. A guardrail's config
  schema derived from a model still has only its patterns checked: the
  runtime checks a config against it non-strict. Matches the TypeScript
  `@kindgi/tools` definition check.
- `kindgi`: **a tool or an agent whose model has a pydantic tagged union
  deploys.** With `Field(discriminator=...)`, pydantic writes OpenAPI's
  `discriminator` keyword beside the union's `oneOf`, and the runtime refused
  a tool's input or output, or an agent's typed answer, when it was
  registered or deployed (`strict mode: unknown keyword: "discriminator"`).
  The wire schema now leaves it out: each member's tag is a `const` (an
  `enum` for several values), so the `oneOf` picks the member. Each member
  also lists its tag in `required`, since pydantic refuses a value without
  its tag, even when the tag has a default.
- `kindgi`: **a union whose member a callable `Discriminator` picks takes
  every value pydantic takes.** pydantic writes it as a plain `oneOf`, and its
  members can overlap: a value that fit two of them was refused, as a tool's
  input or output or an agent's typed answer, though pydantic took it. The
  wire schema now writes it as an `anyOf`.
- `kindgi`: **a tool can pause its run until another system answers.**
  `@tool(pauses=True)`: the handler hands `ctx.wait_token.url` to that system
  and returns `ctx.pause(timeout_ms=..., name=...)`, 24 hours by default and
  at most 24 days. Annotate it `-> Answer | PauseAnswer`: the output schema is
  `Answer`'s. A call from a runtime that sends no wait token fails with
  `pause-not-available`: reading `ctx.wait_token` raises `PauseNotAvailable`
  first, so the tool hands nothing on. `ToolContext.for_test(wait_token=...)`
  tests one. New: `PauseAnswer`, `PauseNotAvailable` and `WaitToken`. The
  client's `Tool` model carries `pauses`.
- `kindgi`: **the client answers a run's wait for another system.**
  `runs.resume(run_id, waitpoint_id=..., value=...)` takes a `pause:` waitpoint
  from `runs.get(run_id).waiting_for.tokens` (`RunWaitingToken`), with the
  tool's output as `value`. Any other waitpoint is refused with
  `run-resume-not-supported`. New error codes: `wait-token-not-found`,
  `wait-token-closed`, `wait-token-output-invalid` and `unsupported-media-type`.
- `kindgi`: **a run says whom it acts for.** The client's `Run` gains
  `acts_for`: `user:<id>` (a person) or `service_account:<id>` (a service
  account), whose access the run has. A schedule's or a webhook's run acts
  for the trigger's owner, and a child run for its parent's. It is an id,
  never a name, and it is `None` on a run that acts for no one and on older
  runs.
- `kindgi`: **`SecretRevokeOutcome` and `SecretRevokeResult` gain an optional
  `recoverable_until`**: when a hard revoke left a copy your secret manager can
  still recover, until when it keeps it. It's `None` on a soft revoke, and
  when a hard revoke left nothing recoverable.
- `kindgi`: **connections to other apps.** The client gains
  `connection_entries.list`; `connection_apps.list`, `create`, `get`,
  `update` and `remove`; `connections.list`, `connect`, `finish`, `get` and
  `disconnect`; and `connections.requests.get` and `start`, with their async
  twins. A tool reads its connections from `ToolContext.connections`, a
  mapping of each declared name to a `ToolConnection` (`connection_id`,
  `app`, `app_name`, `access_token`, `account` as a `ConnectionAccount`,
  `expires_at`), empty when the tool declares none; no `repr` shows a token.
  A tool whose app refuses the token raises `ConnectionRejected(name)` (or
  its own error `from` it), and the pack answers `connection-rejected` naming
  the connection (pack protocol 2.9.0).
- `kindgi`: **`ScheduleRecord`, `WebhookTriggerRecord`, their register and
  patch bodies, and `Run` gain `tools_allowed_unattended`**: the tools whose
  calls in a webhook's or a schedule's runs needn't wait for a person's yes.
  Naming it takes `admin` on the trigger's project, and each id must be a tool
  the trigger's flow or agent calls. A take-over keeps it.
- `kindgi`: **a judgment can carry an expert's correction, graded when a
  version is replayed on the run.** `judgments.create` takes `correction`
  (`Correction`): `calls`, the tool calls the agent should have made, each an
  `ExpectedCall` with its `tool` and, in `args`, the argument fields that
  matter; and `not_called`, the tools it should not have called at all. A
  correction judges the run's whole output, so it goes on the reserved item
  `kindgi:correction` at pointer `""`, one per run per expert: saving again
  replaces it. A `Judgment` returns it as `correction`, and a judged test
  set's cases carry theirs (`JudgedEvalCase.corrections`,
  `JudgedEvalCaseCorrection`). A judged comparison grades each one: a case
  result gains `corrections` (`ComparisonCaseResultCorrection`: `pass_` and
  how many repetitions passed) and `correction_differences`
  (`CorrectionDifference`: by judgment, the first repetition that failed and
  how its calls differed, each a `CallDifferenceCount`,
  `CallDifferenceMustNotCall`, `CallDifferenceMissingField` or
  `CallDifferenceFieldValue`), and the summary's `corrections`
  (`Corrections`) counts those `checked` and `passed`, and lists each by
  judgment (`judgments`, `JudgedComparisonSummaryCorrectionsJudgment`). Shown
  for a promotion gate, not enforced. `correction_differences` quotes argument
  values, so an erasure clears it; the verdicts and counts stay in
  `corrections`. Matches the TypeScript client's.
- `kindgi`: **a test set's cases name their judgments, and a proposal says
  how many it rests on.** A judged case's items gain `judgment_ids`, and their
  `restricted` gains `judgment_ids` too. A proposal's `evidence` is now the
  `ProposalEvidence` model, with `judgment_count` beside `judgment_ids`. The
  create body's `Evidence1` is unchanged.
- `kindgi`: **a proposal says how it was kept, what the replays cost and
  which decisions held.** A proposal's `evaluation` gains `rule` (`better` or
  `cheaper`), `cost_usd` (`ProposalCost`) and `decisions`
  (`ProposalDecisions`). A proposal kept as `cheaper` is `evaluated` with
  `better` false. A judged comparison's summary gains `cost_usd`
  (`JudgedComparisonCost`), and each case result gains `cost_usd`, one per
  repetition.
- `kindgi`: **`secrets.revoke`'s docstrings say what a hard revoke does**: it
  erases the value at Kindgi and hard-deletes it in a secret manager, and
  can't be undone; backups, and a secret manager's own retention, may keep
  copies for a time. They no longer call it cryptographic erasure.
- `kindgi`: **a tool's `needs_spec` is checked, and a test can fill its
  `env`.** `@tool(..., needs_spec=...)` is refused at definition
  (`DefinitionError`) when a schema under `env` or `secrets` doesn't compile
  as the runtime compiles it (it isn't valid Draft 2020-12, or it or a schema
  inside it has a keyword or a `format` the runtime doesn't know, a misspelled
  one say, or a `$ref` that points nowhere), or an `env` default isn't a
  string (`None` included).
  `ToolContext.for_test(tool=...)` builds a context whose `env` is what the
  tool declares under `needs_spec["env"]` — each name from the `env=` you pass
  or its schema's string default, checked against its schema — so a handler
  test resolves env the way the runtime does; names the tool doesn't declare
  are dropped and `secrets=` pass through.
  Matches the TypeScript `@kindgi/tools` definition check and test context.
- `kindgi`: **a tool's schema given as a dict is checked when the tool is
  defined.** `@tool(input={...}, output={...})` and `http_tool` raise
  `DefinitionError` when the runtime would refuse the schema (it isn't valid
  JSON Schema Draft 2020-12, or it has a keyword or a `format` the runtime
  doesn't know, or a `$ref` that points nowhere), the check `needs_spec`'s
  schemas get. Before, such a schema reached the pack index as written, and
  the deploy refused it (under `kindgi dev`, the tool's first call failed).
  Matches the TypeScript `@kindgi/tools` definition check.
- `kindgi`: **the definition check refuses what the runtime's strict
  compile refuses besides unknown names**, word for word as the runtime
  says it:
  - a keyword with no `type` it applies to (`minLength` with no
    `"type": "string"`, say), or a `type` its context can't be;
  - a `required` property nothing defines;
  - a `prefixItems` tuple without matching `minItems` and `maxItems`
    (or `items: false`);
  - `nullable` without a `type`;
  - `then`/`else` without `if`, and `minContains`/`maxContains` without
    `contains`;
  - an empty `enum`;
  - a format bound without a `format` it can compare;
  - a `patternProperties` pattern that matches a property `properties`
    also names;
  - a chain of `$ref`s that only leads back to itself.

  A corpus of schemas, with the runtime's answer to each, keeps the two in
  step.
- `kindgi`: **a pattern is checked as the runtime's JavaScript reads it.**
  When a tool is defined, a `pattern`, or a `patternProperties` pattern,
  that the runtime's `RegExp` refuses raises `DefinitionError` in the
  runtime's words (`Invalid regular expression: /(/u: Unterminated group`),
  in a schema given as a dict and in one derived from a model alike. Before,
  a dict's went by Python's `re` and a model's wasn't checked: a pattern only
  Python or pydantic reads, such as `(?P<name>…)`, reached the deploy, which
  refused it. In a dict, a pattern only JavaScript reads, such as `\p{L}`, is
  still refused, since the SDK checks data against it with Python's `re`. In
  a model, pydantic checks the data, and reads `\p{L}`. A `"format": "regex"`
  value is checked as the runtime checks it, too.
- `kindgi`: **`proposals.improve`'s docstrings say how a refusal names why an
  Improve run has nothing to work on**: a `validation-failed` error's
  `details.reason` is `no-tunable-keys` or, on the agent's instructions (the
  `prompt` tier), `no-pinned-prompt-block`.
- `kindgi`: **`refused_writes` and `max_refused_writes` say what they count:
  every tool call the replay refused, reads included.** The names don't
  change. `stopped` says "a refused tool call" where it said "a refused
  write".

## 0.2.0rc1

- `kindgi`: **`@tool` and `http_tool` take `result_is_outside_data`.** `True`
  says the tool's results are text from outside that nobody checked, such as a
  mail someone sent or a page a search found. An agent reads each result of the
  tool as data, not instructions, in that turn and in every later turn's
  history. It changes what the model is told, not what the tool may do: pair it
  with approvals for anything an agent could do with what it read. The pack's
  index carries it as `resultIsOutsideData`; left out, nothing changes.

## 0.2.0rc0

- `kindgi`: **a tool's schema derived from a model or a type is checked as
  the runtime compiles it, as one given as a dict is.** `@tool` and
  `http_tool` raise `DefinitionError` for a derived input or output schema
  the runtime would refuse when it registers or deploys the tool: a keyword
  `json_schema_extra` adds (`strict mode: unknown keyword: "x-acme-unit"`), a
  `format` pydantic writes that the runtime doesn't know (`"format": "path"`
  for a `pathlib.Path` field; `UUID4`, `IPvAnyAddress`, `FilePath`,
  `Base64Bytes`, `PostgresDsn`, `MongoDsn` and `NatsDsn` write one too), or
  a schema that isn't valid Draft 2020-12. Before, only a derived schema's
  patterns were checked, and the deploy refused the rest. For such a field, a
  plain `uuid.UUID` or `str`, or pydantic's `WithJsonSchema`, gives a schema
  the runtime compiles. A pattern only JavaScript and pydantic read, such as
  `\p{L}`, still passes, since pydantic checks the data. A guardrail's config
  schema derived from a model still has only its patterns checked: the
  runtime checks a config against it non-strict. Matches the TypeScript
  `@kindgi/tools` definition check.
- `kindgi`: **a tool or an agent whose model has a pydantic tagged union
  deploys.** With `Field(discriminator=...)`, pydantic writes OpenAPI's
  `discriminator` keyword beside the union's `oneOf`, and the runtime refused
  a tool's input or output, or an agent's typed answer, when it was
  registered or deployed (`strict mode: unknown keyword: "discriminator"`).
  The wire schema now leaves it out: each member's tag is a `const` (an
  `enum` for several values), so the `oneOf` picks the member. Each member
  also lists its tag in `required`, since pydantic refuses a value without
  its tag, even when the tag has a default.
- `kindgi`: **a union whose member a callable `Discriminator` picks takes
  every value pydantic takes.** pydantic writes it as a plain `oneOf`, and its
  members can overlap: a value that fit two of them was refused, as a tool's
  input or output or an agent's typed answer, though pydantic took it. The
  wire schema now writes it as an `anyOf`.
- `kindgi`: **a tool can pause its run until another system answers.**
  `@tool(pauses=True)`: the handler hands `ctx.wait_token.url` to that system
  and returns `ctx.pause(timeout_ms=..., name=...)`, 24 hours by default and
  at most 24 days. Annotate it `-> Answer | PauseAnswer`: the output schema is
  `Answer`'s. A call from a runtime that sends no wait token fails with
  `pause-not-available`: reading `ctx.wait_token` raises `PauseNotAvailable`
  first, so the tool hands nothing on. `ToolContext.for_test(wait_token=...)`
  tests one. New: `PauseAnswer`, `PauseNotAvailable` and `WaitToken`. The
  client's `Tool` model carries `pauses`.
- `kindgi`: **the client answers a run's wait for another system.**
  `runs.resume(run_id, waitpoint_id=..., value=...)` takes a `pause:` waitpoint
  from `runs.get(run_id).waiting_for.tokens` (`RunWaitingToken`), with the
  tool's output as `value`. Any other waitpoint is refused with
  `run-resume-not-supported`. New error codes: `wait-token-not-found`,
  `wait-token-closed`, `wait-token-output-invalid` and `unsupported-media-type`.
- `kindgi`: **a run says whom it acts for.** The client's `Run` gains
  `acts_for`: `user:<id>` (a person) or `service_account:<id>` (a service
  account), whose access the run has. A schedule's or a webhook's run acts
  for the trigger's owner, and a child run for its parent's. It is an id,
  never a name, and it is `None` on a run that acts for no one and on older
  runs.
- `kindgi`: **`SecretRevokeOutcome` and `SecretRevokeResult` gain an optional
  `recoverable_until`**: when a hard revoke left a copy your secret manager can
  still recover, until when it keeps it. It's `None` on a soft revoke, and
  when a hard revoke left nothing recoverable.
- `kindgi`: **connections to other apps.** The client gains
  `connection_entries.list`; `connection_apps.list`, `create`, `get`,
  `update` and `remove`; `connections.list`, `connect`, `finish`, `get` and
  `disconnect`; and `connections.requests.get` and `start`, with their async
  twins. A tool reads its connections from `ToolContext.connections`, a
  mapping of each declared name to a `ToolConnection` (`connection_id`,
  `app`, `app_name`, `access_token`, `account` as a `ConnectionAccount`,
  `expires_at`), empty when the tool declares none; no `repr` shows a token.
  A tool whose app refuses the token raises `ConnectionRejected(name)` (or
  its own error `from` it), and the pack answers `connection-rejected` naming
  the connection (pack protocol 2.9.0).
- `kindgi`: **`ScheduleRecord`, `WebhookTriggerRecord`, their register and
  patch bodies, and `Run` gain `tools_allowed_unattended`**: the tools whose
  calls in a webhook's or a schedule's runs needn't wait for a person's yes.
  Naming it takes `admin` on the trigger's project, and each id must be a tool
  the trigger's flow or agent calls. A take-over keeps it.
- `kindgi`: **a judgment can carry an expert's correction, graded when a
  version is replayed on the run.** `judgments.create` takes `correction`
  (`Correction`): `calls`, the tool calls the agent should have made, each an
  `ExpectedCall` with its `tool` and, in `args`, the argument fields that
  matter; and `not_called`, the tools it should not have called at all. A
  correction judges the run's whole output, so it goes on the reserved item
  `kindgi:correction` at pointer `""`, one per run per expert: saving again
  replaces it. A `Judgment` returns it as `correction`, and a judged test
  set's cases carry theirs (`JudgedEvalCase.corrections`,
  `JudgedEvalCaseCorrection`). A judged comparison grades each one: a case
  result gains `corrections` (`ComparisonCaseResultCorrection`: `pass_` and
  how many repetitions passed) and `correction_differences`
  (`CorrectionDifference`: by judgment, the first repetition that failed and
  how its calls differed, each a `CallDifferenceCount`,
  `CallDifferenceMustNotCall`, `CallDifferenceMissingField` or
  `CallDifferenceFieldValue`), and the summary's `corrections`
  (`Corrections`) counts those `checked` and `passed`, and lists each by
  judgment (`judgments`, `JudgedComparisonSummaryCorrectionsJudgment`). Shown
  for a promotion gate, not enforced. `correction_differences` quotes argument
  values, so an erasure clears it; the verdicts and counts stay in
  `corrections`. Matches the TypeScript client's.
- `kindgi`: **a test set's cases name their judgments, and a proposal says
  how many it rests on.** A judged case's items gain `judgment_ids`, and their
  `restricted` gains `judgment_ids` too. A proposal's `evidence` is now the
  `ProposalEvidence` model, with `judgment_count` beside `judgment_ids`. The
  create body's `Evidence1` is unchanged.
- `kindgi`: **a proposal says how it was kept, what the replays cost and
  which decisions held.** A proposal's `evaluation` gains `rule` (`better` or
  `cheaper`), `cost_usd` (`ProposalCost`) and `decisions`
  (`ProposalDecisions`). A proposal kept as `cheaper` is `evaluated` with
  `better` false. A judged comparison's summary gains `cost_usd`
  (`JudgedComparisonCost`), and each case result gains `cost_usd`, one per
  repetition.
- `kindgi`: **`secrets.revoke`'s docstrings say what a hard revoke does**: it
  erases the value at Kindgi and hard-deletes it in a secret manager, and
  can't be undone; backups, and a secret manager's own retention, may keep
  copies for a time. They no longer call it cryptographic erasure.
- `kindgi`: **a tool's `needs_spec` is checked, and a test can fill its
  `env`.** `@tool(..., needs_spec=...)` is refused at definition
  (`DefinitionError`) when a schema under `env` or `secrets` doesn't compile
  as the runtime compiles it (it isn't valid Draft 2020-12, or it or a schema
  inside it has a keyword or a `format` the runtime doesn't know, a misspelled
  one say, or a `$ref` that points nowhere), or an `env` default isn't a
  string (`None` included).
  `ToolContext.for_test(tool=...)` builds a context whose `env` is what the
  tool declares under `needs_spec["env"]` — each name from the `env=` you pass
  or its schema's string default, checked against its schema — so a handler
  test resolves env the way the runtime does; names the tool doesn't declare
  are dropped and `secrets=` pass through.
  Matches the TypeScript `@kindgi/tools` definition check and test context.
- `kindgi`: **a tool's schema given as a dict is checked when the tool is
  defined.** `@tool(input={...}, output={...})` and `http_tool` raise
  `DefinitionError` when the runtime would refuse the schema (it isn't valid
  JSON Schema Draft 2020-12, or it has a keyword or a `format` the runtime
  doesn't know, or a `$ref` that points nowhere), the check `needs_spec`'s
  schemas get. Before, such a schema reached the pack index as written, and
  the deploy refused it (under `kindgi dev`, the tool's first call failed).
  Matches the TypeScript `@kindgi/tools` definition check.
- `kindgi`: **the definition check refuses what the runtime's strict
  compile refuses besides unknown names**, word for word as the runtime
  says it:
  - a keyword with no `type` it applies to (`minLength` with no
    `"type": "string"`, say), or a `type` its context can't be;
  - a `required` property nothing defines;
  - a `prefixItems` tuple without matching `minItems` and `maxItems`
    (or `items: false`);
  - `nullable` without a `type`;
  - `then`/`else` without `if`, and `minContains`/`maxContains` without
    `contains`;
  - an empty `enum`;
  - a format bound without a `format` it can compare;
  - a `patternProperties` pattern that matches a property `properties`
    also names;
  - a chain of `$ref`s that only leads back to itself.

  A corpus of schemas, with the runtime's answer to each, keeps the two in
  step.
- `kindgi`: **a pattern is checked as the runtime's JavaScript reads it.**
  When a tool is defined, a `pattern`, or a `patternProperties` pattern,
  that the runtime's `RegExp` refuses raises `DefinitionError` in the
  runtime's words (`Invalid regular expression: /(/u: Unterminated group`),
  in a schema given as a dict and in one derived from a model alike. Before,
  a dict's went by Python's `re` and a model's wasn't checked: a pattern only
  Python or pydantic reads, such as `(?P<name>…)`, reached the deploy, which
  refused it. In a dict, a pattern only JavaScript reads, such as `\p{L}`, is
  still refused, since the SDK checks data against it with Python's `re`. In
  a model, pydantic checks the data, and reads `\p{L}`. A `"format": "regex"`
  value is checked as the runtime checks it, too.
- `kindgi`: **`proposals.improve`'s docstrings say how a refusal names why an
  Improve run has nothing to work on**: a `validation-failed` error's
  `details.reason` is `no-tunable-keys` or, on the agent's instructions (the
  `prompt` tier), `no-pinned-prompt-block`.
- `kindgi`: **`refused_writes` and `max_refused_writes` say what they count:
  every tool call the replay refused, reads included.** The names don't
  change. `stopped` says "a refused tool call" where it said "a refused
  write".

## 0.1.10

No Python changes; the version moves with the npm packages.

## 0.1.10rc1

No Python changes; the version moves with the npm packages.

## 0.1.10rc0

- `kindgi`: **`system_keys.mint`, `list`, `revoke` and `whoami` say what a
  runtime serving one tenant answers.** Its own token mints, lists and revokes
  keys holding `system:license` alone, for the license renewal, and such a key
  reads the license and its use and nothing else.
- `kindgi`: **an agent's `conversation_policy` can't set
  `autoCloseAfterInactiveSeconds`.** It was accepted and never acted on: a
  conversation never closes by itself, only when someone closes it. The
  indexer refuses a pack whose agent sets it (`manifest-validation-failed`, at
  `/agents/<n>/conversationPolicy/autoCloseAfterInactiveSeconds`). The client's
  `ConversationPolicy` model loses `auto_close_after_inactive_seconds`.
- `kindgi`: **`projects.sites.restore_person` lets one of a site's people
  removed in Kindgi back in**, while the site still knows them: the same
  person, with their history. Their grants come back the next time the site
  signs them in. Refused (`site-person-restore-refused`) for someone who
  isn't removed, someone their site said left, and someone who also signs
  in another way. Tenant admins only.

## 0.1.9

No Python changes; the version moves with the npm packages.

## 0.1.9rc1

No Python changes; the version moves with the npm packages.

## 0.1.9rc0

- `kindgi`: **`deployments.pack_env` shows where each name a deployment's
  pack declares is set** (`project`, `org` or `tenant`) and why it can't be
  given to its pack service, if it can't, on a server that runs a pack
  service per deployment. Never a value. For whatever runs the pack
  services, on a `system:pack-env` key: `system_deployments.list_pack_env_changed`,
  `get_pack_env` and `record_pack_env`.
- `kindgi`: **`agents.get`, `flows.get`, `tools.get`, `eval_suites.get` and
  `blocks.get` take `project_id`**: for an item an environment order
  carries, the newest version that can run in that project, which the caller
  must read. Without it, the newest version the caller can see. An older
  runtime ignores it and answers the latest version.
- `kindgi`: **a deployment is promoted to the next environment of its
  environment order.** `deployments.promote` moves the same build, with the
  edits made since to its agents and flows. `deployments.promote_check`
  answers what would move and which values aren't ready in the target,
  writing nothing. `deployments.list` takes `project_id` and `pack_id`.
- `kindgi`: **`deployments.values.list(deployment_id, project_id=…)` lists
  what a deployment needs set in a project**, names only
  (`GET /v1/deployments/{deploymentId}/values`). Each `DeploymentValue` says
  what needs it, where a run finds it (`found_at`) and why it isn't ready
  (`problem`), never the value. Without `project_id`, it's the deployment's
  own project.
- `kindgi`: **a webhook or schedule trigger can run as a service account.**
  `run_as_service_account_id` on `webhooks.register`,
  `webhooks.take_ownership`, `schedules.register` and
  `schedules.take_ownership` names the service account whose grants the
  trigger's runs act with, rather than whoever registered it. Naming an
  account needs `act_as` on it, which tenant admins hold.
- `kindgi`: **`flows.get` and `flows.get_version` answer the flow, and
  `tools.get` and `tools.get_version` the tool.** They read each answer as
  another object that had taken the name `Flow` or `Tool` (a judged run's
  `flow`, an approval's `tool`), so a real flow or tool failed validation.
  Some model names in `kindgi.client.models` change with it, and no old name
  is kept:
  - **Same name, another model:** `Flow` is the flow (it was `Flow1`; the
    judged run's `flow` is `JudgedRunContextFlow`). `Tool` is the tool (it
    was `Tool1`; the approval's `tool` is `RunWaitingApprovalTool`).
  - **Gone, and their new names:**
    - `Scope2`, `Scope3`, `Scope4` (a secret's or an env var's scope: tenant,
      org, project): `ScopeTenant`, `ScopeOrg`, `ScopeProject`. An
      `isinstance` or `match` on the old names needs the new ones.
    - `Scope`: `JudgedComparisonSummaryScope`.
    - `Flow1`, `Tool1`: `Flow`, `Tool`.
    - `Flow2`, `Tool3`, `Agent1`, `Guardrail1`: `DeploymentContentsFlow`,
      `DeploymentContentsTool`, `DeploymentContentsAgent`,
      `DeploymentContentsGuardrail`.
    - `Tool2`: `ComparisonCaseResultTool`.
    - `CodeArtifactRef1`, `CodeArtifactRef2`: `CodeArtifactRefOci`,
      `CodeArtifactRefFilesystem`.
    - `ComparisonCandidate1`, `ComparisonCandidate2`:
      `ComparisonCandidateAgent`, `ComparisonCandidateFlow`.
    - `EnvSetOutcome1` to `3`: `EnvSetOutcomeOk`,
      `EnvSetOutcomeRevisionConflict`, `EnvSetOutcomeError`.
    - `HttpAuthSpec1`, `HttpAuthSpec2`: `HttpAuthSpecBearer`,
      `HttpAuthSpecHeader`.
    - `HttpRequestBodySpec1` to `3`: `HttpRequestBodySpecJsonInput`,
      `HttpRequestBodySpecInputPassthrough`, `HttpRequestBodySpecText`.
    - `JudgeClassScope1` to `3`: `JudgeClassScopeTenant`,
      `JudgeClassScopeProject`, `JudgeClassScopeAgent`.
    - `RecordedSecretScope1` to `3`: `RecordedSecretScopeTenant`,
      `RecordedSecretScopeOrg`, `RecordedSecretScopeProject`.
    - `SecretRotateOutcome1`, `SecretRotateOutcome2`: `SecretRotateOutcomeOk`,
      `SecretRotateOutcomeRotationPending`.
    - `SecretSetOutcome1` to `4`: `SecretSetOutcomeOk`,
      `SecretSetOutcomeAlreadyExists`, `SecretSetOutcomeVersionConflict`,
      `SecretSetOutcomeError`.
    - `WebhookSignature1`, `WebhookSignature2`: `WebhookSignatureHmacSha256`,
      `WebhookSignatureStandardWebhooks`.

  Every other name keeps its model, numbered ones (`Config1`, `Datum2`)
  included, and the client's generation now fails before a name could move
  to another model or vanish. (#916)

- `kindgi`: **`policies.versions.get` answers for a retired version too.** It
  returns a `PolicyVersionRow`, whose `unregistered_at` says when the version
  was retired; an active one has none. A retired version was
  `404 policy-not-found`, a `NotFoundError`; a version the retention sweep has
  purged still is. (#903)

- `kindgi`: **`@tool` and `http_tool` take `needs_approval_when_unattended`.**
  `True` makes each call of the tool wait for a person's approval in a run no
  person started (a webhook, a schedule, an event, or a service account's
  key). A flow's tool step that calls it is refused there. A run a person
  starts is unaffected. The pack's index carries it as
  `needsApprovalWhenUnattended`; left out, nothing changes.

- `kindgi`: **a response reads an enum value, or a union member, that this
  client doesn't know yet.** A newer runtime may add one. 0.1.8 failed the
  whole call with `invalid-response` (`system_keys.list()` with a new scope,
  `audit.sign_ins.list()` with a new kind), as the Java client never did.
  - Every enum a response carries is typed `Literal[...] | str`, one of a
    single value too (`TrustedSigningKey.algorithm`): a value it doesn't
    know comes back as its text.
  - Every union a response carries that a tag tells apart gains a member,
    `<Union>Unrecognized` (`LiveScopeUnrecognized`, `ScopeUnrecognized`, and
    18 more in `kindgi.client.models`), for a tag it doesn't know, with every
    field kept.
  - A stream event of a kind it doesn't know comes back as the typed event,
    not a `dict`. An event that doesn't match its schema is still a `dict`.
  - A request body stays closed. A value outside the known ones, or an
    `Unrecognized` member, is refused before sending, with the error it got
    before. So a value read from a newer runtime can't be sent back from this
    client.
  - A `const` stays closed: it only ever holds its one value. So do the tag
    a union picks its member by (`secrets.rotate`'s `kind` too, as
    `answer.kind == "async"` tells its two answers apart), and
    `webhooks.parse_event`: an endpoint gets only the event types it
    subscribes to.
  - Code that matches every known value (`assert_never`) now has the `str`, or
    the `Unrecognized` member, to handle.

## 0.1.8

No Python changes; the version moves with the npm packages.

## 0.1.8rc0

- `kindgi`: **a sign-in session carries the capabilities its person holds.**
  `identity.me.permissions()`'s `token_capabilities` for a sign-in session
  were always empty. Now they're its person's: none, unless the runtime gives
  them some, as it gives a tenant's first admin every capability but
  `secrets:reveal`. (#893)
- The CLI, for a Python pack: **a stored API key goes only to the address it
  was stored for** (by `kindgi auth login`, or in `kindgi dev`'s
  `.kindgirc.json`). A `--url`, `KINDGI_API_URL` or environment `endpoint`
  that names another address is refused. The comment on
  `[tool.kindgi.environments.<name>]` in the Python template's
  `pyproject.toml` says so. (#889)
- `kindgi`: **`secrets.list` takes `include_revoked`.**
  `include_revoked="true"` lists revoked secrets too, with when and why each
  was revoked (metadata only, never a value). A runtime before 0.1.8 ignores
  it. `kindgi dev`'s secret store pages (`limit`, `cursor`), so a 26th secret
  is no longer left out. (#885)
- `kindgi`: **`runs.journal` pages when asked.** It takes `limit` (1 to 100)
  and `cursor`, and the page says `has_more` and `next_cursor`. Without
  `limit`, the whole journal is one page, as before; a runtime before 0.1.8
  answers it whole either way. (#882)
- `kindgi`: **a secret name the file-backed store can't write is the
  caller's error.** The store `kindgi dev` uses writes only names of capital
  letters, digits and underscores, not starting with a digit
  (`^[A-Z_][A-Z0-9_]*$`), and not `KINDGI_*`; another name is
  `400 secret-name-invalid` (an `InvalidRequestError`), with a name to use
  when there is one, and a name starting `kindgi.` is
  `400 reserved-name-prefix`. Both were `500 secret-store-error`, a
  `ServerError`. `webhooks.register` with `generate_secret` checks the name
  before it registers the trigger. (#853)
- The CLI, for a Python pack: **Kindgi's skills go to `.agents/skills/` too**,
  the folder Codex and Gemini CLI read, as well as `.claude/skills/`
  (`kindgi init` and `kindgi skills sync`). The Python pack's `AGENTS.md` and
  `kindgi-python-getting-started` address any coding agent. (#852)
- `kindgi`: **a delivery or fire skipped for a suspension or a close says
  so.** `WebhookReceipt.skipped` can be `tenant-suspended` or
  `project-suspended`, besides `paused`: the delivery was taken and dropped,
  and nothing was recorded. A closing tenant's delivery is
  `409 tenant-closing`. A `ScheduleFire` or `WebhookFire` whose `outcome` is
  `skipped` names `project-suspended`, `tenant-suspended` or `tenant-closing`
  in its `detail`. For a schedule, such a fire neither counts toward the
  auto-pause nor resets its count of fires in a row. (#836, #840, #848)
- `kindgi`: **a guardrail scoped to flows applies in its flows' steps.** A
  guardrail with `scope: {flows: [...]}` was skipped on every agent turn, a
  `halt` guardrail too. A turn's trace now names the flow whose step started
  it (`RunTrace.flow_id`) when one of its guardrails is scoped to flows.
  (#844)
- `kindgi`: **`license.usage(since=...)`** says how much the deployment was
  used since a time (`LicenseUsage`: `runs`, `people`,
  `projects_in_production`, `since`, `until`, `runtime_version`), counts only:
  what a free license key's renewal carries. Only the deployment's own token,
  or a system key holding `system:license`, reads it. (#832)
- `kindgi`: **a runtime serving many tenants.** `system_keys` (`list`, `mint`,
  `revoke`, `whoami`), `system_tenants` and `system_deployments` manage
  tenants and deployments with a system key, and `projects.production.set`
  puts a project in production. A turn that a template's or tenant's budget
  refuses fails with `rate-limit-exceeded`. (#828)
- The CLI, for a Python pack: **the no-model line says what agents do without
  a model.** In an existing Python app, `kindgi init`'s next steps say agents
  give placeholder replies under `kindgi dev` until you connect a model, with
  the guide's link. (#826)
- `kindgi`: **a request body has limits.** A body over the runtime's
  `requestMaxBytes` (2 MiB hosted, 10 MiB self-hosted) is
  `413 request-too-large`, an `InvalidRequestError` with
  `details["maxBytes"]`, and JSON nested too deeply is refused. (#746)
- `kindgi`: **`kindgi.log` masks a Kindgi token whose kind has three
  letters** (`kgi_lrk_…`, the license renewer's key), as it masks those with
  two. (#682)
- Skills for coding agents in Python packs: `kindgi-python-authoring-tools`
  says an HTTP tool's deadline, cancel and 10 MiB cap cover the response.
  (#681)

## 0.1.7

No Python changes; the version moves with the npm packages.

## 0.1.7rc0

- `kindgi`: **a key can't mint a key that outlives it.** A key that expires
  mints only keys that expire no later than it; a later expiry is
  `403 token-expiry-exceeds-minter`, with the latest allowed time in
  `details["latestExpiresAt"]`. A console session opened by
  `auth.token_sign_in` mints as the key it was opened with
  (`401 auth-revoked` once that key is revoked). (#675)
- Skills for coding agents in Python packs: **`kindgi-using`**, named in the
  Python pack's `AGENTS.md` template: the coding agent guides a person in
  using what was built, read-only, with the CLI's answer and the console page
  that shows the same. (#620)
- `kindgi`: **`webhooks`, webhook triggers**: a signed request from
  WooCommerce, Drupal's Webhooks module, GitHub, Shopify or a Standard
  Webhooks sender starts a flow run. `register`, `list`, `get`, `update`,
  `pause`, `resume`, `unregister`, `fires` and `take_ownership`. (#619)
- `kindgi`: an MCP endpoint signs in with basic auth or OAuth client
  credentials (`MCPBasicAuth`, `MCPOAuth2ClientCredentialsAuth`);
  `license.get` reads the license's status (`LicenseStatus`); a judging
  rule's results count the runs their judgments come from; and a cursor a
  list didn't issue is a 400 on the versions and promotions lists. (#619)
- The CLI, for a Python pack: **one `kindgi dev` per pack.** A second refuses
  with exit code 3 and says where the first is (pid, since when, the console
  and API URLs; with `--json`, `{"running": {...}}`). It used to take over
  the first one's runtime container and rewrite `.kindgirc.json`. A lock left
  by a crash is taken over. `kindgi-python-getting-started` says so. (#573)

## 0.1.6

No Python changes; the version moves with the npm packages.

## 0.1.6rc0

- `kindgi`: **Security: `kindgi[verify]` requires `cryptography` 50.0.0 or
  later**, with no upper cap. It required `cryptography>=42,<47`, which held
  an app below the fixes for GHSA-537c-gmf6-5ccf, CVE-2026-69249,
  CVE-2026-69248 and CVE-2026-69247. `kindgi.exports` works unchanged. (#626)
- `kindgi`: **judging rules and the judging queue**: `projects.judging_rules`
  and `projects.judging_queue`. With them, `runs.failures` groups a
  project's failed runs by cause and version; `teams.project_grants`,
  `projects.team_grants` and `projects.access` give and read teams' roles on
  a project; `identity.users.list(include="grants")` lists each person's
  grants; and `guardrails.outcomes` reads a guardrail's outcomes, passes
  included. Agents, flows, tools, test sets and guardrails say which project
  they're in, and retired ones can be found and brought back. A project role
  `member` is refused on writes: give `viewer`. (#582)
- `kindgi`: **two model-provider key codes are classified:**
  `provider-key-refused` is an `InvalidRequestError` and
  `provider-key-in-use` a `ConflictError`. Reinstating a tool version that
  declares a model provider's key is refused. (#581)
- `kindgi`: **`auth.login` and `auth.callback` are gone**, with the API's own
  OAuth sign-in flow; sign in with `auth.sign_in_options`,
  `auth.token_sign_in`, `auth.refresh` and `auth.logout`. The
  `event_triggers` and `webhooks` resources are gone too: the runtime doesn't
  serve event triggers or inbound webhooks. New: `identity.me.permissions()`
  says what the caller may do, in one call; `audit.sign_ins.list()` reads a
  tenant's sign-in history (tenant admins); `eval_runs.rescore` and
  `proposals.rescore` score again; and `kindgi.webhooks.parse_event` also
  returns an `ApprovalRequestedEvent` (`approval.requested`). (#572)
- The CLI, for a Python pack: **`kindgi dev` runs the pack's code
  sandboxed.** It can't read the home folder's keys and cloud credentials,
  secret files (`.env*`, `.kindgi`, `.npmrc`, `.pypirc`, `.netrc`), the
  Docker socket or other UNIX sockets. It keeps the app (read and write), the
  runtime and dependencies (read), the network and its own temp folder.
  `kindgi-python-authoring-tools` describes it. (#562)
- `kindgi`: **`ctx.idempotency_key`**, the same every time a tool call runs
  (resumed, retried, or run again after a crash) and different for every
  other call, so a tool that writes can dedupe on it. A UUID; `None` from a
  runtime before 0.1.6. (#557)
- `kindgi`: **`Kindgi()` and `AsyncKindgi()` find their settings on first
  use**, not when created (`KINDGI_API_URL`, `KINDGI_API_TOKEN`, or the
  running `kindgi dev`). A module-scope `kindgi = Kindgi()` no longer raises
  at import, so a build step that imports the app (Django's
  `collectstatic`, a Docker build running `manage.py`) works. Settings still
  missing raise the same `ValueError` at the first request, or on reading
  `base_url` or `token`. (#555)
- `kindgi`: **only the names a pack declares reach its code.** The Python
  pack service drops every environment variable the pack doesn't declare,
  keeping `KINDGI_*` and the platform's, before the pack's code loads. It
  logs the dropped names (`env-dropped`), never their values.
  `KINDGI_PACK_ENV_FILTER=off` keeps every variable (`kindgi dev` sets it);
  a value other than `on` or `off` fails the start with `config-invalid`.
  (#551)
- The CLI, for a Python pack: **`kindgi init` keeps coding agents away from
  the files that hold keys.** It merges `Read(...)` deny rules for `.env*`,
  `.kindgi/secrets.env`, `.kindgi/dev/runtime.env`, `kindgi.env` and
  `pack.env` into `.claude/settings.json`, never overwriting it, and adds
  them to a `.cursorignore`, `.geminiignore` or `.aiderignore` that already
  exists. `kindgi-python-getting-started` says so. (#544)
- `kindgi`: **the indexer warns when a guardrail's check id doesn't start
  with the pack's id** and a dot. Packs in one tenant share one space of
  check names. It's a warning only: the pack builds and indexes as before,
  and `kindgi build` and `kindgi dev` print it. (#500)
- `kindgi`: **a tool's secret can be optional.** A `needs_spec` secret whose
  schema allows null (`{"type": ["string", "null"]}`) is left out of
  `ctx.secrets` when the env doesn't have it, and the call goes on. A runtime
  before 0.1.6 still fails the call with `secret-unavailable`. (#478)
- `kindgi`: **`secrets.rotate` reads an async rotation.** A `202` answer
  (`kind: "async"`, with the rotation's id and its status and events URLs)
  raised `invalid-response`, because every answer was read as the sync
  model. It now returns
  `SecretRotateResponseSync | SecretRotateResponseAsync`, picked by status:
  tell them apart by `kind == "async"` or `isinstance`. (#315)

## 0.1.5

- Skills for coding agents in Python packs: `kindgi-python-authoring-tools`
  covers a mutating tool's writes effect, logging from a tool (`ctx.log`)
  and tests beside the tool. (#512)
- The CLI, for a Python pack: in an existing Python app, `kindgi init`'s next
  steps say agents answer with the dev-echo fallback (canned replies) until a
  provider is registered. (#511)
- `kindgi`: **`cost.aggregate` across projects counts only the projects the
  caller may read**, and records with no project. Any tenant member saw every
  project's spend; a tenant admin still sees all. (#505)
- `kindgi`: **`same-user` memory needs the run's end user.** A run that named
  no end user (`participant_id`) read and kept `same-user` memory as the user
  its key acts for, so one key serving many customers shared memory across
  them. A `same-user` retrieval in a run that names no end user is now
  skipped (the pass records
  `degraded: [{intent, reason: "no-participant"}]`). Pass the end user as
  `participant_id` when you start the run. It applies with a runtime from
  0.1.5 on. (#501)

## 0.1.5rc0

- `kindgi`: **a pack can't ship its check under a built-in check's id**
  (`must-cite`, `never-call-tool`, `max-tool-calls`, `output-matches`,
  `tool-order`, `required-substring`, `forbidden-substring`). The runtime
  runs the built-in for a guardrail naming one, so the pack's check would be
  silently replaced. `kindgi.pack.define.RESERVED_CHECK_IDS` lists them, and
  defining one is a `DefinitionError` that says to rename the check. A
  guardrail that names a built-in is fine. (#460)
- Skills for coding agents in Python packs: `kindgi-python-authoring-agents`
  covers memory, recall and erasure, and `kindgi-python-authoring-guardrails`
  the built-in checks: how to name one and each one's config. (#439, #459)
- `kindgi`: **memory facts and erasure.** A fact keeps its id across
  revisions (`memory.get_fact`, `memory.supersede_fact`,
  `memory.verify_fact`; `FactRevisionList`, `FactSubject`), and every memory
  read sees only what the caller may read. `memory.create_erasure(...)`
  erases one fact, one conversation or a person, with a ledger that holds no
  content. An agent's retrieval can read the person's earlier conversations.
  (#258, #419)
- `kindgi`: **improvement proposals and passes.** A proposal changes data
  blocks (`ProposalChange`, `ProposalCandidate`), `proposals.improve` starts
  an improvement pass, and `improvement_passes` (`list`, `get`, `cancel`)
  reads and stops them (`ImprovementPass`, `ImprovementBudget`). (#240, #417)
- `kindgi`: **sign-in.** `auth.sign_in_options` lists a deployment's ways in,
  its own included. An identity provider is `oauth2`, `oidc` or `saml`, set
  up from its side first (the redirect URI or ACS URL comes before
  registration) and changed in place. `auth.token_sign_in()` exchanges an API
  token for a console session that keeps the key's scopes. A domain routes
  sign-in only once it's verified. (#310, #343, #353, #362, #382, #409)
- The CLI, for a Python pack: the Python pack's README matches `kindgi init`,
  its commands under the right runner (`uv run kindgi …`). (#397)
- `kindgi`: **an idempotency key is held while its request runs, and belongs
  to its caller.** A repeat while the first is in flight is
  `409 idempotency-key-in-flight`, so another client's own retry no longer
  starts a second run. Another caller with the same key no longer gets the
  first caller's answer, and an answer that holds a secret (a new API key or
  session token) isn't kept (`idempotency-key-replay-withheld`). (#348, #395)
- `kindgi`: **`kindgi.log`**, Kindgi's structured logger on the standard
  library, writing the same records as `@kindgi/log`:
  `get_logger(subsystem, **bindings)`, `create_logger`, `logger_from_env`
  and `configure()`, set by `KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and
  `KINDGI_LOG_FORMAT`. Levels inherit by dotted name, with `TRACE`; JSON and
  pretty formats; redaction by key and by value; `parse_traceparent` and
  `child_span`; and `JsonFormatter` and `PrettyFormatter` for an app's own
  `logging`. The Python pack service writes its records with the call's ids,
  and a tool logs beneath its call with `ctx.log`
  (`ctx.log.info("looked up order", order_id=…)`). `ToolContext.secrets` is
  left out of the context's `repr`, so printing a context never shows a
  secret. (#388)
- `kindgi`: a provider or MCP endpoint registration can opt in to receive the
  run's `traceparent` (`send_traceparent`); it's off by default. (#378)
- `kindgi`: **every 409 is a `ConflictError`**, including a code the client
  doesn't list, such as `run-lease-lost` or `agent-version-mismatch`; 20 of
  the 60 documented 409 codes were a `ServerError`. Match on `server_code`,
  which every error carries. The client's code list is held to the API's
  own. (#371)
- `kindgi`: **signed exports verify.** `kindgi.exports.verify_signed_export`
  checks an approval's audit bundle, a run's provenance or compliance
  evidence (Ed25519 or ECDSA) and returns a `SignedExportVerification`
  (`valid`, `reason`, `body`), optionally against `trusted_keys`;
  `export_signing_keys.list()` lists the export keys. It needs the `verify`
  extra: `pip install 'kindgi[verify]'`. An audit bundle made by an app
  embedding `@kindgi/api` 0.1.4 verifies too. (#271, #355)
- `kindgi`: **people in a tenant.** `identity.users.unregister(user_id)`
  removes a person, revoking their keys and sessions and removing their
  grants and memberships (tenant admins only). The people list is a tenant
  admin's (`403 permission-denied` for anyone else), and a member is added
  by email or id. (#311, #354)
- `kindgi`: a guardrail registration whose config its pack check would refuse
  is refused up front. (#318)
- `kindgi`: **`runs.follow(run_id)` and `runs.follow_progress(run_id)`**, sync
  and async, follow a run to its end. The server ends a stream after the
  terminal event or after 5 minutes; these reconnect with `Last-Event-Id`
  until `run.completed`, `run.failed` or `run.cancelled`, each event once.
  `runs.stream` stays the plain call, which ended early for a run longer than
  5 minutes, such as one waiting for an approval. (#316)
- `kindgi`: **the pack service checks a `check-invoke` config as sent**, with
  no defaults filled in, and refuses a guardrail whose `configSchema` doesn't
  compile, as it refuses a tool's input schema. A config that doesn't fit is
  `input-validation-failed`, with `checkId` and `issues`, and the check
  doesn't run; the TypeScript pack service now does the same. (#314)
- `kindgi`: **a provider registration the runtime couldn't build is refused
  when registered**, naming the setting. `providers.check` runs the same
  check on a registered provider (`ProviderCheckResult`,
  `AdapterConfigProblem`). (#301)
- `kindgi`: **agents can remember.** `Agent(memory=...)` with
  `{"remember": {"types": [...], "scope": "same-user", "keepDays": 30}}`
  gives the agent's turns the built-in tool `kindgi_remember`, under rules
  the declaration fixes and the model can't change; `scope` is `same-user`,
  `same-conversation`, `same-project` or `tenant`. Retrieved memory enters
  the prompt as labelled data, and `{"instructionTypes": ["policy"]}` makes a
  verified fact of those types an instruction. (#266, #277)
- `kindgi`: **a failed run carries its reason as data**: `Run.failure`
  (`RunFailure`: `code`, `message`, `cause`), so a caller needn't parse
  `failure_message`. (#275)
- `kindgi`: an artifact belongs to a project (`project_id` on upload and on
  the record), and `capabilities` reads the capability catalog. (#256)
- `kindgi`: **a replay sends a read-only tool the env values its past call
  saw** (`tool_env` on the replay record), so a changed value doesn't look
  like a difference between versions. (#246)
- `kindgi`: **`ctx.env`, per project.** A tool that declares env names in
  `needs_spec={"env": {...}}` gets their values per call: the project's
  value, else the org's, else the tenant's. A runtime before 0.1.5 leaves
  `ctx.env` empty. `kindgi-python-authoring-tools` describes it. (#243)
- `kindgi`: **API keys for people and service accounts.** `tokens.mint` takes
  `for` (`MintTokenBody.for_`), the person or service account the key acts
  as, by default the caller; token records carry `principal`; and
  `service_accounts` manages service accounts. (#241)
- `kindgi`: **schedules** run an agent or a flow as their owner, with
  catch-up, overlap, history and run-now: `schedules` (`ScheduleRecord`,
  `ScheduleFire`, `TriggerOwner`), with `fires`, `run_now` and
  `take_ownership`. (#239)
- `kindgi`: a run a trigger started says which, and by which fire
  (`RunTrigger`: `trigger_id`, `kind`, `fire_id`). (#236)

## 0.1.4

- `kindgi`: **a waited `runs.start` is never sent twice.** One that took
  longer than the client's timeout (60 s by default) was sent again with the
  same idempotency key, so the runtime could start the run up to three
  times. Now a call other than a GET is sent again only when nothing can
  have run: a failure to connect, a connect or pool timeout, a 429 or a 503.
  A read timeout, a dropped connection, or a 502 or 504 is raised at once. A
  waited `runs.start` that times out raises a `NetworkError` that says the
  run may still be going, to start it with `options={"wait": False}`, and to
  follow it with `runs.stream` or `runs.get`; `NetworkError.timeout` is the
  timeout in seconds. (#335)
- `kindgi`: **`ModelInfo.sampling` and `ModelInfo.thinking`**
  (`ModelThinking`): `sampling` is false for a model that takes no sampling
  settings. A model that rejects `temperature` no longer fails the call, and
  a guardrail judge on a thinking model still gets its verdict. (#299)
- `kindgi`: a provider registration takes `default_model`, the model that
  comes first within the provider when nothing else ranks. (#296)

## 0.1.4rc5

- Skills for coding agents in Python packs: `kindgi-python-getting-started`
  and `kindgi-python-authoring-agents` describe the dev-echo warning and the
  one-key presets for OpenAI, Gemini, Groq and OpenRouter. (#280)
- The CLI, for a Python pack: **the echo agent from
  `kindgi init --template=python` names its tools by what they do** ("greet
  them with the greet tool"), not by id: a model sees a tool id with `.`
  rewritten to `__`. `kindgi-python-authoring-agents` says the same. (#278)
- `kindgi`: **an id parameter takes `str | UUID`**, and a list of them
  `list[str | UUID]`: every parameter named `…_id` or declared as a UUID. The
  models carry ids as `UUID`, so `kindgi.runs.get(run.id)` now type-checks
  under pyright and mypy; it always worked at runtime. (#276)
- `kindgi`: **`Run.trace_id`**, and the pack service takes pack protocol
  2.4.1's optional `traceparent` header. Both are optional, so an older
  runtime keeps working. (#257)

## 0.1.4rc4

- The CLI, for a Python pack: **the `dev-echo` fallback says it isn't a
  model.** A text answer starts with one warning line, and the result carries
  `warnings: [{code: "dev-echo-not-a-model", ...}]`; typed and structured
  outputs stay plain JSON. The Python pack's README and `AGENTS.md` templates
  point to the one-key presets for more model providers. (#255)
- Skills for coding agents in Python packs: **the five Python skills start
  from `kindgi-cli` on PyPI**, with no Node:
  `uvx --from "kindgi-cli>=0.1,<0.2" kindgi init <name> --template=python`,
  then `uv run kindgi <command>`. (#254)
- `kindgi`: **a gate policy can't leave a gated scope unpinned.** A gate
  policy for a scope that only follows a pin above it is refused
  (`409 gate-policy-scope-unpinned`), and a promotion, rollback or unpin that
  would leave a narrower gated scope on another version is refused with the
  new `409 gate-policy-descendant-unpinned`, a `ConflictError`. (#247)

## 0.1.4rc3

- `kindgi`: **`approvals.list` takes `wait_token_id`**, a list of up to 50
  run-wait tokens: only the approvals linked to those waits. A runtime that
  doesn't apply the filter answers the others too. (#226)
- `kindgi-cli`: first release. The Kindgi CLI on PyPI, so a Python developer
  needs only Python, uv and Docker, no Node:
  `uvx --from kindgi-cli kindgi init my-pack --template=python`, then
  `uv sync` and `uv run kindgi dev`. The wheel carries `@kindgi/cli` of the
  same version, with Node from `nodejs-wheel-binaries`. Under it, the CLI's
  hints say `uv run kindgi …` (`poetry run kindgi …` in a Poetry project),
  `kindgi init --template=python` lists `kindgi-cli` in the pack's dev group,
  and in an existing app the next steps give the `uv add --dev`,
  `poetry add --group dev` or `pip install` line. It refuses a TypeScript
  pack, naming the npm CLI. `kindgi doctor` passes Node as bundled and skips
  npm. (#89)

## 0.1.4rc2

- `kindgi`: **live agent versions per scope, and promotions.** `agents.live`
  (`resolve`, `list`, `rollback`, `unpin`) and `agents.promotions` say which
  agent version is live in a tenant, an org, a project, or a segment path
  inside a project (`LivePin`, `LiveVersionResolution`). A segment path is
  ordered steps, each a dict or a `ScopeSegment`:
  `segments=[{"key": "company", "value": "acme"}, ...]`. A comparison's live
  baseline names its segments the same way. (#105, #214, #216)
- `kindgi`: **a judge class can be restricted** with `assertable_by`: a
  minimum reviewer role, principal kinds or principal ids. A judgment from a
  caller who doesn't meet it is `403 judge-class-not-allowed`. A gate
  policy's comparison can count restricted classes only
  (`only_restricted_classes`). (#210)
- `kindgi`: **promotions go through a gate policy.** `gate_policies`
  (`publish`, `list`, `get`, `versions`) holds the checks a promotion must
  show (`GateCheck`, `GatePolicyRef`, `GateApproval`). A gated scope always
  resolves to a pin: `gate-policy-scope-unpinned` and `gate-policy-needs-pin`
  are new conflicts. A refused promotion is recorded as evidence of kind
  `agent-promotion-refused`. (#200, #204, #207)
- `kindgi`: **unregistering an agent version that's live in a scope is
  refused** with `409 agent-version-live`, a `ConflictError` whose details
  list the scopes it serves. (#202)
- `kindgi`: a flow step that runs the agent version its flow version holds
  records `via: "flow-pin"`, not `"explicit"`. (#201)
- `kindgi`: **an error code the client doesn't list is read by its HTTP
  status**: 404 and 410 are a `NotFoundError`, 401 and 403 an `AuthError`,
  429 a `RateLimitedError`, 400 an `InvalidRequestError`, and so on, so a
  newer server's code is no longer a `ServerError`. A 409 or 422 with an
  unlisted code stays a `ServerError` in this release. (#198)
- `kindgi`: **the retention routes**: `retention.scheduled` (paged with
  `cursor`, answering `has_more` and `next_cursor`), `retention.sweep` and
  `retention.sweep_domain` (`RetentionSweepResult`,
  `RetentionScheduledPage`). A retention policy is checked when published,
  one per domain: a bad one is `400 validation-failed`, naming the field.
  (#162, #196)
- `kindgi`: `audit.authz.list` takes `order="asc"` or `"desc"`. (#194)
- `kindgi`: `observations.list` takes the filters the route already read:
  `agent_version`, `conversation_id`, `since` and `until`. (#185)
- `kindgi`: **every list answer has `data`, `has_more` and `next_cursor`**,
  and `paginate` and `apaginate` work out `has_more` from the cursor when an
  older server leaves it out. They failed on those lists. (#181)
- `kindgi`: `eval_suites.unregister(suite_id, version)`, as
  `agents.unregister`, beside `eval_suites.versions.unregister`. (#176)
- The CLI, for a Python pack: on macOS, a pack's watchers share one watch, so
  `kindgi dev` stops in about a second instead of up to 30 s. (#175)
- `kindgi`: `conversations.list` leaves out a comparison's replay
  conversations; `replays="include"` or `"only"` changes that (the default
  is `"exclude"`). (#164)
- `kindgi`: **a decision says how its run went on.** When deciding an
  approval resumes the run, the answer's `resume` is `ok`, or `failed` with
  the run's error (such as `tool-version-unresolvable`); the decision stands
  either way. A run that couldn't go on used to stay `running`. (#158)

## 0.1.4rc1

- `kindgi`: **a comparison's result is typed.** `comparison_of(run)` in
  `kindgi.client` returns an eval run's `JudgedComparisonResult` (summary,
  metrics, per-case results), or `None` (`ComparisonMetric`,
  `ComparisonCandidate`). (#146)
- `kindgi`: **a write to a read-only registry is `409 registry-read-only`**,
  a `ConflictError`: under `kindgi dev`, the pack's files are the source. A
  write used to say an agent was already registered, and an unregister said
  "not found". (#140)
- `kindgi`: **a flow comparison can run some of the flow's agents or tools at
  other versions** without publishing a flow version: the start body takes
  `versions` (agents and tools by id, each to an exact version;
  `FlowVersionOverrides`), kept in the run's `comparison.versions`. (#138)

## 0.1.4rc0

- `kindgi`: **data blocks**, versioned prompt templates and settings: `blocks`
  (`publish`, `get`, `list`, narrowed by `scope_kind` and `scope_id`) and
  `blocks.versions` (`list`, `get`, `unregister`, `reinstate`), with `Block`,
  `PublishBlockBody`, `PromptBlockContent` and `SettingsBlockContent`.
  (#123, #136)
- `kindgi`: `agents.derive_version(...)` publishes a new agent version from
  an existing one with other prompt or settings block pins
  (`DeriveAgentVersionBody`, `AgentPinSwaps`). (#132)
- `kindgi`: **an `Agent` takes its prompt and settings from data blocks.**
  `instructions` takes a string or
  `{"prompt": "<block id>", "version": "<range>"}`, and
  `settings=[{"id": ..., "version": ...}]` and
  `model_settings={"id": ..., "version": ...}` name settings blocks. The
  block versions are pinned when the agent version is published. A tool
  reads the settings its calling agent version pins as
  `ctx.settings["<block id>"]`; a runtime on a pack protocol before 2.4.0
  sends none, so `ctx.settings` is empty there. (#127)
- `kindgi`: **comparison eval runs.** An agent version runs on a test set
  beside the recorded runs, replayed without repeating their side effects,
  and is scored against the judgments (`EvalComparison`, `EvalBaseline`). A
  flow version can be the candidate too: each case replays the past flow
  run's input and stops at a write the past run didn't do. A judged flow run
  keeps its tool calls, with results, in the test-set item's
  `context.flow`. (#121, #122, #124)
- `kindgi`: **unregistering a version stops it being chosen, not the pins
  that hold it.** A new run naming it is refused, while a resumed run and a
  published version that pins it still run it. Agent and flow versions carry
  `unregistered_at`. (#116)
- `kindgi`: **a version pins what it uses when it's published.** An agent
  version carries a lockfile of the tool, prompt and settings versions it
  uses (`pins`, `pins_digest`), and a flow version its agent and tool
  versions (`FlowPins`). `pins_digest(pins)` in `kindgi.client` gives the
  `sha256:…` string the runtime computes: two versions with the same digest
  run the same blocks. A deploy whose agent version is already registered
  with other pins or content registers the next free version in its line
  instead of changing the old one (`PinChange`, `VersionDerivation`).
  (#112, #113, #114)
- `kindgi`: **deleting an org leaves a tombstone.** Its projects and teams
  remain without an org, and its secrets are deleted with it. `org` is a
  retention domain. (#106)
- `kindgi`: **`cost.aggregate` takes `limit`** (1 to 10000, default 1000):
  groups come most expensive first, and the answer says `truncated` and
  `total_groups`. Both are optional, so the client still reads an older
  runtime's answer. (#104)
- `kindgi`: a provider registration takes `labels`, string keys to string
  values (at most 32 keys), for bookkeeping; the router ignores them.
  `provider` is a retention domain. (#103)
- `kindgi`: **test sets built from judgments**:
  `eval_suites.build_from_judgments` and `eval_suites.list_cases` create and
  read a `judged` test set from an agent's or flow's judged runs
  (`JudgedEvalCase`). (#102)
- `kindgi`: **a pack serves several versions of one tool side by side.** The
  pack index and `python -m kindgi.pack serve` key tools by id and version,
  and a call names the version it wants. Two files that define the same id
  and version are still a pack error. (#96)
- `kindgi`: **judgments and judge classes**: a yes or no, with a reason,
  about one item of a finished run's output, under a judge class that can
  carry a weight. `judgments` and `judge_classes`, with `JudgeClass` and
  `JudgedItem`. (#92)
- The CLI, for a Python pack: `kindgi dev`'s watchers also scan behind
  `fs.watch`, so an edit whose file event macOS dropped is still picked up
  and the pack reloads. (#84)
- `kindgi`: **publishing a policy of a kind no runtime part applies is
  refused**: `access-control`, `adapter-allowlist`, `rate-limit` or
  `compliance` is `400 kind-not-applied`, with `details["appliedKinds"]`. It
  was accepted and changed nothing. (#81)
- `kindgi`: **a duplicate org, team or project slug is
  `409 slug-conflict`**, a `ConflictError` with
  `server_code == "slug-conflict"`; it was a `500`, a `ServerError`. A
  project's slug is unique within its org, not across the tenant, and
  deleting an org whose projects' slugs would clash answers the same
  conflict, with the slugs in `details`. (#74, #77)

## 0.1.3

- `kindgi`: first release. Tools, guardrail checks, agents and flows in
  Python 3.11 or later: `@tool` (schemas from `input=` and `output=`, or from
  annotations: pydantic models, `TypedDict`, dataclasses), `@guardrail`,
  `http_tool(...)` for a tool that is one HTTP request, and `Agent(...)` and
  `Flow(...)` declared as data beside them. The pack's id and version come
  from `[tool.kindgi.pack]` in `pyproject.toml`, and its files are found by
  folder (`tools/`, `agents/`, `flows/`, `guardrails/`) or by
  `[tool.kindgi.discovery]` globs. A handler (`def` or `async def`) gets a
  `ToolContext`: the call's ids, `ctx.secrets` (declared with `needs_spec`)
  and `ctx.cancellation`.
- `kindgi`: the pack service. `python -m kindgi.pack index` writes the pack's
  index and `python -m kindgi.pack serve` runs its code over pack protocol
  v2, passing the shared conformance suite; `kindgi dev` does both and
  reloads on save. It checks the env names `[tool.kindgi.env]` declares when
  it starts (`KINDGI_PACK_ENV_CHECK=strict` or `warn`).
- `kindgi`: `kindgi.client`, a typed client for every operation of the
  Kindgi API, generated from its OpenAPI description: `Kindgi()` and
  `AsyncKindgi()` (settings from `KINDGI_API_URL` and `KINDGI_API_TOKEN`),
  pydantic models, `paginate` and `apaginate`, `runs.stream` for a run's
  events, an automatic `Idempotency-Key`, and retries (`max_retries=2`,
  honouring `Retry-After`). Its errors are `KindgiApiError`s
  (`NotFoundError`, `ConflictError`, `InvalidRequestError`,
  `GuardrailViolationError`, `AuthError`, `RateLimitedError`, `ServerError`,
  `NetworkError`) with `status`, `server_code`, `details` and `request_id`.
- `kindgi`: `kindgi.webhooks`: `verify` and `parse_event` check a Standard
  Webhooks signature, secret rotation included, on `run.finished` and
  `webhook.test`; `sign`, `signed_headers` and `generate_secret` help test a
  receiver. `RunTrace` and its records (`CheckResult`, `ModelCallRecord`,
  `ToolCallRecord`, `ToolResultRecord`) unit-test a guardrail check; tools
  and guardrails stay plain callables.
