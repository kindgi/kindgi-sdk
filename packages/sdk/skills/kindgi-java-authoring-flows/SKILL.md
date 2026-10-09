---
name: kindgi-java-authoring-flows
description: >
  Covers writing flows for a Kindgi pack in Java (`com.kindgi:kindgi-pack`):
  `Flow.define(id)` as a `public static final` field, tool and agent steps
  (`toolNode`, `agentNode`, or a node map with `inputMapping` and `config`),
  edges and their `when` conditions and `policy`, branches that join again,
  inputMapping from runInput / nodeOutputs, typed agent output in a flow,
  the flow's declared output, loops and fanout, and running a flow (runs
  start --flow, in the background, as a dry run) and reading its journal.
  Load this whenever you are authoring or editing code in a Java pack's
  flows packages (a pack whose `kindgi.config.json` says
  `"language": "java"`), defining a flow, or when the user asks to add,
  change or debug one. Java tools are covered by
  kindgi-java-authoring-tools, Java agents by kindgi-java-authoring-agents.
type: core
library: "kindgi-pack (Java)"
version: "0.1.0"
sdk_version: "0.0.0"
pack_languages: [java]
sources:
  - sdks/java/kindgi-pack/README.md
  - sdks/java/kindgi-pack/src/main/java/com/kindgi/pack/Flow.java
  - packages/specs/schemas/flow.schema.json
---

# Authoring Kindgi flows in Java

> **Running `kindgi`:** the pack pins its CLI (`"cli"` in
> `kindgi.config.json`), and `./kindgiw` runs that version, so every
> `kindgi <command>` below runs as `./kindgiw <command>`. Maven runs as
> `./mvnw`.
>
> Java support is in preview: tested and supported, but the API may still
> change in 0.1.6 without the usual deprecation period.

