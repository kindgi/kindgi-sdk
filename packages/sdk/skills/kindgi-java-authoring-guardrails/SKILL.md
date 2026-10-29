---
name: kindgi-java-authoring-guardrails
description: >
  Covers writing guardrails (safety checks on an agent's turn) for a Kindgi
  pack in Java (`com.kindgi:kindgi-pack`): `Guardrail.define(id)` as a
  `public static final` field, a `(config, trace)` check returning a
  `CheckResult`, `RunTrace`, config records and the values a check runs
  with, actions, severity and scope, unit tests with `evaluate`, and wiring
  a guardrail onto an agent. halt fails the turn and retry sends the answer
  back to the model for a new one (escalate / compensate are only recorded
  in 0.1), and a check sees only the current turn: its user message and tool
  results, not earlier turns'. Load this whenever you are authoring or
  editing code in a Java pack's guardrails packages (a pack whose
  `kindgi.config.json` says `"language": "java"`), defining a check, or
  wiring a guardrail onto an agent. Java agents are covered by
  kindgi-java-authoring-agents, Java tools by kindgi-java-authoring-tools.
type: core
library: "kindgi-pack (Java)"
version: "0.1.4"
sdk_version: "0.0.0"
pack_languages: [java]
sources:
  - sdks/java/kindgi-pack/README.md
  - sdks/java/kindgi-pack/src/main/java/com/kindgi/pack/Guardrail.java
  - sdks/java/kindgi-pack/src/main/java/com/kindgi/pack/RunTrace.java
---

# Authoring Kindgi guardrails in Java

> **Running `kindgi`:** the pack pins its CLI (`"cli"` in
> `kindgi.config.json`), and `./kindgiw` runs that version, so every
> `kindgi <command>` below runs as `./kindgiw <command>`. Maven runs as
> `./mvnw`.
>
> Java support is in preview: tested and supported, but the API may still
> change in a later release without the usual deprecation period.

A **guardrail** is a rule an agent's turn must satisfy: a **check** (a
function over the turn's trace) plus an **action** (what happens when it
fails). In a Java pack it is a `public static final Guardrail<C>` field of a
class in a `guardrails` package. For an agent turn, the runtime evaluates
every guardrail the agent lists once, on the final answer, before it is
stored.

`Guardrail.define` has no field for the other points a guardrail can run at (`at`, and a check's `points`), so a Java guardrail runs at the final answer only; the points are documented at https://docs.kindgi.com/v0.3/guides/guardrails/configure-a-guardrail/#where-in-the-turn-it-runs.

Ask what the rule should catch before writing one. The sample
`response-not-empty` guardrail is a demonstration, not a template.

## What a guardrail can do in 0.1

Read this before you plan a guardrail. Three limits decide what can be
built:

- **`halt` and `retry` act.** A failed `halt` guardrail fails the turn with
  `guardrail-violation`, and the answer is not stored. A failed `retry`
  guardrail sends the answer back to the model, with the check's reason in a
  user message, for a new one; the failed answer isn't stored. When it has
  failed `retry.maxAttempts` answers (the first one included; 2 when left
  out), the turn fails with `guardrail-violation` and
  `details.attempts`. Each new answer is a model call that the agent's
  `budget.maxSteps` counts. The `halt` and `retry` guardrails judge each
  answer, a judge's calls included, which `budget.maxCostUsd` doesn't count;
  the others judge only the answer that's sent. A new answer can call tools
  again, side-effecting ones included, with approvals as usual. `escalate`
  and `compensate` are recorded on the turn's violations, as `log-only` is,
  and the turn completes: nothing escalates or calls a compensating tool. So
  "block the reply and make the agent try again" is a `retry` guardrail.
- **A check sees one turn.** The trace holds the current turn only: its
  user message (`trace.userInput()`), its tool calls and their results
  (`toolCalls()`, `toolResults()`) and its answer (`output()`). Earlier
  turns' messages, tool results and answers aren't in it. A check that
  every figure in the answer comes from a tool result or the user's
  message therefore blocks an answer that repeats a figure seen only in an
  earlier turn.
- **A check's in-memory state doesn't last.** The check runs in the pack
  service's process, so anything it keeps in a `static` field (say, a map
  of conversations) is lost when that process is replaced: under `kindgi
  dev`, on every reload after a save and on a restart; in a deployment,
  whenever an instance stops. With more than one instance, each keeps its
  own copy, and one conversation's turns can land on different instances.
  Don't keep a conversation's history this way.

