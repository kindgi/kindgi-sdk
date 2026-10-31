# @kindgi/guardrails

## 0.3.0

### Patch Changes

- 8dd91b0: **A `retry` guardrail sends a failed answer back to the model, for a new one.** Before, `on-violation: 'retry'` was only recorded, as `log-only` is, and the turn completed. Now, in an agent turn with a `retry` guardrail:
  - Each finished answer, after output repair, is judged on the turn's `halt` and `retry` guardrails. A failed `halt` fails the turn at once. A failed `retry` adds the answer and a user message naming the guardrails and their checks' reasons (`[kindgi:guardrail-retry] ["<id>",…]`), and the model writes a new answer.
  - `retry.maxAttempts` counts the answers a guardrail fails, the first one included: with 3, it sends a failed answer back up to twice, and the third answer it fails ends the turn. Left out, it's 2. When a guardrail's attempts run out, or the agent's `budget.maxSteps` does, or the loop's 32 model calls do, the turn fails with `guardrail-violation`: its message says "after N answers", and `GuardrailViolationError.attempts` (and the wire's `details.attempts`) says how many answers the turn had.
  - The other guardrails judge only the answer that's sent, once. A sent-back answer and its note aren't stored in the conversation.
  - The outcome ledger gets a set of rows per answer judged, under the step `budget-check@<iteration>`, so a guardrail's counts are of answers judged. A turn without a `retry` guardrail is judged and recorded as before.
  - The loop's iteration output and `agent.turn` 1.1.0 are unchanged, so a run journaled by either version resumes on the other. A turn resumed in another process after its last answer was judged in the loop judges that answer on its `halt` and `retry` guardrails again, since what the loop judged is kept in memory only; a `retry` failure there fails the turn as out of attempts.
  - A dry run skips the model call and sends nothing back: a `retry` guardrail that fails its answer fails the turn, as one out of attempts does.
  
  `categorizeOutcomes` sorts `retry` failures into a new `retry` list, out of `other`. `GuardrailViolationError` and `describeBlockingViolations` take the attempts. `@kindgi/guardrails`' `retryHandler` takes a `retry` action without `action.retry` (the default attempts apply). The `Action`, schema, OpenAPI and SDK docs say what `retry` does; `@kindgi/client`'s `GuardrailViolationError` gains `attempts`. The guardrail skills say it too: `kindgi-authoring-guardrails` 0.3.12, `kindgi-python-authoring-guardrails` 0.1.6, `kindgi-java-authoring-guardrails` and `kindgi-scala-authoring-guardrails` 0.1.3. The agents skills say that a `retry` guardrail sends the answer back: `kindgi-authoring-agents` 0.4.10, `kindgi-python-authoring-agents` 0.1.9, `kindgi-java-authoring-agents` and `kindgi-scala-authoring-agents` 0.1.5.
- 8dd91b0: **A guardrail says where in the agent's turn it runs: `at`.** `'before-tool'` judges a call the model asked for, before it runs and before any approval is asked; `'after-tool'` a call's result, before the model sees it; `'model-step'` each model reply that asks for tool calls, before any of them runs; and `'final-answer'`, the default, the answer that would be stored. `sees: 'conversation'` gives the check the conversation's earlier turns too (`trace.earlier`), and `scope.tools` limits a guardrail at a tool point to the tools it names (a trailing `*` matches every id with that prefix). A check says where it can run with `defineCheck({ points })`; one that names none runs at the final answer only, as every check does today. A guardrail at a point its check doesn't run at is refused by `validateGuardrail`, the pack indexer, the deploy route, and the register route when it names a built-in check (`422 guardrail-config-invalid`, the problem at `/at`). Registering one that names a pack check isn't refused: at that point in a turn, the guardrail fails as a check that couldn't run (`check-point-unsupported`). A pack check whose index lists no points runs at the final answer only. `validateGuardrail` and `validateGuardrailSpec` also refuse one that asks a point for what it can't do, so registering answers `400 validation-failed` and deploying `deployment-validation-failed`: `'escalate'` and `'compensate'` stay at the final answer, where they're recorded as today, and `scope.tools` is for the tool points. `scope.tools` names one or more tools, with a `*` only at the end. The pack indexer refuses an `at` or `sees` it doesn't know, a malformed `scope.tools` or `points`, a point the pack's check doesn't run at, and what a point can't do, with the deploy's paths and words (`guardrail <id>: /action/on-violation: "escalate" is recorded at the final answer only, not at "before-tool"`), so a pack that builds doesn't fail its deploy for them; a built-in check at a point it doesn't run at is refused at deploy. The built-in checks: `must-cite` and `required-substring` run at the final answer; `never-call-tool`, `max-tool-calls` and `tool-order` before a tool call too, judging that call against the turn's earlier calls; `output-matches` and `forbidden-substring` on each reply and each call's result too. The pack index carries `at`, `sees` and the pack check's `checkPoints`.
- 8dd91b0: **The agent loop runs a guardrail where its `at` says: before a tool call, after it, or on each model reply that asks for tool calls.** Until now every guardrail judged the final answer. `halt`, `retry` and the recorded actions now work at the loop's points too:
  - **`at: 'before-tool'`** judges a call after its access check and before any approval is asked. A `halt` fails the turn with `guardrail-violation`. A `retry` refuses the call: it doesn't run, and the model gets the guardrail's reason as its result, so it can go on without the call or make another.
  - **`at: 'after-tool'`** judges what a call returned, or the error it failed with, before the model sees it. A `retry` withholds it: the reason is stored as the call's result in its place, so neither the model nor a later turn's history sees the result. A replay's recorded result is judged as a live one is.
  - **Read-only calls that run together.** A call that a `before-tool` guardrail judges starts a batch of read-only calls and never joins one, so its check sees every call before it in the step that ran, as when calls ran one after another. A call it refuses runs nothing, and the calls after it in its batch run. Results are judged at `after-tool` one by one, in the order the model asked; a `halt` there stops the calls still running and stores no result after it.
  - **`at: 'model-step'`** judges a reply that asks for calls, before any of them runs. A `retry` sends the reply back: none of its calls runs, nothing of it is stored, and the model writes a new reply.
  - **Attempts are counted across the turn, one for each reply.** A `retry` guardrail's `retry.maxAttempts` counts the model's replies it acted on: a reply it sent back, or one with a call it refused or a result it withheld. Two calls of one reply that it refuses are one attempt. When they run out, or the turn has no steps left, the turn fails as at the final answer, with `attempts`, the replies there were. A tool's own result can't count as one, whatever its text.
  - **A check that can't run** at its point (a point its check doesn't run at, or its time ran out) acts as a failed one: a `halt` fails the turn, a `retry` refuses or withholds with a reason that names why. A check that isn't registered counts as one that runs at the final answer only, so it fails as `check-point-unsupported`, saying no check by that name is registered. So a broken check never lets a call through unchecked.
  - **A dry run** skips the model call, so its reply asks for no tools and no guardrail runs at a loop point in it. Were one to, it would act as in any run.
  - **`budget.maxLatencyMs` is enforced at these three points**, with a default by kind when it's left out: 10 s for `zero-llm`, 60 s for `llm-judge`, 30 s for any other. The loop stops waiting for a check past its time and cancels it, and the check fails as `check-timed-out`. The pack index now carries a guardrail's `budget`, so a pack's guardrail runs with its own. The final answer keeps no limit, and `maxCostUsd` isn't enforced anywhere yet; the docs say so.
  - **The record says where.** A failure's `guardrail-violation` names the point and, at a tool point, the call (`point`, `callId`), and so do `guardrail.violated` and `guardrail.error` events, the outcome rows (`point`, `callId`, `nodeId` `dispatch-tools@<iteration>`, or `dispatch-tools@<iteration>:<point>:<callId>` at a tool point) and the provenance's `guardrail-check` nodes. Failures with any other action join the turn's `violations`.
  - **A resumed turn decides nothing twice.** Each check's outcome at a point is recorded with the step, so a turn resumed after an approval, or a step run again, reuses it: no judge is asked or billed again, and no event is sent again.
  - **A reply whose calls share an id, or have none, fails the turn** with `model-invocation-failed`, before any of its calls is judged or runs, and the message names the call and the id. A step records what it decided for a call by its id, so a second call with the first one's id would get its verdicts.
  - **New error codes:** `check-timed-out` (with `limitMs`) and `check-point-unsupported` (with `checkId` and `point`).
  - **The final answer** runs only the guardrails at the final answer. Its trace keeps every call the model asked for, as today; at the loop's points, the trace's `toolCalls` and `toolResults` hold only the calls that ran.
