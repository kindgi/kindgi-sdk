---
name: kindgi-scala-authoring-flows
description: >
  Covers writing flows for a Kindgi pack in Scala (`kindgi-pack-scala`,
  `com.kindgi.pack.scaladsl`): `Flow(id)` as a `val` of an object named like
  its file, tool and agent steps (`toolNode`, `agentNode`, or a node map
  with `inputMapping` and `config`), edges and their `when` conditions and
  `policy` (`edge(Map(…))`), branches that join again, inputMapping from
  runInput / nodeOutputs, typed agent output in a flow, the flow's declared
  output, loops and fanout, and running a flow (runs start --flow, in the
  background, as a dry run) and reading its journal. Load this whenever you
  are authoring or editing code in a Scala pack's flows packages (a pack
  whose `kindgi.config.json` says `"language": "scala"`), defining a flow,
  or when the user asks to add, change or debug one. Scala tools are
  covered by kindgi-scala-authoring-tools, Scala agents by
  kindgi-scala-authoring-agents.
type: core
library: "kindgi-pack-scala"
version: "0.1.0"
sdk_version: "0.0.0"
pack_languages: [scala]
sources:
  - sdks/scala/README.md
  - sdks/scala/kindgi-pack-scala/src/main/scala/com/kindgi/pack/scaladsl/Agent.scala
  - packages/specs/schemas/flow.schema.json
---

# Authoring Kindgi flows in Scala

> **Running `kindgi`:** the pack pins its CLI (`"cli"` in
> `kindgi.config.json`), and `./kindgiw` runs that version, so every
> `kindgi <command>` below runs as `./kindgiw <command>`.
>
> Scala support is in preview: tested and supported, but the API may still
> change in 0.1.6 without the usual deprecation period.