What works today for a check on figures: tell the agent, in its
instructions, to call its tools again in every answer that quotes a
figure, so the figure is in that turn's tool results. It depends on the
model following the instruction, and it doesn't cover figures the user
typed in an earlier turn: `trace.userInput()` is only the current turn's
message, so an answer that repeats them is still blocked.

## A guardrail

```java
// src/main/java/acme/guardrails/Citations.java
package acme.guardrails;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.kindgi.pack.CheckResult;
import com.kindgi.pack.Guardrail;
import jakarta.validation.constraints.Min;
import java.util.Map;

/** acme.no-fabricated-quotes: an answer that quotes case law looked the citations up. */
public final class Citations {
  public record Config(@JsonProperty(defaultValue = "1") @Min(0) int minLookups) {}

  public static final Guardrail<Config> NO_FABRICATED_QUOTES = Guardrail.define("acme.no-fabricated-quotes")
      .name("No fabricated quotations")
      .onViolation("halt")
      .severity("critical")
      .config(Config.class)
      // What the check runs with, keyed as on the wire.
      .set("config", Map.of("minLookups", 2))
      .check((config, trace) -> {
        long lookups = trace.toolCalls().stream()
            .map(call -> (Map<?, ?>) call)
            .filter(call -> "acme.verify-citation".equals(call.get("toolName")))
            .count();
        return lookups >= config.minLookups()
            ? CheckResult.pass()
            : CheckResult.fail("Only " + lookups + " citation lookups (need " + config.minLookups() + "+).");
      });

  private Citations() {}
}
```

- **The check** is `(config, trace) -> CheckResult`: `CheckResult.pass()`
  or `CheckResult.fail(reason)`. A failed result's reason is what the
  violation reports, so make it say what was wrong. A check built on futures
  uses `asyncCheck` and returns a `CompletionStage<CheckResult>`.
- **`trace`** is a `RunTrace`:
  - `output()`: the final answer's text;
  - `userInput()`;
  - `toolCalls()`: each a map with `toolId`, `toolName`, `arguments`;
  - `toolResults()`: each with `toolCallId`, `output`;
  - `modelCalls()`;
  - `mode()`: `runtime` or `ci`;
  - `runId()`, `tenantId()`;
  - `raw()`: the trace as sent, with any field a newer runtime adds.
- **`config(Type.class)`** is the config's type. Its schema is derived as a
  tool input's is, and the service binds the values to it. A
  `@JsonProperty(defaultValue = …)` is the value when none is given.
  `configSchema(Map)` gives a schema instead; the config is then a `Map`.
- **`set("config", Map.of(…))`** holds the values the check runs with,
  keyed as on the wire. They go into the index, and the service checks them
  against the schema before every evaluation. Without them the check runs
  with `{}` and the defaults. So give every field a default: a required
  field with no value fails every evaluation (`input-validation-failed`).
- An exception thrown from the check fails the evaluation (`handler-throw`).
  For a rule that isn't met, return `CheckResult.fail(…)`.
- A check gets no model and no provider: it can't call an LLM. Keep it a
  pure function of the trace (fast, deterministic, free).

## `Guardrail.define(id)`

- **`id`:** `<pack-id>.<guardrail-name>`, kebab-case. Name the rule as a
  positive assertion: `no-fabricated-quotes`, `response-not-empty`.