- 8dd91b0: **How much an agent's model thinks, and the level each call sent.** A model-settings block takes `thinking`, from `lowest` (as little as the model allows) through `minimal`, `low`, `medium`, `high` and `xhigh` to `max`, beside `temperature` and `maxOutputTokens`. The turn's model calls ask for it (`ModelCallInput.thinking`, which judges already set to `lowest`), and an improvement pass can try the levels a block's schema marks tunable. A model's `thinking` in a provider's `metadata.models` takes `levels`, the levels it takes besides `lowest`, least first, and a `default`, the level a call that asks none is sent. A `default` the model doesn't take is refused at registration, naming the ones it takes. Without `levels`, a model takes `low`, `medium` and `high`, plus `minimal` when its `lowest` is `minimal`, and none below its `lowest` when that's `medium` or `high`. A level a model doesn't take is rounded to the next one it takes, or to its highest, and the call warns `thinking-level-adjusted`; a level asked of a model that doesn't think sends nothing and warns `thinking-unsupported`. `thinkingFor` and `thinkingLevelsOf` in `@kindgi/capabilities` work this out for an adapter. Each model call's cost record (`GET /v1/cost/records`) carries `thinking`: the level the call asked for (`asked`), the one sent (`level`) and the vendor's fields as they went out (`sent`). The turn record's `model-call` node and the `model.call.completed` event carry `asked` and `level`. Each built-in adapter sends the level: Anthropic as `output_config.effort`, with `thinking.type` when a call asks `lowest` of a model whose `lowest` is `disabled` or `between_tools`; Gemini as `thinkingLevel`; OpenAI-compatible endpoints as `reasoning_effort` or `reasoning.effort`, winning over an effort in `extraBody`; Azure OpenAI and Bedrock as the AI SDK's portable `reasoning`, and a level the AI SDK drops is reported as not sent, with `thinking-unsupported`. On Bedrock that includes `none`, which the AI SDK sends nothing for, so `lowest` on a model whose least is `none` or `disabled` gets the model's own default. In-process models don't think, so a level asked of them warns. Each result's `thinking` says the level and what was sent. Gemini's `adapter_config.thinkingLevels` moved to `metadata.models[].thinking.default`: a new registration with it is refused, naming the new place, and a stored one builds without it being read. `GeminiProviderOptions.thinkingLevels` and the `GeminiThinkingLevel` type are gone. The CLI's presets list each thinking model's `levels` from its vendor's pages, so `kindgi providers register --preset` registers them; Bedrock's Claude lists `max` but not `xhigh`, which the AI SDK sends to Bedrock as `max`, and a model whose levels no page settles (Bedrock's GPT models, Vertex's Gemini) lists none. Bedrock's `us.openai.gpt-6-luna` now has `low` as its least thinking, not `none`, which the AI SDK sends nothing for there. A runtime before 0.3.0 refuses a model's `levels`: there, `--preset` registers the models without them, and says so.
- c39c1e6: **Breaking: `defineGuardrail(spec, checks)` is now `validateGuardrail(spec, checks)`.** It validates a guardrail declaration against the wire schema and a check registry and returns a `Result`, as before; only the name changes, and there's no alias. The new name says what it does, beside `validateGuardrailSpec`, and leaves `defineGuardrail` free for authoring a guardrail, as `defineTool` and `defineCheck` author theirs. To upgrade, rename the import and the call. The guardrail schema's descriptions and the `kindgi-authoring-guardrails` skill name `validateGuardrail`.
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
  - @kindgi/capabilities@0.3.0
  - @kindgi/compliance@0.3.0
  - @kindgi/types@0.3.0
  - @kindgi/schema@0.3.0
  - @kindgi/bounds@0.3.0

## 0.3.0-rc.0

### Patch Changes

- 8dd91b0: **A `retry` guardrail sends a failed answer back to the model, for a new one.** Before, `on-violation: 'retry'` was only recorded, as `log-only` is, and the turn completed. Now, in an agent turn with a `retry` guardrail:
  - Each finished answer, after output repair, is judged on the turn's `halt` and `retry` guardrails. A failed `halt` fails the turn at once. A failed `retry` adds the answer and a user message naming the guardrails and their checks' reasons (`[kindgi:guardrail-retry] ["<id>",…]`), and the model writes a new answer.
  - `retry.maxAttempts` counts the answers a guardrail fails, the first one included: with 3, it sends a failed answer back up to twice, and the third answer it fails ends the turn. Left out, it's 2. When a guardrail's attempts run out, or the agent's `budget.maxSteps` does, or the loop's 32 model calls do, the turn fails with `guardrail-violation`: its message says "after N answers", and `GuardrailViolationError.attempts` (and the wire's `details.attempts`) says how many answers the turn had.
  - The other guardrails judge only the answer that's sent, once. A sent-back answer and its note aren't stored in the conversation.
  - The outcome ledger gets a set of rows per answer judged, under the step `budget-check@<iteration>`, so a guardrail's counts are of answers judged. A turn without a `retry` guardrail is judged and recorded as before.
  - The loop's iteration output and `agent.turn` 1.1.0 are unchanged, so a run journaled by either version resumes on the other. A turn resumed in another process after its last answer was judged in the loop judges that answer on its `halt` and `retry` guardrails again, since what the loop judged is kept in memory only; a `retry` failure there fails the turn as out of attempts.
  - A dry run skips the model call and sends nothing back: a `retry` guardrail that fails its answer fails the turn, as one out of attempts does.
  
  `categorizeOutcomes` sorts `retry` failures into a new `retry` list, out of `other`. `GuardrailViolationError` and `describeBlockingViolations` take the attempts. `@kindgi/guardrails`' `retryHandler` takes a `retry` action without `action.retry` (the default attempts apply). The `Action`, schema, OpenAPI and SDK docs say what `retry` does; `@kindgi/client`'s `GuardrailViolationError` gains `attempts`. The guardrail skills say it too: `kindgi-authoring-guardrails` 0.3.12, `kindgi-python-authoring-guardrails` 0.1.6, `kindgi-java-authoring-guardrails` and `kindgi-scala-authoring-guardrails` 0.1.3. The agents skills say that a `retry` guardrail sends the answer back: `kindgi-authoring-agents` 0.4.10, `kindgi-python-authoring-agents` 0.1.9, `kindgi-java-authoring-agents` and `kindgi-scala-authoring-agents` 0.1.5.
- 8dd91b0: **A guardrail says where in the agent's turn it runs: `at`.** `'before-tool'` judges a call the model asked for, before it runs and before any approval is asked; `'after-tool'` a call's result, before the model sees it; `'model-step'` each model reply that asks for tool calls, before any of them runs; and `'final-answer'`, the default, the answer that would be stored. `sees: 'conversation'` gives the check the conversation's earlier turns too (`trace.earlier`), and `scope.tools` limits a guardrail at a tool point to the tools it names (a trailing `*` matches every id with that prefix). A check says where it can run with `defineCheck({ points })`; one that names none runs at the final answer only, as every check does today. A guardrail at a point its check doesn't run at is refused by `validateGuardrail`, the pack indexer, the deploy route, and the register route when it names a built-in check (`422 guardrail-config-invalid`, the problem at `/at`). Registering one that names a pack check isn't refused: at that point in a turn, the guardrail fails as a check that couldn't run (`check-point-unsupported`). A pack check whose index lists no points runs at the final answer only. `validateGuardrail` and `validateGuardrailSpec` also refuse one that asks a point for what it can't do, so registering answers `400 validation-failed` and deploying `deployment-validation-failed`: `'escalate'` and `'compensate'` stay at the final answer, where they're recorded as today, and `scope.tools` is for the tool points. `scope.tools` names one or more tools, with a `*` only at the end. The pack indexer refuses an `at` or `sees` it doesn't know, a malformed `scope.tools` or `points`, a point the pack's check doesn't run at, and what a point can't do, with the deploy's paths and words (`guardrail <id>: /action/on-violation: "escalate" is recorded at the final answer only, not at "before-tool"`), so a pack that builds doesn't fail its deploy for them; a built-in check at a point it doesn't run at is refused at deploy. The built-in checks: `must-cite` and `required-substring` run at the final answer; `never-call-tool`, `max-tool-calls` and `tool-order` before a tool call too, judging that call against the turn's earlier calls; `output-matches` and `forbidden-substring` on each reply and each call's result too. The pack index carries `at`, `sees` and the pack check's `checkPoints`.
- 8dd91b0: **The agent loop runs a guardrail where its `at` says: before a tool call, after it, or on each model reply that asks for tool calls.** Until now every guardrail judged the final answer. `halt`, `retry` and the recorded actions now work at the loop's points too:
  - **`at: 'before-tool'`** judges a call after its access check and before any approval is asked. A `halt` fails the turn with `guardrail-violation`. A `retry` refuses the call: it doesn't run, and the model gets the guardrail's reason as its result, so it can go on without the call or make another.
  - **`at: 'after-tool'`** judges what a call returned, or the error it failed with, before the model sees it. A `retry` withholds it: the reason is stored as the call's result in its place, so neither the model nor a later turn's history sees the result. A replay's recorded result is judged as a live one is.
  - **Read-only calls that run together.** A call that a `before-tool` guardrail judges starts a batch of read-only calls and never joins one, so its check sees every call before it in the step that ran, as when calls ran one after another. A call it refuses runs nothing, and the calls after it in its batch run. Results are judged at `after-tool` one by one, in the order the model asked; a `halt` there stops the calls still running and stores no result after it.
  - **`at: 'model-step'`** judges a reply that asks for calls, before any of them runs. A `retry` sends the reply back: none of its calls runs, nothing of it is stored, and the model writes a new reply.
  - **Attempts are counted across the turn, one for each reply.** A `retry` guardrail's `retry.maxAttempts` counts the model's replies it acted on: a reply it sent back, or one with a call it refused or a result it withheld. Two calls of one reply that it refuses are one attempt. When they run out, or the turn has no steps left, the turn fails as at the final answer, with `attempts`, the replies there were. A tool's own result can't count as one, whatever its text.
  - **A check that can't run** at its point (a point its check doesn't run at, or its time ran out) acts as a failed one: a `halt` fails the turn, a `retry` refuses or withholds with a reason that names why. A check that isn't registered counts as one that runs at the final answer only, so it fails as `check-point-unsupported`, saying no check by that name is registered. So a broken check never lets a call through unchecked.
  - **A dry run** skips the model call, so its reply asks for no tools and no guardrail runs at a loop point in it. Were one to, it would act as in any run.
  - **`budget.maxLatencyMs` is enforced at these three points**, with a default by kind when it's left out: 10 s for `zero-llm`, 60 s for `llm-judge`, 30 s for any other. The loop stops waiting for a check past its time and cancels it, and the check fails as `check-timed-out`. The pack index now carries a guardrail's `budget`, so a pack's guardrail runs with its own. The final answer keeps no limit, and `maxCostUsd` isn't enforced anywhere yet; the docs say so.
  - **The record says where.** A failure's `guardrail-violation` names the point and, at a tool point, the call (`point`, `callId`), and so do `guardrail.violated` and `guardrail.error` events, the outcome rows (`point`, `callId`, `nodeId` `dispatch-tools@<iteration>`, or `dispatch-tools@<iteration>:<point>:<callId>` at a tool point) and the provenance's `guardrail-check` nodes. Failures with any other action join the turn's `violations`.
  - **A resumed turn decides nothing twice.** Each check's outcome at a point is recorded with the step, so a turn resumed after an approval, or a step run again, reuses it: no judge is asked or billed again, and no event is sent again.
  - **A reply whose calls share an id, or have none, fails the turn** with `model-invocation-failed`, before any of its calls is judged or runs, and the message names the call and the id. A step records what it decided for a call by its id, so a second call with the first one's id would get its verdicts.
  - **New error codes:** `check-timed-out` (with `limitMs`) and `check-point-unsupported` (with `checkId` and `point`).
  - **The final answer** runs only the guardrails at the final answer. Its trace keeps every call the model asked for, as today; at the loop's points, the trace's `toolCalls` and `toolResults` hold only the calls that ran.
