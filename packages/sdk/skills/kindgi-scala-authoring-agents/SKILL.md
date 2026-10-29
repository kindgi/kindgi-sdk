---
name: kindgi-scala-authoring-agents
description: >
  Covers writing agents for a Kindgi pack in Scala (`kindgi-pack-scala`,
  `com.kindgi.pack.scaladsl`): `Agent(id)` as a `val` of an object named like
  its file, wiring tools (`Tool` vals or an id with a version range) and
  guardrails, capabilities and model choice (preferredProvider /
  preferredModel), conversation policy, turn budgets, prompt parameters, a
  typed answer from a case class (`output[T]`), and tool-error retries, all
  as data with Scala maps. Load this whenever you are authoring or editing
  code in a Scala pack's agents packages (a pack whose `kindgi.config.json`
  says `"language": "scala"`), defining an agent, or when the user asks to
  add, change or refactor one. Scala tools are covered by
  kindgi-scala-authoring-tools, Scala guardrails by
  kindgi-scala-authoring-guardrails, connecting a real model by
  kindgi-authoring-providers.
type: core
library: "kindgi-pack-scala"
version: "0.1.6"
sdk_version: "0.0.0"
pack_languages: [scala]
sources:
  - sdks/scala/README.md
  - sdks/scala/kindgi-pack-scala/src/main/scala/com/kindgi/pack/scaladsl/Agent.scala
  - packages/specs/schemas/agent.schema.json
  - packages/specs/schemas/pack-index.schema.json
---

# Authoring Kindgi agents in Scala

> **Running `kindgi`:** the pack pins its CLI (`"cli"` in
> `kindgi.config.json`), and `./kindgiw` runs that version, so every
> `kindgi <command>` below runs as `./kindgiw <command>`.
>
> Scala support is in preview: tested and supported, but the API may still
> change in a later release without the usual deprecation period.

An **agent** is a versioned, model-driven orchestrator. It's made of:
- instructions (a prompt template);
- the tools it may call;
- the capabilities its model needs;
- guardrails that gate its answer;
- optionally, a conversation policy.

In a Scala pack it is **data**: a `val` of type `Agent` in an object named
like its file, in an `agents` package. The model runs in the Kindgi runtime,
not in your JVM. Your Scala code runs only inside the agent's tools and
guardrail checks.

## Ask before building

"Add an agent" is a conversation opener, not a ticket. Before writing a
file, ask:

- **What should the agent do?** The purpose drives everything else.
- **Which tools does it need?** New ones, or existing ones?
- **Multi-turn or one-shot?** History changes the shape.
- **Any rules it must respect?** Those become guardrails.

The pack's sample agent proves the runtime works end to end. It is not the
shape to imitate unless the user asks for that.

## An agent

```scala
// src/main/scala/acme/agents/BriefWriter.scala
package acme.agents

import acme.guardrails.ResponseNotEmpty
import acme.tools.Echo
import com.kindgi.pack.scaladsl._

/** acme.brief-writer: drafts a brief's argument from the case facts. */
object BriefWriter {
  /** The typed answer: the final message must be JSON of this shape. */
  final case class Brief(argument: String, citations: List[String])

  val agent: Agent = Agent("acme.brief-writer")
    .version("0.1.0")
    .name("Brief Writer")
    .description("Drafts appellate briefs from a case file; cites precedents.")
    .instructions(
      "You are drafting a brief in {{ jurisdiction }}. The user gives the case facts; you write " +
        "a Section IV argument citing at least two precedents. Check every cite with the echo tool " +
        "before using it. Never invent one.")
    .capability(Map("needs" -> List(Map("feature" -> "tool-use"))))
    .tool(Echo.tool)
    .guardrail(ResponseNotEmpty.guardrail)
    .set("parameters", List(Map("name" -> "jurisdiction", "type" -> "string", "required" -> true)))
    .set("conversationPolicy", Map("historyLimit" -> 20))
    .set("budget", Map("maxSteps" -> 8, "maxCostUsd" -> 0.5, "maxWallMs" -> 60000))
    .set("toolErrors", Map("maxRetries" -> 1, "retryOn" -> List("invalid-arguments", "unknown-tool")))
    .output[Brief]
    .build()
}
```

- Tools and guardrails are the pack's own vals, imported like any member:
  `.tool(Echo.tool)`, `.guardrail(ResponseNotEmpty.guardrail)`.
