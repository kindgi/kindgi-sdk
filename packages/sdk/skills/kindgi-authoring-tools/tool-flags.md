# Read-only tools, a person's yes, and outside data

## Read-only tools: `mutating`

`mutating: false` declares that the tool changes nothing outside Kindgi; it only reads. Leaving `mutating` out counts as mutating, the same as `true`. It decides three things, in both authoring modes:

- **Dry runs.** `kindgi runs start --dry-run` runs a tool only if it's `mutating: false` and its `effects` declare no `writes`, `deletes`, `spawns-run`, `emits-event` or `external-side-effect`. The first other tool stops the run with `dry-run-effectful-tool`.
- **Approval gates.** When an agent turns tool gates on (`conversationPolicy.hitl.tools`) and sets neither an override for the tool nor a `default`, a `mutating: false` tool runs straight through, and any other tool asks for approval on its first use.
- **Runs a new mail started.** A call of a tool that isn't `mutating: false` waits for a person's yes, unless the mail trigger's `toolsAllowedUnattended` lists it.

So declare `mutating: false` on every tool that only reads, and never on one that writes.

A tool that writes also says what it writes, in `effects`, beside `mutating: true`:

```ts
  effects: [{ kind: 'writes', resource: 'acme:refunds' }],
  mutating: true,
```

The kinds are `reads`, `writes`, `deletes`, `network`, `spawns-run`, `emits-event`, `external-side-effect` and `sensitive-data-egress` (`EFFECT_KINDS` in `@kindgi/tools`); `defineTool` refuses any other. `resource` is free text naming what the tool touches. A read-only tool keeps `effects: []`.

## A person's yes when no one is watching: `needsApprovalWhenUnattended`

`needsApprovalWhenUnattended: true` declares that a person must say yes to every call of the tool in a run no person started: one a schedule, a webhook, a new mail, an event or a service account's key started. In such a run:

- **An agent's call waits** for a person's yes, whatever the agent's `conversationPolicy.hitl.tools` says. The agent's rules can't lift it: agents are reused, and the tool's author knows what it does.
- **A flow's tool step that calls it is refused.** Put the tool behind an agent step instead, whose call waits.
- **A trigger can lift both, for its own runs only.** A project admin names the tool in a webhook trigger's, a schedule's or a mail trigger's `toolsAllowedUnattended` (`--allow-unattended=<tool-id>` on `kindgi webhooks`, `kindgi schedules` and `kindgi mail-triggers`). In that trigger's runs, the tool is then as in a run a person started. The tenant's approval rules still apply.

In a run a person started (signed in, or with their own API key), the agent's rules decide, as for any tool. Absent means `false`. Declare it on a tool that moves money or changes something people rely on:

```ts
  effects: [{ kind: 'writes', resource: 'acme:refunds' }],
  mutating: true,
  needsApprovalWhenUnattended: true,
```

Docs: https://docs.kindgi.com/v0.1/guides/approvals/ask-before-a-tool-runs/#when-no-person-started-the-run

A step can run more than once (resumed after an approval, retried after a failure, run again after a crash), so a tool that writes uses `ctx.idempotencyKey`: the same every time this call runs, different for every other call. Pass it to the system you write to (an `Idempotency-Key` header, a client reference, a unique column) or look for it there first, and a refund never goes out twice. Not `ctx.requestId`: a model's call id is only unique within one of its answers. The key is absent outside a run and from a runtime before 0.1.6. Docs: https://docs.kindgi.com/v0.1/guides/tools/write-a-tool/#make-a-side-effect-happen-once

## Results that are text from outside: `resultIsOutsideData`

`resultIsOutsideData: true` says the tool's results are text from outside that nobody checked, such as a mail someone sent or a page a search found. An agent reads each result of the tool as data, not instructions, in that turn and in every later turn's history. It changes what the model is told, not what the tool may do: pair it with approvals for anything an agent could do with what it read. Absent means `false`.