- 8dd91b0: **How much an agent's model thinks, and the level each call sent.** A model-settings block takes `thinking`, from `lowest` (as little as the model allows) through `minimal`, `low`, `medium`, `high` and `xhigh` to `max`, beside `temperature` and `maxOutputTokens`. The turn's model calls ask for it (`ModelCallInput.thinking`, which judges already set to `lowest`), and an improvement pass can try the levels a block's schema marks tunable. A model's `thinking` in a provider's `metadata.models` takes `levels`, the levels it takes besides `lowest`, least first, and a `default`, the level a call that asks none is sent. A `default` the model doesn't take is refused at registration, naming the ones it takes. Without `levels`, a model takes `low`, `medium` and `high`, plus `minimal` when its `lowest` is `minimal`, and none below its `lowest` when that's `medium` or `high`. A level a model doesn't take is rounded to the next one it takes, or to its highest, and the call warns `thinking-level-adjusted`; a level asked of a model that doesn't think sends nothing and warns `thinking-unsupported`. `thinkingFor` and `thinkingLevelsOf` in `@kindgi/capabilities` work this out for an adapter. Each model call's cost record (`GET /v1/cost/records`) carries `thinking`: the level the call asked for (`asked`), the one sent (`level`) and the vendor's fields as they went out (`sent`). The turn record's `model-call` node and the `model.call.completed` event carry `asked` and `level`. Each built-in adapter sends the level: Anthropic as `output_config.effort`, with `thinking.type` when a call asks `lowest` of a model whose `lowest` is `disabled` or `between_tools`; Gemini as `thinkingLevel`; OpenAI-compatible endpoints as `reasoning_effort` or `reasoning.effort`, winning over an effort in `extraBody`; Azure OpenAI and Bedrock as the AI SDK's portable `reasoning`, and a level the AI SDK drops is reported as not sent, with `thinking-unsupported`. On Bedrock that includes `none`, which the AI SDK sends nothing for, so `lowest` on a model whose least is `none` or `disabled` gets the model's own default. In-process models don't think, so a level asked of them warns. Each result's `thinking` says the level and what was sent. Gemini's `adapter_config.thinkingLevels` moved to `metadata.models[].thinking.default`: a new registration with it is refused, naming the new place, and a stored one builds without it being read. `GeminiProviderOptions.thinkingLevels` and the `GeminiThinkingLevel` type are gone. The CLI's presets list each thinking model's `levels` from its vendor's pages, so `kindgi providers register --preset` registers them; Bedrock's Claude lists `max` but not `xhigh`, which the AI SDK sends to Bedrock as `max`, and a model whose levels no page settles (Bedrock's GPT models, Vertex's Gemini) lists none. Bedrock's `us.openai.gpt-6-luna` now has `low` as its least thinking, not `none`, which the AI SDK sends nothing for there. A runtime before 0.3.0 refuses a model's `levels`: there, `--preset` registers the models without them, and says so.
- c39c1e6: **Breaking: `defineGuardrail(spec, checks)` is now `validateGuardrail(spec, checks)`.** It validates a guardrail declaration against the wire schema and a check registry and returns a `Result`, as before; only the name changes, and there's no alias. The new name says what it does, beside `validateGuardrailSpec`, and leaves `defineGuardrail` free for authoring a guardrail, as `defineTool` and `defineCheck` author theirs. To upgrade, rename the import and the call. The guardrail schema's descriptions and the `kindgi-authoring-guardrails` skill name `validateGuardrail`.
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
  - @kindgi/capabilities@0.3.0-rc.0
  - @kindgi/compliance@0.3.0-rc.0
  - @kindgi/types@0.3.0-rc.0
  - @kindgi/schema@0.3.0-rc.0
  - @kindgi/bounds@0.3.0-rc.0

## 0.2.0

### Patch Changes

- Updated dependencies [08dedca]
- Updated dependencies [b6e20ca]
- Updated dependencies [d70c2a5]
- Updated dependencies [e019e64]
- Updated dependencies [68e0d57]
- Updated dependencies [119ac78]
  - @kindgi/compliance@0.2.0
  - @kindgi/schema@0.2.0
  - @kindgi/capabilities@0.2.0
  - @kindgi/bounds@0.2.0
  - @kindgi/types@0.2.0

## 0.2.0-rc.1

### Patch Changes

- Updated dependencies [b6e20ca]
  - @kindgi/compliance@0.2.0-rc.1
  - @kindgi/capabilities@0.2.0-rc.1
  - @kindgi/schema@0.2.0-rc.1
  - @kindgi/bounds@0.2.0-rc.1
  - @kindgi/types@0.2.0-rc.1

## 0.2.0-rc.0

### Patch Changes

- Updated dependencies [08dedca]
- Updated dependencies [d70c2a5]
- Updated dependencies [e019e64]
- Updated dependencies [68e0d57]
- Updated dependencies [119ac78]
  - @kindgi/compliance@0.2.0-rc.0
  - @kindgi/schema@0.2.0-rc.0
  - @kindgi/capabilities@0.2.0-rc.0
  - @kindgi/bounds@0.2.0-rc.0
  - @kindgi/types@0.2.0-rc.0

## 0.1.10

### Patch Changes

- @kindgi/capabilities@0.1.10
  - @kindgi/compliance@0.1.10
  - @kindgi/schema@0.1.10
  - @kindgi/bounds@0.1.10
  - @kindgi/types@0.1.10

## 0.1.10-rc.1

### Patch Changes

- @kindgi/bounds@0.1.10-rc.1
  - @kindgi/capabilities@0.1.10-rc.1
  - @kindgi/compliance@0.1.10-rc.1
  - @kindgi/schema@0.1.10-rc.1
  - @kindgi/types@0.1.10-rc.1

## 0.1.10-rc.0

### Patch Changes

- @kindgi/capabilities@0.1.10-rc.0
  - @kindgi/compliance@0.1.10-rc.0
  - @kindgi/schema@0.1.10-rc.0
  - @kindgi/bounds@0.1.10-rc.0
  - @kindgi/types@0.1.10-rc.0

## 0.1.9

### Patch Changes

- 7be0273: **A guardrail's `action` is described as what it does in 0.1: only `halt` acts.** The OpenAPI `GuardrailAction` description, the guardrail YAML schema (`guardrail.schema.json`, both its `on-violation` text and its top-level description), the `Guardrail.action` and `OnViolation` docs and the package description of `@kindgi/guardrails`, the TS client's `GuardrailAction`, the Python client's model and the Python SDK README now say the same as the guardrail skills: a failed `halt` check fails the turn with `guardrail-violation`, and any other value, `retry`, `escalate`, `compensate` and custom names included, is recorded as a violation and the turn completes. They no longer say that `retry` runs the step again, that `escalate` routes to review, that `compensate` calls a tool, that a custom name needs an action handler registered (the runtime registers none), or that a `retry` action needs `maxAttempts` (only a `retry` object, when given, needs it). `retry`, `escalateTo` and `compensateWith` gain descriptions saying nothing acts on them in 0.1. No behaviour changes, and no shape changes.
- 8bcfa4b: **The guardrail skills and the guardrails guide say up front what a guardrail can do in 0.1.** Before, the skills listed `halt / retry / escalate / log-only / compensate` in their descriptions and said only far down that the runtime acts only on `halt`, so a coding agent asked to "block the reply and make the agent try again" planned a retry it couldn't build. The skills (`kindgi-authoring-guardrails` 0.3.10, `kindgi-python-authoring-guardrails` 0.1.5, `kindgi-java-authoring-guardrails` 0.1.2, `kindgi-scala-authoring-guardrails` 0.1.2) and the guide's overview now open with three limits:
  - **Only `halt` acts.** `retry`, `escalate` and `compensate` are recorded on the turn's violations, as `log-only` is, and nothing runs the turn again, escalates or calls a tool.
  - **A check sees one turn:** that turn's user message, tool calls, tool results and answer. Earlier turns aren't in its trace.
  - **A check's in-memory state doesn't last:** it's lost when the pack's process is replaced (every reload and restart under `kindgi dev`, an instance stopping in a deployment), and each instance keeps its own.
  
  They also say what works today for a check on figures, and what it doesn't cover. The `on-violation` action's docs say the same: the `Action` JSDoc in `@kindgi/guardrails`, the Python `@guardrail` docstring, and `onViolation` in the Java and Scala packs. No behaviour changes.
- Updated dependencies [5d68d0d]
- Updated dependencies [d563887]
- Updated dependencies [d563887]
- Updated dependencies [d563887]
- Updated dependencies [3c8afcf]
- Updated dependencies [ffeecb2]
- Updated dependencies [3502389]
  - @kindgi/compliance@0.1.9
  - @kindgi/capabilities@0.1.9
  - @kindgi/bounds@0.1.9
  - @kindgi/schema@0.1.9
  - @kindgi/types@0.1.9

## 0.1.9-rc.1

### Patch Changes

- @kindgi/bounds@0.1.9-rc.1
  - @kindgi/capabilities@0.1.9-rc.1
  - @kindgi/compliance@0.1.9-rc.1
  - @kindgi/schema@0.1.9-rc.1
  - @kindgi/types@0.1.9-rc.1

