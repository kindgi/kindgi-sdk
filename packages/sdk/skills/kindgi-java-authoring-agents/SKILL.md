---
name: kindgi-java-authoring-agents
description: >
  Covers writing agents for a Kindgi pack in Java (`com.kindgi:kindgi-pack`):
  `Agent.define(id)` as a `public static final` field, wiring tools (`Tool`
  objects or an id with a version range) and guardrails, capabilities and
  model choice (preferredProvider / preferredModel), conversation policy,
  turn budgets, prompt parameters, a typed answer from a record, and
  tool-error retries, all as data. Load this whenever you are authoring or
  editing code in a Java pack's agents packages (a pack whose
  `kindgi.config.json` says `"language": "java"`), defining an agent, or
  when the user asks to add, change or refactor one. Java tools are covered
  by kindgi-java-authoring-tools, Java guardrails by
  kindgi-java-authoring-guardrails, connecting a real model by
  kindgi-authoring-providers.
type: core
library: "kindgi-pack (Java)"
version: "0.1.0"
sdk_version: "0.0.0"
pack_languages: [java]
sources:
  - sdks/java/kindgi-pack/README.md
  - sdks/java/kindgi-pack/src/main/java/com/kindgi/pack/Agent.java
  - packages/specs/schemas/agent.schema.json
  - packages/specs/schemas/pack-index.schema.json
---

# Authoring Kindgi agents in Java

> **Running `kindgi`:** the pack pins its CLI (`"cli"` in
> `kindgi.config.json`), and `./kindgiw` runs that version, so every
> `kindgi <command>` below runs as `./kindgiw <command>`. Maven runs as
> `./mvnw`.
>
> Java support is in preview: tested and supported, but the API may still
> change in 0.1.6 without the usual deprecation period.

An **agent** is a versioned, model-driven orchestrator. It's made of:
- instructions (a prompt template);
- the tools it may call;
- the capabilities its model needs;
- guardrails that gate its answer;
- optionally, a conversation policy.

In a Java pack it is **data**: a `public static final Agent` field of a class
in an `agents` package. The model runs in the Kindgi runtime, not in your
JVM. Your Java code runs only inside the agent's tools and guardrail checks.

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

```java
// src/main/java/acme/agents/BriefWriter.java
package acme.agents;

import acme.guardrails.ResponseNotEmpty;
import acme.tools.Echo;
import com.kindgi.pack.Agent;
import java.util.List;
import java.util.Map;

/** acme.brief-writer: drafts a brief's argument from the case facts. */
public final class BriefWriter {
  /** The typed answer: the final message must be JSON of this shape. */
  public record Brief(String argument, List<String> citations) {}

  public static final Agent AGENT = Agent.define("acme.brief-writer")
      .version("0.1.0")
      .name("Brief Writer")
      .description("Drafts appellate briefs from a case file; cites precedents.")
      .instructions("You are drafting a brief in {{ jurisdiction }}. The user gives the case facts; you write "
          + "a Section IV argument citing at least two precedents. Check every cite with the echo tool "
          + "before using it. Never invent one.")
      .capability(Map.of("needs", List.of(Map.of("feature", "tool-use"))))
      .tool(Echo.TOOL)
      .guardrail(ResponseNotEmpty.GUARDRAIL)
      .set("parameters", List.of(Map.of("name", "jurisdiction", "type", "string", "required", true)))
      .set("conversationPolicy", Map.of("historyLimit", 20))
      .set("budget", Map.of("maxSteps", 8, "maxCostUsd", 0.5, "maxWallMs", 60_000))
      .set("toolErrors", Map.of("maxRetries", 1, "retryOn", List.of("invalid-arguments", "unknown-tool")))
      .output(Brief.class)
      .build();

  private BriefWriter() {}
}
```

- Tools and guardrails are the pack's own fields, imported like any class:
  `.tool(Echo.TOOL)`, `.guardrail(ResponseNotEmpty.GUARDRAIL)`.
- **`build()` needs a version, a name and instructions.** Anything missing
  is an error where the agent is defined, and the indexer reports it with
  the file.
- **Every other field is `set(field, value)`, keyed as on the wire:** the
  field and its maps are camelCase (`conversationPolicy`, `maxSteps`,
  `historyLimit`), as `agent.schema.json` names them. The indexer checks
  each agent against the pack index's schema, and `kindgi dev` reports a
  mistake with its file.
- A class may hold several agents, each in its own `static final` field.

## Field by field

- **`id`:** `<pack-id>.<agent-name>`, kebab-case, dot-namespaced.
- **`version`:** an exact semver. Conversations pin the version they started
  on.
- **`name`, `description`**, and `set("tags", List.of(…))`: for people and
  listings. The model never sees the description.
- **`instructions`:** a LiquidJS template. `{{ variable }}` comes from
  `parameters` or the runtime's own variables (`today`, `now`, `agent.*`,
  `conversation.*`). It's rendered strictly: an unknown variable fails the
  turn. Write it as a brief for a capable colleague: what to do, which tools
  to prefer, what to refuse, the quality bar. Name a tool by what it does
  ("the verify-citation tool"), never by its dotted id. The model sees ids in
  its provider's form (`acme__verify-citation` for Anthropic and
  OpenAI-compatible models), and a dotted id in the instructions can make it
  call a name it wasn't given. `instructions(Map.of("prompt", …, "version", …))`
  references a registered prompt block instead.
