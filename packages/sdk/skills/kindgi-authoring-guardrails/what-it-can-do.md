# What a guardrail can do in 0.1

Read this before you plan a guardrail. These decide what can be built:

- **`halt` and `retry` act.** At the final answer, a failed `halt`
  guardrail fails the turn with `guardrail-violation`, and the response is
  not stored. A failed `retry` guardrail sends the answer back to the
  model, with the check's reason in a user message, for a new one; the
  failed answer isn't stored. When it has failed `action.retry.maxAttempts`
  answers (the first one included; 2 when left out), the turn fails with
  `guardrail-violation` and `details.attempts`. Each new answer is a model
  call that the agent's `budget.maxSteps` counts. With a `retry` guardrail
  at the final answer, the `halt` and `retry` guardrails there judge each
  answer, a judge's calls included, which `budget.maxCostUsd` doesn't
  count; the others judge only the answer that's sent. A new answer can
  call tools again, side-effecting ones included, with approvals as usual.
  `escalate` and `compensate` are recorded on the turn's violations, as
  `log-only` is, and the turn completes: nothing escalates or calls a
  compensating tool. So "block the reply and make the agent try again" is
  a `retry` guardrail.
- **They act in the loop too.** At `'before-tool'` (after the call's
  access check, before any approval is asked), `halt` fails the turn and
  `retry` refuses the call: it doesn't run, and the model gets the reason
  as its result. At `'after-tool'`, `retry` withholds the result: the
  reason is stored as the call's result in its place, so neither the model
  nor a later turn's history sees it; a replay's recorded result is judged
  as a live one is. At `'model-step'`, `retry` sends the reply back: none
  of its calls runs, nothing of it is stored, and the model writes a new
  reply. `retry.maxAttempts` counts replies across the turn: each reply
  the guardrail sent back, or one with a call it refused or a result it
  withheld, counts once, so two calls of one reply that it refuses are one
  attempt. When they run out, or the turn has no steps left, the turn
  fails with `attempts`, the replies there were. A tool's own result never
  counts as one. A `log-only` failure joins the turn's `violations`. A
  dry run skips the model call, so no guardrail runs at these points in
  one.
  `escalate` and `compensate` are refused away from the final answer
  (by `kindgi build`, `deployment-validation-failed` on deploy,
  `400 validation-failed` on register). A failure names `details.point` and, at a tool point,
  `details.callId`. A resumed turn reuses each point's recorded outcome:
  no judge is asked or billed twice.
- **A check sees one turn, unless its guardrail says
  `sees: 'conversation'`.** The trace holds the current turn: its user
  message (`trace.userInput`), its tool calls and their results
  (`trace.toolCalls`, `trace.toolResults`) and its response
  (`trace.output`, at the final answer only). With `'conversation'`,
  `trace.earlier` adds the earlier turns the model was given (all, or the
  agent's `conversationPolicy.historyLimit` window), oldest first, each
  `{ userInput?, output?, toolCalls, toolResults }`; on a first turn it's
  `[]`. An llm-judge then also sends its judge their messages, calls and
  answers, quoted, as data.
- **A check's in-memory state doesn't last.** The check runs in the pack
  service's process, so anything it keeps at module level (say, a record
  per `trace.conversationId`) is lost when that process is replaced: under
  `kindgi dev`, on every reload after a save and on a restart; in a
  deployment, whenever an instance stops. With more than one instance,
  each keeps its own copy, and one conversation's turns can land on
  different instances. Don't keep a conversation's history this way.

A check that every figure in the response comes from a tool result or a
user's message reads `trace.earlier` with the current turn, under
`sees: 'conversation'`. Without it, a figure seen only in an earlier
turn fails the check.