## 0.1.9-rc.0

### Patch Changes

- 7be0273: **A guardrail's `action` is described as what it does in 0.1: only `halt` acts.** The OpenAPI `GuardrailAction` description, the guardrail YAML schema (`guardrail.schema.json`, both its `on-violation` text and its top-level description), the `Guardrail.action` and `OnViolation` docs and the package description of `@kindgi/guardrails`, the TS client's `GuardrailAction`, the Python client's model and the Python SDK README now say the same as the guardrail skills: a failed `halt` check fails the turn with `guardrail-violation`, and any other value, `retry`, `escalate`, `compensate` and custom names included, is recorded as a violation and the turn completes. They no longer say that `retry` runs the step again, that `escalate` routes to review, that `compensate` calls a tool, that a custom name needs an action handler registered (the runtime registers none), or that a `retry` action needs `maxAttempts` (only a `retry` object, when given, needs it). `retry`, `escalateTo` and `compensateWith` gain descriptions saying nothing acts on them in 0.1. No behaviour changes, and no shape changes.
- 8bcfa4b: **The guardrail skills and the guardrails guide say up front what a guardrail can do in 0.1.** Before, the skills listed `halt / retry / escalate / log-only / compensate` in their descriptions and said only far down that the runtime acts only on `halt`, so a coding agent asked to "block the reply and make the agent try again" planned a retry it couldn't build. The skills (`kindgi-authoring-guardrails` 0.3.10, `kindgi-python-authoring-guardrails` 0.1.5, `kindgi-java-authoring-guardrails` 0.1.2, `kindgi-scala-authoring-guardrails` 0.1.2) and the guide's overview now open with three limits:
  - **Only `halt` acts.** `retry`, `escalate` and `compensate` are recorded on the turn's violations, as `log-only` is, and nothing runs the turn again, escalates or calls a tool.
  - **A check sees one turn:** that turn's user message, tool calls, tool results and answer. Earlier turns aren't in its trace.
  - **A check's in-memory state doesn't last:** it's lost when the pack's process is replaced (every reload and restart under `kindgi dev`, an instance stopping in a deployment), and each instance keeps its own.
  
  They also say what works today for a check on figures, and what it doesn't cover. The `on-violation` action's docs say the same: the `Action` JSDoc in `@kindgi/guardrails`, the Python `@guardrail` docstring, and `onViolation` in the Java and Scala packs. No behaviour changes.
- Updated dependencies [5d68d0d]
- Updated dependencies [d563887]
- Updated dependencies [d563887]
- Updated dependencies [d563887]
- Updated dependencies [3c8afcf]
- Updated dependencies [ffeecb2]
- Updated dependencies [3502389]
  - @kindgi/compliance@0.1.9-rc.0
  - @kindgi/capabilities@0.1.9-rc.0
  - @kindgi/bounds@0.1.9-rc.0
  - @kindgi/schema@0.1.9-rc.0
  - @kindgi/types@0.1.9-rc.0

## 0.1.8

### Patch Changes

- cd84814: **`must-cite` and `output-matches` compile their patterns with `@kindgi/bounds`,** once per config for its registration and every evaluation after it (they compiled on every evaluation, twice).
  - A pattern longer than the process's limit is refused like one that doesn't compile: 8,192 characters with its flags, unless the server sets other bounds. A server under the hosted profile runs patterns on RE2 and refuses, by name, what RE2 lacks.
  - `must-cite` stops counting once it has found `minCitations`, so a pass reports that many as `citationCount`; a fail still reports every one found.
  - `must-cite`'s `minCitations` is capped by the bounds' `mustCiteMaxCitations`: no cap unless the server sets one, 100 under the hosted profile. Over it, registration refuses the config at `/config/minCitations` and evaluation throws.
- 76532eb: **A turn that can't route names the registered providers its registry couldn't set up, and why.** Before, a tenant whose only provider failed to build (its settings no longer allowed on the deployment, say) got `capability-routing-failed` with `reasons: []`, and the cause was only in the server's log.
  - `ProviderRegistry.setupFailures(tenantId)` (optional): the tenant's registered providers its last `hydrate` couldn't set up, each a `ProviderSetupFailure` (`providerId`, `message`). `list` still leaves them out.
  - `RouteInput.setupFailures` (optional): when nothing routes, `capability-unsatisfiable` names each under the requirement `provider set up`, by its provider id alone, with the new rejection code `provider-setup-failed`. The error's message gives the first one's why and counts the rest. A route another provider satisfies is unchanged.
  - An agent turn and an `llm-judge` guardrail pass the registry's setup failures to the router. A registry without `setupFailures` routes as before.