A **flow** is a versioned, durable graph of steps: tools (your code) and
agents (a model's judgment), joined by edges that can carry conditions. It
is **data**, not code: a `public static final Flow` field of a class in a
`flows` package. The runtime runs it step by step, journals every step, and
can resume a run that was interrupted. A run pins the flow version it
started on.

Use a flow when the order of the work is known: parse, then classify, then
branch, then write. Use a single agent when the model should decide the
order.

## Ask before building

- **What goes in, and what comes out?** The run input's shape and the
  output the caller reads. They become `runInput.*` paths and `output`.
- **Which steps are code, which are judgment?** Deterministic work (parse,
  rank, look up, write) is a tool. Judgment (classify, draft, summarize) is
  an agent with a typed `output`.
- **Where does it branch?** Every branch needs a condition, and the steps
  after a branch must cope with the branch that didn't run.
- **What does it change outside Kindgi?** Know which tools write: a dry run
  stops before them (see "Running a flow").

## A flow

The tools and the agent it runs:

```java
// src/main/java/acme/tools/Tickets.java
package acme.tools;

import com.kindgi.pack.Tool;
import org.jspecify.annotations.Nullable;

/** The ticket tools: parse one, look its invoice up, draft the reply. */
public final class Tickets {
  public record Ticket(String customerId, String body) {}

  public record ParseInput(Ticket ticket) {}

  public record Parsed(String text) {}

  public record InvoiceInput(String customerId) {}

  public record Invoice(String number, double amount) {}

  public record Found(Invoice invoice) {}

  /** `invoice` is absent when the billing step didn't run: it may be null. */
  public record ReplyInput(String category, @Nullable Invoice invoice) {}

  public record Reply(String text) {}

  public static final Tool<ParseInput, Parsed> PARSE = Tool.define("acme.parse-ticket")
      .description("Extracts a ticket's text.")
      .input(ParseInput.class)
      .output(Parsed.class)
      .mutating(false)
      .handler((input, ctx) -> new Parsed(input.ticket().body().strip()));

  public static final Tool<InvoiceInput, Found> LOOKUP_INVOICE = Tool.define("acme.lookup-invoice")
      .description("The customer's latest invoice.")
      .input(InvoiceInput.class)
      .output(Found.class)
      .mutating(false)
      .handler((input, ctx) -> new Found(new Invoice("INV-1", 42.0)));

  public static final Tool<ReplyInput, Reply> DRAFT_REPLY = Tool.define("acme.draft-reply")
      .description("Drafts a reply for the ticket's category.")
      .input(ReplyInput.class)
      .output(Reply.class)
      .mutating(false)
      .handler((input, ctx) -> new Reply(input.invoice() == null
          ? "Thanks, we're on it (" + input.category() + ")."
          : "Invoice " + input.invoice().number() + " is " + input.invoice().amount() + "."));

  private Tickets() {}
}
```

```java
// src/main/java/acme/agents/TicketClassifier.java
package acme.agents;

import com.kindgi.pack.Agent;
import java.util.List;
import java.util.Map;

/** acme.ticket-classifier: one word for a ticket's category. */
public final class TicketClassifier {
  public record Category(String category) {}

  public static final Agent AGENT = Agent.define("acme.ticket-classifier")
      .version("0.1.0")
      .name("Ticket classifier")
      .instructions("Classify the support ticket for {{ product }}: answer billing, bug or other, "
          + "as JSON with one field, category.")
      .capability(Map.of("needs", List.of(Map.of("feature", "tool-use"))))
      .set("parameters", List.of(Map.of("name", "product", "type", "string", "required", true)))
      .output(Category.class)
      .build();

  private TicketClassifier() {}
}
```

The flow:

```java
// src/main/java/acme/flows/TriageTicket.java
package acme.flows;

import acme.agents.TicketClassifier;
import acme.tools.Tickets;
import com.kindgi.pack.Flow;
import java.util.List;
import java.util.Map;

/** acme.triage-ticket: parse, classify, look billing up when needed, reply. */
public final class TriageTicket {
  static final Map<String, Object> IS_BILLING = Map.of(
      "op", "eq",
      "left", Map.of("path", "nodeOutputs.classify.output.category"),
      "right", Map.of("literal", "billing"));

  public static final Flow FLOW = Flow.define("acme.triage-ticket")
      .version("0.1.0")
      .set("name", "Triage a support ticket")
      .set("description", "Parses a ticket, classifies it, looks billing up when needed, drafts a reply.")
      .node(Map.of("id", "parse", "kind", "tool", "ref", Tickets.PARSE,
          "inputMapping", Map.of("ticket", Map.of("path", "runInput.ticket"))))
      .node(Map.of("id", "classify", "kind", "agent", "ref", TicketClassifier.AGENT,
          "inputMapping", Map.of("text", Map.of("path", "nodeOutputs.parse.text")),
          "config", Map.of("parameters", Map.of("product", "acme-cloud"))))
      .node(Map.of("id", "billing", "kind", "tool", "ref", Tickets.LOOKUP_INVOICE,
          "inputMapping", Map.of("customerId", Map.of("path", "runInput.ticket.customerId"))))
      .node(Map.of("id", "reply", "kind", "tool", "ref", Tickets.DRAFT_REPLY,
          "inputMapping", Map.of(
              "category", Map.of("path", "nodeOutputs.classify.output.category"),
              "invoice", Map.of("path", "nodeOutputs.billing.invoice"))))
      .edge("e0", "$start", "parse")
      .edge("e1", "parse", "classify")
      .edge(Map.of("id", "e2", "from", "classify", "to", "billing", "when", IS_BILLING))
      .edge(Map.of("id", "e3", "from", "classify", "to", "reply", "when", Map.of("op", "not", "child", IS_BILLING)))
      .edge("e4", "billing", "reply")
      .edge("e5", "reply", "$end")
      .set("output", Map.of(
          "mapping", Map.of(
              "category", Map.of("path", "nodeOutputs.classify.output.category"),
              "reply", Map.of("path", "nodeOutputs.reply.text")),
          "schema", Map.of(
              "type", "object",
              "properties", Map.of("category", Map.of("type", "string"), "reply", Map.of("type", "string")),
              "required", List.of("category", "reply"))))
      .build();

  private TriageTicket() {}
}
```

- **Steps:** `toolNode(id, Tool)` and `agentNode(id, Agent)` are a step with
  nothing more. A step with an `inputMapping`, a `config`, a loop or a fanout
  is a map, `node(Map.of(…))`, as `flow.schema.json` describes it. In a
  node's map, a `Tool`, `Agent` or `Flow` (loop bodies and fanout branches
  included) becomes its id. A primitive of another pack is its id string.