- **`capability(Map)`:** what the model must support, such as
  `Map.of("needs", List.of(Map.of("feature", "tool-use")))`. Call it once per
  capability. The turn routes its first capability to pick a provider and
  model; with none declared, the turn fails.
- **`tool(Tool)`:** pins that tool's version (its own, or the pack's).
  **`tool(id, range)`** is a tool of another pack, with a semver **range**
  (`"^1.0.0"`); the highest active matching version is picked at turn
  start. An agent with no tools is chat-only.
- **`guardrail(Guardrail)`** or **`guardrail(id)`:** evaluated once per turn
  on the final answer, before it is stored. An id with no registered
  guardrail fails the turn.
- **`set("parameters", List.of(Map.of("name", …, "type", …, "required", …)))`:**
  inputs the caller supplies per run. They fill `{{ … }}` in the
  instructions.
- **`set("preferredProvider", "anthropic")`, `set("preferredModel", "claude-haiku-5-5")`:**
  soft hints. The router prefers them when they satisfy the capabilities.
  To *require* a model, put it in the capability:
  `Map.of("needs", List.of(Map.of("feature", "tool-use"), Map.of("models", Map.of("allow", List.of("claude-haiku-5-5")))))`.
- **`set("conversationPolicy", …)`:** `historyLimit` caps the prior messages
  loaded, and `hitl` configures approval gates. Absent, the turn loads the
  full history with no gates. A tenant's `hitl` policy can tighten the gates
  (a shorter timeout, a higher reviewer role, stricter per tool), never
  loosen them.
- **`set("budget", …)`:** per turn. `maxSteps` counts model calls (default
  8); `maxCostUsd`; `maxWallMs` (default 120 000). Exceeding the steps or the
  cost fails the turn (`budget-exceeded`); running out of wall time aborts
  it. Leave room for real models: a turn with tool calls can take tens of
  seconds.
- **`output(Type.class)`:** a typed answer, with its schema derived from the
  record. The final answer must be JSON matching it. A wrong one goes back
  to the model with the problems (`maxRepairs`, default 1), and then the
  turn fails (`output-schema-violation`). For `maxRepairs` or a schema of
  your own, use `set("output", Map.of("schema", …, "maxRepairs", 2))`. The
  parsed answer is the turn result's `output`. In a flow it is
  `nodeOutputs.<step>.output.<field>`.
- **`set("toolErrors", …)`:** `maxRetries` and `retryOn`. A failed tool call
  goes back to the model as the call's result, so it can fix the call. The
  default kinds are `invalid-arguments` and `unknown-tool` (nothing ran). Add
  `tool-error` only when retrying the tool is safe. Each retry costs a step.

## Which model answers

Agents run on a registered model provider: the router picks one whose
models satisfy the capabilities. `kindgi dev` gives a new pack `dev-echo`, a
**fallback** that answers only while no other provider fits. It calls the
first tool and replies "⚠ dev-echo isn't a real model: …", then "Tool
responded: …". The turn carries the `fallback-provider` and
`dev-echo-not-a-model` warnings. dev-echo can't fill in any other tool
input, and can't give a typed answer: an agent with `output` fails with
`output-schema-violation` until a real model is registered. To register one,
see `kindgi-authoring-providers` (`./kindgiw providers register --preset=anthropic`,
or `"providers": [{"preset": "anthropic"}]` in `kindgi.config.json`).

## Iterating

Save the file: `kindgi dev` recompiles, re-indexes, and the next run uses
it, with no restart. Bump `version` when you break what callers rely on (a
removed parameter, an incompatible output), not on every save.

Run an agent from another terminal in the pack directory:

```sh
./kindgiw runs start --agent=acme.brief-writer --input='{"userMessage":"…","parameters":{"jurisdiction":"US"}}'
```

or from a Java app with the client (`kindgi-java-getting-started`).

## Common mistakes

1. **Building an agent without asking what it should do.** Copying the
   sample's shape answers the wrong question.
2. **No `capability(…)`.** The turn can't pick a model.
3. **Java names inside the maps.** `set("budget", Map.of("max_steps", 4))`
   isn't a budget: the keys are the wire's camelCase (`maxSteps`,
   `historyLimit`, `maxRetries`).
4. **An unregistered guardrail id.** Pass the `Guardrail` field, or make sure
   the id is one the tenant has.
5. **`{{ variable }}` not in `parameters`.** The turn fails when the
   instructions render.
6. **An agent that isn't a `static final` field.** Only static fields are
   indexed.
7. **A tight `maxWallMs` with a real model.** 15 s aborts real turns under
   load; 60 s is a safer start.
8. **Expecting dev-echo to give a typed answer.** It can't: register a real
   model first.

## When the framework itself is the problem

If the bug is in Kindgi or kindgi-pack (the index dropping a field, a
misleading error, the router picking the wrong model) and not in the pack's
code, load `kindgi-framework-feedback` and file it with
`./kindgiw feedback write`.