- ebf405d: **`compileJsonSchema` and `compileInlineSchema` compile under the process's bounds (`@kindgi/bounds`),** and compile each schema once.
  - A `$ref` is compiled once, where its target is, not copied into each place that uses it (Ajv's `inlineRefs: false`), so the code a schema compiles to grows with its JSON.
  - A schema nested deeper than `schemaMaxDepth`, or larger than `schemaMaxBytes` as JSON, is refused before it's compiled, naming the limit: 64 levels and 1 MiB unless the server sets other bounds.
  - Validators are kept by the schema's JSON as written and the options it was compiled with, the least recently used dropped once `schemaCacheEntries` are kept or their schemas' JSON passes `schemaCacheMaxBytes`. A schema that didn't compile throws the same error again. The cache is all that keeps a compiled schema: `compileInlineSchema`'s result keeps the schema's cache key, not its validator, and compiles it again on `validate` once the cache has dropped it. New `holdJsonSchema` does the same for `compileJsonSchema`, and a tool holds its validators through it. A schema JSON can't carry (a key whose value is `undefined`, say) is never cached, so it's held as compiled.
  - Each tenant's compiles share a budget, `schemaCompileBudgetMs` in any 60 seconds (hosted 2 s, self-hosted none). `runAsTenant` (new in `@kindgi/bounds`) says whose compile it is and which count: by default only a schema compiled again after the cache dropped it; with `{ compiles: 'all' }`, every compile. Past the budget, a compile that counts throws `SchemaCompileBudgetError` with `retryAfterMs`, from `compileInlineSchema` too; `defineTool`, `validateToolManifest` and a guardrail's config check pass it on rather than report the schema as invalid, and `compileInlineSchema`'s `validate` throws it when it compiles again. A tenant that compiled nothing for an hour is forgotten: its next compiles are first ones again, as after a restart. `runOutsideTenant` (new) runs Kindgi's own work, started inside a tenant's scope, outside it.
  - Under the hosted profile, every check a schema makes of the data runs in time linear in the data (`uniqueItems`: in its size times its depth). Patterns (`pattern`, `patternProperties`, `propertyNames`) run on RE2 through `compileTenantPattern`, and a schema with one RE2 can't run doesn't compile. Formats are ajv-formats' `fast` ones (looser in places: `date` accepts `2026-02-30`), with `regex` a pattern whose syntax `compileTenantPattern` accepts, checked without building RE2's program (`tenantPatternSyntaxProblem`, new in `@kindgi/bounds`; a pattern RE2 refuses only as it builds the program, for its size or a few escapes, passes), and `url` written without its backtracking. `uniqueItems` finds a repeat by a key for each item, with Ajv's verdict and error.
  - `createSpecRegistry` and `loadSpecRegistry` run the patterns of Kindgi's own schemas on V8.
  - A guardrail's config is checked against its check's schema through `compileJsonSchema`, so the same bounds apply.
- ebf405d: **An agent turn whose work its tenant's budget refuses fails with `rate-limit-exceeded`, not `model-invocation-failed`,** on a server with budgets kept per tenant (Kindgi Cloud). The error names the budget in `details.limit` (`template-render-time` or `schema-compile-time`), with `details.budgetMs`, and says when the tenant is under it again. `POST /v1/runs` answers it as `429`, with `Retry-After` and `details.runId`, and the run reads as failed with that code. The OpenAPI document lists the 429 on `POST /v1/runs`.
  - New: the tenant input bounds' `templateRenderBudgetMs`, the time a tenant's instructions templates may spend rendering in any 60 seconds. Once a tenant has spent it, its next render is refused before it starts. A self-hosted server has none.
  - `TenantBudgetError` (`@kindgi/bounds`) is what each budget's refusal is: `SchemaCompileBudgetError` and the new `TemplateRenderBudgetError` (`@kindgi/agents`) extend it, with `limit`, `budgetMs` and `retryAfterMs`. The API answers any of them thrown from a route as `429 rate-limit-exceeded`.
  - A guardrail check, or a tenant's approval policy, whose schema compile the budget refuses no longer fails as `check-failed` or `tenant-policy-unavailable`: the turn fails as above.
  - A failed run's `failure` has `details` for a code that has them. For `rate-limit-exceeded` that's `limit` and `budgetMs`, never the wait, which is stale once read back. The `run.finished` webhook's run can carry `failure` beside `failureMessage`. It's absent from a runtime that doesn't send it yet. `parseEvent` (`@kindgi/sdk/webhooks`) reads it, and reads a failure's `cause` as any JSON value.
- Updated dependencies [cd84814]
- Updated dependencies [3a3f233]
- Updated dependencies [76532eb]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [3a3f233]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
  - @kindgi/bounds@0.1.8
  - @kindgi/capabilities@0.1.8
  - @kindgi/schema@0.1.8
  - @kindgi/types@0.1.8
  - @kindgi/compliance@0.1.8

## 0.1.8-rc.0

### Patch Changes

- cd84814: **`must-cite` and `output-matches` compile their patterns with `@kindgi/bounds`,** once per config for its registration and every evaluation after it (they compiled on every evaluation, twice).
  - A pattern longer than the process's limit is refused like one that doesn't compile: 8,192 characters with its flags, unless the server sets other bounds. A server under the hosted profile runs patterns on RE2 and refuses, by name, what RE2 lacks.
  - `must-cite` stops counting once it has found `minCitations`, so a pass reports that many as `citationCount`; a fail still reports every one found.
  - `must-cite`'s `minCitations` is capped by the bounds' `mustCiteMaxCitations`: no cap unless the server sets one, 100 under the hosted profile. Over it, registration refuses the config at `/config/minCitations` and evaluation throws.
- 76532eb: **A turn that can't route names the registered providers its registry couldn't set up, and why.** Before, a tenant whose only provider failed to build (its settings no longer allowed on the deployment, say) got `capability-routing-failed` with `reasons: []`, and the cause was only in the server's log.
  - `ProviderRegistry.setupFailures(tenantId)` (optional): the tenant's registered providers its last `hydrate` couldn't set up, each a `ProviderSetupFailure` (`providerId`, `message`). `list` still leaves them out.
  - `RouteInput.setupFailures` (optional): when nothing routes, `capability-unsatisfiable` names each under the requirement `provider set up`, by its provider id alone, with the new rejection code `provider-setup-failed`. The error's message gives the first one's why and counts the rest. A route another provider satisfies is unchanged.
  - An agent turn and an `llm-judge` guardrail pass the registry's setup failures to the router. A registry without `setupFailures` routes as before.
- ebf405d: **`compileJsonSchema` and `compileInlineSchema` compile under the process's bounds (`@kindgi/bounds`),** and compile each schema once.
  - A `$ref` is compiled once, where its target is, not copied into each place that uses it (Ajv's `inlineRefs: false`), so the code a schema compiles to grows with its JSON.
  - A schema nested deeper than `schemaMaxDepth`, or larger than `schemaMaxBytes` as JSON, is refused before it's compiled, naming the limit: 64 levels and 1 MiB unless the server sets other bounds.
  - Validators are kept by the schema's JSON as written and the options it was compiled with, the least recently used dropped once `schemaCacheEntries` are kept or their schemas' JSON passes `schemaCacheMaxBytes`. A schema that didn't compile throws the same error again. The cache is all that keeps a compiled schema: `compileInlineSchema`'s result keeps the schema's cache key, not its validator, and compiles it again on `validate` once the cache has dropped it. New `holdJsonSchema` does the same for `compileJsonSchema`, and a tool holds its validators through it. A schema JSON can't carry (a key whose value is `undefined`, say) is never cached, so it's held as compiled.
  - Each tenant's compiles share a budget, `schemaCompileBudgetMs` in any 60 seconds (hosted 2 s, self-hosted none). `runAsTenant` (new in `@kindgi/bounds`) says whose compile it is and which count: by default only a schema compiled again after the cache dropped it; with `{ compiles: 'all' }`, every compile. Past the budget, a compile that counts throws `SchemaCompileBudgetError` with `retryAfterMs`, from `compileInlineSchema` too; `defineTool`, `validateToolManifest` and a guardrail's config check pass it on rather than report the schema as invalid, and `compileInlineSchema`'s `validate` throws it when it compiles again. A tenant that compiled nothing for an hour is forgotten: its next compiles are first ones again, as after a restart. `runOutsideTenant` (new) runs Kindgi's own work, started inside a tenant's scope, outside it.
  - Under the hosted profile, every check a schema makes of the data runs in time linear in the data (`uniqueItems`: in its size times its depth). Patterns (`pattern`, `patternProperties`, `propertyNames`) run on RE2 through `compileTenantPattern`, and a schema with one RE2 can't run doesn't compile. Formats are ajv-formats' `fast` ones (looser in places: `date` accepts `2026-02-30`), with `regex` a pattern whose syntax `compileTenantPattern` accepts, checked without building RE2's program (`tenantPatternSyntaxProblem`, new in `@kindgi/bounds`; a pattern RE2 refuses only as it builds the program, for its size or a few escapes, passes), and `url` written without its backtracking. `uniqueItems` finds a repeat by a key for each item, with Ajv's verdict and error.
  - `createSpecRegistry` and `loadSpecRegistry` run the patterns of Kindgi's own schemas on V8.
  - A guardrail's config is checked against its check's schema through `compileJsonSchema`, so the same bounds apply.
- ebf405d: **An agent turn whose work its tenant's budget refuses fails with `rate-limit-exceeded`, not `model-invocation-failed`,** on a server with budgets kept per tenant (Kindgi Cloud). The error names the budget in `details.limit` (`template-render-time` or `schema-compile-time`), with `details.budgetMs`, and says when the tenant is under it again. `POST /v1/runs` answers it as `429`, with `Retry-After` and `details.runId`, and the run reads as failed with that code. The OpenAPI document lists the 429 on `POST /v1/runs`.
  - New: the tenant input bounds' `templateRenderBudgetMs`, the time a tenant's instructions templates may spend rendering in any 60 seconds. Once a tenant has spent it, its next render is refused before it starts. A self-hosted server has none.
  - `TenantBudgetError` (`@kindgi/bounds`) is what each budget's refusal is: `SchemaCompileBudgetError` and the new `TemplateRenderBudgetError` (`@kindgi/agents`) extend it, with `limit`, `budgetMs` and `retryAfterMs`. The API answers any of them thrown from a route as `429 rate-limit-exceeded`.
  - A guardrail check, or a tenant's approval policy, whose schema compile the budget refuses no longer fails as `check-failed` or `tenant-policy-unavailable`: the turn fails as above.
  - A failed run's `failure` has `details` for a code that has them. For `rate-limit-exceeded` that's `limit` and `budgetMs`, never the wait, which is stale once read back. The `run.finished` webhook's run can carry `failure` beside `failureMessage`. It's absent from a runtime that doesn't send it yet. `parseEvent` (`@kindgi/sdk/webhooks`) reads it, and reads a failure's `cause` as any JSON value.
- Updated dependencies [cd84814]
- Updated dependencies [3a3f233]
- Updated dependencies [76532eb]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [3a3f233]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
  - @kindgi/bounds@0.1.8-rc.0
  - @kindgi/capabilities@0.1.8-rc.0
  - @kindgi/schema@0.1.8-rc.0
  - @kindgi/types@0.1.8-rc.0
  - @kindgi/compliance@0.1.8-rc.0

## 0.1.7

### Patch Changes

- Updated dependencies [7bd61d6]
- Updated dependencies [b90e2c6]
- Updated dependencies [f080a20]
  - @kindgi/capabilities@0.1.7
  - @kindgi/types@0.1.7
  - @kindgi/compliance@0.1.7
  - @kindgi/schema@0.1.7

## 0.1.7-rc.0

### Patch Changes

- Updated dependencies [7bd61d6]
- Updated dependencies [b90e2c6]
- Updated dependencies [f080a20]
  - @kindgi/capabilities@0.1.7-rc.0
  - @kindgi/types@0.1.7-rc.0
  - @kindgi/compliance@0.1.7-rc.0
  - @kindgi/schema@0.1.7-rc.0

## 0.1.6

### Patch Changes

- fdb86ae: **A guardrail that only names a built-in check is marked.** The CLI's indexer sets `checkBuiltIn: true` on a pack index guardrail whose check is a built-in's (`must-cite`, …), and a deployment keeps it on the guardrail (`Guardrail.checkBuiltIn`, in both specs). From runtime 0.1.6, a guardrail that names a built-in, comes with its pack's code, and lacks the mark gets one warning in the runtime's log each time the runtime loads it. Such a pack was built with a CLI from before 0.1.6. One built before 0.1.5 may also ship its own check under the built-in's id, which the built-in replaces. Nothing is refused, and the built-in still runs. Rebuilding with a current CLI silences the warning. An older runtime ignores the mark.
  
  `POST /v1/guardrails`' `guardrail-config-invalid` now says it covers the config of any check the guardrail names, a pack check's or a built-in's.
- 307771f: Guardrail outcomes: what each guardrail's checks came to, passes included, counted on the server.
  
  - **The record:** an agent turn's guardrail gate records each check as `passed`, `violated` (the answer went through), `blocked` (a `halt` failed the turn) or `errored` (the check couldn't run). It records through `InvokeAgentBindings.guardrailOutcomes`, a `GuardrailOutcomeSink` from `@kindgi/guardrails`, before it acts on them, so a blocked turn is recorded too.
    - **No content:** only ids, the action, the severity and an error's code. No answer, and no check's reason.
    - **Not recorded:** replays and dry runs.
    - **Strict:** a sink that throws fails the step with `persistence-error`, so the counts never silently miss a turn.
    - **Without a sink,** nothing is recorded.
  - **`categorizeOutcomes`** also answers `checks`, each guardrail's outcome in order.
  - **`GET /v1/guardrails/{guardrailId}/outcomes`:** a guardrail's outcomes on a project's agent turns over a window. The answer has the `counts`, the same counts per agent version (`byAgentVersion`), the window's latest blocked turns (`recentBlocked`, run ids and times only) and `recordedSince`, the earliest outcome kept.
    - **The query:** `projectId`, `from` and `to` are required, with a window of at most 90 days. `recent` is optional: 0 to 50, 10 by default.
    - **Who:** it needs `read` on the guardrail and on the project.
    - **Retention:** outcomes go with their run's retention, so a window can hold fewer than asked.
  - **`GuardrailRegistryBinding.outcomes`** is optional. Without it, the route answers `501 guardrail-outcomes-not-supported`.
  - **The clients:** TypeScript `guardrails.outcomes(id, query)`; Python `guardrails.outcomes(...)`.
- 03151ca: **A union of types compiles.** A schema with `type: ['string', 'number', 'boolean', 'null']`, which is what Zod 4 writes for `z.union([z.string(), z.number(), z.boolean(), z.null()])`, used to be refused ("strict mode: use allowUnionTypes…"), while `.nullable()` compiled. It's standard JSON Schema, and every schema compiler now takes it: tool input and output, an agent's typed output, a guardrail check's config, flow and block schemas, and the pack service's validation. `ALLOW_UNION_TYPES` (`@kindgi/schema`) says so.
  - A schema that strict mode still refuses (an open tuple, an unknown keyword) says how out: for a field that may hold any JSON value, `z.json()` (or `{}` in JSON Schema) compiles.
  - The Java pack service validates a union of types too (its CHANGELOG). Python's always did.
- Updated dependencies [a6ac2e9]
- Updated dependencies [eed55a1]
- Updated dependencies [a2b2ae8]
- Updated dependencies [6a4715c]
- Updated dependencies [03151ca]
- Updated dependencies [b4bbd95]
  - @kindgi/compliance@0.1.6
  - @kindgi/capabilities@0.1.6
  - @kindgi/schema@0.1.6
  - @kindgi/types@0.1.6

## 0.1.6-rc.0

### Patch Changes

- fdb86ae: **A guardrail that only names a built-in check is marked.** The CLI's indexer sets `checkBuiltIn: true` on a pack index guardrail whose check is a built-in's (`must-cite`, …), and a deployment keeps it on the guardrail (`Guardrail.checkBuiltIn`, in both specs). From runtime 0.1.6, a guardrail that names a built-in, comes with its pack's code, and lacks the mark gets one warning in the runtime's log each time the runtime loads it. Such a pack was built with a CLI from before 0.1.6. One built before 0.1.5 may also ship its own check under the built-in's id, which the built-in replaces. Nothing is refused, and the built-in still runs. Rebuilding with a current CLI silences the warning. An older runtime ignores the mark.
  
  `POST /v1/guardrails`' `guardrail-config-invalid` now says it covers the config of any check the guardrail names, a pack check's or a built-in's.
- 307771f: Guardrail outcomes: what each guardrail's checks came to, passes included, counted on the server.
  
  - **The record:** an agent turn's guardrail gate records each check as `passed`, `violated` (the answer went through), `blocked` (a `halt` failed the turn) or `errored` (the check couldn't run). It records through `InvokeAgentBindings.guardrailOutcomes`, a `GuardrailOutcomeSink` from `@kindgi/guardrails`, before it acts on them, so a blocked turn is recorded too.
    - **No content:** only ids, the action, the severity and an error's code. No answer, and no check's reason.
    - **Not recorded:** replays and dry runs.
    - **Strict:** a sink that throws fails the step with `persistence-error`, so the counts never silently miss a turn.
    - **Without a sink,** nothing is recorded.
  - **`categorizeOutcomes`** also answers `checks`, each guardrail's outcome in order.
  - **`GET /v1/guardrails/{guardrailId}/outcomes`:** a guardrail's outcomes on a project's agent turns over a window. The answer has the `counts`, the same counts per agent version (`byAgentVersion`), the window's latest blocked turns (`recentBlocked`, run ids and times only) and `recordedSince`, the earliest outcome kept.
    - **The query:** `projectId`, `from` and `to` are required, with a window of at most 90 days. `recent` is optional: 0 to 50, 10 by default.
    - **Who:** it needs `read` on the guardrail and on the project.
    - **Retention:** outcomes go with their run's retention, so a window can hold fewer than asked.
  - **`GuardrailRegistryBinding.outcomes`** is optional. Without it, the route answers `501 guardrail-outcomes-not-supported`.
  - **The clients:** TypeScript `guardrails.outcomes(id, query)`; Python `guardrails.outcomes(...)`.
