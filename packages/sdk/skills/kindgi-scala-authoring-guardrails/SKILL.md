---
name: kindgi-scala-authoring-guardrails
description: >
  Covers writing guardrails (safety checks on an agent's turn) for a Kindgi
  pack in Scala (`kindgi-pack-scala`, `com.kindgi.pack.scaladsl`):
  `Guardrail[Config](id)` as a `val` of an object named like its file, a
  `(config, trace)` check returning a `CheckResult` (or a Future of one with
  `checkAsync`), `RunTrace`, config case classes and the values a check runs
  with, actions (halt / retry / escalate / log-only / compensate), severity
  and scope, munit tests with `evaluate`, and wiring a guardrail onto an
  agent. Load this whenever you are authoring or editing code in a Scala
  pack's guardrails packages (a pack whose `kindgi.config.json` says
  `"language": "scala"`), defining a check, or wiring a guardrail onto an
  agent. Scala agents are covered by kindgi-scala-authoring-agents, Scala
  tools by kindgi-scala-authoring-tools.
type: core
library: "kindgi-pack-scala"
version: "0.1.0"
sdk_version: "0.0.0"
pack_languages: [scala]
sources:
  - sdks/scala/README.md
  - sdks/scala/kindgi-pack-scala/src/main/scala/com/kindgi/pack/scaladsl/Guardrail.scala
  - sdks/java/kindgi-pack/src/main/java/com/kindgi/pack/RunTrace.java
---

# Authoring Kindgi guardrails in Scala

> **Running `kindgi`:** the pack pins its CLI (`"cli"` in
> `kindgi.config.json`), and `./kindgiw` runs that version, so every
> `kindgi <command>` below runs as `./kindgiw <command>`.
>
> Scala support is in preview: tested and supported, but the API may still
> change in 0.1.6 without the usual deprecation period.

A **guardrail** is a rule an agent's turn must satisfy: a **check** (a
function over the turn's trace) plus an **action** (what happens when it
fails). In a Scala pack it is a `val` of type `Guardrail[C]` in an object
named like its file, in a `guardrails` package. For an agent turn, the
runtime evaluates every guardrail the agent lists once, on the final answer,
before it is stored.

Ask what the rule should catch before writing one. The sample
`response-not-empty` guardrail is a demonstration, not a template.

## A guardrail

```scala
// src/main/scala/acme/guardrails/Citations.scala
package acme.guardrails

import com.kindgi.pack.scaladsl._
import jakarta.validation.constraints.Min
import scala.jdk.CollectionConverters._

/** acme.no-fabricated-quotes: an answer that quotes case law looked the citations up. */
object Citations {
  final case class Config(@Min(value = 0) minLookups: Int = 1)

  val noFabricatedQuotes: Guardrail[Config] = Guardrail[Config]("acme.no-fabricated-quotes")
    .name("No fabricated quotations")
    .onViolation("halt")
    .severity("critical")
    // What the check runs with, keyed as on the wire.
    .set("config", Map("minLookups" -> 2))
    .check { (config, trace) =>
      val lookups = trace.toolCalls.asScala.count {
        case call: java.util.Map[_, _] => call.get("toolName") == "acme.verify-citation"
        case _                         => false
      }
      if (lookups >= config.minLookups) CheckResult.pass
      else CheckResult.fail(s"Only $lookups citation lookups (need ${config.minLookups}+).")
    }
}
```

- **The check** is `(config, trace) => CheckResult`: `CheckResult.pass` or
  `CheckResult.fail(reason)`. A failed result's reason is what the violation
  reports, so make it say what was wrong. `checkAsync` takes a
  `(config, trace) => Future[CheckResult]`.
- **`trace`** is a `RunTrace` (kindgi-pack's), with Java collections:
  - `output`: the final answer's text (`null` when there's none: wrap it in
    `Option`);
  - `userInput`;
  - `toolCalls`: each a map with `toolId`, `toolName` (the tool's dotted
    id), `arguments`;
  - `toolResults`: each with `toolCallId`, `output`;
  - `modelCalls`;
  - `mode`: `runtime` or `ci`;
  - `runId`, `tenantId`;
  - `raw`: the trace as sent.
- **`Guardrail[Config](id)`** takes the config's case class. Its schema is
  derived as a tool input's is, and a parameter's default is the value when
  none is given. `Guardrail.json(id).configSchema(Map(…))` gives a schema
  instead; the config is then a `Map[String, Any]`.