- **Edges:** `edge(id, from, to)` joins two steps. An edge with a condition
  (`when`) or a `policy` is a map, `edge(Map.of(…))`.
- **Other fields:** `set(field, value)` takes `name`, `description`,
  `output`, `maxParallelism` and `metadata`. `build()` needs a version.
- **The maps are the wire's shape,** so their keys are camelCase
  (`inputMapping`, `loopKind`, `maxIterations`).
- **Where it's checked:** the indexer checks every flow against
  `flow.schema.json` (version, node and edge shapes, `$start` / `$end`).
  `kindgi dev` reports a mistake as a file error that says what and where,
  while the pack's other primitives keep serving. Whether a step's tool or
  agent exists is checked when a run starts (see "Running a flow").
- `Map.of` takes up to ten pairs. For a bigger map, use `Map.ofEntries` or a
  `LinkedHashMap`.

## Nodes

- **A tool step** (`"kind": "tool"`) runs the tool `ref`.
  - Its input is what the node's `inputMapping` builds; else, the output of
    the node's single upstream node (the run input after `$start`).
  - The input is checked against the tool's input schema, so a mismatch
    fails the step with `input-validation-failed`.
  - The node's output is what the tool returned, as JSON (its Jackson names).
- **An agent step** (`"kind": "agent"`) runs one turn of the agent `ref`, as a
  child run of the flow run.
  - The agent gets the node's input two ways: as structured input
    (`{{ input.text }}` in its instructions), and as its user message (the
    input as JSON).
  - `"config": {"parameters": {…}}` fills the agent's `parameters` (string,
    number or boolean values). `"config": {"version": "1.2.0"}` pins an agent
    version; without it, the latest active version runs.
  - The node's output: `output` is the agent's typed answer (its
    `output(Type.class)`); `text` is the answer as text; `runId` and
    `conversationId` are the child run's. Read a field as
    `nodeOutputs.<node>.output.<field>`.
  - An answer that doesn't fit the agent's output, after its repairs, fails
    the step with `output-schema-violation`. An approval inside the agent's
    turn parks the flow until it's decided.
- **A loop** (`"kind": "loop"`) repeats a body.
  - `"loopKind": "foreach"` runs it once per element of `iterateOver`
    (`concurrency` up to 32 in parallel). `"loopKind": "while"` runs it until
    `exitCondition`.
  - The body (`"body": {"nodes": […], "edges": […]}`) has its own nodes and
    edges, with `$loop-start` and `$loop-end`. The element is the body's
    input.
  - `maxIterations` and `outputSchema` are required.
  - The loop's output is `finalOutput`, plus `outputs` with
    `"collectAllIterations": true`.
  - Node ids must be unique across the whole flow, bodies included.
- **A fanout** (`"kind": "fanout"`) runs several handlers on the same input
  at once. Each is a branch (`branchId`, `handler`: a `Tool` or an id, and
  `outputSchema`). `convergence` decides the result: `all-succeed`,
  `any-succeed` (the first success wins), or `settle-all` (wait for every
  branch and report each).
- **A sub-flow** (`"kind": "subgraph"`) is part of the flow schema, but a run
  refuses it today (`flow-unbound`). Inline the steps instead.

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

Each operand is `Map.of("literal", …)` or `Map.of("path", …)`. When a path
doesn't resolve, `eq`, `lt`, `lte`, `gt` and `gte` are false, and `ne` is
true. So for the "otherwise" branch, wrap the condition in `not` (as above)
rather than writing a second comparison: it covers exactly what the first
edge doesn't. A condition used twice is easiest as a constant (`IS_BILLING`).