A **flow** is a versioned, durable graph of steps: tools (your code) and
agents (a model's judgment), joined by edges that can carry conditions. It
is **data**, not code: a `val` of type `Flow` in an object named like its
file, in a `flows` package. The runtime runs it step by step, journals every
step, and can resume a run that was interrupted. A run pins the flow version
it started on.

Use a flow when the order of the work is known: parse, then classify, then
branch, then write. Use a single agent when the model should decide the
order.

## Ask before building

- **What goes in, and what comes out?** The run input's shape and the
  output the caller reads. They become `runInput.*` paths and `output`.
- **Which steps are code, which are judgment?** Deterministic work (parse,
  rank, look up, write) is a tool. Judgment (classify, draft, summarize) is
  an agent with a typed output.
- **Where does it branch?** Every branch needs a condition, and the steps
  after a branch must cope with the branch that didn't run.
- **What does it change outside Kindgi?** Know which tools write: a dry run
  stops before them (see "Running a flow").

## A flow

The tools and the agent it runs:

```scala
// src/main/scala/acme/tools/Tickets.scala
package acme.tools

import com.kindgi.pack.scaladsl._

/** The ticket tools: parse one, look its invoice up, draft the reply. */
object Tickets {
  final case class Ticket(customerId: String, body: String)
  final case class ParseInput(ticket: Ticket)
  final case class Parsed(text: String)
  final case class InvoiceInput(customerId: String)
  final case class Invoice(number: String, amount: BigDecimal)
  final case class Found(invoice: Invoice)
  /** `invoice` is absent when the billing step didn't run: an Option. */
  final case class ReplyInput(category: String, invoice: Option[Invoice])
  final case class Reply(text: String)

  val parse: Tool[ParseInput, Parsed] = Tool[ParseInput, Parsed]("acme.parse-ticket")
    .description("Extracts a ticket's text.")
    .readOnly
    .handler((in, _) => Parsed(in.ticket.body.strip))

  val lookupInvoice: Tool[InvoiceInput, Found] = Tool[InvoiceInput, Found]("acme.lookup-invoice")
    .description("The customer's latest invoice.")
    .readOnly
    .handler((_, _) => Found(Invoice("INV-1", BigDecimal("42.00"))))

  val draftReply: Tool[ReplyInput, Reply] = Tool[ReplyInput, Reply]("acme.draft-reply")
    .description("Drafts a reply for the ticket's category.")
    .readOnly
    .handler((in, _) =>
      Reply(in.invoice match {
        case Some(invoice) => s"Invoice ${invoice.number} is ${invoice.amount}."
        case None          => s"Thanks, we're on it (${in.category})."
      }))
}
```

```scala
// src/main/scala/acme/agents/TicketClassifier.scala
package acme.agents

import com.kindgi.pack.scaladsl._

/** acme.ticket-classifier: one word for a ticket's category. */
object TicketClassifier {
  final case class Category(category: String)

  val agent: Agent = Agent("acme.ticket-classifier")
    .version("0.1.0")
    .name("Ticket classifier")
    .instructions(
      "Classify the support ticket for {{ product }}: answer billing, bug or other, " +
        "as JSON with one field, category.")
    .capability(Map("needs" -> List(Map("feature" -> "tool-use"))))
    .set("parameters", List(Map("name" -> "product", "type" -> "string", "required" -> true)))
    .output[Category]
    .build()
}
```

The flow:

```scala
// src/main/scala/acme/flows/TriageTicket.scala
package acme.flows

import acme.agents.TicketClassifier
import acme.tools.Tickets
import com.kindgi.pack.scaladsl._

/** acme.triage-ticket: parse, classify, look billing up when needed, reply. */
object TriageTicket {
  private val isBilling = Map(
    "op" -> "eq",
    "left" -> Map("path" -> "nodeOutputs.classify.output.category"),
    "right" -> Map("literal" -> "billing"))

  val flow: Flow = Flow("acme.triage-ticket")
    .version("0.1.0")
    .set("name", "Triage a support ticket")
    .set("description", "Parses a ticket, classifies it, looks billing up when needed, drafts a reply.")
    .node(Map("id" -> "parse", "kind" -> "tool", "ref" -> Tickets.parse,
      "inputMapping" -> Map("ticket" -> Map("path" -> "runInput.ticket"))))
    .node(Map("id" -> "classify", "kind" -> "agent", "ref" -> TicketClassifier.agent,
      "inputMapping" -> Map("text" -> Map("path" -> "nodeOutputs.parse.text")),
      "config" -> Map("parameters" -> Map("product" -> "acme-cloud"))))
    .node(Map("id" -> "billing", "kind" -> "tool", "ref" -> Tickets.lookupInvoice,
      "inputMapping" -> Map("customerId" -> Map("path" -> "runInput.ticket.customerId"))))
    .node(Map("id" -> "reply", "kind" -> "tool", "ref" -> Tickets.draftReply,
      "inputMapping" -> Map(
        "category" -> Map("path" -> "nodeOutputs.classify.output.category"),
        "invoice" -> Map("path" -> "nodeOutputs.billing.invoice"))))
    .edge("e0", "$start", "parse")
    .edge("e1", "parse", "classify")
    .edge(Map("id" -> "e2", "from" -> "classify", "to" -> "billing", "when" -> isBilling))
    .edge(Map("id" -> "e3", "from" -> "classify", "to" -> "reply", "when" -> Map("op" -> "not", "child" -> isBilling)))
    .edge("e4", "billing", "reply")
    .edge("e5", "reply", "$end")
    .set("output", Map(
      "mapping" -> Map(
        "category" -> Map("path" -> "nodeOutputs.classify.output.category"),
        "reply" -> Map("path" -> "nodeOutputs.reply.text")),
      "schema" -> Map(
        "type" -> "object",
        "properties" -> Map("category" -> Map("type" -> "string"), "reply" -> Map("type" -> "string")),
        "required" -> List("category", "reply"))))
    .build()
}
```

- **Steps:** `toolNode(id, tool)` and `agentNode(id, agent)` are a step with
  nothing more. A step with an `inputMapping`, a `config`, a loop or a fanout
  is a map, `node(Map(…))`, as `flow.schema.json` describes it. In a node's
  map, a `Tool`, `Agent` or `Flow` (loop bodies and fanout branches included)
  becomes its id. A primitive of another pack is its id string.
- **Edges:** `edge(id, from, to)` joins two steps. An edge with a condition
  (`when`) or a `policy` is a map, `edge(Map(…))`.
- **Other fields:** `set(field, value)` takes `name`, `description`,
  `output`, `maxParallelism` and `metadata`. `build()` needs a version.
- **The maps are the wire's shape,** in Scala maps and lists, so their keys
  are camelCase (`inputMapping`, `loopKind`, `maxIterations`).
- **Where it's checked:** the indexer checks every flow against
  `flow.schema.json` (version, node and edge shapes, `$start` / `$end`).
  `kindgi dev` reports a mistake as a file error that says what and where,
  while the pack's other primitives keep serving. Whether a step's tool or
  agent exists is checked when a run starts (see "Running a flow").

## Nodes

- **A tool step** (`"kind" -> "tool"`) runs the tool `ref`.
  - Its input is what the node's `inputMapping` builds; else, the output of
    the node's single upstream node (the run input after `$start`).
  - The input is checked against the tool's input schema, so a mismatch
    fails the step with `input-validation-failed`.
  - The node's output is what the tool returned, as JSON.
- **An agent step** (`"kind" -> "agent"`) runs one turn of the agent `ref`,
  as a child run of the flow run.
  - The agent gets the node's input two ways: as structured input
    (`{{ input.text }}` in its instructions), and as its user message (the
    input as JSON).
  - `"config" -> Map("parameters" -> Map(…))` fills the agent's `parameters`
    (string, number or boolean values). `"config" -> Map("version" -> "1.2.0")`
    pins an agent version; without it, the latest active version runs.
  - The node's output: `output` is the agent's typed answer (its
    `output[T]`); `text` is the answer as text; `runId` and `conversationId`
    are the child run's. Read a field as `nodeOutputs.<node>.output.<field>`.
  - An answer that doesn't fit the agent's output, after its repairs, fails
    the step with `output-schema-violation`. An approval inside the agent's
    turn parks the flow until it's decided.
- **A loop** (`"kind" -> "loop"`) repeats a body.
  - `"loopKind" -> "foreach"` runs it once per element of `iterateOver`
    (`concurrency` up to 32 in parallel). `"loopKind" -> "while"` runs it
    until `exitCondition`.
  - The body (`"body" -> Map("nodes" -> List(…), "edges" -> List(…))`) has
    its own nodes and edges, with `$loop-start` and `$loop-end`. The element
    is the body's input.
  - `maxIterations` and `outputSchema` are required.
  - The loop's output is `finalOutput`, plus `outputs` with
    `"collectAllIterations" -> true`.
  - Node ids must be unique across the whole flow, bodies included.
- **A fanout** (`"kind" -> "fanout"`) runs several handlers on the same input
  at once. Each is a branch (`branchId`, `handler`: a `Tool` or an id, and
  `outputSchema`). `convergence` decides the result: `all-succeed`,
  `any-succeed` (the first success wins), or `settle-all` (wait for every
  branch and report each).
- **A sub-flow** (`"kind" -> "subgraph"`) is part of the flow schema, but a
  run refuses it today (`flow-unbound`). Inline the steps instead.

## Edges and conditions

An edge goes from a node (or `$start`) to a node (or `$end`). Without `when`
it fires when its source completes. With `when`, it fires only if the
condition is true. Conditions are maps:

| Operator | Shape |
|---|---|
| `eq` `ne` `lt` `lte` `gt` `gte` | `op`, `left`, `right` |
| `in` `notIn` | `op`, `value`, `set` |
| `exists` `notExists` `truthy` `falsy` | `op`, `value` |
| `and` `or` | `op`, `children` (a list) |
| `not` | `op`, `child` |

Each operand is `Map("literal" -> …)` or `Map("path" -> …)`. When a path
doesn't resolve, `eq`, `lt`, `lte`, `gt` and `gte` are false, and `ne` is
true. So for the "otherwise" branch, wrap the condition in `not` (as above)
rather than writing a second comparison: it covers exactly what the first
edge doesn't. A condition used twice is easiest as a `val` (`isBilling`).

**Joining branches.** A node with several incoming edges runs once every one
of them is decided and at least one fired. Above, `reply` runs after
`billing` on the billing branch, and straight after `classify` otherwise. A
node none of whose incoming edges fired is skipped, and so is everything
only it leads to.

**Edge policy** (`"policy"` on the edge into a node with a single incoming
edge; a node with several ignores it):
- `"retry" -> Map("maxAttempts" -> …, "delayMs" -> …)`, with `backoff` and
  `maxDelayMs` optional; up to 10 attempts in all;
- `"timeoutMs"`: a step that takes longer fails with `reason: timeout`;
- `"concurrencyKey"`: at most one such step at a time in the tenant;
- `"priority"`: −100 to 100.

## Inputs and the output

`inputMapping` maps each key to a `literal` or a `path`. Its keys are the
tool's input **as it travels**: the case class's Jackson names (a parameter
`customerId` is the key `customerId`; with `@JsonProperty("customer_id")`,
it's `customer_id`). Paths are dot-separated (a number segment indexes an
array: `items.0.sku`), rooted at:
- `runInput.…`: the input the run started with;
- `nodeOutputs.<nodeId>.…`: a step's output. For an agent step, add
  `.output.<field>` to read its typed answer;
- `state.…`: values the runtime's own handlers write. Pack tools don't
  write it, so use `nodeOutputs`.

A path that doesn't resolve leaves its key out. So a step after a branch
that didn't run gets no `invoice` key at all. Make that parameter an
`Option` (as above), or give it a default.

`set("output", …)` is what the run returns: a `mapping` resolved when the
run finishes, checked against `schema` if you give one. A run whose output
doesn't match fails. Without an output, the run returns the output of the
step that reached `$end`.

## Running a flow

From another terminal in the pack directory, while `kindgi dev` runs:

```sh
./kindgiw runs start --flow=acme.triage-ticket --input='{"ticket":{"customerId":"c-1","body":"Charged twice"}}'
./kindgiw runs start --flow=acme.triage-ticket --input=@ticket.json --no-wait   # the run id now; it finishes in the background
./kindgiw runs start --flow=acme.triage-ticket --input=@ticket.json --dry-run   # stops before a tool that may write
./kindgiw runs get <run-id>        # status, output, failureMessage
./kindgiw runs journal <run-id>    # every step.started / step.completed / edge.evaluated
./kindgiw runs stream <run-id>     # follow a running one
./kindgiw runs cancel <run-id>
```

- **A refusal before the run exists:** `422 flow-unbound` names the nodes a
  run can't bind: a tool or agent id the tenant doesn't have, or a
  sub-flow. Fix the ids; nothing ran.
- **A failed step fails the run**, and `failureMessage` says which step and
  why. Retry it on its edge with `policy.retry`, but only if running the
  step twice is safe.
- **`--no-wait`** is how an application starts runs
  (`"options": {"wait": false}`). It answers with the run id at once; poll
  the run or follow its stream.
- **`--dry-run`** runs a tool only if it's declared read-only (`readOnly`)
  and has no `writes`, `deletes`, `spawns-run`, `emits-event` or
  `external-side-effect` effect. The first other tool stops the run with
  `dry-run-effectful-tool`, and everything before it really ran.

## Iterating on a flow

Save the file, and `kindgi dev` recompiles and re-indexes. The next run uses
the new definition, with no restart. A run already in flight keeps the
version it started on. Bump `version` when callers' contract changes (the
input or the output), not on every save.