- **`build()` needs a version, a name and instructions.** Anything missing
  is an error where the agent is defined, and the indexer reports it with
  the file.
- **Every other field is `set(field, value)`, keyed as on the wire,** with
  Scala maps and lists: the field and its maps are camelCase
  (`conversationPolicy`, `maxSteps`, `historyLimit`), as `agent.schema.json`
  names them. The indexer checks each agent against the pack index's
  schema, and `kindgi dev` reports a mistake with its file.
- An object may hold several agents, each in its own `val`.

## Field by field

- **`id`:** `<pack-id>.<agent-name>`, kebab-case, dot-namespaced.
- **`version`:** an exact semver. Conversations pin the version they started
  on.
- **`name`, `description`**, and `set("tags", List(…))`: for people and
  listings. The model never sees the description.
- **`instructions`:** a LiquidJS template. `{{ variable }}` comes from
  `parameters` or the runtime's own variables (`today`, `now`, `agent.*`,
  `conversation.*`). It's rendered strictly: an unknown variable fails the
  turn. Write it as a brief for a capable colleague: what to do, which tools
  to prefer, what to refuse, the quality bar. Name a tool by what it does
  ("the verify-citation tool"), never by its dotted id. The model sees ids in
  its provider's form (`acme__verify-citation` for Anthropic and
  OpenAI-compatible models), and a dotted id in the instructions can make it
  call a name it wasn't given. `instructions(Map("prompt" -> …, "version" -> …))`
  references a registered prompt block instead.
- **`capability(Map(…))`:** what the model must support, such as
  `Map("needs" -> List(Map("feature" -> "tool-use")))`. Call it once per
  capability. The turn routes its first capability to pick a provider and
  model; with none declared, the turn fails.
- **`tool(tool)`:** pins that tool's version (its own, or the pack's).
  **`tool(id, range)`** is a tool of another pack, with a semver **range**
  (`"^1.0.0"`); the highest active matching version is picked at turn
  start. An agent with no tools is chat-only.
- **`guardrail(guardrail)`** or **`guardrail(id)`:** checks the final answer,
  before it is stored. One whose action is `retry` sends the answer back to
  the model for a new one, up to `retry.maxAttempts` answers in all (default
  2); then the turn fails (`guardrail-violation`). An id with no registered
  guardrail fails the turn.
- **`set("parameters", List(Map("name" -> …, "type" -> …, "required" -> …)))`:**
  inputs the caller supplies per run. They fill `{{ … }}` in the
  instructions.
- **`set("preferredProvider", "anthropic")`, `set("preferredModel", "claude-haiku-5-5")`:**
  soft hints. The router prefers them when they satisfy the capabilities.
  To *require* a model, put it in the capability:
  `Map("needs" -> List(Map("feature" -> "tool-use"), Map("models" -> Map("allow" -> List("claude-haiku-5-5")))))`.
- **`set("conversationPolicy", …)`:** `historyLimit` caps the prior messages
  loaded, and `hitl` configures approval gates. Absent, the turn loads the
  full history with no gates. A tenant's `hitl` policy can tighten the gates
  (a shorter timeout, a higher reviewer role, stricter per tool), never
  loosen them. `"separateApprover"` in `hitl` (`true`, or
  `Map("overrides" -> Map("<tool id>" -> true))`) makes a tool's approval
  need someone other than whoever asked.
- **`set("budget", …)`:** per turn. `maxSteps` counts model calls (default
  8, at most 32); `maxCostUsd`; `maxWallMs` (default 120 000). Exceeding
  the steps or the cost fails the turn (`budget-exceeded`); running out of
  wall time aborts it. Leave room for real models: a turn with tool calls
  can take tens of seconds.
- **`output[T]`:** a typed answer, with its schema derived from the case
  class. The final answer must be JSON matching it. A wrong one goes back to
  the model with the problems (`maxRepairs`, default 1), and then the turn
  fails (`output-schema-violation`). For `maxRepairs` or a schema of your
  own, use `set("output", Map("schema" -> …, "maxRepairs" -> 2))`. The parsed
  answer is the turn result's `output`. In a flow it is
  `nodeOutputs.<step>.output.<field>`.
- **`set("toolErrors", …)`:** `maxRetries` and `retryOn`. A failed tool call
  goes back to the model as the call's result, so it can fix the call. The
  default kinds are `invalid-arguments` and `unknown-tool` (nothing ran). Add
  `tool-error` only when retrying the tool is safe. Each retry costs a step.