- **`onViolation(action)`:** `halt`, `retry`, `escalate`, `log-only` or
  `compensate`. For one that needs settings, pass the whole object instead,
  with `action(Map.of("on-violation", "retry", "retry", Map.of("maxAttempts", 2)))`.
  The same goes for `escalateTo` and `compensateWith` (a tool id). The
  builder refuses a check with neither.
  - In an agent turn, a failed `halt` guardrail fails the turn
    (`guardrail-violation`), and the answer is not stored.
  - A failed `retry` guardrail sends the answer back for a new one, up to
    its `maxAttempts` answers (above).
  - Any other action reports the failure in the turn result's `violations`,
    and the turn completes.
  - `escalate` and `compensate` are recorded on the violation, with no
    escalation or compensating call in 0.1.
- **`severity`:** `info`, `warn`, `error` (default) or `critical`. It's
  independent of the action: dashboards group by severity, and execution
  follows the action.
- **`set("scope", Map.of("when", "runtime-only"))`:** when the guardrail
  applies: `always`, `ci-only` or `runtime-only`, narrowed by `agents`,
  `flows` and `tenants` lists.
- **`name`:** a display name. **`checkId`:** defaults to the id.
- **`kind`:** `zero-llm`, the default: a check over the trace, which is what
  a pack writes.
- `set("sandbox" | "limits" | "network", …)` are recorded in the index.

## Testing

`evaluate` runs the check with the config as given, with no schema check
and no defaults. An async check is awaited.

```java
// src/test/java/acme/CitationsTest.java
package acme;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import acme.guardrails.Citations;
import com.kindgi.pack.RunTrace;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class CitationsTest {
  @Test
  void noLookupsFails() throws Exception {
    RunTrace trace = new RunTrace(Map.of("output", "As held in Smith v. Jones…"));
    assertFalse(Citations.NO_FABRICATED_QUOTES.evaluate(new Citations.Config(1), trace).passed());
  }

  @Test
  void enoughLookupsPass() throws Exception {
    Map<String, Object> lookup = Map.of("toolName", "acme.verify-citation", "arguments", Map.of());
    RunTrace trace = new RunTrace(Map.of("toolCalls", List.of(lookup, lookup)));
    assertTrue(Citations.NO_FABRICATED_QUOTES.evaluate(new Citations.Config(2), trace).passed());
  }
}
```

`new RunTrace(Map)` takes the trace as the runtime sends it, camelCase keys
included.

## Wiring onto an agent

```java
Agent.define("acme.brief-writer")
    // …
    .guardrail(Citations.NO_FABRICATED_QUOTES)
```

Pass the `Guardrail`, or its id (`.guardrail("acme.no-fabricated-quotes")`).
`kindgi dev` registers the pack's guardrails. An agent that names an id with
no registered guardrail fails the turn before the model is called
(`Agent "…" references guardrails not in the registry: <id>`).

## Common mistakes

1. **A required config field with no value.** Without `set("config", …)`,
   the check runs with `{}`. Give the field a default
   (`@JsonProperty(defaultValue = "1")`), or the guardrail its values.
2. **`set("config", …)` keyed by Java names.** It's keyed like the wire: the
   record's Jackson names.
3. **No `onViolation` or `action`.** The builder refuses the check.
4. **Expecting `halt` to try again.** `halt` stops the turn; `retry` asks
   the model for a new answer, and fails the turn once its `maxAttempts`
   answers have failed.
5. **Calling a model from the check.** That isn't available: keep checks
   pure.
6. **Throwing for a broken rule.** Return `CheckResult.fail(…)`. An
   exception is an evaluation error, not a violation.
7. **A guardrail that isn't a `static final` field**, or a public class in
   a `guardrails` package that defines none (a file error). A helper there
   is package-private, or a record, an enum or an interface.

## When the framework itself is the problem

If the bug is in Kindgi or kindgi-pack (a trace field missing, a misleading
error) and not in the check, load `kindgi-framework-feedback` and file it
with `./kindgiw feedback write`.