- **`set("config", Map(…))`** holds the values the check runs with, keyed as
  on the wire. They go into the index, and the service checks them against
  the schema before every evaluation. Without them the check runs with `{}`
  and the defaults. So give every parameter a default: a required one with
  no value fails every evaluation (`input-validation-failed`).
- An exception thrown from the check fails the evaluation (`handler-throw`).
  For a rule that isn't met, return `CheckResult.fail(…)`.
- A check gets no model and no provider: it can't call an LLM. Keep it a
  pure function of the trace (fast, deterministic, free).

## `Guardrail[Config](id)`

- **`id`:** `<pack-id>.<guardrail-name>`, kebab-case. Name the rule as a
  positive assertion: `no-fabricated-quotes`, `response-not-empty`.
- **`onViolation(action)`:** `halt`, `retry`, `escalate`, `log-only` or
  `compensate`. For one that needs settings, pass the whole object instead,
  with `action(Map("on-violation" -> "retry", "retry" -> Map("maxAttempts" -> 2)))`.
  The same goes for `escalateTo` and `compensateWith` (a tool id). The
  builder refuses a check with neither.
  - In an agent turn, a failed `halt` guardrail fails the turn
    (`guardrail-violation`), and the answer is not stored.
  - Any other action reports the failure in the turn result's `violations`,
    and the turn completes.
  - In 0.1 the runtime acts only on `halt`: `retry`, `escalate` and
    `compensate` are recorded on the violation, with no second attempt,
    escalation or compensating call.
- **`severity`:** `info`, `warn`, `error` (default) or `critical`. It's
  independent of the action: dashboards group by severity, and execution
  follows the action.
- **`set("scope", Map("when" -> "runtime-only"))`:** when the guardrail
  applies: `always`, `ci-only` or `runtime-only`, narrowed by `agents`,
  `flows` and `tenants` lists.
- **`name`:** a display name. **`checkId`:** defaults to the id.
- **`kind`:** `zero-llm`, the default: a check over the trace, which is what
  a pack writes.
- `set("sandbox" | "limits" | "network", …)` are recorded in the index.

## Testing

`evaluate` runs the check with the config as given, with no schema check
and no defaults. An async check is awaited.

```scala
// src/test/scala/acme/CitationsSuite.scala
package acme

import acme.guardrails.Citations
import com.kindgi.pack.RunTrace
import java.util.{List => JList, Map => JMap}

class CitationsSuite extends munit.FunSuite {
  test("no lookups fails") {
    val trace = new RunTrace(JMap.of("output", "As held in Smith v. Jones…"))
    assert(!Citations.noFabricatedQuotes.evaluate(Citations.Config(1), trace).passed)
  }

  test("enough lookups pass") {
    val lookup = JMap.of("toolName", "acme.verify-citation", "arguments", JMap.of())
    val trace = new RunTrace(JMap.of("toolCalls", JList.of(lookup, lookup)))
    assert(Citations.noFabricatedQuotes.evaluate(Citations.Config(2), trace).passed)
  }
}
```

`new RunTrace(map)` takes the trace as the runtime sends it: a Java map,
camelCase keys included.

## Wiring onto an agent

```scala
Agent("acme.brief-writer")
  // …
  .guardrail(Citations.noFabricatedQuotes)
```

Pass the `Guardrail`, or its id (`.guardrail("acme.no-fabricated-quotes")`).
`kindgi dev` registers the pack's guardrails. An agent that names an id with
no registered guardrail fails the turn before the model is called
(`Agent "…" references guardrails not in the registry: <id>`).

## Common mistakes

1. **A config parameter with no default and no value.** Without
   `set("config", …)`, the check runs with `{}`. Give the parameter a
   default, or the guardrail its values.
2. **`set("config", …)` keyed by Scala names that differ from the wire.**
   It's keyed by the case class's Jackson names.
3. **No `onViolation` or `action`.** The builder refuses the check.
4. **Expecting another attempt.** `halt` stops the turn, and in 0.1 `retry`
   doesn't run the turn again: it's only recorded.
5. **Calling a model from the check.** That isn't available: keep checks
   pure.
6. **Throwing for a broken rule.** Return `CheckResult.fail(…)`. An
   exception is an evaluation error, not a violation.
7. **`trace.output.length` without a null check.** `output` is `null` when
   the turn produced no text: `Option(trace.output).getOrElse("")`.
8. **A guardrail as a `def` or a `lazy val`.** It's a file error: make it a
   `val`.

## When the framework itself is the problem

If the bug is in Kindgi, kindgi-pack or the Scala layer (a trace field
missing, a misleading error) and not in the check, load
`kindgi-framework-feedback` and file it with `./kindgiw feedback write`.