- 03151ca: **A union of types compiles.** A schema with `type: ['string', 'number', 'boolean', 'null']`, which is what Zod 4 writes for `z.union([z.string(), z.number(), z.boolean(), z.null()])`, used to be refused ("strict mode: use allowUnionTypes…"), while `.nullable()` compiled. It's standard JSON Schema, and every schema compiler now takes it: tool input and output, an agent's typed output, a guardrail check's config, flow and block schemas, and the pack service's validation. `ALLOW_UNION_TYPES` (`@kindgi/schema`) says so.
  - A schema that strict mode still refuses (an open tuple, an unknown keyword) says how out: for a field that may hold any JSON value, `z.json()` (or `{}` in JSON Schema) compiles.
  - The Java pack service validates a union of types too (its CHANGELOG). Python's always did.
- Updated dependencies [a6ac2e9]
- Updated dependencies [eed55a1]
- Updated dependencies [a2b2ae8]
- Updated dependencies [6a4715c]
- Updated dependencies [03151ca]
- Updated dependencies [b4bbd95]
  - @kindgi/compliance@0.1.6-rc.0
  - @kindgi/capabilities@0.1.6-rc.0
  - @kindgi/schema@0.1.6-rc.0
  - @kindgi/types@0.1.6-rc.0

## 0.1.5

### Patch Changes

- cb20b9a: The built-in guardrail checks check their config. A guardrail naming one (`must-cite`, `never-call-tool`, `max-tool-calls`, `output-matches`, `tool-order`, `required-substring`, `forbidden-substring`) with a config the check doesn't take is refused when it's registered (`POST /v1/guardrails`: `422 guardrail-config-invalid`, each problem in `details.issues`) or deployed (`deployment-validation-failed`), and if one still reaches a turn it's a check that can't run (`invalid-check-config`), so a `halt` guardrail fails closed. Before, a mistake could silently disable the rule: `never-call-tool` with `tools: "acme.refund"` (not a list) forbade nothing. Each built-in publishes its config as JSON Schema (`configSchema` on its registered check), refuses a setting it doesn't know, and checks that a regular expression compiles. A deployment's index guardrail carrying a field this version doesn't know (from a newer CLI) now deploys, the field dropped, instead of failing the deployment; `POST /v1/guardrails` stays strict. `GUARDRAIL_SPEC_KEYS` is exported from `@kindgi/guardrails`. **When you upgrade:** a guardrail registered earlier that names a built-in check with a config it doesn't take never ran its check before (the built-ins weren't running), so nothing showed; now each of its turns gets `invalid-check-config`, and with `halt` its agents' turns are blocked. List your guardrails (`kindgi guardrails list`); for each that names a built-in with a config it doesn't take, unregister it (`kindgi guardrails unregister <id>`), then register it again or redeploy, with a config that fits. The runtime also warns at start about each one it finds.
- a211c34: **A guardrail whose config its pack check would refuse can be refused at registration.**
  - **The gap:** `POST /v1/guardrails` naming a pack's check with a config that breaks the check's `configSchema` was accepted. Then the pack service refused every call, so every turn the guardrail checked failed.
  - **`createApp({ checkGuardrailConfig })`:** a runtime passes this optional hook, and the route answers **`422 guardrail-config-invalid`**:
    - the message is one sentence naming the guardrail, the check and the first problem: `Guardrail "acme.strict" doesn't fit check "my-pack.checks.answer-length": config.maxChars must be > 0.`;
    - `details.issues` lists every problem, `{ path, message }`, with `path` a JSON pointer into the guardrail (`/config/maxChars`) and `message` naming the setting (`config.maxChars must be > 0.`), the provider check's shape.
    - Without the hook, nothing changes.
  - **`Guardrail.configSchema`** is a new optional runtime-declaration field, like `codeArtifactRef`. `POST /v1/deployments` now keeps the pack index's `configSchema` on each guardrail it registers, so a runtime can check against it.
  - **`@kindgi/guardrails`:**
    - `guardrailConfigProblems({ configSchema, config })` checks the config as declared, without filling in defaults, as the indexer and the pack service do;
    - `describeGuardrailConfigProblems` words the message.
  - **Both clients** read `guardrail-config-invalid` as an invalid request, with its `issues`. The CLI prints the message and one line per issue.
- a432049: A halting guardrail whose check can't run now stops the turn; it used to let it through. A guardrail whose check isn't registered, has an invalid configuration, or whose judge can't be routed to a model (or with no check registry bound at all) no longer passes silently. A check that throws (pack code that crashed, a pack service that couldn't be reached, a judge call that failed) is one of these too: a `check-failed` evaluation error with what it threw, where it used to fail the turn whatever the guardrail's action; a cancelled turn still ends as it did. With `halt`, the turn fails with `guardrail-violation`: `violations` is empty, and `evaluationErrors` names the guardrail, the error code and why. With any other action, the turn goes on. In both cases every such error emits a `guardrail.error` turn event, adds the guardrail's provenance node (`evaluated: false`), and is listed under `errors` in the `evaluate-guardrails` step's output. `categorizeOutcomes` takes the guardrails the outcomes came from, so each error carries its guardrail's action and severity (`blockingErrors` holds the `halt` ones), and `describeBlockingViolations` names guardrails that couldn't run.
- Updated dependencies [0919fe6]
- Updated dependencies [490d083]
- Updated dependencies [e27d050]
- Updated dependencies [88953c7]
- Updated dependencies [70c5737]
- Updated dependencies [eff6249]
- Updated dependencies [0fe157e]
- Updated dependencies [646a906]
  - @kindgi/compliance@0.1.5
  - @kindgi/capabilities@0.1.5
  - @kindgi/schema@0.1.5
  - @kindgi/types@0.1.5

## 0.1.5-rc.0

### Patch Changes