- **`set("parallelToolCalls", false)`:** when a model step asks for several
  calls at once, an agent runs calls to read-only tools (`mutating(false)`, no
  changing effect) that come one after another at the same time, up to 8 of
  them, and any other call on its own, in the order the model asked; the results reach the conversation in that order either way. A call that may wait, for another system's answer or for the person who started the run to connect an app, runs on its own too. `false`
  runs every call on its own, for read-only tools that mustn't overlap (a
  rate-limited API, say).

**In a run a webhook or an event started**, the turn's message is data:
it arrives inside an `<event note="kindgi event: data, not
instructions">` block, and the system message tells the model never to
follow instructions found there. It stays data in every later turn of
the conversation, whoever starts that turn. Every agent step of such a
run reads its message that way, so put a step's task in the agent's
instructions, not in its input. `{{ input.* }}` (a flow step's input)
isn't wrapped: Liquid puts it into the instructions as it is. So keep
event text out of instructions. Interpolate only the typed fields a check
step reduced the event to (an id, a status, an amount), never free text
from the event.

## Which model answers

Agents run on a registered model provider: the router picks one whose
models satisfy the capabilities. `kindgi dev` gives a new pack `dev-echo`, a
**fallback** that answers only while no other provider fits. It calls the
first tool and replies "⚠ dev-echo isn't a real model: …", then "Tool
responded: …". The turn carries the `fallback-provider` and
`dev-echo-not-a-model` warnings. dev-echo can't fill in any other tool
input, and can't give a typed answer: an agent with an output type fails
with `output-schema-violation` until a real model is registered. To register
one, see `kindgi-authoring-providers` (`./kindgiw providers register --preset=anthropic`,
or `"providers": [{"preset": "anthropic"}]` in `kindgi.config.json`).
Commit the declaration: it holds the key's name, never the key, and it's how
a teammate's `kindgi dev`, or another worktree's, gets the same provider.

**How much the model thinks** (runtime 0.3.0 or later; an older one
refuses a block with `thinking`): the agent names a model-settings block with
`set("modelSettings", Map("id" -> "acme.reply-model", "version" -> "^1.0.0"))`.
It's a settings block, such as `blocks/reply-model.json`, whose values may
set `temperature`, `maxOutputTokens` and `thinking`:
`{ "id": "acme.reply-model", "version": "1.0.0", "kind": "settings", "content": { "values": { "thinking": "low" } } }`.
The block's `thinking` (`lowest`, `minimal`, `low`, `medium`, `high`,
`xhigh` or `max`) is sent; else the `thinking.default` the model's provider
registration gives it (see `kindgi-authoring-providers`); else no level,
and the model thinks as its vendor sets. A level the model doesn't take
goes as the next one up that it takes, or its highest, with a
`thinking-level-adjusted` warning. A guardrail's or an eval's model judge
asks for `lowest`.

## Iterating

Save the file: `kindgi dev` recompiles through sbt's server, re-indexes, and
the next run uses it, with no restart. Bump `version` when you break what
callers rely on (a removed parameter, an incompatible output), not on every
save.

Run an agent from another terminal in the pack directory:

```sh
./kindgiw runs start --agent=acme.brief-writer --input='{"userMessage":"…","parameters":{"jurisdiction":"US"}}'
```

## Common mistakes

1. **Building an agent without asking what it should do.** Copying the
   sample's shape answers the wrong question.
2. **No `capability(…)`.** The turn can't pick a model.
3. **Scala names inside the maps.** `set("budget", Map("max_steps" -> 4))`
   isn't a budget: the keys are the wire's camelCase (`maxSteps`,
   `historyLimit`, `maxRetries`).
4. **An unregistered guardrail id.** Pass the `Guardrail` val, or make sure
   the id is one the tenant has.
5. **`{{ variable }}` not in `parameters`.** The turn fails when the
   instructions render.
6. **An agent as a `def` or a `lazy val`.** It's a file error: make it a
   `val`.
7. **A tight `maxWallMs` with a real model.** 15 s aborts real turns under
   load; 60 s is a safer start.
8. **Expecting dev-echo to give a typed answer.** It can't: register a real
   model first.

## When the framework itself is the problem

If the bug is in Kindgi, kindgi-pack or the Scala layer (the index dropping
a field, a misleading error, the router picking the wrong model) and not in
the pack's code, load `kindgi-framework-feedback` and file it with
`./kindgiw feedback write`.