**Joining branches.** A node with several incoming edges runs once every one
of them is decided and at least one fired. Above, `reply` runs after
`billing` on the billing branch, and straight after `classify` otherwise. A
node none of whose incoming edges fired is skipped, and so is everything
only it leads to.

**Edge policy** (`"policy"` on the edge into a node with a single incoming
edge; a node with several ignores it):
- `"retry": {"maxAttempts", "delayMs"?, "backoff"?, "maxDelayMs"?}`, up to 10
  attempts in all;
- `"timeoutMs"`: a step that takes longer fails with `reason: timeout`;
- `"concurrencyKey"`: at most one such step at a time in the tenant;
- `"priority"`: −100 to 100.

## Inputs and the output

`inputMapping` maps each key to a `literal` or a `path`. Its keys are the
tool's input **as it travels**: the record's Jackson names (a component
`customerId` is the key `customerId`; with
`@JsonProperty("customer_id")`, it's `customer_id`). Paths are dot-separated
(a number segment indexes an array: `items.0.sku`), rooted at:
- `runInput.…`: the input the run started with;
- `nodeOutputs.<nodeId>.…`: a step's output. For an agent step, add
  `.output.<field>` to read its typed answer;
- `state.…`: values the runtime's own handlers write. Pack tools don't
  write it, so use `nodeOutputs`.

A path that doesn't resolve leaves its key out. So a step after a branch
that didn't run gets no `invoice` key at all, rather than `null`. Make that
component optional in the tool's input (`@Nullable Invoice invoice`, as
above).

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

From a Java app, the client starts one the same way:
`client.runs().start(StartRunBody.WithFlow.builder().flow("acme.triage-ticket").input(…).build())`.

- **A refusal before the run exists:** `422 flow-unbound` names the nodes a
  run can't bind: a tool or agent id the tenant doesn't have, or a
  sub-flow. Fix the ids; nothing ran.
- **A failed step fails the run**, and `failureMessage` says which step and
  why. Retry it on its edge with `policy.retry`, but only if running the
  step twice is safe.
- **`--no-wait`** is how an application starts runs
  (`"options": {"wait": false}`). It answers with the run id at once; poll
  the run or follow its stream.
- **`--dry-run`** runs a tool only if it's declared read-only:
  `mutating(false)` and no `writes`, `deletes`, `spawns-run`, `emits-event`
  or `external-side-effect` effect. The first other tool stops the run with
  `dry-run-effectful-tool`, and everything before it really ran. That's
  useful for checking the wiring without the writes.

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
   condition in `not`: it covers exactly what the first edge doesn't.
3. **Reading an agent step's answer at `nodeOutputs.<step>.<field>`.** The
   typed answer is under `.output`: `nodeOutputs.<step>.output.<field>`. An
   agent without an output type has only `text`.
4. **A required input component fed by a branch that may not run.** The key
   is left out, the tool's input check fails, and so does the step. Make it
   `@Nullable`.
5. **`inputMapping` keys in the wrong spelling.** They're the input's wire
   names: `customer_id` doesn't fill a `customerId` component that has no
   `@JsonProperty("customer_id")`.
6. **A `when` given through `set("edges", …)`.** `build()` writes the edges
   you added with `edge(…)`; use `edge(Map.of(…))` for an edge with a
   condition or a policy.
7. **A sub-flow node.** A run refuses it (`flow-unbound`) until sub-flows
   are supported.
8. **Duplicate node ids inside a loop body.** Ids are unique across the
   whole flow, bodies included.
9. **`mutating(false)` on a tool that writes.** A dry run then runs it for
   real, and an approval gate (when it falls back on `mutating`) won't ask
   before it.
10. **A read-only tool without `mutating(false)`.** A dry run stops at it,
    and an approval gate asks before it on first use.

## When the framework itself is the problem

If the bug is in Kindgi or kindgi-pack (a step's output missing a field, a
condition that evaluates wrongly, a misleading error) and not in the pack's
code, load `kindgi-framework-feedback` and file it with
`./kindgiw feedback write`.