- cb20b9a: The built-in guardrail checks check their config. A guardrail naming one (`must-cite`, `never-call-tool`, `max-tool-calls`, `output-matches`, `tool-order`, `required-substring`, `forbidden-substring`) with a config the check doesn't take is refused when it's registered (`POST /v1/guardrails`: `422 guardrail-config-invalid`, each problem in `details.issues`) or deployed (`deployment-validation-failed`), and if one still reaches a turn it's a check that can't run (`invalid-check-config`), so a `halt` guardrail fails closed. Before, a mistake could silently disable the rule: `never-call-tool` with `tools: "acme.refund"` (not a list) forbade nothing. Each built-in publishes its config as JSON Schema (`configSchema` on its registered check), refuses a setting it doesn't know, and checks that a regular expression compiles. A deployment's index guardrail carrying a field this version doesn't know (from a newer CLI) now deploys, the field dropped, instead of failing the deployment; `POST /v1/guardrails` stays strict. `GUARDRAIL_SPEC_KEYS` is exported from `@kindgi/guardrails`. **When you upgrade:** a guardrail registered earlier that names a built-in check with a config it doesn't take never ran its check before (the built-ins weren't running), so nothing showed; now each of its turns gets `invalid-check-config`, and with `halt` its agents' turns are blocked. List your guardrails (`kindgi guardrails list`); for each that names a built-in with a config it doesn't take, unregister it (`kindgi guardrails unregister <id>`), then register it again or redeploy, with a config that fits. The runtime also warns at start about each one it finds.
- a211c34: **A guardrail whose config its pack check would refuse can be refused at registration.**
  - **The gap:** `POST /v1/guardrails` naming a pack's check with a config that breaks the check's `configSchema` was accepted. Then the pack service refused every call, so every turn the guardrail checked failed.
  - **`createApp({ checkGuardrailConfig })`:** a runtime passes this optional hook, and the route answers **`422 guardrail-config-invalid`**:
    - the message is one sentence naming the guardrail, the check and the first problem: `Guardrail "acme.strict" doesn't fit check "my-pack.checks.answer-length": config.maxChars must be > 0.`;
    - `details.issues` lists every problem, `{ path, message }`, with `path` a JSON pointer into the guardrail (`/config/maxChars`) and `message` naming the setting (`config.maxChars must be > 0.`), the provider check's shape.
    - Without the hook, nothing changes.
  - **`Guardrail.configSchema`** is a new optional runtime-declaration field, like `codeArtifactRef`. `POST /v1/deployments` now keeps the pack index's `configSchema` on each guardrail it registers, so a runtime can check against it.
  - **`@kindgi/guardrails`:**
    - `guardrailConfigProblems({ configSchema, config })` checks the config as declared, without filling in defaults, as the indexer and the pack service do;
    - `describeGuardrailConfigProblems` words the message.
  - **Both clients** read `guardrail-config-invalid` as an invalid request, with its `issues`. The CLI prints the message and one line per issue.
- a432049: A halting guardrail whose check can't run now stops the turn; it used to let it through. A guardrail whose check isn't registered, has an invalid configuration, or whose judge can't be routed to a model (or with no check registry bound at all) no longer passes silently. A check that throws (pack code that crashed, a pack service that couldn't be reached, a judge call that failed) is one of these too: a `check-failed` evaluation error with what it threw, where it used to fail the turn whatever the guardrail's action; a cancelled turn still ends as it did. With `halt`, the turn fails with `guardrail-violation`: `violations` is empty, and `evaluationErrors` names the guardrail, the error code and why. With any other action, the turn goes on. In both cases every such error emits a `guardrail.error` turn event, adds the guardrail's provenance node (`evaluated: false`), and is listed under `errors` in the `evaluate-guardrails` step's output. `categorizeOutcomes` takes the guardrails the outcomes came from, so each error carries its guardrail's action and severity (`blockingErrors` holds the `halt` ones), and `describeBlockingViolations` names guardrails that couldn't run.
- Updated dependencies [0919fe6]
- Updated dependencies [490d083]
- Updated dependencies [e27d050]
- Updated dependencies [88953c7]
- Updated dependencies [70c5737]
- Updated dependencies [eff6249]
- Updated dependencies [0fe157e]
- Updated dependencies [646a906]
  - @kindgi/compliance@0.1.5-rc.0
  - @kindgi/capabilities@0.1.5-rc.0
  - @kindgi/schema@0.1.5-rc.0
  - @kindgi/types@0.1.5-rc.0

## 0.1.4

### Patch Changes

- 68da079: The providers skill and the `kindgi init` READMEs name each preset's default model and `claude-haiku-5-5`, and the skill says how ties now break (the provider's default model before its others), that the Claude 5.5 and GPT-6 models take no `temperature`, and how thinking counts. The guardrails README describes the `llm-judge` strategy, including its answer's token budget on a model that thinks.
- 1c0252c: **A guardrail judge on a model that thinks still gets its verdict.** Claude Sonnet 5.5 and Opus 5.5, Haiku 5.5, Gemini 3.8 Flash and OpenAI's GPT-6 models think by default, and their thinking counts against the output cap. A judge's 256 tokens could be gone before the verdict.
  - `ModelInfo.thinking` (`{ mode: 'adaptive' | 'always', lowest }`) says how a model thinks and its vendor's setting for the least thinking. The HTTP API validates it (otherwise 400, reason `invalid-thinking`) and returns it; the Python client has `ModelThinking`.
  - `ModelCallInput.thinking: 'lowest'` asks for that least. The anthropic adapter sends Sonnet 5.5's `between_tools` or Haiku 5.5's `disabled` with effort `low`, and Opus 5.5's effort `low` alone. The gemini adapter sends the thinking level (`LOW` on 3.8 Flash, which refuses `MINIMAL`; `MINIMAL` on 3.5 Flash-Lite). openai-compat sends `reasoning_effort`. A model without `thinking` gets nothing extra.
  - A guardrail judge asks for it, and on a thinking model its cap is 256 + 2048 tokens (`JUDGE_VERDICT_TOKENS`, `JUDGE_THINKING_TOKENS`).
  - The presets mark the models: anthropic's Opus, Sonnet and Haiku 5.5, gemini and gemini-api's 3.8 Flash and 3.5 Flash-Lite, openai's gpt-6.1-sol and gpt-6-luna. Re-register to pick the marks up.
- Updated dependencies [1c0252c]
- Updated dependencies [1c0252c]
- Updated dependencies [b9d3c01]
- Updated dependencies [7b63137]
- Updated dependencies [fac7472]
- Updated dependencies [f999acd]
- Updated dependencies [bd3ce67]
- Updated dependencies [26b2a23]
- Updated dependencies [e58e35c]
- Updated dependencies [2040daf]
- Updated dependencies [2923703]
- Updated dependencies [d0ebeb6]
- Updated dependencies [ae417f7]
  - @kindgi/capabilities@0.1.4
  - @kindgi/types@0.1.4
  - @kindgi/compliance@0.1.4
  - @kindgi/schema@0.1.4

## 0.1.4-rc.5

### Patch Changes

- @kindgi/capabilities@0.1.4-rc.5
  - @kindgi/compliance@0.1.4-rc.5
  - @kindgi/schema@0.1.4-rc.5
  - @kindgi/types@0.1.4-rc.5

## 0.1.4-rc.4

### Patch Changes

- Updated dependencies [f999acd]
  - @kindgi/capabilities@0.1.4-rc.4
  - @kindgi/compliance@0.1.4-rc.4
  - @kindgi/schema@0.1.4-rc.4
  - @kindgi/types@0.1.4-rc.4

## 0.1.4-rc.3

### Patch Changes

- @kindgi/capabilities@0.1.4-rc.3
  - @kindgi/compliance@0.1.4-rc.3
  - @kindgi/schema@0.1.4-rc.3
  - @kindgi/types@0.1.4-rc.3

## 0.1.4-rc.2

### Patch Changes

- Updated dependencies [bd3ce67]
- Updated dependencies [e58e35c]
- Updated dependencies [2040daf]
- Updated dependencies [ae417f7]
  - @kindgi/compliance@0.1.4-rc.2
  - @kindgi/types@0.1.4-rc.2
  - @kindgi/capabilities@0.1.4-rc.2
  - @kindgi/schema@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- @kindgi/capabilities@0.1.4-rc.1
  - @kindgi/compliance@0.1.4-rc.1
  - @kindgi/schema@0.1.4-rc.1
  - @kindgi/types@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
- Updated dependencies [2923703]
- Updated dependencies [d0ebeb6]
  - @kindgi/types@0.1.4-rc.0
  - @kindgi/capabilities@0.1.4-rc.0
  - @kindgi/compliance@0.1.4-rc.0
  - @kindgi/schema@0.1.4-rc.0

## 0.1.3

### Patch Changes