## Common mistakes

1. **Building a flow without asking what goes in and comes out.** The pack's
   `EchoFlow` proves the runtime works. It isn't a template for the user's
   flow.
2. **A second comparison for "otherwise".** On a path that may be missing,
   `eq` is false and `ne` is true, and `lt`/`gt` are both false, so a
   hand-written opposite can miss a case or overlap. Wrap the positive
   condition in `not`.
3. **Reading an agent step's answer at `nodeOutputs.<step>.<field>`.** The
   typed answer is under `.output`. An agent without an output type has
   only `text`.
4. **A required input parameter fed by a branch that may not run.** The key
   is left out, the tool's input check fails, and so does the step. Make it
   an `Option`, or give it a default.
5. **`inputMapping` keys in the wrong spelling.** They're the input's wire
   names.
6. **A `when` given through `set("edges", …)`.** `build()` writes the edges
   added with `edge(…)`; use `edge(Map(…))` for an edge with a condition or
   a policy.
7. **A sub-flow node.** A run refuses it (`flow-unbound`).
8. **Duplicate node ids inside a loop body.** Ids are unique across the
   whole flow, bodies included.
9. **`readOnly` on a tool that writes.** A dry run then runs it for real.
10. **A flow as a `def` or a `lazy val`.** It's a file error: make it a
    `val`.

## When the framework itself is the problem

If the bug is in Kindgi, kindgi-pack or the Scala layer (a step's output
missing a field, a condition that evaluates wrongly, a misleading error) and
not in the pack's code, load `kindgi-framework-feedback` and file it with
`./kindgiw feedback write`.