- 629057d: Every model call is recorded, with everything the provider says about it, and the cost API reads it per call, per run tree, and per org.
  
  - **Usage recording.** The agent turn records each model call in a usage sink (`InvokeAgentBindings.usage`, `UsageSink` / `ModelUsageRecord` in `@kindgi/capabilities`) before the step goes on, a call that threw included. The record carries the call id, project, run, agent and version, conversation, step, provider, the model actually called, a fallback flag, status, usage, duration and finish reason; a failed call's error carries the attempts it took. llm-judge guardrails record theirs too (`EvaluationBindings.usage`, `purpose: guardrail-judge:<id>`, with the turn's step and agent version). A dry run records nothing.
  - **A sink that fails** is tried again (`recordModelUsage`; a record is idempotent by call id). An answered call it still can't record fails the step with `persistence-error` (an llm-judge's is `judge-usage-unrecorded`, which the turn fails on the same way). A failed call keeps its own failure, and says when it couldn't be recorded either.
  - **Usage, unfolded.** `UsageCounters` reports the parts of its totals: `cacheReadTokens` and `cacheWriteTokens` are parts of `promptTokens`, `reasoningTokens` of `completionTokens`. A part is there when the provider reports it, a reported 0 included, and absent when it doesn't. `ModelCallResult` adds `servedModel` (the exact version the vendor reports), `providerRequestId`, `attempts` (HTTP attempts, the SDK's own retries included, counted with `createAttemptCounter` from `@kindgi/capabilities/attempts`, a Node-only entry; a call that throws keeps its own error, and `attemptsOf(error)` gives its attempts) and `rawUsage` (the vendor's usage object as it reported it). The Anthropic, Gemini and OpenAI-compatible adapters fill them.
  - **Breaking, for a custom model adapter:** `UsageCounters.cachedTokens` is renamed `cacheReadTokens`.
  - **Breaking, for a custom `CostBinding`:** `tokens` is required on `CostAggregateGroup` and `CostAggregateResult`, and a binding that can't read should throw (the API answers 500) rather than return an empty page.
  - **Cost API (`@kindgi/api`, `@kindgi/client`).** A cost record of a model call carries `callId`, `projectId`, `rootRunId`, `parentRunId`, `agentVersion`, `flowId`, `nodeId`, `step`, `purpose`, `model`, `servedModel`, `fallback`, `status`, `usage`, `durationMs`, `finishReason`, `providerRequestId`, `attempts` and `error`, and `rawUsage` with `include=rawUsage`. New filters: `model`, `servedModel`, `rootRunId`, `includeDescendants` (with `runId`). New `groupBy` dimensions: `model`, `servedModel`, `projectId`, `orgId`, `rootRunId`, `flowId`. Every aggregate group and the total carry `tokens: {prompt, completion, cacheRead, cacheWrite, reasoning}`. A binding that fails answers 500, never an empty page. `to` is exclusive, as the binding always applied it. The TypeScript client takes `scope`, the new filters and `includeRawUsage`.
  - **`run.finished`** carries `usage: {calls, costUsd, tokens}` (`RunTreeUsage`) for the run tree, when the runtime records usage: what the ledger had recorded when the run finished, failed calls counted (a child run still running then isn't in it).
  - **Clients:** `includeDescendants` is a boolean query parameter; the Python client names a cost record's error `ModelCallError`.
  - **Provenance (breaking for readers of `model-call` attributes):** a `model-call` node keeps the call's identity (`callId`, `providerId`, `model`, `finishReason`, `step`); its `promptTokens`, `completionTokens` and `costUsd` are gone from `attributes`. A provenance read carries them in `callUsage`, by `callId`, from the cost ledger, outside the signed DAG (`ProvenanceBinding.getCallUsage`). A signed export includes `callUsage` as it stood when signed (bundle schema `1.1.0`).
- eac7732: A tool knows its run's project and org: `ToolContext.projectId` and `orgId` (Python: `project_id`, `org_id`), and a guardrail check's trace gets `orgId` (`org_id`) next to `projectId`. The runtime sets them from the run and its project, never from the run's input or a model's arguments, so a tool can compare an org or project id in its input with the run's own instead of trusting it. `orgId` is absent when the project has no org. They reach pack code in the call context: pack protocol 2.3.0 adds optional `projectId` and `orgId` to `callContext`. A pack service built with Kindgi 0.1.1 answers such calls as before (it checks only `v`, `tenantId` and `runId`); `@kindgi/pack-conformance` has a suite that proves it against the 0.1.1 releases (`describeCallContextCompatibility`). Also: `NodeContext.projectId` / `orgId` for the kernel, and `InvokeAgentInput.orgId` and `ResumeAgentTurnInput.orgId`, so a turn resumed after an approval keeps its org.
- Updated dependencies [629057d]
- Updated dependencies [1463b77]
  - @kindgi/capabilities@0.1.3
  - @kindgi/types@0.1.3
  - @kindgi/compliance@0.1.3
  - @kindgi/schema@0.1.3

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- afd259f: A TypeScript guardrail's config is resolved by its check's `configSchema`, as Python's guardrails do. `defineCheck`'s `evaluate` gets the schema's defaults applied (a guardrail that declares no config gets them all, so `z.number().default(1)` is 1, not `undefined`), and a config that doesn't fit is refused, naming where. The indexer checks each guardrail's `config` against its schema: a config that doesn't fit, or a required field with no default left out, is a file error, and `kindgi build` refuses the pack.
- Updated dependencies [966a615]
- Updated dependencies [89a14b6]
  - @kindgi/capabilities@0.1.2
  - @kindgi/compliance@0.1.2
  - @kindgi/schema@0.1.2
  - @kindgi/types@0.1.2

## 0.1.1

### Patch Changes

- @kindgi/capabilities@0.1.1
  - @kindgi/compliance@0.1.1
  - @kindgi/schema@0.1.1
  - @kindgi/types@0.1.1

## 0.1.0

### Minor Changes

- aec851d: Guardrail checks stop when the turn does.
  
  - `@kindgi/guardrails`: `EvaluationBindings.abortSignal` (optional). It fires when the caller stops waiting: the agent turn was cancelled, or ran past its wall-clock budget. The llm-judge strategy passes it to the judge's model call. A check that calls out to a model or a service should pass it on.
  - `@kindgi/agents`: the turn's abort signal reaches every guardrail check. `evaluateGate` takes it as a fifth argument. Before, a slow or stuck judge, or a pack check, held the turn past its budget.
- aec851d: The JSON Schemas now describe what the code accepts (agent 1.1.0, capability 1.1.0, flow 1.9.0, guardrail 1.1.0, pack 1.1.0). The bundled copies in `@kindgi/capabilities`, `@kindgi/flow` and `@kindgi/guardrails` match.
  
  - **BREAKING — `agent.schema.json` 1.1.0:** `tools` entries are `{ id, version }` references (`version` is an npm semver range), matching `ToolRef` and `defineAgent`. Agent JSON with bare-string tool ids — which `defineAgent` already rejected — now fails schema validation too.
  - **BREAKING — `pack.schema.json` 1.1.0:** a pack agent's `tools` use the same `{ id, version }` references (`agent.schema.json#/$defs/ToolRef`). Pack manifests with bare-string tool ids now fail validation.
  - **`capability.schema.json` 1.1.0:** new optional `kind` (default `llm-inference`), which the router already reads, and a `models` requirement (`{ models: { allow?, deny? } }`) next to `providers`. `defineCapability` validates through this schema, so it now accepts both.
  - **BREAKING — `flow.schema.json` 1.9.0:** the top-level `triggers` array is gone. No code read it — schedules, event triggers and webhooks are registered through their own APIs and name the flow they start. Flow JSON that still declares `triggers` now fails `loadFlow`.
  - **BREAKING — `guardrail.schema.json` 1.1.0:** `check` is required, as in the `Guardrail` type (`defineGuardrail` already failed without a registered check), and a `retry` action requires `maxAttempts`. `POST /v1/guardrails` rejects a spec without `check`.
  - **`guardrail.schema.json` 1.1.0 (widening, not breaking):** `kind` and `on-violation` accept any non-empty string — the built-ins are listed as `examples` — so `defineGuardrail`, `validateGuardrailSpec`, the API and the client accept adapter kinds and custom actions. `defineGuardrail` still requires a registered check of the guardrail's kind, and still checks the action's shape. The schema also allows `sandbox`, `limits`, `network` and `needsSpec`, which the type declares, with the same shapes as on tools.
  - **`@kindgi/guardrails`:** when `evaluateGuardrail` runs with `EvaluationBindings.actions` and the fired action has no registered handler, it returns the new `unknown-action` error naming the action (after the violation is recorded) instead of skipping the action silently.
  - **`@kindgi/api` / `@kindgi/client`:** the `Guardrail` wire schema and client types require `check` and `retry.maxAttempts`, and take `kind` / `on-violation` as open strings.
  - **`@kindgi/specs` README:** until the first stable release, a breaking schema change is a minor bump with a version-history note; the major-`$id` rule applies from 1.0.0.

### Patch Changes

- aec851d: Messages and variable descriptions no longer point at internal components: `KINDGI_API_PORT` / `KINDGI_OPENFGA_API_URL` / `KINDGI_SECRETS_BACKEND` descriptions say what the runtime does; the `external` guardrail strategy's error says to register an execution strategy; the payload-version error reads "Unsupported payload version N (this reader handles version M)" — it was worded "newer than this reader" also for older versions.
- aec851d: LLM-judge guardrails route under the tenant policy.
  
  - `@kindgi/guardrails`: `EvaluationBindings.tenantPolicy`. When set, the judge model is routed under it (provider / model allow and deny lists, `regionAllow`, caps), and an explicit `judgeProvider` must satisfy it too — otherwise the check fails with `judge-routing-failed`. Previously judges were routed with no tenant policy, so a tenant restricted to one region could have its run output sent to a judge model elsewhere.
  - `@kindgi/agents`: the turn passes the tenant policy it was routed under (bound policy merged with the policy registry's) to guardrail evaluation; `evaluateGate` takes it as an optional fourth argument.
- aec851d: JSON Schema descriptions (51, across 12 schemas and their bundled copies) now match the code and stay inside this repository: neutral examples (`acme.*`), no vendor names the code doesn't target, "the Kindgi runtime" instead of "the OS", no roadmap notes, and corrected claims (tool `needs` are declarative, `capability-unsatisfiable` happens at routing time, `step.cancelled` wording, SSE `eventId`). `Capability.budget` and `Guardrail.budget` are documented as declarative — not enforced by the runtime — in the schemas and the TypeScript types. Only `description` values changed; keys, types, enums and `$comment` schema versions are unchanged.
- aec851d: Tool inputs get their Zod defaults, transforms and refinements.
  
  - `@kindgi/schema`:
    - `toJSONSchema(schema, io)` and `toJSONSchemaSync(schema, converter, io)` take a required `io` (`SchemaIo`, `'input'` or `'output'`). The two sides differ exactly where Zod defaults: on the input side a `.default()` field is optional, on the output side it is required. Before, every conversion produced the output side.
    - `parseWithSchema(schema, value)` parses through a Zod schema's Standard Schema interface: defaults, transforms and refinements applied, or the issues.
  - `@kindgi/tools`:
    - A tool's advertised input schema is the input side, so a model may leave a defaulted field out.
    - `invokeTool` validates a copy of the input, filling in JSON Schema `default`s. A Zod-authored tool's input is then parsed with `inputZod`, so the handler gets its parsed input. A failed refinement is `input-validation-failed`, with the field's path.
    - A handler's input type defaults to `InferOutput` of the input schema, the parsed type.
  - `@kindgi/handler-runtime`: `runWorker`, which the pack service runs tools through, prepares the input the same way. The indexer converts tool inputs and guardrail config on the input side.
  - `@kindgi/guardrails`: a check's config schema converts on the input side.
  - `@kindgi/agents`: a typed agent's output schema converts on the output side, so downstream steps can rely on every field.
  - `@kindgi/sdk`: the tools skill explains what a handler receives.
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/capabilities@0.1.0
  - @kindgi/types@0.1.0
  - @kindgi/schema@0.1.0
  - @kindgi/compliance@0.1.0
